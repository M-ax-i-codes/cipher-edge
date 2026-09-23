import type { Candle } from "../types.ts";
import { confirmedSwingHighs, confirmedSwingLows } from "./swings.ts";

export interface BreakoutParams {
  arm: number;
  /** Retest tolerance around the broken level, in percent. */
  retestTolerancePct: number;
  /** How many bars back to consider a swing high as overhead resistance. */
  maxSwingAgeBars: number;
  /** Bars allowed between breakout and its retest. */
  retestWindowBars: number;
}

export const DEFAULT_BREAKOUT: BreakoutParams = { arm: 5, retestTolerancePct: 0.25, maxSwingAgeBars: 60, retestWindowBars: 24 };

export interface BreakoutSeries {
  /** Bar where price closed above overhead resistance. */
  breakout: boolean[];
  /** Bar where price retested the broken level as support and held. */
  retest: boolean[];
  /** The broken level associated with each retest (else null). */
  retestLevel: Array<number | null>;
}

/**
 * Breakout + retest detection (Setup B structure), fully causal.
 *
 * Overhead resistance at bar t is the nearest confirmed swing high above the prior
 * close, drawn from swings confirmed by bar t and no older than maxSwingAgeBars.
 *   breakout[t]: close[t] > R and close[t-1] <= R.
 *   retest[t]:   after a breakout at level R, low[t] returns to within
 *                +/- retestTolerancePct of R and close[t] holds >= R.
 *
 * No future bar is consulted: swings are only eligible once their right-hand
 * confirmation bars have occurred.
 */
export function detectBreakoutRetest(candles: Candle[], params: BreakoutParams = DEFAULT_BREAKOUT): BreakoutSeries {
  const { arm, retestTolerancePct, maxSwingAgeBars, retestWindowBars } = params;
  const highs = candles.map((c) => c.high);
  const swings = confirmedSwingHighs(highs, arm, arm, candles.length - 1);
  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);
  const breakout = new Array<boolean>(candles.length).fill(false);
  const retest = new Array<boolean>(candles.length).fill(false);
  const retestLevel = new Array<number | null>(candles.length).fill(null);

  let active: { level: number; bar: number } | null = null;
  let swingCursor = 0;
  const confirmed: Array<{ index: number; value: number }> = [];

  for (let t = 1; t < candles.length; t += 1) {
    // Advance confirmed swings up to bar t.
    while (swingCursor < swings.length && (swings[swingCursor] as { confirmedAt: number }).confirmedAt <= t) {
      const s = swings[swingCursor] as { index: number; value: number };
      confirmed.push({ index: s.index, value: s.value });
      swingCursor += 1;
    }
    // Recent overhead swing highs.
    const priorClose = closes[t - 1] as number;
    let resistance: number | null = null;
    for (const s of confirmed) {
      if (t - s.index > maxSwingAgeBars) continue;
      if (s.value > priorClose && (resistance === null || s.value < resistance)) resistance = s.value;
    }

    if (resistance !== null && (closes[t] as number) > resistance && priorClose <= resistance) {
      breakout[t] = true;
      active = { level: resistance, bar: t };
      continue;
    }

    if (active && t - active.bar <= retestWindowBars) {
      const tol = (retestTolerancePct / 100) * active.level;
      const touched = (lows[t] as number) <= active.level + tol;
      const held = (closes[t] as number) >= active.level;
      if (touched && held) {
        retest[t] = true;
        retestLevel[t] = active.level;
        active = null;
      }
    } else if (active && t - active.bar > retestWindowBars) {
      active = null;
    }
  }
  return { breakout, retest, retestLevel };
}

/** Nearest confirmed support below price (for Setup B stop placement), causal. */
export function nearestSupport(candles: Candle[], arm: number, upTo: number, price: number, maxAgeBars: number): number | null {
  const lows = candles.map((c) => c.low);
  const swings = confirmedSwingLows(lows, arm, arm, upTo);
  let best: number | null = null;
  for (const s of swings) {
    if (upTo - s.index > maxAgeBars) continue;
    if (s.value < price && (best === null || s.value > best)) best = s.value;
  }
  return best;
}
