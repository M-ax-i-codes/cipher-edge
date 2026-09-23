import type { Candle, WaveTrendState } from "../types.ts";
import { ema, sma } from "../util/math.ts";

export interface WaveTrendParams {
  /** Channel length (EMA period for esa and d). Default 10. */
  n1: number;
  /** os1 smoothing (EMA period applied to the channel index). Default 21. */
  n2: number;
  /** os2 = SMA(os1, os2Smooth). Default 4. */
  os2Smooth: number;
}

export const DEFAULT_WT: WaveTrendParams = { n1: 10, n2: 21, os2Smooth: 4 };

export interface WaveTrendSeries {
  ap: number[];
  esa: number[];
  d: number[];
  ci: number[];
  os1: number[];
  os2: number[];
}

/**
 * WaveTrend oscillator (the core of VMC Cipher B's "WaveTrend Oscillators").
 *
 * Formulas (documented; this is the widely-published WaveTrend, e.g. LazyBear's):
 *   ap  = (high + low + close) / 3
 *   esa = EMA(ap, n1)
 *   d   = EMA(|ap - esa|, n1)
 *   ci  = (ap - esa) / (0.015 * d)
 *   os1 = EMA(ci, n2)
 *   os2 = SMA(os1, os2Smooth)
 *
 * os1/os2 are roughly bounded to [-100, +100]; the zero-line is neutral,
 * > +60 is treated as overbought and < -60 as oversold by the strategy layer.
 *
 * NOTE ON FIDELITY: this reproduces the standard public WaveTrend. VMC's exact
 * proprietary smoothing of the Cipher B variant is not published, so any residual
 * difference from the TradingView plot is a known limitation (see README).
 */
export function computeWaveTrend(candles: Candle[], params: WaveTrendParams = DEFAULT_WT): WaveTrendSeries {
  const { n1, n2, os2Smooth } = params;
  const ap = candles.map((c) => (c.high + c.low + c.close) / 3);
  const esa = ema(ap, n1);
  const dev = ap.map((v, i) => (Number.isFinite(esa[i] as number) ? Math.abs(v - (esa[i] as number)) : NaN));
  const d = ema(dev, n1);
  const ci = ap.map((v, i) => {
    const di = d[i] as number;
    const ei = esa[i] as number;
    if (!Number.isFinite(di) || !Number.isFinite(ei) || di === 0) return NaN;
    return (v - ei) / (0.015 * di);
  });
  const os1 = ema(ci, n2);
  const os2 = sma(os1, os2Smooth);
  return { ap, esa, d, ci, os1, os2 };
}

/** WaveTrend state at a single bar index (NaN fields during warm-up). */
export function waveTrendAt(series: WaveTrendSeries, i: number): WaveTrendState {
  return {
    ap: series.ap[i] as number,
    esa: series.esa[i] as number,
    d: series.d[i] as number,
    ci: series.ci[i] as number,
    os1: series.os1[i] as number,
    os2: series.os2[i] as number,
  };
}
