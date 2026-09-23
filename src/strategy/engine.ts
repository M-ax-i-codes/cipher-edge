import type { Candle, StrategySignal } from "../types.ts";
import { computeCipherB, DEFAULT_CIPHERB } from "../indicators/cipherB.ts";
import type { CipherBConfig } from "../indicators/cipherB.ts";
import { detectBreakoutRetest, DEFAULT_BREAKOUT } from "../structure/breakout.ts";
import type { BreakoutParams } from "../structure/breakout.ts";
import { confirmedSwingHighs } from "../structure/swings.ts";
import { evaluateSetupA } from "./setupA.ts";
import { evaluateSetupB } from "./setupB.ts";
import type { SetupInput } from "./context.ts";

export interface StrategyConfig {
  cipherB: CipherBConfig;
  breakout: BreakoutParams;
  /** Setup A: price must reach within this % of the reference swing high. */
  sweepTolerancePct: number;
  /** Setup B: momentum wave at/below this counts as cooled to the zero-line. */
  momentumCoolMax: number;
  /** Max age (bars) of a swing high used as Setup A supply reference. */
  maxSwingAgeBars: number;
  /** Bars to skip after a non-NO_TRADE signal (de-duplication). */
  signalCooldownBars: number;
  /** Bars to skip at the start for indicator warm-up. */
  warmupBars: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  cipherB: DEFAULT_CIPHERB,
  breakout: DEFAULT_BREAKOUT,
  sweepTolerancePct: 0.3,
  momentumCoolMax: 0,
  maxSwingAgeBars: 60,
  signalCooldownBars: 3,
  warmupBars: 60,
};

function noTrade(t: number, symbol: string, conditions: Record<string, boolean>): StrategySignal {
  return {
    ts: 0, symbol, direction: "NO_TRADE", setupType: "NONE", conditions,
    swingHigh: null, swingLow: null, supportLevel: null, resistanceLevel: null,
  };
}

/**
 * Deterministic strategy engine. Evaluates Setup A, then Setup B, else NO_TRADE.
 * The LLM layer is consulted only after a deterministic signal exists and can never
 * manufacture one - this function is the single source of truth for direction.
 */
export function evaluateAll(candles: Candle[], symbol: string, cfg: StrategyConfig = DEFAULT_STRATEGY): StrategySignal[] {
  const cipher = computeCipherB(candles, cfg.cipherB);
  const breakout = detectBreakoutRetest(candles, cfg.breakout);
  const highs = candles.map((c) => c.high);
  const arm = cfg.breakout.arm;
  const swingHighs = confirmedSwingHighs(highs, arm, arm, candles.length - 1);

  const out: StrategySignal[] = new Array(candles.length);
  let swingCursor = 0;
  const confirmed: Array<{ index: number; value: number }> = [];
  let cooldownUntil = -1;

  for (let t = 0; t < candles.length; t += 1) {
    while (swingCursor < swingHighs.length && (swingHighs[swingCursor] as { confirmedAt: number }).confirmedAt <= t) {
      const s = swingHighs[swingCursor] as { index: number; value: number };
      confirmed.push({ index: s.index, value: s.value });
      swingCursor += 1;
    }

    if (t < cfg.warmupBars) {
      out[t] = { ...noTrade(t, symbol, {}), ts: candles[t]!.ts };
      continue;
    }

    // Nearest recent confirmed swing high (overhead supply) for Setup A.
    let recentIdx = -1;
    let recentVal: number | null = null;
    for (const s of confirmed) {
      if (t - s.index > cfg.maxSwingAgeBars) continue;
      if (s.index > recentIdx) { recentIdx = s.index; recentVal = s.value; }
    }
    const refSwingHigh = recentVal;

    const input: SetupInput = {
      t,
      candle: candles[t]!,
      prevCandle: t > 0 ? candles[t - 1]! : null,
      cipher: cipher[t]!,
      prevCipher: t > 0 ? cipher[t - 1]! : null,
      wave: cipher[t]!.momentumWave,
      wavePrev: t > 0 ? cipher[t - 1]!.momentumWave : NaN,
      wavePrev2: t > 1 ? cipher[t - 2]!.momentumWave : NaN,
      refSwingHigh,
      retestLevel: breakout.retestLevel[t] ?? null,
      retestNow: breakout.retest[t] ?? false,
      overbought: cfg.cipherB.overbought,
      oversold: cfg.cipherB.oversold,
      sweepTolerancePct: cfg.sweepTolerancePct,
      momentumCoolMax: cfg.momentumCoolMax,
    };

    let signal: StrategySignal;
    if (t <= cooldownUntil) {
      signal = { ...noTrade(t, symbol, { cooldown: true }), ts: candles[t]!.ts };
    } else {
      const a = evaluateSetupA(input);
      if (a.pass) {
        signal = {
          ts: candles[t]!.ts, symbol, direction: "SHORT", setupType: "BEARISH_DIVERGENCE",
          conditions: a.conditions, swingHigh: refSwingHigh, swingLow: null,
          supportLevel: null, resistanceLevel: refSwingHigh,
        };
        cooldownUntil = t + cfg.signalCooldownBars;
      } else {
        const b = evaluateSetupB(input);
        if (b.pass) {
          signal = {
            ts: candles[t]!.ts, symbol, direction: "LONG", setupType: "BREAKOUT_RETEST",
            conditions: b.conditions, swingHigh: null, swingLow: breakout.retestLevel[t] ?? null,
            supportLevel: breakout.retestLevel[t] ?? null, resistanceLevel: null,
          };
          cooldownUntil = t + cfg.signalCooldownBars;
        } else {
          signal = { ...noTrade(t, symbol, { ...a.conditions, ...b.conditions }), ts: candles[t]!.ts };
        }
      }
    }
    out[t] = signal;
  }
  return out;
}
