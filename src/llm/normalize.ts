import type { CipherBState, RiskPlan, StrategySignal } from "../types.ts";
import { round } from "../util/math.ts";

/**
 * Build the normalized market/indicator state fed to the LLM. Only bounded,
 * de-identified numbers and the satisfied-condition audit are included - never raw
 * keys, never future bars. The LLM interprets confluence; it cannot see or change
 * the mandatory-condition outcome.
 */
export function buildLlmInput(signal: StrategySignal, cipher: CipherBState, risk: RiskPlan): Record<string, unknown> {
  const satisfied = Object.entries(signal.conditions).filter(([, v]) => v === true).map(([k]) => k);
  return {
    setup_type: signal.setupType,
    direction: signal.direction,
    conditions_satisfied: satisfied,
    momentum_wave: round(cipher.momentumWave, 2),
    wavetrend_os1: round(cipher.wt.os1, 2),
    wavetrend_os2: round(cipher.wt.os2, 2),
    dot: cipher.dot,
    overbought: cipher.overbought,
    oversold: cipher.oversold,
    bearish_divergence: cipher.bearishDivergence,
    bullish_divergence: cipher.bullishDivergence,
    stop_distance_pct: round(risk.stopDistancePct, 3),
    risk_reward_ratio: round(risk.riskRewardRatio, 2),
  };
}

export const PROMPT_VERSION = "cipheredge-llm-v1";

export function buildPrompt(input: Record<string, unknown>): string {
  return [
    "You are a confluence analyst for a VMC Cipher B trading agent. The deterministic strategy",
    "engine has ALREADY decided the direction; you must not change it. Assess only the strength",
    "and ambiguity of the confluence described below and return strict JSON:",
    '{"confluence":"strong|moderate|weak","confidence_adjustment":<number in [-0.15,0.15]>,"notes":["..."]}',
    "State:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}
