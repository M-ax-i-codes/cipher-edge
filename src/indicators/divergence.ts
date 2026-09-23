import type { Candle } from "../types.ts";
import { confirmedSwingHighs, confirmedSwingLows } from "../structure/swings.ts";
import type { SwingPoint } from "../structure/swings.ts";

export interface DivergenceParams {
  /** Fractal arm length (left = right = swingLookback). */
  swingLookback: number;
  /** Minimum bars between the two compared swings. */
  minSwingBars: number;
  /** The newer swing must be within this many bars of the current bar. */
  maxSwingAgeBars: number;
}

export const DEFAULT_DIVERGENCE: DivergenceParams = { swingLookback: 5, minSwingBars: 2, maxSwingAgeBars: 60 };

export interface DivergenceSeries {
  bearish: boolean[];
  bullish: boolean[];
}

/**
 * Regular (classic) divergence on confirmed swing points, computed causally.
 *
 *   Bearish: between the two most recent confirmed swing highs, price prints a
 *            higher high while the momentum wave prints a lower high.
 *   Bullish: between the two most recent confirmed swing lows, price prints a
 *            lower low while the momentum wave prints a higher low.
 *
 * NO LOOK-AHEAD: a swing at index i is only eligible once bar (i + swingLookback)
 * has occurred, i.e. its right-hand confirmation bars exist. Implemented with a
 * monotonic cursor over pre-confirmed swings, which is O(n) and returns exactly the
 * same set as re-scanning `confirmedSwing*(values, arm, arm, t)` at every bar.
 */
export function computeDivergence(candles: Candle[], wave: number[], params: DivergenceParams = DEFAULT_DIVERGENCE): DivergenceSeries {
  const { swingLookback, minSwingBars, maxSwingAgeBars } = params;
  const n = candles.length;
  const bearish = new Array<boolean>(n).fill(false);
  const bullish = new Array<boolean>(n).fill(false);
  if (n === 0) return { bearish, bullish };

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swingHighs = confirmedSwingHighs(highs, swingLookback, swingLookback, n - 1);
  const swingLows = confirmedSwingLows(lows, swingLookback, swingLookback, n - 1);

  const activeHighs: SwingPoint[] = [];
  const activeLows: SwingPoint[] = [];
  let highCursor = 0;
  let lowCursor = 0;

  for (let t = 0; t < n; t += 1) {
    while (highCursor < swingHighs.length && (swingHighs[highCursor] as SwingPoint).confirmedAt <= t) {
      activeHighs.push(swingHighs[highCursor] as SwingPoint);
      highCursor += 1;
    }
    while (lowCursor < swingLows.length && (swingLows[lowCursor] as SwingPoint).confirmedAt <= t) {
      activeLows.push(swingLows[lowCursor] as SwingPoint);
      lowCursor += 1;
    }

    if (activeHighs.length >= 2) {
      const s2 = activeHighs[activeHighs.length - 1] as SwingPoint;
      const s1 = activeHighs[activeHighs.length - 2] as SwingPoint;
      const w1 = wave[s1.index] as number;
      const w2 = wave[s2.index] as number;
      const recent = t - s2.index <= maxSwingAgeBars;
      const separated = s2.index - s1.index >= minSwingBars;
      if (recent && separated && Number.isFinite(w1) && Number.isFinite(w2)) {
        if (s2.value > s1.value && w2 < w1) bearish[t] = true;
      }
    }

    if (activeLows.length >= 2) {
      const s2 = activeLows[activeLows.length - 1] as SwingPoint;
      const s1 = activeLows[activeLows.length - 2] as SwingPoint;
      const w1 = wave[s1.index] as number;
      const w2 = wave[s2.index] as number;
      const recent = t - s2.index <= maxSwingAgeBars;
      const separated = s2.index - s1.index >= minSwingBars;
      if (recent && separated && Number.isFinite(w1) && Number.isFinite(w2)) {
        if (s2.value < s1.value && w2 > w1) bullish[t] = true;
      }
    }
  }
  return { bearish, bullish };
}
