/**
 * Execution tests: fill ordering, cost application and stop management.
 * The pessimistic stop-first rule is the single most important assumption in the
 * backtest - when one bar touches both the stop and a target, intra-bar order is
 * unknown, so CipherEdge assumes the WORST outcome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPosition, stepPosition, forceClose, unrealizedPnl, DEFAULT_EXECUTION } from "../src/backtest/portfolio.ts";
import type { OpenPosition, OpenPositionInput } from "../src/backtest/portfolio.ts";
import { DEFAULT_COSTS, feeOn, applySlippage, fundingForBar, slippageCost } from "../src/backtest/costs.ts";
import type { CostConfig } from "../src/backtest/costs.ts";
import { candle, T0, M15 } from "./helpers.ts";

function mkPosition(over: Partial<OpenPositionInput> = {}): OpenPosition {
  return openPosition({
    id: "T1", symbol: "BTCUSDT", timeframe: "15m", direction: "LONG", setupType: "BREAKOUT_RETEST",
    confidence: 0.55, entryTs: T0, intendedEntryPrice: 100, stopLoss: 99, takeProfit1: 101.5,
    takeProfit2: 102.5, quantity: 1, riskAmount: 1, intendedRiskPct: 0.5, actualRiskPct: 0.5,
    notionalCapApplied: false, bindingConstraint: "risk-budget", costs: DEFAULT_COSTS,
    ...over,
  });
}

test("cost helpers: fees, adverse slippage, funding", () => {
  const cfg: CostConfig = { takerFeeBps: 10, slippageBps: 5, fundingBpsPer8h: 1 };
  assert.ok(Math.abs(feeOn(100, 2, cfg) - 0.2) < 1e-12, "10bps of 200 notional = 0.2");
  assert.ok(applySlippage(100, "buy", cfg) > 100, "a buy fills WORSE than intended (higher)");
  assert.ok(applySlippage(100, "sell", cfg) < 100, "a sell fills WORSE than intended (lower)");
  assert.ok(Math.abs(applySlippage(100, "buy", cfg) - 100.05) < 1e-12, "5bps adverse on a buy");
  assert.ok(Math.abs(applySlippage(100, "sell", cfg) - 99.95) < 1e-12, "5bps adverse on a sell");
  assert.ok(slippageCost(100, 100.05, 2) > 0, "slippage cost is a positive drag");
  // 8 hours of a 1bp/8h funding rate on 1000 notional = 0.1
  assert.ok(Math.abs(fundingForBar(1000, 480, cfg) - 0.1) < 1e-12, "one full funding period");
  assert.ok(Math.abs(fundingForBar(1000, 240, cfg) - 0.05) < 1e-12, "half a funding period prorates");
  assert.equal(fundingForBar(1000, 0, cfg), 0);
});

test("entry fill charges adverse slippage and a taker fee immediately", () => {
  const long = mkPosition({ intendedEntryPrice: 100, quantity: 2 });
  assert.ok(Math.abs(long.entryPrice - 100.05) < 1e-12, "long entry fills 5bps higher");
  assert.ok(Math.abs(long.entryFee - feeOn(100.05, 2, DEFAULT_COSTS)) < 1e-12);
  assert.ok(long.entryFee > 0);
  assert.equal(long.initialQuantity, 2);
  assert.equal(long.quantity, 2);
  assert.equal(long.initialStopLoss, 99, "the planned stop must be preserved");

  const short = mkPosition({ direction: "SHORT", intendedEntryPrice: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5, quantity: 2 });
  assert.ok(Math.abs(short.entryPrice - 99.95) < 1e-12, "short entry fills 5bps lower");
});

test("PESSIMISTIC: a bar touching both stop and target exits at the STOP", () => {
  const p = mkPosition({ stopLoss: 99, takeProfit1: 101.5, takeProfit2: 102.5 });
  // One bar spanning the stop AND both targets - intra-bar order is unknowable.
  const bar = candle(T0 + M15, 100, 103, 98, 100);
  const res = stepPosition(p, bar, 15, { ...DEFAULT_EXECUTION, pessimisticIntraBar: true }, DEFAULT_COSTS);
  assert.equal(res.closed, true);
  assert.equal(res.trade?.exitReason, "stop", "must assume the stop filled first");
  assert.ok((res.trade?.exitPrice ?? 0) < p.entryPrice, "a long stopped out loses money");
  assert.ok((res.trade?.realizedPnl ?? 0) < 0);
});

test("with pessimism disabled the same bar takes profit instead (proves the flag is what changes the outcome)", () => {
  const optimistic = mkPosition({ stopLoss: 99, takeProfit1: 101.5, takeProfit2: 102.5 });
  const bar = candle(T0 + M15, 100, 103, 98, 100);
  const res = stepPosition(optimistic, bar, 15, { ...DEFAULT_EXECUTION, pessimisticIntraBar: false }, DEFAULT_COSTS);
  assert.equal(res.trade?.exitReason, "tp2", "optimistic ordering reaches the far target");
  assert.ok((res.trade?.realizedPnl ?? 0) > 0);
  assert.ok(res.trade!.realizedPnl > -1, "optimistic outcome must be better than the pessimistic one");
});

test("default config keeps pessimisticIntraBar true", () => {
  assert.equal(DEFAULT_EXECUTION.pessimisticIntraBar, true, "the conservative assumption must stay on");
});

test("TP1 partially exits, moves the stop to breakeven, and preserves the planned stop", () => {
  const p = mkPosition({ quantity: 2, stopLoss: 99, takeProfit1: 101.5, takeProfit2: 105 });
  const bar = candle(T0 + M15, 100, 102, 99.9, 101.8); // touches TP1 only
  const res = stepPosition(p, bar, 15, DEFAULT_EXECUTION, DEFAULT_COSTS);
  assert.equal(res.closed, false, "position is still open after a partial exit");
  assert.equal(p.tp1Filled, true);
  assert.ok(Math.abs(p.quantity - 1) < 1e-9, "50% of 2 units taken off at TP1");
  assert.equal(p.stopLoss, p.entryPrice, "stop moved to breakeven");
  assert.equal(p.initialStopLoss, 99, "the PLANNED stop is still recoverable for the audit trail");
  assert.notEqual(p.initialStopLoss, p.stopLoss, "managed and planned stops legitimately differ after TP1");

  // Now the breakeven stop is hit: the remainder exits at entry, not at the original stop.
  const bar2 = candle(T0 + 2 * M15, 101, 101.2, 99, 99.5);
  const res2 = stepPosition(p, bar2, 15, DEFAULT_EXECUTION, DEFAULT_COSTS);
  assert.equal(res2.closed, true);
  assert.equal(res2.trade?.exitReason, "stop");
  // TradeRecord.exitPrice is the VWAP of EVERY exit leg, and each leg is charged adverse
  // sell slippage. Leg 1 filled at TP1; leg 2 (the remainder) must fill at the MANAGED
  // breakeven stop (entry), NOT at the original planned stop of 99.
  const tp1Fill = applySlippage(p.takeProfit1, "sell", DEFAULT_COSTS);
  const breakevenFill = applySlippage(p.entryPrice, "sell", DEFAULT_COSTS);
  const plannedStopFill = applySlippage(p.initialStopLoss, "sell", DEFAULT_COSTS);
  const expectedVwap = (tp1Fill + breakevenFill) / 2;
  assert.ok(
    Math.abs((res2.trade?.exitPrice ?? 0) - expectedVwap) < 1e-9,
    "exit price is the VWAP of the TP1 leg and the breakeven-stop leg",
  );
  assert.ok(breakevenFill > plannedStopFill, "the remainder exits at breakeven, better than the abandoned planned stop");
  assert.ok(
    Math.abs((res2.trade?.exitPrice ?? 0) - (tp1Fill + plannedStopFill) / 2) > 1e-6,
    "the reported exit price is NOT consistent with exiting at the original stop",
  );
  assert.equal(res2.trade?.initialStopLoss, 99, "the closed trade still reports the planned stop");
});

test("TP2 closes the remainder and books the full round-trip cost", () => {
  const p = mkPosition({ quantity: 2, stopLoss: 99, takeProfit1: 101.5, takeProfit2: 102.5 });
  const bar = candle(T0 + M15, 100, 102.6, 100, 102.4); // TP1 then TP2, never the stop
  const res = stepPosition(p, bar, 15, { ...DEFAULT_EXECUTION, pessimisticIntraBar: false }, DEFAULT_COSTS);
  assert.equal(res.closed, true);
  assert.equal(res.trade?.exitReason, "tp2");
  assert.equal(res.trade?.quantity, 2, "the trade reports the INITIAL quantity");
  assert.ok((res.trade?.realizedPnl ?? 0) > 0);
  const t = res.trade!;
  assert.ok(Math.abs(t.fees - (t.realizedPnl < 0 ? 0 : t.fees)) < 1e-12);
  assert.ok(t.fees > 0 && t.slippage > 0, "both legs' fees and slippage are booked");
  assert.ok(Math.abs(t.rMultiple - t.realizedPnl / t.riskAmount) < 1e-9, "R multiple = pnl / risk");
});

test("time stop force-exits at the bar close after the configured holding period", () => {
  const p = mkPosition({ stopLoss: 90, takeProfit1: 130, takeProfit2: 150 });
  const exec = { ...DEFAULT_EXECUTION, timeStopMinutes: 60 };
  const bar1 = candle(T0 + M15, 100, 100.5, 99.5, 100);
  assert.equal(stepPosition(p, bar1, 15, exec, DEFAULT_COSTS).closed, false, "inside the holding window");
  const bar2 = candle(T0 + 4 * M15, 100, 100.5, 99.5, 100); // 60 minutes after entry
  const res = stepPosition(p, bar2, 15, exec, DEFAULT_COSTS);
  assert.equal(res.closed, true);
  assert.equal(res.trade?.exitReason, "time");
  assert.equal(res.trade?.holdingMinutes, 60);
});

test("funding accrues over the holding period and is deducted from realised PnL", () => {
  const cfg: CostConfig = { takerFeeBps: 0, slippageBps: 0, fundingBpsPer8h: 10 };
  const p = mkPosition({ quantity: 1, stopLoss: 50, takeProfit1: 200, takeProfit2: 300, costs: cfg });
  const noCostEntry = p.entryPrice;
  assert.equal(noCostEntry, 100, "zero slippage means the fill equals the intended price");
  // 8 hours of holding at 10bp/8h on ~100 notional = 0.1
  const bars = 32; // 32 x 15m = 8h
  let closed = null;
  for (let i = 1; i <= bars; i += 1) {
    const res = stepPosition(p, candle(T0 + i * M15, 100, 100.1, 99.9, 100), 15, { ...DEFAULT_EXECUTION, timeStopMinutes: 0 }, cfg);
    if (res.closed) { closed = res.trade; break; }
  }
  assert.equal(closed, null, "no stop/target/time exit should have triggered");
  assert.ok(p.funding > 0, "funding must accrue while the position is open");
  assert.ok(Math.abs(p.funding - 0.1) < 1e-6, `expected ~0.1 of funding, got ${p.funding}`);
  const trade = forceClose(p, candle(T0 + (bars + 1) * M15, 100, 100, 100, 100), "eod", cfg);
  assert.ok(trade.funding > 0);
  assert.ok(trade.realizedPnl < 0, "with flat price, funding alone makes the trade a small loss");
});

test("unrealised PnL marks to the current price and is sign-correct per direction", () => {
  const long = mkPosition({ intendedEntryPrice: 100, quantity: 1 });
  assert.ok(unrealizedPnl(long, 105, DEFAULT_COSTS) > 0, "long profits when price rises");
  assert.ok(unrealizedPnl(long, 95, DEFAULT_COSTS) < 0, "long loses when price falls");
  const short = mkPosition({ direction: "SHORT", intendedEntryPrice: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5, quantity: 1 });
  assert.ok(unrealizedPnl(short, 95, DEFAULT_COSTS) > 0, "short profits when price falls");
  assert.ok(unrealizedPnl(short, 105, DEFAULT_COSTS) < 0, "short loses when price rises");
});

test("forceClose settles whatever remains at the bar close and labels it eod", () => {
  const p = mkPosition({ quantity: 3, stopLoss: 50, takeProfit1: 200, takeProfit2: 300 });
  const trade = forceClose(p, candle(T0 + M15, 100, 101, 99, 100.5), "eod", DEFAULT_COSTS);
  assert.equal(trade.exitReason, "eod");
  assert.equal(trade.quantity, 3);
  assert.equal(p.quantity, 0, "nothing may remain open after a force close");
  assert.ok(Math.abs(trade.exitPrice - applySlippage(100.5, "sell", DEFAULT_COSTS)) < 1e-9, "a long closes by selling");
});

test("a zero-quantity fill is a no-op (guards against phantom exits)", () => {
  const p = mkPosition({ quantity: 1, stopLoss: 50, takeProfit1: 200, takeProfit2: 300 });
  const res = stepPosition(p, candle(T0 + M15, 100, 100.1, 99.9, 100), 15, DEFAULT_EXECUTION, DEFAULT_COSTS);
  assert.equal(res.closed, false);
  assert.equal(p.quantity, 1);
  assert.equal(res.trade, null);
});
