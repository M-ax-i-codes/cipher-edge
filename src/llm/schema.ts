import type { Direction, ExecutionDecision, SetupType } from "../types.ts";

const DIRECTIONS: Direction[] = ["LONG", "SHORT", "NO_TRADE"];
const SETUPS: SetupType[] = ["BEARISH_DIVERGENCE", "BREAKOUT_RETEST", "NONE"];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value: ExecutionDecision | null;
}

/** Validate a parsed LLM payload against the strict CipherEdge execution schema. */
export function validateExecutionDecision(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["not an object"], value: null };
  const o = raw as Record<string, unknown>;

  const direction = o.direction as Direction;
  if (!DIRECTIONS.includes(direction)) errors.push(`direction must be one of ${DIRECTIONS.join("/")}`);
  const setup = o.setup_type as SetupType;
  if (!SETUPS.includes(setup)) errors.push(`setup_type must be one of ${SETUPS.join("/")}`);
  const conf = Number(o.confidence_score);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) errors.push("confidence_score must be a number in [0,1]");

  const ex = o.execution as Record<string, unknown> | undefined;
  if (!ex || typeof ex !== "object") errors.push("execution object missing");
  else {
    for (const k of ["entry_price", "stop_loss", "take_profit_1", "take_profit_2", "risk_reward_ratio"]) {
      if (!Number.isFinite(Number(ex[k]))) errors.push(`execution.${k} must be a finite number`);
    }
  }
  if (!Array.isArray(o.rationale) || o.rationale.some((r) => typeof r !== "string")) errors.push("rationale must be an array of strings");

  if (errors.length > 0) return { ok: false, errors, value: null };
  return {
    ok: true, errors: [],
    value: {
      symbol: String(o.symbol ?? ""),
      direction, setup_type: setup,
      confidence_score: Math.min(1, Math.max(0, conf)),
      execution: {
        entry_price: Number(ex!.entry_price), stop_loss: Number(ex!.stop_loss),
        take_profit_1: Number(ex!.take_profit_1), take_profit_2: Number(ex!.take_profit_2),
        risk_reward_ratio: Number(ex!.risk_reward_ratio),
      },
      rationale: (o.rationale as string[]).slice(0, 8),
      provenance: { model: "unvalidated", promptVersion: "unvalidated", llmUsed: true, deterministicGate: "NONE" },
    },
  };
}

/** Extract just the confluence payload the LLM is allowed to influence. */
export interface ConfluencePayload {
  confluence: "strong" | "moderate" | "weak";
  confidence_adjustment: number;
  notes: string[];
}

export function validateConfluence(raw: unknown): { ok: boolean; value: ConfluencePayload | null } {
  if (typeof raw !== "object" || raw === null) return { ok: false, value: null };
  const o = raw as Record<string, unknown>;
  const confluence = o.confluence;
  if (confluence !== "strong" && confluence !== "moderate" && confluence !== "weak") return { ok: false, value: null };
  const adj = Number(o.confidence_adjustment);
  if (!Number.isFinite(adj)) return { ok: false, value: null };
  const notes = Array.isArray(o.notes) ? o.notes.filter((n) => typeof n === "string") : [];
  return { ok: true, value: { confluence, confidence_adjustment: Math.min(0.15, Math.max(-0.15, adj)), notes } };
}
