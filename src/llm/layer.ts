import type { CipherBState, ExecutionDecision, RiskPlan, StrategySignal } from "../types.ts";
import { clamp, round } from "../util/math.ts";
import { buildLlmInput, buildPrompt, PROMPT_VERSION } from "./normalize.ts";
import { validateConfluence } from "./schema.ts";
import type { LlmProvider } from "./provider.ts";

export interface LayerMeta {
  model: string;
  promptVersion?: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

/** Rule-derived base confidence from confluence flags - a calibrated score, not a probability. */
function baseConfidence(cipher: CipherBState): number {
  let c = 0.55;
  if (cipher.bearishDivergence || cipher.bullishDivergence) c += 0.1;
  if (cipher.dot !== 0) c += 0.08;
  if (cipher.overbought || cipher.oversold) c += 0.07;
  return clamp(c, 0, 0.9);
}

/**
 * LLM refinement layer. It may explain and adjust confidence for a setup the
 * deterministic engine already approved; it can NEVER manufacture a setup or flip a
 * NO_TRADE. With no provider (or on any LLM failure) it degrades to the pure
 * rule-derived decision so the pipeline stays deterministic and reproducible.
 */
export async function refineDecision(
  signal: StrategySignal,
  cipher: CipherBState,
  risk: RiskPlan,
  provider: LlmProvider | null,
  meta: LayerMeta,
): Promise<ExecutionDecision> {
  const promptVersion = meta.promptVersion ?? PROMPT_VERSION;

  if (signal.direction === "NO_TRADE") {
    const unmet = Object.entries(signal.conditions).filter(([, v]) => v !== true).map(([k]) => k);
    return {
      symbol: signal.symbol, direction: "NO_TRADE", setup_type: "NONE", confidence_score: 0,
      execution: { entry_price: 0, stop_loss: 0, take_profit_1: 0, take_profit_2: 0, risk_reward_ratio: 0 },
      rationale: unmet.length > 0 ? [`mandatory conditions not satisfied: ${unmet.join(", ")}`] : ["no setup conditions met"],
      provenance: { model: meta.model, promptVersion, llmUsed: false, deterministicGate: "NONE" },
    };
  }

  let confidence = baseConfidence(cipher);
  const rationale: string[] = [`deterministic ${signal.setupType} signal approved by rules engine`];
  let llmUsed = false;
  let model = meta.model;

  if (provider) {
    try {
      const input = buildLlmInput(signal, cipher, risk);
      const raw = await provider.complete(buildPrompt(input));
      const parsed = validateConfluence(extractJson(raw));
      if (parsed.ok && parsed.value) {
        confidence = clamp(confidence + parsed.value.confidence_adjustment, 0, 0.95);
        rationale.push(`llm confluence=${parsed.value.confluence}`);
        for (const n of parsed.value.notes.slice(0, 3)) rationale.push(n);
        llmUsed = true;
        model = provider.model;
      }
    } catch {
      // LLM unavailable/invalid: fall back to rule-derived confidence (still deterministic).
      rationale.push("llm unavailable - rule-derived confidence used");
    }
  }

  return {
    symbol: signal.symbol,
    direction: signal.direction,
    setup_type: signal.setupType,
    confidence_score: round(confidence, 3),
    execution: {
      entry_price: round(risk.entryPrice, 6),
      stop_loss: round(risk.stopLoss, 6),
      take_profit_1: round(risk.takeProfit1, 6),
      take_profit_2: round(risk.takeProfit2, 6),
      risk_reward_ratio: round(risk.riskRewardRatio, 3),
    },
    rationale,
    provenance: { model, promptVersion, llmUsed, deterministicGate: signal.setupType },
  };
}
