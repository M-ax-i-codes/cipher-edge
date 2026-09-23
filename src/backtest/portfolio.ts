import type { BindingConstraint, Candle, SetupType, TradeRecord } from "../types.ts";
import { applySlippage, feeOn, fundingForBar, slippageCost, DEFAULT_COSTS } from "./costs.ts";
import type { CostConfig } from "./costs.ts";

export interface ExecutionConfig {
  /** Percent of the position taken off at TP1 (0 disables scaling, 100 = all out at TP1). */
  tp1ExitPct: number;
  /** Move the stop to the entry price once TP1 has filled. */
  moveStopToBreakeven: boolean;
  /** Force-exit a position open longer than this (minutes). 0 disables the time stop. */
  timeStopMinutes: number;
  /** If a bar touches both the stop and a target, assume the STOP filled first. */
  pessimisticIntraBar: boolean;
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  tp1ExitPct: 50,
  moveStopToBreakeven: true,
  timeStopMinutes: 720,
  pessimisticIntraBar: true,
};

export type ExitReason = TradeRecord["exitReason"];

/** A live (open) position, mutated bar by bar. All prices already include adverse slippage. */
export interface OpenPosition {
  id: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  confidence: number;
  entryTs: number;
  intendedEntryPrice: number;
  entryPrice: number;
  /** Stop as planned at entry - never mutated, so the realised R:R stays auditable. */
  initialStopLoss: number;
  /** Managed stop; moved to breakeven after TP1 when configured. */
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  quantity: number;
  initialQuantity: number;
  riskAmount: number;
  intendedRiskPct: number;
  /** Risk actually at hazard, percent of equity at entry (after any notional cap). */
  actualRiskPct: number;
  notionalCapApplied: boolean;
  /** Which constraint set the final size - carried through so the report can group by it. */
  bindingConstraint: BindingConstraint;
  entryFee: number;
  exitFees: number;
  funding: number;
  slippage: number;
  realizedLegPnl: number;
  exitQty: number;
  exitNotional: number;
  tp1Filled: boolean;
  exitTs: number;
  exitReason: ExitReason;
}

export interface OpenPositionInput {
  id: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  confidence: number;
  entryTs: number;
  intendedEntryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  quantity: number;
  riskAmount: number;
  intendedRiskPct: number;
  actualRiskPct: number;
  notionalCapApplied: boolean;
  bindingConstraint: BindingConstraint;
  costs?: CostConfig;
}

/** Book the entry fill: adverse slippage + taker fee are charged immediately. */
export function openPosition(input: OpenPositionInput): OpenPosition {
  const costs = input.costs ?? DEFAULT_COSTS;
  const side: "buy" | "sell" = input.direction === "LONG" ? "buy" : "sell";
  const filled = applySlippage(input.intendedEntryPrice, side, costs);
  return {
    id: input.id,
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    setupType: input.setupType,
    confidence: input.confidence,
    entryTs: input.entryTs,
    intendedEntryPrice: input.intendedEntryPrice,
    entryPrice: filled,
    initialStopLoss: input.stopLoss,
    stopLoss: input.stopLoss,
    takeProfit1: input.takeProfit1,
    takeProfit2: input.takeProfit2,
    quantity: input.quantity,
    initialQuantity: input.quantity,
    riskAmount: input.riskAmount,
    intendedRiskPct: input.intendedRiskPct,
    actualRiskPct: input.actualRiskPct,
    notionalCapApplied: input.notionalCapApplied,
    bindingConstraint: input.bindingConstraint,
    entryFee: feeOn(filled, input.quantity, costs),
    exitFees: 0,
    funding: 0,
    slippage: slippageCost(input.intendedEntryPrice, filled, input.quantity),
    realizedLegPnl: 0,
    exitQty: 0,
    exitNotional: 0,
    tp1Filled: false,
    exitTs: input.entryTs,
    exitReason: "eod",
  };
}

const EPSILON = 1e-12;

/** "Value if we closed right now" - used to mark equity between entries and exits. */
export function unrealizedPnl(p: OpenPosition, markPrice: number, costs: CostConfig = DEFAULT_COSTS): number {
  const dir = p.direction === "LONG" ? 1 : -1;
  const openLeg = dir * (markPrice - p.entryPrice) * p.quantity - feeOn(markPrice, p.quantity, costs);
  return p.realizedLegPnl + openLeg - p.entryFee - p.funding;
}

