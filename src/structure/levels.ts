import type { Candle } from "../types.ts";
import { confirmedSwingHighs, confirmedSwingLows } from "./swings.ts";

export interface Level {
  price: number;
  touches: number;
  kind: "support" | "resistance";
}

/** Cluster a set of prices into levels: values within tolerancePct merge, center = mean. */
export function clusterLevels(values: number[], tolerancePct: number): Array<{ price: number; touches: number }> {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const clusters: Array<{ sum: number; n: number }> = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(v - last.sum / last.n) / (last.sum / last.n) <= tolerancePct / 100) {
      last.sum += v;
      last.n += 1;
    } else {
      clusters.push({ sum: v, n: 1 });
    }
  }
  return clusters.map((c) => ({ price: c.sum / c.n, touches: c.n }));
}

/**
 * Horizontal support/resistance from confirmed swing points, causal (only swings
 * confirmed by `upTo` are used). Resistances = clustered swing highs above price,
 * supports = clustered swing lows below price.
 */
export function findLevels(candles: Candle[], arm: number, tolerancePct: number, upTo: number, price: number): { supports: Level[]; resistances: Level[] } {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const sh = confirmedSwingHighs(highs, arm, arm, upTo).map((s) => s.value);
  const sl = confirmedSwingLows(lows, arm, arm, upTo).map((s) => s.value);
  const resistances = clusterLevels(sh.filter((v) => v > price), tolerancePct).map((c) => ({ ...c, kind: "resistance" as const }));
  const supports = clusterLevels(sl.filter((v) => v < price), tolerancePct).map((c) => ({ ...c, kind: "support" as const }));
  resistances.sort((a, b) => a.price - b.price);
  supports.sort((a, b) => b.price - a.price);
  return { supports, resistances };
}
