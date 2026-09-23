import type { SetupInput } from "./context.ts";

export interface SetupVerdict {
  pass: boolean;
  conditions: Record<string, boolean>;
}

/**
 * SETUP A - BEARISH MEAN-REVERSION SHORT. All conditions are mandatory; the LLM
 * layer may comment on confluence but cannot waive any of them.
 *
 *   structure   : price reached/swept the reference swing high (supply zone).
 *   divergence  : confirmed bearish divergence (price HH vs wave LH).
 *   exhaustion  : momentum wave was in the overbought zone at t or t-1.
 *   redDot      : a top red dot fired at t or t-1.
 *   rejection   : the trigger bar closed down (close < open) - rejection confirmation.
 */
export function evaluateSetupA(input: SetupInput): SetupVerdict {
  const { candle, cipher, prevCipher, refSwingHigh, wave, wavePrev, overbought, sweepTolerancePct } = input;
  const structure = refSwingHigh !== null && candle.high >= refSwingHigh * (1 - sweepTolerancePct / 100);
  const divergence = cipher.bearishDivergence;
  const exhaustion = cipher.overbought || (prevCipher?.overbought ?? false) || wave >= overbought || wavePrev >= overbought;
  const redDot = cipher.dot === 1 || prevCipher?.dot === 1;
  const rejection = candle.close < candle.open;
  const conditions = { structure, divergence, exhaustion, redDot, rejection };
  const pass = structure && divergence && exhaustion && redDot && rejection;
  return { pass, conditions };
}
