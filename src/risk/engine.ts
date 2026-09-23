import type { BindingConstraint, RiskPlan, StrategySignal } from "../types.ts";
import { round } from "../util/math.ts";

export interface RiskConfig {
  /** Intended risk per trade, percent of current equity. */
  riskPerTradePct: number;
  /** Hard ceiling on risk per trade, percent of equity. */
  maxRiskPerTradePct: number;
  /** Setup A stop buffer above the structural swing high, percent. */
  setupAStopBufferPct: number;
  /** Setup B stop buffer below structural support, percent. */
  setupBStopBufferPct: number;
  /** Minimum accepted reward:risk on the TP1 target. */
  minRiskReward: number;
  /** Portfolio-wide cap on simultaneously open positions. */
  maxConcurrentPositions: number;
  /** Stop opening new positions once the day's loss reaches this % of day-start equity. */
  dailyLossCapPct: number;
  /** Cap on a single position's notional as a percent of equity. */
  maxPositionNotionalPct: number;
  /**
   * Minimum structural stop distance, percent of entry price.
   *
   * A stop tighter than this is not a tradeable stop: it sits inside normal bar noise, and
   * because size = riskBudget / stopDistance, a near-zero stop inflates the intended size
   * until the notional cap clamps it - which collapses the risk actually taken towards zero
   * while transaction costs stay proportional to notional. The result is a trade that can
   * only lose its own costs, and an R-multiple divided by an almost-zero denominator.
   * Rejecting it is a validity gate, not a performance tuning knob.
   */
  minStopDistancePct: number;
  /** TP1 / TP2 expressed as multiples of the stop distance (R). */
  tp1Multiple: number;
  tp2Multiple: number;
}

export const DEFAULT_RISK: RiskConfig = {
  riskPerTradePct: 0.5,
  maxRiskPerTradePct: 1.0,
  setupAStopBufferPct: 0.4,
  setupBStopBufferPct: 0.4,
  minRiskReward: 1.5,
  maxConcurrentPositions: 3,
  dailyLossCapPct: 2.0,
  maxPositionNotionalPct: 20,
  minStopDistancePct: 0.15,
  tp1Multiple: 1.5,
  tp2Multiple: 2.5,
};

export interface RiskInput {
  equity: number;
  dayStartEquity: number;
  openPositions: number;
  signal: StrategySignal;
  entryPrice: number;
}

function reject(reasons: string[], entry: number): RiskPlan {
  return {
    approved: false,
    reasons,
    entryPrice: entry,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    quantity: 0,
    notional: 0,
    riskAmount: 0,
    riskRewardRatio: 0,
    stopDistancePct: 0,
    intendedRiskPct: 0,
    intendedQuantity: 0,
    intendedNotional: 0,
    notionalCapApplied: false,
    actualRiskPct: 0,
    actualRiskAmount: 0,
    bindingConstraint: "risk-budget" as BindingConstraint,
  };
}

/**
 * Deterministic risk engine - the ONLY place size, stop, targets and approval are decided.
 *
 * Enforced here, in code, with no LLM participation:
 *   - intended risk 0.5% of equity, hard-capped at maxRiskPerTradePct (1%)
 *   - minimum 1.5 R:R on TP1
 *   - maximum `maxConcurrentPositions` (3) open positions
 *   - 2% daily loss cap measured against day-start equity
 *   - single-position notional cap
 *   - minimum structural stop distance (rejects degenerate stops)
 *
 * Every rejection reason is returned in `reasons` and surfaced in the report funnel, so a
 * trade that was turned down is visible rather than silently dropped.
 *
 * Setup A (SHORT): SL = structural swing high * (1 + buffer)  -> the stop sits above supply.
 * Setup B (LONG):  SL = structural support   * (1 - buffer)  -> the stop sits below demand.
 * TP1/TP2 = entry -/+ tpMultiple * stopDistance.
 *
 * SIZING TRANSPARENCY: `intendedQuantity` is what the risk budget alone implies. If the
 * notional cap is smaller, the position is reduced and `notionalCapApplied` is set, so the
 * report can state exactly which constraint bound and how much intended risk was forgone.
 * The cap never increases risk.
 */
