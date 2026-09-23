/**
 * Top red / bottom green dot detection.
 *
 * DOCUMENTED INTERPRETATION: a dot marks a local turning point of the momentum wave
 * that occurs inside an extreme zone - i.e. momentum exhaustion.
 *   - Top red dot  (+1): the wave forms a local peak (wave[i-1] > wave[i] and
 *     wave[i-1] > wave[i-2]) while that peak is at/above the overbought threshold.
 *   - Bottom green dot (-1): the wave forms a local trough (wave[i-1] < wave[i] and
 *     wave[i-1] < wave[i-2]) while that trough is at/below the oversold threshold.
 *
 * The dot is emitted on bar i (the confirmation bar), referencing the extremum at
 * i-1, so it is fully causal - no look-ahead.
 */
export function detectDots(wave: number[], overbought: number, oversold: number): Array<-1 | 0 | 1> {
  const out = new Array<-1 | 0 | 1>(wave.length).fill(0);
  for (let i = 2; i < wave.length; i += 1) {
    const a = wave[i - 2] as number;
    const b = wave[i - 1] as number;
    const c = wave[i] as number;
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    if (b > a && b > c && b >= overbought) out[i] = 1;
    else if (b < a && b < c && b <= oversold) out[i] = -1;
  }
  return out;
}
