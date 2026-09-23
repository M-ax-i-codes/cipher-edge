const MINUTE = 60_000;

/** Granularity label -> milliseconds per bar. Supports Bitget-style labels. */
export function granularityMs(granularity: string): number {
  const g = granularity.toLowerCase();
  const map: Record<string, number> = {
    "1m": MINUTE, "5m": 5 * MINUTE, "15m": 15 * MINUTE, "30m": 30 * MINUTE,
    "1h": 60 * MINUTE, "4h": 240 * MINUTE, "1d": 1440 * MINUTE,
  };
  if (map[g]) return map[g];
  const m = /^(\d+)([mhd])$/.exec(g);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    return n * (unit === "m" ? MINUTE : unit === "h" ? 60 * MINUTE : 1440 * MINUTE);
  }
  throw new Error(`unknown granularity: ${granularity}`);
}

/** Floor a timestamp to its bar open time for a given granularity. */
export function barOpen(ts: number, granularity: string): number {
  const g = granularityMs(granularity);
  return Math.floor(ts / g) * g;
}

export function isoUtc(ts: number): string {
  return new Date(ts).toISOString();
}
