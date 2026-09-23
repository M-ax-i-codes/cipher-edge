import { ema } from "../util/math.ts";

/**
 * The Cipher B "momentum wave".
 *
 * DOCUMENTED INTERPRETATION: VMC does not publish the exact momentum-wave formula.
 * CipherEdge defines it as a light EMA smoothing of the WaveTrend os1 line, which
 * preserves the semantics the strategy relies on - a zero-line, an overbought zone
 * (> +60) and an oversold zone (< -60). `smooth` = 3 by default.
 *
 * This is the single largest fidelity assumption in the project and is called out
 * explicitly in the README and in every report's provenance block.
 */
export function computeMomentumWave(os1: number[], smooth = 3): number[] {
  return ema(os1, Math.max(1, smooth));
}
