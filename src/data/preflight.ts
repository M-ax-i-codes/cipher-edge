/**
 * Pre-flight data-quality gate.
 *
 * The user requirement is explicit: verify each symbol's timestamps, bar counts, gaps,
 * partial candles and completeness BEFORE the backtest runs. This module is where that
 * happens, and it is the only thing that decides whether a run may describe itself as
 * validated.
 *
 * Why contiguity matters and is not cosmetic: WaveTrend is an EMA chain and the engine
 * fills at "the next bar's open". Both silently assume that bar i and bar i+1 are
 * adjacent in time. Across a US market-close or weekend gap in an rToken series that
 * assumption is false, so those series are gated out of the validated run and reported
 * separately as lower-completeness sensitivity results.
 */
import type { Candle } from "../types.ts";
import type { DataQualitySettings } from "../config.ts";
import { granularityMs, isoUtc } from "../util/time.ts";
import { verifySeries } from "./integrity.ts";
import type { IntegrityReport } from "./integrity.ts";
import { loadCandles } from "./source.ts";
import type { DataProvenance } from "./source.ts";
import { resample } from "./resample.ts";

export interface SeriesQuality {
  symbol: string;
  granularity: string;
  integrity: IntegrityReport;
  /** Largest gap between two adjacent bars, in bars (1 = perfectly contiguous). */
  maxAdjacentGapBars: number;
  /** Largest gap between two adjacent bars, in minutes. */
  maxAdjacentGapMinutes: number;
  /** True when the final bar had not closed at the time of this check. */
  lastBarPartial: boolean;
  passesCompleteness: boolean;
  passesContiguity: boolean;
  passes: boolean;
  reasons: string[];
  provenance: DataProvenance[];
}

export interface PreflightResult {
  checkedAt: string;
  gate: DataQualitySettings;
  series: SeriesQuality[];
  symbolsChecked: string[];
  symbolsPassed: string[];
  symbolsFailed: string[];
  allPassed: boolean;
  /** First and last timestamp common to every passing trigger series. */
  commonFromIso: string | null;
  commonToIso: string | null;
}

/** Largest adjacent-timestamp gap, measured in whole bars. Returns 1 for a contiguous series. */
export function maxAdjacentGap(candles: Candle[], granularity: string): { bars: number; minutes: number } {
  const g = granularityMs(granularity);
  let worst = g;
  for (let i = 1; i < candles.length; i += 1) {
    const delta = (candles[i] as Candle).ts - (candles[i - 1] as Candle).ts;
    if (delta > worst) worst = delta;
  }
  const bars = candles.length > 1 ? Math.round(worst / g) : 1;
  return { bars: Math.max(1, bars), minutes: (Math.max(1, bars) * g) / 60_000 };
}

/** A bar is partial when its close time is still in the future. */
export function lastBarIsPartial(candles: Candle[], granularity: string, now: number = Date.now()): boolean {
  if (candles.length === 0) return false;
  const last = candles[candles.length - 1] as Candle;
  return last.ts + granularityMs(granularity) > now;
}

export function assessSeries(
  symbol: string,
  granularity: string,
  candles: Candle[],
  gate: DataQualitySettings,
  provenance: DataProvenance[] = [],
  now: number = Date.now(),
): SeriesQuality {
  const integrity = verifySeries(candles, granularity);
  const gap = maxAdjacentGap(candles, granularity);
  const lastBarPartial = lastBarIsPartial(candles, granularity, now);
  const reasons: string[] = [];

  const passesCompleteness = integrity.completenessPct >= gate.requireCompletenessPct;
  if (!passesCompleteness) {
    reasons.push(`completeness ${integrity.completenessPct}% < required ${gate.requireCompletenessPct}% (${integrity.totalMissingBars} missing bars)`);
  }
  const passesContiguity = gap.bars <= gate.maxAdjacentGapBars;
  if (!passesContiguity) {
    reasons.push(`largest adjacent gap ${gap.bars} bars (${gap.minutes} min) > allowed ${gate.maxAdjacentGapBars} bars`);
  }
  if (integrity.malformedOhlc > 0) reasons.push(`${integrity.malformedOhlc} malformed OHLC bars`);
  if (integrity.nonPositivePrice > 0) reasons.push(`${integrity.nonPositivePrice} non-positive prices`);
  if (integrity.duplicates > 0) reasons.push(`${integrity.duplicates} duplicate timestamps`);
  if (integrity.unsorted > 0) reasons.push(`${integrity.unsorted} out-of-order timestamps`);
  if (lastBarPartial) reasons.push("final bar had not closed at check time (partial candle)");
  if (integrity.bars === 0) reasons.push("series is empty");

  return {
    symbol,
    granularity,
    integrity,
    maxAdjacentGapBars: gap.bars,
    maxAdjacentGapMinutes: gap.minutes,
    lastBarPartial,
    passesCompleteness,
    passesContiguity,
    passes: reasons.length === 0,
    reasons,
    provenance,
  };
}

