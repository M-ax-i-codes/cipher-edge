/** Shared synthetic-data helpers. Deterministic: no randomness, no network, no clock. */
import type { Candle } from "../src/types.ts";

export const MIN = 60_000;
export const M15 = 15 * MIN;
export const H1 = 60 * MIN;

/** Fixed epoch so every test run is byte-identical. 2026-01-01T00:00:00Z */
export const T0 = 1_767_225_600_000;

export function candle(ts: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { ts, open, high, low, close, volume };
}

/** A flat series at `price` - useful for asserting "nothing fires without structure". */
export function flatSeries(n: number, price = 100, granularity = M15, startTs = T0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(candle(startTs + i * granularity, price, price, price, price));
  }
  return out;
}

/**
 * A deterministic pseudo-random walk. Seeded LCG so results never vary between runs
 * (Math.random would make the suite non-reproducible).
 */
export function walkSeries(n: number, opts: { start?: number; seed?: number; vol?: number; granularity?: number; startTs?: number; drift?: number } = {}): Candle[] {
  const start = opts.start ?? 100;
  const vol = opts.vol ?? 0.004;
  const drift = opts.drift ?? 0;
  const granularity = opts.granularity ?? M15;
  const startTs = opts.startTs ?? T0;
  let seed = opts.seed ?? 12345;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const shock = (next() - 0.5) * 2 * vol + drift;
    const close = Math.max(0.01, open * (1 + shock));
    const wick = Math.abs(next() - 0.5) * vol * open;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    out.push(candle(startTs + i * granularity, open, high, Math.max(0.01, low), close, 100 + Math.round(next() * 900)));
    price = close;
  }
  return out;
}

/**
 * A scripted shape: an uptrend, a lower-high pullback, then a higher-high push - the
 * geometry that produces a confirmed swing high and, with a falling wave, bearish divergence.
 */
export function shapedSeries(granularity = M15, startTs = T0): Candle[] {
  const prices = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 111, 110,
    109, 108, 107, 106, 105, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113,
    113.5, 113.2, 112.8, 112.4, 112, 111.6, 111.2, 110.8, 110.4, 110,
  ];
  return prices.map((p, i) => {
    const prev = i > 0 ? (prices[i - 1] as number) : p;
    const open = prev;
    const close = p;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    return candle(startTs + i * granularity, open, high, low, close, 500);
  });
}

/** Resample-free 1h companion for a 15m series (every 4th bar aggregated). */
export function toHourly(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const bucket = candles.slice(i, i + 4);
    out.push(
      candle(
        (bucket[0] as Candle).ts,
        (bucket[0] as Candle).open,
        Math.max(...bucket.map((c) => c.high)),
        Math.min(...bucket.map((c) => c.low)),
        (bucket[bucket.length - 1] as Candle).close,
        bucket.reduce((a, c) => a + c.volume, 0),
      ),
    );
  }
  return out;
}

export function approx(actual: number, expected: number, tol = 1e-9, msg = ""): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} expected ~${expected}, got ${actual} (tol ${tol})`);
  }
}

/** True when two numeric arrays agree on their common prefix, ignoring NaN warm-up. */
export function prefixEqual(a: number[], b: number[], tol = 1e-12): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    const xNaN = !Number.isFinite(x);
    const yNaN = !Number.isFinite(y);
    if (xNaN !== yNaN) return false;
    if (xNaN) continue;
    if (Math.abs(x - y) > tol) return false;
  }
  return true;
}
