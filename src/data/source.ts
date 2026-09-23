import { existsSync } from "node:fs";
import type { Candle } from "../types.ts";
import { isoUtc } from "../util/time.ts";
import { BitgetCandleClient } from "./bitget.ts";
import { loadCandlesJsonl, localCandlePath, sliceByTime } from "./local.ts";

export type DataSourceKind = "local-jsonl" | "bitget-rest";

/** Exactly where a series came from - printed in every report so results are auditable. */
export interface DataProvenance {
  symbol: string;
  granularity: string;
  source: DataSourceKind;
  path: string | null;
  bars: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface LoadCandlesOptions {
  dataDir: string;
  symbol: string;
  /** Granularity stored on disk / requested from the API (normally "1m"). */
  granularity: string;
  from?: number;
  to?: number;
  /** Only used when the local file is missing. Default false - backtests stay offline. */
  allowNetwork?: boolean;
  client?: BitgetCandleClient;
}

export interface LoadedSeries {
  candles: Candle[];
  provenance: DataProvenance;
}

function provenanceFor(symbol: string, granularity: string, source: DataSourceKind, path: string | null, candles: Candle[]): DataProvenance {
  const first = candles.length > 0 ? (candles[0] as Candle).ts : null;
  const last = candles.length > 0 ? (candles[candles.length - 1] as Candle).ts : null;
  return { symbol, granularity, source, path, bars: candles.length, firstTs: first, lastTs: last };
}

/**
 * Load a candle series: committed local JSONL first (offline, reproducible), and the
 * public Bitget REST API only if the file is missing AND allowNetwork is set.
 */
export async function loadCandles(opts: LoadCandlesOptions): Promise<LoadedSeries> {
  const path = localCandlePath(opts.dataDir, opts.symbol, opts.granularity);
  if (existsSync(path)) {
    const all = loadCandlesJsonl(path);
    const candles = sliceByTime(all, opts.from, opts.to);
    return { candles, provenance: provenanceFor(opts.symbol, opts.granularity, "local-jsonl", path, candles) };
  }
  if (!opts.allowNetwork) {
    throw new Error(`no local candle file for ${opts.symbol} (${path}) and network access is disabled`);
  }
  const client = opts.client ?? new BitgetCandleClient();
  const to = opts.to ?? Date.now();
  const from = opts.from ?? to - 30 * 86_400_000;
  const candles = await client.fetchRange(opts.symbol, opts.granularity, from, to);
  return { candles, provenance: provenanceFor(opts.symbol, opts.granularity, "bitget-rest", null, candles) };
}

/** Human-readable provenance block used in reports and README validation output. */
export function formatProvenance(list: DataProvenance[]): string {
  return list
    .map((p) => {
      const span =
        p.firstTs !== null && p.lastTs !== null ? `${isoUtc(p.firstTs)} -> ${isoUtc(p.lastTs)}` : "no data";
      return `${p.symbol} ${p.granularity} source=${p.source} bars=${p.bars} ${span}`;
    })
    .join("\n");
}
