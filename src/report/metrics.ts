import type { EquityPoint, TradeRecord } from "../types.ts";
import { mean, percentile, round, stdev } from "../util/math.ts";

export interface SymbolSlice {
  symbol: string;
  trades: number;
  netPnl: number;
  winRatePct: number | null;
  avgR: number | null;
}

export interface GroupSlice {
  group: string;
  trades: number;
  netPnl: number;
  winRatePct: number | null;
  avgR: number | null;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnl: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgR: number | null;
  medianR: number | null;
  bestR: number | null;
  worstR: number | null;
  avgHoldingMinutes: number | null;
  medianHoldingMinutes: number | null;
  /** MODELLED costs (fee/slippage/funding assumptions), all deducted from netPnl. */
  fees: number;
  slippage: number;
  funding: number;
  totalModelledCosts: number;
  turnoverNotional: number;
  exitReasons: Record<string, number>;
  longs: number;
  shorts: number;
  setupA: number;
  setupB: number;
  notionalCapApplied: number;
  bindingConstraint: Record<string, number>;
  avgIntendedRiskPct: number | null;
  avgActualRiskPct: number | null;
  maxActualRiskPct: number | null;
  avgConfidence: number | null;
  bySymbol: SymbolSlice[];
  bySetup: GroupSlice[];
  byDirection: GroupSlice[];
}

function group(trades: TradeRecord[], key: (t: TradeRecord) => string): GroupSlice[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const k = key(t);
    const list = map.get(k) ?? [];
    list.push(t);
    map.set(k, list);
  }
  return [...map.entries()]
    .map(([name, list]) => {
      const net = list.reduce((a, t) => a + t.realizedPnl, 0);
      const wins = list.filter((t) => t.realizedPnl > 0).length;
      const rs = list.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
      const m = mean(rs);
      return {
        group: name,
        trades: list.length,
        netPnl: round(net, 2),
        winRatePct: list.length > 0 ? round((wins / list.length) * 100, 1) : null,
        avgR: m !== null ? round(m, 3) : null,
      };
    })
    .sort((a, b) => b.trades - a.trades || a.group.localeCompare(b.group));
}

/**
 * Trade-level statistics. Every cost figure here is MODELLED (Bitget taker fee,
 * adverse slippage, flat funding assumption) and is already deducted from netPnl.
 */
export function summarizeTrades(trades: TradeRecord[]): TradeStats {
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.realizedPnl, 0);
  const rs = trades.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
  const holds = trades.map((t) => t.holdingMinutes).filter((h) => Number.isFinite(h));
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  const binding: Record<string, number> = {};
  for (const t of trades) binding[t.bindingConstraint] = (binding[t.bindingConstraint] ?? 0) + 1;

  const mRs = mean(rs);
  const mHold = mean(holds);
  const mWin = mean(wins.map((t) => t.realizedPnl));
  const mLoss = mean(losses.map((t) => t.realizedPnl));
  const mIntendedRisk = mean(trades.map((t) => t.intendedRiskPct));
  const mActualRisk = mean(trades.map((t) => t.actualRiskPct));
  const maxActualRisk = trades.length > 0 ? Math.max(...trades.map((t) => t.actualRiskPct)) : null;

  const bySymbolRaw = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const list = bySymbolRaw.get(t.symbol) ?? [];
    list.push(t);
    bySymbolRaw.set(t.symbol, list);
  }
  const bySymbol: SymbolSlice[] = [...bySymbolRaw.entries()]
    .map(([symbol, list]) => {
      const net = list.reduce((a, t) => a + t.realizedPnl, 0);
      const w = list.filter((t) => t.realizedPnl > 0).length;
      const lrs = list.map((t) => t.rMultiple).filter((r) => Number.isFinite(r));
      const m = mean(lrs);
      return {
        symbol,
        trades: list.length,
        netPnl: round(net, 2),
        winRatePct: list.length > 0 ? round((w / list.length) * 100, 1) : null,
        avgR: m !== null ? round(m, 3) : null,
      };
    })
    .sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl));

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length > 0 ? round((wins.length / trades.length) * 100, 2) : null,
    netPnl: round(netPnl, 2),
    grossWin: round(grossWin, 2),
    grossLoss: round(grossLoss, 2),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : grossWin > 0 ? null : null,
    expectancy: trades.length > 0 ? round(netPnl / trades.length, 2) : null,
    avgWin: mWin !== null ? round(mWin, 2) : null,
    avgLoss: mLoss !== null ? round(mLoss, 2) : null,
    avgR: mRs !== null ? round(mRs, 3) : null,
    medianR: percentile(rs, 50) !== null ? round(percentile(rs, 50) as number, 3) : null,
    bestR: rs.length > 0 ? round(Math.max(...rs), 3) : null,
    worstR: rs.length > 0 ? round(Math.min(...rs), 3) : null,
    avgHoldingMinutes: mHold !== null ? round(mHold, 1) : null,
    medianHoldingMinutes: percentile(holds, 50) !== null ? round(percentile(holds, 50) as number, 1) : null,
    fees: round(trades.reduce((a, t) => a + t.fees, 0), 2),
    slippage: round(trades.reduce((a, t) => a + t.slippage, 0), 2),
    funding: round(trades.reduce((a, t) => a + t.funding, 0), 2),
    totalModelledCosts: round(trades.reduce((a, t) => a + t.fees + t.slippage + t.funding, 0), 2),
    turnoverNotional: round(trades.reduce((a, t) => a + t.notional + t.quantity * t.exitPrice, 0), 2),
    exitReasons,
    longs: trades.filter((t) => t.direction === "LONG").length,
    shorts: trades.filter((t) => t.direction === "SHORT").length,
    setupA: trades.filter((t) => t.setupType === "BEARISH_DIVERGENCE").length,
    setupB: trades.filter((t) => t.setupType === "BREAKOUT_RETEST").length,
    notionalCapApplied: trades.filter((t) => t.bindingConstraint === "notional-cap").length,
    bindingConstraint: binding,
    avgIntendedRiskPct: mIntendedRisk !== null ? round(mIntendedRisk, 4) : null,
    avgActualRiskPct: mActualRisk !== null ? round(mActualRisk, 4) : null,
    maxActualRiskPct: maxActualRisk !== null ? round(maxActualRisk, 4) : null,
    avgConfidence: mean(trades.map((t) => t.confidence)) !== null ? round(mean(trades.map((t) => t.confidence)) as number, 3) : null,
    bySymbol,
    bySetup: group(trades, (t) => `${t.setupType}`),
    byDirection: group(trades, (t) => t.direction),
  };
}

