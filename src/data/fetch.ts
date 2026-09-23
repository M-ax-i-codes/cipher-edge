import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Candle } from "../types.ts";
import { isoUtc } from "../util/time.ts";
import { BitgetCandleClient } from "./bitget.ts";
import { integrityTableRow, verifySeries } from "./integrity.ts";
import type { IntegrityReport } from "./integrity.ts";
import { localCandlePath } from "./local.ts";

const DAY_MS = 86_400_000;

export interface FetchOptions {
  dataDir: string;
  symbols: string[];
  granularities: string[];
  /** Lookback in days. Use a little more than the backtest window so alignment never shortens it. */
  days: number;
  concurrency?: number;
  client?: BitgetCandleClient;
  onProgress?: (msg: string) => void;
}

export interface FetchResultEntry {
  symbol: string;
  granularity: string;
  path: string;
  bars: number;
  bytes: number;
  integrity: IntegrityReport;
  elapsedMs: number;
}

export interface FetchResult {
  generatedAt: string;
  fromIso: string;
  toIso: string;
  days: number;
  source: string;
  requests: number;
  errors: string[];
  entries: FetchResultEntry[];
}

/** Serialize candles to the canonical JSONL row shape used across the project. */
export function candlesToJsonl(candles: Candle[]): string {
  const lines = candles.map((c) => {
    const row: Record<string, number> = { ts: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
    if (typeof c.quoteVolume === "number" && Number.isFinite(c.quoteVolume)) row.qv = c.quoteVolume;
    return JSON.stringify(row);
  });
  return `${lines.join("\n")}\n`;
}

export function writeCandlesJsonl(path: string, candles: Candle[]): number {
  mkdirSync(dirname(path), { recursive: true });
  const text = candlesToJsonl(candles);
  writeFileSync(path, text, "utf8");
  return Buffer.byteLength(text, "utf8");
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runnerCount = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: runnerCount }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
}

/**
 * Download native Bitget spot candles for the whole universe and persist them as JSONL.
 *
 * Public, keyless, read-only: this is the only network path in CipherEdge. It never sends
 * credentials and never touches a trading endpoint.
 */
export async function fetchDataset(opts: FetchOptions): Promise<FetchResult> {
  const log = opts.onProgress ?? (() => undefined);
  const client = opts.client ?? new BitgetCandleClient();
  const to = Date.now();
  const from = to - opts.days * DAY_MS;
  const concurrency = opts.concurrency ?? 4;

  const tasks: Array<{ symbol: string; granularity: string }> = [];
  for (const symbol of opts.symbols) for (const granularity of opts.granularities) tasks.push({ symbol, granularity });

  const entries: FetchResultEntry[] = [];
  const errors: string[] = [];
  log(`fetching ${tasks.length} series (${opts.symbols.length} symbols x ${opts.granularities.join(",")}) for ${opts.days}d`);

  await pool(tasks, concurrency, async (task, index) => {
    const started = Date.now();
    try {
      const candles = await client.fetchRange(task.symbol, task.granularity, from, to);
      if (candles.length === 0) {
        errors.push(`${task.symbol} ${task.granularity}: no candles returned`);
        return;
      }
      const path = localCandlePath(opts.dataDir, task.symbol, task.granularity);
      const bytes = writeCandlesJsonl(path, candles);
      const integrity = verifySeries(candles, task.granularity);
      entries.push({
        symbol: task.symbol,
        granularity: task.granularity,
        path,
        bars: candles.length,
        bytes,
        integrity,
        elapsedMs: Date.now() - started,
      });
      log(`  [${index + 1}/${tasks.length}] ${task.symbol} ${task.granularity}: ${candles.length} bars, ${integrity.completenessPct}% complete, ${integrity.clean ? "CLEAN" : "REVIEW"}`);
    } catch (err) {
      errors.push(`${task.symbol} ${task.granularity}: ${err instanceof Error ? err.message : String(err)}`);
      log(`  [${index + 1}/${tasks.length}] ${task.symbol} ${task.granularity}: FAILED`);
    }
  });

  entries.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.granularity.localeCompare(b.granularity));
  return {
    generatedAt: new Date().toISOString(),
    fromIso: isoUtc(from),
    toIso: isoUtc(to),
    days: opts.days,
    source: "Bitget public spot REST v2 /api/v2/spot/market/history-candles (keyless, read-only)",
    requests: client.requestCount,
    errors,
    entries,
  };
}

/** Render data/INTEGRITY.md from a fetch result. */
export function buildIntegrityMarkdown(result: FetchResult, note: string[]): string {
  const lines: string[] = [];
  lines.push("# CipherEdge dataset integrity audit");
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Source: ${result.source}`);
  lines.push(`Requested window: ${result.fromIso} -> ${result.toIso} (${result.days} days)`);
  lines.push(`HTTP requests: ${result.requests}`);
  lines.push(`Series fetched: ${result.entries.length}`);
  lines.push(`Errors: ${result.errors.length}`);
  lines.push("");
  lines.push("Every figure below is **OBSERVED** from the fetched files. No value is estimated.");
  lines.push("");
  lines.push("| symbol | gran | bars | expected | completeness | missing | gaps | malformed OHLC | zero-vol bars | first (UTC) | last (UTC) | span | status |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const e of result.entries) lines.push(`| ${integrityTableRow(e.symbol, e.granularity, e.integrity)} |`);
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("## Errors");
    for (const err of result.errors) lines.push(`- ${err}`);
  }
  lines.push("");
  lines.push("## Notes");
  for (const n of note) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}