export interface PreflightOptions {
  dataDir: string;
  symbols: string[];
  triggerGranularity: string;
  structureGranularity: string;
  /** Finer series used to synthesise a missing trigger series; reported as resampled, never as native. */
  resampleFrom?: string | null;
  gate: DataQualitySettings;
  allowNetwork?: boolean;
}

async function loadOne(
  opts: PreflightOptions,
  symbol: string,
  granularity: string,
): Promise<{ candles: Candle[]; provenance: DataProvenance[] }> {
  const provenance: DataProvenance[] = [];
  try {
    const loaded = await loadCandles({
      dataDir: opts.dataDir,
      symbol,
      granularity,
      allowNetwork: opts.allowNetwork ?? false,
    });
    provenance.push(loaded.provenance);
    return { candles: loaded.candles, provenance };
  } catch (err) {
    if (!opts.resampleFrom) throw err;
    const finer = await loadCandles({
      dataDir: opts.dataDir,
      symbol,
      granularity: opts.resampleFrom,
      allowNetwork: opts.allowNetwork ?? false,
    });
    provenance.push(finer.provenance);
    const up = resample(finer.candles, granularity);
    provenance.push({
      symbol,
      granularity,
      source: finer.provenance.source,
      path: finer.provenance.path,
      bars: up.length,
      firstTs: up.length > 0 ? (up[0] as Candle).ts : null,
      lastTs: up.length > 0 ? (up[up.length - 1] as Candle).ts : null,
    });
    return { candles: up, provenance };
  }
}

/**
 * Assess every requested symbol on both the trigger and the structure timeframe.
 * A symbol passes only when BOTH series pass.
 */
export async function preflightData(opts: PreflightOptions): Promise<PreflightResult> {
  const series: SeriesQuality[] = [];
  const passed = new Set(opts.symbols);

  for (const symbol of opts.symbols) {
    for (const granularity of [opts.triggerGranularity, opts.structureGranularity]) {
      let quality: SeriesQuality;
      try {
        const loaded = await loadOne(opts, symbol, granularity);
        quality = assessSeries(symbol, granularity, loaded.candles, opts.gate, loaded.provenance);
      } catch (err) {
        quality = assessSeries(symbol, granularity, [], opts.gate, []);
        quality.reasons.push(err instanceof Error ? err.message : String(err));
        quality.passes = false;
      }
      series.push(quality);
      if (!quality.passes) passed.delete(symbol);
    }
  }

  const symbolsPassed = opts.symbols.filter((s) => passed.has(s));
  const symbolsFailed = opts.symbols.filter((s) => !passed.has(s));

  let commonFromIso: string | null = null;
  let commonToIso: string | null = null;
  const trigPass = series.filter((q) => q.granularity === opts.triggerGranularity && q.passes);
  if (trigPass.length > 0) {
    const firsts = trigPass.map((q) => q.integrity.firstTs as number);
    const lasts = trigPass.map((q) => q.integrity.lastTs as number);
    commonFromIso = isoUtc(Math.max(...firsts));
    commonToIso = isoUtc(Math.min(...lasts));
  }

  return {
    checkedAt: new Date().toISOString(),
    gate: opts.gate,
    series,
    symbolsChecked: [...opts.symbols],
    symbolsPassed,
    symbolsFailed,
    allPassed: symbolsFailed.length === 0 && symbolsPassed.length > 0,
    commonFromIso,
    commonToIso,
  };
}

/** Strict mode: abort rather than quietly trade gappy data. */
export function assertPreflightOk(result: PreflightResult): void {
  if (result.allPassed) return;
  const lines = result.series
    .filter((q) => !q.passes)
    .map((q) => `  - ${q.symbol} ${q.granularity}: ${q.reasons.join("; ")}`);
  const msg = [
    `data-quality gate failed for ${result.symbolsFailed.length} of ${result.symbolsChecked.length} symbols:`,
    ...lines,
    result.gate.strict
      ? "dataQuality.strict is true, so the run is aborted. Use the extended universe for a labelled lower-completeness sensitivity run instead."
      : "dataQuality.strict is false, so these symbols will be skipped.",
  ].join("\n");
  if (result.gate.strict) throw new Error(msg);
}

/** Symbols that survive the gate - what a non-strict run should actually trade. */
export function usableSymbols(result: PreflightResult): string[] {
  return result.symbolsPassed;
}

/** Markdown table for the run report, so the data behind the numbers is in the same file. */
export function preflightMarkdown(result: PreflightResult): string {
  const header = [
    "| symbol | gran | bars | completeness | missing | max gap (bars) | max gap (min) | partial last bar | first (UTC) | last (UTC) | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = result.series.map((q) =>
    [
      q.symbol,
      q.granularity,
      String(q.integrity.bars),
      `${q.integrity.completenessPct}%`,
      String(q.integrity.totalMissingBars),
      String(q.maxAdjacentGapBars),
      String(q.maxAdjacentGapMinutes),
      q.lastBarPartial ? "YES" : "no",
      q.integrity.firstIso ?? "-",
      q.integrity.lastIso ?? "-",
      q.passes ? "PASS" : `FAIL: ${q.reasons.join("; ")}`,
    ].join(" | "),
  );
  return [...header, ...rows].join("\n");
}
