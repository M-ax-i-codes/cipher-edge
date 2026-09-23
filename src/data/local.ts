import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../types.ts";

interface RawRow { ts?: number; o?: number; h?: number; l?: number; c?: number; v?: number; qv?: number }

/** Parse one JSONL row: {"ts","o","h","l","c","v","qv"}. Returns null for blank/invalid lines. */
export function parseCandleLine(line: string): Candle | null {
  const text = line.trim();
  if (text.length === 0) return null;
  let row: RawRow;
  try {
    row = JSON.parse(text) as RawRow;
  } catch {
    return null;
  }
  const ts = Number(row.ts);
  const open = Number(row.o);
  const high = Number(row.h);
  const low = Number(row.l);
  const close = Number(row.c);
  if (![ts, open, high, low, close].every((v) => Number.isFinite(v))) return null;
  const volume = Number(row.v);
  const quoteVolume = Number(row.qv);
  return {
    ts,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : undefined,
  };
}

/** De-duplicate by timestamp and sort ascending. Deterministic ordering is required for reproducibility. */
export function normalizeCandles(rows: Candle[]): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const row of rows) byTs.set(row.ts, row);
  return [...byTs.keys()].sort((a, b) => a - b).map((ts) => byTs.get(ts) as Candle);
}

export function loadCandlesJsonl(path: string): Candle[] {
  const text = readFileSync(path, "utf8");
  const rows: Candle[] = [];
  for (const line of text.split("\n")) {
    const candle = parseCandleLine(line);
    if (candle) rows.push(candle);
  }
  return normalizeCandles(rows);
}

/** Canonical on-disk layout: <dataDir>/<SYMBOL>.<granularity>.jsonl */
export function localCandlePath(dataDir: string, symbol: string, granularity: string): string {
  return join(dataDir, `${symbol}.${granularity}.jsonl`);
}

export function listLocalSymbols(dataDir: string, granularity: string): string[] {
  if (!existsSync(dataDir)) return [];
  const suffix = `.${granularity}.jsonl`;
  return readdirSync(dataDir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort();
}

/** Inclusive [from, to] window on bar OPEN time. */
export function sliceByTime(candles: Candle[], from?: number, to?: number): Candle[] {
  return candles.filter(
    (c) => (from === undefined || c.ts >= from) && (to === undefined || c.ts <= to),
  );
}
