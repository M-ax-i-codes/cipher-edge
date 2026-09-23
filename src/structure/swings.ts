export interface SwingPoint {
  index: number;
  value: number;
  /** Bar at which this swing becomes confirmed (index + right). */
  confirmedAt: number;
}

function isSwingHigh(values: number[], i: number, left: number, right: number): boolean {
  const v = values[i] as number;
  if (!Number.isFinite(v)) return false;
  for (let k = i - left; k <= i + right; k += 1) {
    if (k === i) continue;
    const w = values[k] as number;
    if (!Number.isFinite(w) || w >= v) return false;
  }
  return true;
}

function isSwingLow(values: number[], i: number, left: number, right: number): boolean {
  const v = values[i] as number;
  if (!Number.isFinite(v)) return false;
  for (let k = i - left; k <= i + right; k += 1) {
    if (k === i) continue;
    const w = values[k] as number;
    if (!Number.isFinite(w) || w <= v) return false;
  }
  return true;
}

/**
 * Confirmed swing highs, causal: a swing at index i is only returned once bar
 * `upTo` >= i + right, i.e. the right-hand confirmation bars have actually occurred.
 * This is what keeps divergence / structure free of look-ahead bias.
 */
export function confirmedSwingHighs(highs: number[], left: number, right: number, upTo: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  const last = Math.min(upTo - right, highs.length - 1);
  for (let i = left; i <= last; i += 1) {
    if (isSwingHigh(highs, i, left, right)) out.push({ index: i, value: highs[i] as number, confirmedAt: i + right });
  }
  return out;
}

export function confirmedSwingLows(lows: number[], left: number, right: number, upTo: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  const last = Math.min(upTo - right, lows.length - 1);
  for (let i = left; i <= last; i += 1) {
    if (isSwingLow(lows, i, left, right)) out.push({ index: i, value: lows[i] as number, confirmedAt: i + right });
  }
  return out;
}
