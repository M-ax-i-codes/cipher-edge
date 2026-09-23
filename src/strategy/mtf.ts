import type { Candle, StrategySignal } from "../types.ts";
import { confirmedSwingHighs, confirmedSwingLows } from "../structure/swings.ts";
import type { SwingPoint } from "../structure/swings.ts";
import { granularityMs } from "../util/time.ts";

export interface HtfConfig {
  /** When false the trigger-timeframe structure is used as-is. */
  enabled: boolean;
  /** Fractal arm length for higher-timeframe swing confirmation. */
  arm: number;
  /** A higher-timeframe level must be within this % of price to count as the structure reference. */
  tolerancePct: number;
  /** Ignore higher-timeframe swings older than this many higher-timeframe bars. */
  maxAgeBars: number;
}

export const DEFAULT_HTF: HtfConfig = { enabled: true, arm: 5, tolerancePct: 0.6, maxAgeBars: 240 };

export interface HtfLevels {
  /** Nearest confirmed higher-timeframe swing high acting as supply / flipped resistance. */
  resistance: number | null;
  /** Nearest confirmed higher-timeframe swing low acting as demand / flipped support. */
  support: number | null;
}

export interface HtfIndex {
  /** Levels known at `ts`, strictly from higher-timeframe bars that had already CLOSED by `ts`. */
  at(ts: number, price: number): HtfLevels;
  readonly bars: number;
}

function nearest(swings: SwingPoint[], k: number, price: number, cfg: HtfConfig, side: "above" | "below"): number | null {
  const tol = cfg.tolerancePct / 100;
  const minIndex = k - cfg.maxAgeBars;
  let preferred: { value: number; dist: number } | null = null;
  let fallback: { value: number; dist: number } | null = null;
  for (let i = swings.length - 1; i >= 0; i -= 1) {
    const s = swings[i] as SwingPoint;
    if (s.index < minIndex) break;
    const dist = Math.abs(s.value - price) / price;
    if (dist > tol) continue;
    if (fallback === null || dist < fallback.dist) fallback = { value: s.value, dist };
    const onSide = side === "above" ? s.value >= price : s.value <= price;
    if (onSide && (preferred === null || dist < preferred.dist)) preferred = { value: s.value, dist };
  }
  const best = preferred ?? fallback;
  return best === null ? null : best.value;
}

/**
 * Higher-timeframe (1h) structure index - the "primary structure" leg of the strategy.
 *
 * Causality: `at(ts, price)` only ever consults higher-timeframe bars whose close time
 * (openTs + granularity) is <= ts, and only swings whose right-hand confirmation bars
 * have already occurred. No future bar can influence a past level.
 */
export function buildHtfIndex(htf: Candle[], htfGranularity: string, cfg: HtfConfig = DEFAULT_HTF): HtfIndex {
  const g = granularityMs(htfGranularity);
  const highs = htf.map((c) => c.high);
  const lows = htf.map((c) => c.low);
  const swingHighs = confirmedSwingHighs(highs, cfg.arm, cfg.arm, htf.length - 1);
  const swingLows = confirmedSwingLows(lows, cfg.arm, cfg.arm, htf.length - 1);

  const activeHighs: SwingPoint[] = [];
  const activeLows: SwingPoint[] = [];
  let highCursor = 0;
  let lowCursor = 0;
  let lastTs = Number.NEGATIVE_INFINITY;

  function reset(): void {
    activeHighs.length = 0;
    activeLows.length = 0;
    highCursor = 0;
    lowCursor = 0;
    lastTs = Number.NEGATIVE_INFINITY;
  }

  function at(ts: number, price: number): HtfLevels {
    if (htf.length === 0 || !(price > 0) || !Number.isFinite(price)) return { resistance: null, support: null };
    if (ts < lastTs) reset();
    lastTs = ts;

    // Binary search the last HTF bar that had fully closed by `ts`.
    let k = -1;
    let lo = 0;
    let hi = htf.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((htf[mid] as Candle).ts + g <= ts) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (k < 0) return { resistance: null, support: null };

    while (highCursor < swingHighs.length && (swingHighs[highCursor] as SwingPoint).confirmedAt <= k) {
      activeHighs.push(swingHighs[highCursor] as SwingPoint);
      highCursor += 1;
    }
    while (lowCursor < swingLows.length && (swingLows[lowCursor] as SwingPoint).confirmedAt <= k) {
      activeLows.push(swingLows[lowCursor] as SwingPoint);
      lowCursor += 1;
    }
    return {
      resistance: nearest(activeHighs, k, price, cfg, "above"),
      support: nearest(activeLows, k, price, cfg, "below"),
    };
  }

  return { at, bars: htf.length };
}

export interface HtfApplyResult {
  signals: StrategySignal[];
  /** Signals that had a deterministic setup but no higher-timeframe structure to anchor the stop. */
  vetoed: number;
  /** Signals that were re-anchored onto a higher-timeframe level. */
  anchored: number;
  checked: number;
}

function veto(signal: StrategySignal): StrategySignal {
  return {
    ...signal,
    direction: "NO_TRADE",
    setupType: "NONE",
    conditions: { ...signal.conditions, htfStructure: false },
    swingHigh: null,
    swingLow: null,
    supportLevel: null,
    resistanceLevel: null,
  };
}

/**
 * Re-anchor trigger-timeframe signals onto 1h structure ("1-hour primary structure,
 * 5m/15m trigger execution"). A setup with no 1h level within tolerance is vetoed to
 * NO_TRADE, because the stop would have no structural reference.
 */
export function applyHtfStructure(
  signals: StrategySignal[],
  trigger: Candle[],
  triggerGranularity: string,
  index: HtfIndex,
  cfg: HtfConfig = DEFAULT_HTF,
): HtfApplyResult {
  if (!cfg.enabled) return { signals, vetoed: 0, anchored: 0, checked: 0 };
  const g = granularityMs(triggerGranularity);
  let vetoed = 0;
  let anchored = 0;
  let checked = 0;

  const out = signals.map((signal, t) => {
    if (signal.direction === "NO_TRADE") return signal;
    const candle = trigger[t] as Candle | undefined;
    if (!candle) return signal;
    checked += 1;
    const levels = index.at(candle.ts + g, candle.close);

    if (signal.direction === "SHORT") {
      if (levels.resistance === null) { vetoed += 1; return veto(signal); }
      anchored += 1;
      return { ...signal, swingHigh: levels.resistance, resistanceLevel: levels.resistance };
    }
    if (levels.support === null) { vetoed += 1; return veto(signal); }
    anchored += 1;
    return { ...signal, swingLow: levels.support, supportLevel: levels.support };
  });

  return { signals: out, vetoed, anchored, checked };
}