export interface ReturnStats {
  startingCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  sortino: number | null;
  volatilityPctAnnualized: number | null;
  periodsPerYear: number;
  bars: number;
  avgEquity: number | null;
  maxOpenPositions: number;
  /** Exposure stats are not computed by summarizeReturns; the report prints n/a when absent. */
  avgExposurePct?: number | null;
  maxExposurePct?: number | null;
}

/**
 * Return statistics from a mark-to-market equity curve.
 *
 * Annualisation uses a 365-day year because Bitget spot (and the rToken pairs in the
 * universe) trade 24/7. Sharpe/Sortino use rf = 0 - stated as an assumption, not a fact.
 */
export function summarizeReturns(equity: EquityPoint[], startingCapital: number, barMinutes: number): ReturnStats {
  const sorted = [...equity].sort((a, b) => a.ts - b.ts);
  const finalEquity = sorted.length > 0 ? (sorted[sorted.length - 1] as EquityPoint).equity : startingCapital;
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as EquityPoint;
    const cur = sorted[i] as EquityPoint;
    if (prev.equity > 0) returns.push(cur.equity / prev.equity - 1);
  }
  const periodsPerYear = barMinutes > 0 ? (365 * 24 * 60) / barMinutes : 0;
  const mu = mean(returns);
  const sd = stdev(returns);
  const sharpe = mu !== null && sd !== null && sd > 0 && periodsPerYear > 0 ? (mu / sd) * Math.sqrt(periodsPerYear) : null;
  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length > 1 ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / (downside.length - 1)) : null;
  const sortino = mu !== null && downsideDev !== null && downsideDev > 0 && periodsPerYear > 0 ? (mu / downsideDev) * Math.sqrt(periodsPerYear) : null;

  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  for (const p of sorted) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
  }

  const avgEquity = mean(sorted.map((p) => p.equity));
  return {
    startingCapital: round(startingCapital, 2),
    finalEquity: round(finalEquity, 2),
    totalReturnPct: round(((finalEquity - startingCapital) / startingCapital) * 100, 3),
    maxDrawdownPct: round(maxDd, 3),
    sharpe: sharpe !== null ? round(sharpe, 3) : null,
    sortino: sortino !== null ? round(sortino, 3) : null,
    volatilityPctAnnualized: sd !== null && periodsPerYear > 0 ? round(sd * Math.sqrt(periodsPerYear) * 100, 2) : null,
    periodsPerYear: round(periodsPerYear, 2),
    bars: sorted.length,
    avgEquity: avgEquity !== null ? round(avgEquity, 2) : null,
    maxOpenPositions: sorted.reduce((m, p) => Math.max(m, p.openPositions), 0),
  };
}
