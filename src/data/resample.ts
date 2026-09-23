import type { Candle } from "../types.ts";
import { barOpen, granularityMs } from "../util/time.ts";

export interface ResampleOptions {
  /** Drop the final (possibly partial) bucket. Default true - avoids partial-bar bias. */
  dropIncomplete?: boolean;
}

/**
 * Resample a lower-granularity series upward (e.g. 1m -> 15m / 1h).
 *
 * Buckets are aligned to UTC bar-open boundaries. The last bucket is dropped by
 * default because it may be incomplete, which would otherwise inject a systematic
 * partial-bar bias into indicators and fills.
 */
export function resample(candles: Candle[], target: string, opts: ResampleOptions = {}): Candle[] {
  const dropIncomplete = opts.dropIncomplete ?? true;
  granularityMs(target); // validates the label early
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const key = barOpen(c.ts, target);
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        ts: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        quoteVolume: c.quoteVolume,
      });
      continue;
    }
    current.high = Math.max(current.high, c.high);
    current.low = Math.min(current.low, c.low);
    current.close = c.close;
    current.volume += c.volume;
    if (typeof current.quoteVolume === "number" && typeof c.quoteVolume === "number") {
      current.quoteVolume += c.quoteVolume;
    }
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const out = keys.map((k) => buckets.get(k) as Candle);
  if (!dropIncomplete || out.length === 0) return out;
  return out.slice(0, -1);
}

/** Number of bars per day for a granularity (used to size warm-up and windows). */
export function barsPerDay(granularity: string): number {
  return Math.round(86_400_000 / granularityMs(granularity));
}