export function evaluateRisk(input: RiskInput, cfg: RiskConfig = DEFAULT_RISK): RiskPlan {
  const { equity, dayStartEquity, openPositions, signal, entryPrice } = input;
  const reasons: string[] = [];

  if (signal.direction === "NO_TRADE") return reject(["no deterministic signal"], entryPrice);
  if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) return reject(["invalid entry price"], entryPrice);
  if (!(equity > 0)) return reject(["non-positive equity"], entryPrice);

  if (openPositions >= cfg.maxConcurrentPositions) reasons.push(`max concurrent positions reached (${cfg.maxConcurrentPositions})`);
  const dayLossPct = dayStartEquity > 0 ? ((dayStartEquity - equity) / dayStartEquity) * 100 : 0;
  if (dayLossPct >= cfg.dailyLossCapPct) reasons.push(`daily loss cap breached (${round(dayLossPct, 2)}% >= ${cfg.dailyLossCapPct}%)`);

  // --- Stop loss from structure -------------------------------------------------
  let stopLoss: number;
  if (signal.direction === "SHORT") {
    const ref = signal.swingHigh ?? signal.resistanceLevel;
    if (ref === null || !(ref > 0)) return reject(["setup A missing structural swing high for stop"], entryPrice);
    stopLoss = ref * (1 + cfg.setupAStopBufferPct / 100);
    if (stopLoss <= entryPrice) return reject(["stop not above entry for short"], entryPrice);
  } else {
    const ref = signal.supportLevel ?? signal.swingLow;
    if (ref === null || !(ref > 0)) return reject(["setup B missing structural support for stop"], entryPrice);
    stopLoss = ref * (1 - cfg.setupBStopBufferPct / 100);
    if (stopLoss >= entryPrice) return reject(["stop not below entry for long"], entryPrice);
  }
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!(stopDistance > 0)) return reject(["zero stop distance"], entryPrice);
  const stopDistancePct = (stopDistance / entryPrice) * 100;
  if (stopDistancePct < cfg.minStopDistancePct) {
    reasons.push(
      `stop distance ${round(stopDistancePct, 4)}% below the ${cfg.minStopDistancePct}% minimum - degenerate stop, size and R:R would be meaningless`,
    );
  }

  // --- Targets and R:R ----------------------------------------------------------
  const dir = signal.direction === "SHORT" ? -1 : 1;
  const takeProfit1 = entryPrice + dir * cfg.tp1Multiple * stopDistance;
  const takeProfit2 = entryPrice + dir * cfg.tp2Multiple * stopDistance;
  const riskRewardRatio = cfg.tp1Multiple;
  if (riskRewardRatio < cfg.minRiskReward) {
    reasons.push(`R:R ${round(riskRewardRatio, 2)} below minimum ${cfg.minRiskReward}`);
  }

  // --- Sizing: risk budget first, then the notional cap --------------------------
  const intendedRiskPct = Math.min(cfg.riskPerTradePct, cfg.maxRiskPerTradePct);
  const intendedRiskAmount = (equity * intendedRiskPct) / 100;
  const intendedQuantity = intendedRiskAmount / stopDistance;
  const intendedNotional = intendedQuantity * entryPrice;
  const maxNotional = (equity * cfg.maxPositionNotionalPct) / 100;

  let quantity = intendedQuantity;
  let notional = intendedNotional;
  let notionalCapApplied = false;
  if (intendedNotional > maxNotional) {
    notional = maxNotional;
    quantity = notional / entryPrice;
    notionalCapApplied = true;
  }
  const bindingConstraint: BindingConstraint = notionalCapApplied ? "notional-cap" : "risk-budget";
  const actualRiskAmount = quantity * stopDistance;
  const actualRiskPct = equity > 0 ? (actualRiskAmount / equity) * 100 : 0;

  if (!(quantity > 0) || !(notional > 0)) reasons.push("position size is zero");

  const approved = reasons.length === 0;
  if (!approved) {
    // Rejected: keep the diagnostics (stop, targets, distances, reasons) so the report can
    // explain the refusal, but carry no size at all. Nothing tradeable leaves this branch.
    return {
      approved: false,
      reasons,
      entryPrice,
      stopLoss: round(stopLoss, 8),
      takeProfit1: round(takeProfit1, 8),
      takeProfit2: round(takeProfit2, 8),
      quantity: 0,
      notional: 0,
      riskAmount: 0,
      riskRewardRatio: round(riskRewardRatio, 3),
      stopDistancePct: round(stopDistancePct, 4),
      intendedRiskPct: round(intendedRiskPct, 4),
      intendedQuantity: 0,
      intendedNotional: 0,
      notionalCapApplied: false,
      actualRiskPct: 0,
      actualRiskAmount: 0,
      bindingConstraint: "risk-budget" as BindingConstraint,
    };
  }
  return {
    approved,
    reasons,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    quantity: round(quantity, 8),
    notional: round(notional, 2),
    riskAmount: round(actualRiskAmount, 2),
    riskRewardRatio: round(riskRewardRatio, 3),
    stopDistancePct: round(stopDistancePct, 4),
    intendedRiskPct: round(intendedRiskPct, 4),
    intendedQuantity: round(intendedQuantity, 8),
    intendedNotional: round(intendedNotional, 2),
    notionalCapApplied,
    actualRiskPct: round(actualRiskPct, 4),
    actualRiskAmount: round(actualRiskAmount, 2),
    bindingConstraint,
  };
}
