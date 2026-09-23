import type { Candle } from "../types.ts";
import { normalizeCandles } from "./local.ts";

const DEFAULT_BASE = "https://api.bitget.com";

const GRANULARITY_MAP: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1h",
  "4h": "4h",
  "6h": "6h",
  "12h": "12h",
  "1d": "1d",
};

/** Map a CipherEdge granularity label onto the Bitget v2 spot `granularity` value. */
export function bitgetGranularity(granularity: string): string {
  const mapped = GRANULARITY_MAP[granularity.toLowerCase()];
  if (!mapped) throw new Error(`unsupported bitget granularity: ${granularity}`);
  return mapped;
}

export interface BitgetClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  pageSize?: number;
  userAgent?: string;
}

type RawRow = Array<string | number>;

function rowToCandle(row: RawRow): Candle | null {
  const ts = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  if (![ts, open, high, low, close].every((v) => Number.isFinite(v))) return null;
  const volume = Number(row[5]);
  const quoteVolume = Number(row[6]);
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

/**
 * PUBLIC Bitget spot market-data client (v2 REST, `/api/v2/spot/market/history-candles`).
 *
 * Deliberately read-only and keyless: CipherEdge is a research / paper-trading agent and
 * never calls an authenticated endpoint, never reads an API key, and never places an order.
 * It exists so a reviewer can refresh or extend the candle dataset with the same code path
 * that produced the committed dataset.
 */
export class BitgetCandleClient {
  readonly name = "bitget";
  requestCount = 0;
  errorCount = 0;
  private baseUrl: string;
  private timeoutMs: number;
  private retries: number;
  private pageSize: number;
  private userAgent: string;

  constructor(options: BitgetClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.BITGET_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.pageSize = options.pageSize ?? 200;
    this.userAgent = options.userAgent ?? "CipherEdge/0.1 (research; paper-trading only)";
  }

  private async fetchJson<T>(url: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        this.requestCount += 1;
        const res = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const body = (await res.json()) as { code?: string; msg?: string; data?: T };
        if (body && body.code !== undefined && body.code !== "00000") {
          throw new Error(`bitget error ${body.code}: ${body.msg ?? "unknown"}`);
        }
        return (body?.data ?? (body as unknown as T)) as T;
      } catch (err) {
        lastError = err;
        this.errorCount += 1;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("bitget request failed");
  }

  /** One page of history ending at (and including) `endTime`. */
  async fetchPage(symbol: string, granularity: string, endTime: number): Promise<Candle[]> {
    const url =
      `${this.baseUrl}/api/v2/spot/market/history-candles` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&granularity=${encodeURIComponent(bitgetGranularity(granularity))}` +
      `&endTime=${endTime}&limit=${this.pageSize}`;
    const data = await this.fetchJson<RawRow[]>(url);
    if (!Array.isArray(data)) return [];
    const rows: Candle[] = [];
    for (const row of data) {
      const candle = rowToCandle(row);
      if (candle) rows.push(candle);
    }
    return normalizeCandles(rows);
  }

  /** Page backwards through history until `from` is covered (or the exchange runs out). */
  async fetchRange(symbol: string, granularity: string, from: number, to: number, maxPages = 400): Promise<Candle[]> {
    const acc: Candle[] = [];
    let cursor = to;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.fetchPage(symbol, granularity, cursor);
      if (rows.length === 0) break;
      acc.push(...rows);
      const oldest = rows[0] as Candle;
      if (oldest.ts <= from) break;
      const next = oldest.ts - 1;
      if (next >= cursor) break; // no progress - stop rather than spin
      cursor = next;
    }
    return normalizeCandles(acc).filter((c) => c.ts >= from && c.ts <= to);
  }
}
