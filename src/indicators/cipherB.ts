import type { Candle, CipherBState } from "../types.ts";
import { computeWaveTrend, waveTrendAt, DEFAULT_WT } from "./wavetrend.ts";
import type { WaveTrendParams } from "./wavetrend.ts";
import { computeMomentumWave } from "./momentumWave.ts";
import { detectDots } from "./dots.ts";
import { computeDivergence, DEFAULT_DIVERGENCE } from "./divergence.ts";
import type { DivergenceParams } from "./divergence.ts";

export interface CipherBConfig {
  wavetrend: WaveTrendParams;
  momentumSmooth: number;
  overbought: number;
  oversold: number;
  divergence: DivergenceParams;
}

export const DEFAULT_CIPHERB: CipherBConfig = {
  wavetrend: DEFAULT_WT,
  momentumSmooth: 3,
  overbought: 60,
  oversold: -60,
  divergence: DEFAULT_DIVERGENCE,
};

/**
 * Aggregate the full VMC Cipher B state for every bar: WaveTrend os1/os2, the
 * momentum wave, top-red / bottom-green dots, overbought/oversold zones, and
 * causal bullish/bearish divergence. Everything here is computed from bars <= i.
 */
export function computeCipherB(candles: Candle[], cfg: CipherBConfig = DEFAULT_CIPHERB): CipherBState[] {
  const wt = computeWaveTrend(candles, cfg.wavetrend);
  const wave = computeMomentumWave(wt.os1, cfg.momentumSmooth);
  const dots = detectDots(wave, cfg.overbought, cfg.oversold);
  const div = computeDivergence(candles, wave, cfg.divergence);
  return candles.map((c, i) => {
    const w = wave[i] as number;
    return {
      ts: c.ts,
      wt: waveTrendAt(wt, i),
      momentumWave: w,
      dot: dots[i] as -1 | 0 | 1,
      overbought: Number.isFinite(w) && w >= cfg.overbought,
      oversold: Number.isFinite(w) && w <= cfg.oversold,
      bearishDivergence: div.bearish[i] as boolean,
      bullishDivergence: div.bullish[i] as boolean,
    };
  });
}
