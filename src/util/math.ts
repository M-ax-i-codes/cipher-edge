export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** Nearest-rank percentile. Returns null for empty input. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, dp = 6): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Exponential moving average as a full-length series.
 * NaN-aware: leading NaNs (indicator warm-up) are skipped, the seed is the SMA of the
 * first `period` finite values, and any later NaN holds the previous value.
 * k = 2 / (period + 1).
 */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length === 0) return out;
  const start = values.findIndex((v) => Number.isFinite(v));
  if (start < 0 || values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i += 1) seed += values[i] as number;
  let prev = seed / period;
  out[start + period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = start + period; i < values.length; i += 1) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Simple moving average as a full-length series; indices before the window are NaN. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** True if every value is finite (used to gate indicator warm-up). */
export function allFinite(values: Array<number | null | undefined>): boolean {
  for (const v of values) if (typeof v !== "number" || !Number.isFinite(v)) return false;
  return true;
}
