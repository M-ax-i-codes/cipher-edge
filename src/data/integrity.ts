import type { Candle } from "../types.ts";
import { granularityMs, isoUtc } from "../util/time.ts";

export interface GapInfo {
  afterTs: number;
  beforeTs: number;
  missingBars: number;
  missingMinutes: number;
}

export interface IntegrityReport {
  bars: number;
  expectedBars: number;
  completenessPct: number;
  duplicates: number;
  unsorted: number;
  gaps: GapInfo[];
  totalMissingBars: number;
  malformedOhlc: number;
  nonPositivePrice: number;
  negativeVolume: number;
  zeroVolumeBars: number;
  firstTs: number | null;
  lastTs: number | null;
  firstIso: string | null;
  lastIso: string | null;
  spanDays: number;
  /** True only when there are no gaps, no duplicates, sorted order and valid OHLC. */
  clean: boolean;
}

/**
 * Audit a candle series BEFORE it is used: coverage, ordering, duplicates, gaps,
 * malformed OHLC and non-positive prices. The backtest refuses dirty data silently -
 * every finding here is written into the run's provenance.
 */
export function verifySeries(candles: Candle[], granularity: string): IntegrityReport {
  const g = granularityMs(granularity);
  const n = candles.length;
  const first = n > 0 ? (candles[0] as Candle).ts : null;
  const last = n > 0 ? (candles[n - 1] as Candle).ts : null;
  const expectedBars = first !== null && last !== null ? Math.floor((last - first) / g) + 1 : 0;

  let duplicates = 0;
  let unsorted = 0;
  let malformedOhlc = 0;
  let nonPositivePrice = 0;
  let negativeVolume = 0;
  let zeroVolumeBars = 0;
  const gaps: GapInfo[] = [];
  let totalMissingBars = 0;

  for (let i = 0; i < n; i += 1) {
    const c = candles[i] as Candle;
    if (i > 0) {
      const prev = candles[i - 1] as Candle;
      if (c.ts === prev.ts) duplicates += 1;
      else if (c.ts < prev.ts) unsorted += 1;
      else if (c.ts - prev.ts > g) {
        const missing = Math.round((c.ts - prev.ts) / g) - 1;
        totalMissingBars += missing;
        if (gaps.length < 50) {
          gaps.push({ afterTs: prev.ts, beforeTs: c.ts, missingBars: missing, missingMinutes: (missing * g) / 60_000 });
        }
      }
    }
    const ordered = c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.high >= c.low;
    if (!ordered || ![c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v))) malformedOhlc += 1;
    if (![c.open, c.high, c.low, c.close].every((v) => v > 0)) nonPositivePrice += 1;
    if (c.volume < 0) negativeVolume += 1;
    if (c.volume === 0) zeroVolumeBars += 1;
  }

  const spanDays = first !== null && last !== null ? (last - first) / 86_400_000 : 0;
  const clean =
    n > 0 && duplicates === 0 && unsorted === 0 && totalMissingBars === 0 && malformedOhlc === 0 && nonPositivePrice === 0 && negativeVolume === 0;

  return {
    bars: n,
    expectedBars,
    completenessPct: expectedBars > 0 ? Math.round((n / expectedBars) * 10000) / 100 : 0,
    duplicates,
    unsorted,
    gaps,
    totalMissingBars,
    malformedOhlc,
    nonPositivePrice,
    negativeVolume,
    zeroVolumeBars,
    firstTs: first,
    lastTs: last,
    firstIso: first !== null ? isoUtc(first) : null,
    lastIso: last !== null ? isoUtc(last) : null,
    spanDays: Math.round(spanDays * 100) / 100,
    clean,
  };
}

/** One markdown row per (symbol, granularity) for data/INTEGRITY.md. */
export function integrityTableRow(symbol: string, granularity: string, r: IntegrityReport): string {
  return [
    symbol,
    granularity,
    String(r.bars),
    String(r.expectedBars),
    `${r.completenessPct}%`,
    String(r.totalMissingBars),
    String(r.gaps.length),
    String(r.malformedOhlc),
    String(r.zeroVolumeBars),
    r.firstIso ?? "-",
    r.lastIso ?? "-",
    `${r.spanDays}d`,
    r.clean ? "CLEAN" : "REVIEW",
  ].join(" | ");
}