function fill(p: OpenPosition, bar: Candle, intendedPrice: number, qty: number, reason: ExitReason, costs: CostConfig, events: string[]): void {
  if (qty <= EPSILON) return;
  const side: "buy" | "sell" = p.direction === "LONG" ? "sell" : "buy";
  const filled = applySlippage(intendedPrice, side, costs);
  const fee = feeOn(filled, qty, costs);
  const dir = p.direction === "LONG" ? 1 : -1;
  const pnl = dir * (filled - p.entryPrice) * qty - fee;
  p.realizedLegPnl += pnl;
  p.exitFees += fee;
  p.slippage += slippageCost(intendedPrice, filled, qty);
  p.exitQty += qty;
  p.exitNotional += filled * qty;
  p.quantity -= qty;
  if (p.quantity < EPSILON) p.quantity = 0;
  p.exitTs = bar.ts;
  p.exitReason = reason;
  events.push(`${reason} ${qty} @ ${filled.toFixed(6)} pnl=${pnl.toFixed(4)}`);
}

/** Finalize a fully-closed position into the canonical TradeRecord. */
function toTrade(p: OpenPosition): TradeRecord {
  const exitPrice = p.exitQty > 0 ? p.exitNotional / p.exitQty : p.entryPrice;
  const realizedPnl = p.realizedLegPnl - p.entryFee - p.funding;
  return {
    id: p.id,
    symbol: p.symbol,
    timeframe: p.timeframe,
    direction: p.direction,
    setupType: p.setupType,
    confidence: p.confidence,
    entryTs: p.entryTs,
    exitTs: p.exitTs,
    entryPrice: p.entryPrice,
    exitPrice,
    initialStopLoss: p.initialStopLoss,
    stopLoss: p.stopLoss,
    takeProfit1: p.takeProfit1,
    takeProfit2: p.takeProfit2,
    quantity: p.initialQuantity,
    notional: p.initialQuantity * p.entryPrice,
    riskAmount: p.riskAmount,
    intendedRiskPct: p.intendedRiskPct,
    actualRiskPct: p.actualRiskPct,
    notionalCapApplied: p.notionalCapApplied,
    bindingConstraint: p.bindingConstraint,
    fees: p.entryFee + p.exitFees,
    slippage: p.slippage,
    funding: p.funding,
    realizedPnl,
    rMultiple: p.riskAmount > 0 ? realizedPnl / p.riskAmount : 0,
    holdingMinutes: (p.exitTs - p.entryTs) / 60_000,
    exitReason: p.exitReason,
  };
}

export interface StepResult {
  closed: boolean;
  trade: TradeRecord | null;
  events: string[];
}

/**
 * Walk one position through one bar. Ordering is deliberately conservative: funding is
 * accrued first, then (with `pessimisticIntraBar`) a stop that is touched in the same bar
 * as a target is assumed to have filled FIRST.
 */
export function stepPosition(
  p: OpenPosition,
  bar: Candle,
  barMinutes: number,
  exec: ExecutionConfig = DEFAULT_EXECUTION,
  costs: CostConfig = DEFAULT_COSTS,
): StepResult {
  const events: string[] = [];
  const accrued = fundingForBar(p.quantity * bar.close, barMinutes, costs);
  if (accrued > 0) {
    p.funding += accrued;
    events.push(`funding ${accrued.toFixed(4)}`);
  }

  const long = p.direction === "LONG";
  const stopHit = long ? bar.low <= p.stopLoss : bar.high >= p.stopLoss;
  const tp1Hit = !p.tp1Filled && (long ? bar.high >= p.takeProfit1 : bar.low <= p.takeProfit1);
  const tp2Hit = long ? bar.high >= p.takeProfit2 : bar.low <= p.takeProfit2;
  const timeUp = exec.timeStopMinutes > 0 && bar.ts - p.entryTs >= exec.timeStopMinutes * 60_000;

  if (stopHit && (exec.pessimisticIntraBar || !(tp1Hit || tp2Hit))) {
    fill(p, bar, p.stopLoss, p.quantity, "stop", costs, events);
    return { closed: true, trade: toTrade(p), events };
  }

  if (tp1Hit) {
    const qty = p.quantity * (exec.tp1ExitPct / 100);
    fill(p, bar, p.takeProfit1, qty, "tp1", costs, events);
    p.tp1Filled = true;
    if (exec.moveStopToBreakeven) {
      p.stopLoss = p.entryPrice;
      events.push("stop moved to breakeven");
    }
  }

  if (tp2Hit && p.quantity > EPSILON) {
    fill(p, bar, p.takeProfit2, p.quantity, "tp2", costs, events);
    return { closed: true, trade: toTrade(p), events };
  }

  if (p.quantity <= EPSILON) return { closed: true, trade: toTrade(p), events };

  if (timeUp) {
    fill(p, bar, bar.close, p.quantity, "time", costs, events);
    return { closed: true, trade: toTrade(p), events };
  }

  return { closed: false, trade: null, events };
}

/** Close whatever is left at a bar's close price (end of data / shutdown). */
export function forceClose(
  p: OpenPosition,
  bar: Candle,
  reason: ExitReason = "eod",
  costs: CostConfig = DEFAULT_COSTS,
): TradeRecord {
  const events: string[] = [];
  if (p.quantity > EPSILON) fill(p, bar, bar.close, p.quantity, reason, costs, events);
  return toTrade(p);
}
