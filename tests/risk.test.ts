/**
 * Risk-control tests: the specification numbers must be enforced in code, not just written down.
 * Spec: 0.5% intended risk (1% ceiling), minimum 1.5 R:R, maximum 3 concurrent positions,
 * 2% daily loss cap, plus the degenerate-stop validity gate and the notional cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk, DEFAULT_RISK } from "../src/risk/engine.ts";
import type { RiskConfig } from "../src/risk/engine.ts";
import type { StrategySignal } from "../src/types.ts";

function longSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    ts: 1_700_000_000_000, symbol: "BTCUSDT", direction: "LONG", setupType: "BREAKOUT_RETEST",
    conditions: { breakoutRetest: true, momentumReset: true, trigger: true },
    swingHigh: null, swingLow: 9_900, supportLevel: 9_900, resistanceLevel: null,
    ...overrides,
  };
}

function shortSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    ts: 1_700_000_000_000, symbol: "BTCUSDT", direction: "SHORT", setupType: "BEARISH_DIVERGENCE",
    conditions: { structure: true, divergence: true, exhaustion: true, redDot: true, rejection: true },
    swingHigh: 10_100, swingLow: null, supportLevel: null, resistanceLevel: 10_100,
    ...overrides,
  };
}

function noTrade(): StrategySignal {
  return {
    ts: 1_700_000_000_000, symbol: "BTCUSDT", direction: "NO_TRADE", setupType: "NONE",
    conditions: {}, swingHigh: null, swingLow: null, supportLevel: null, resistanceLevel: null,
  };
}

const base = { equity: 10_000, dayStartEquity: 10_000, openPositions: 0 };

/** Long stop = level * (1 - buffer); short stop = level * (1 + buffer). Mirrors the engine. */
const buf = DEFAULT_RISK.setupBStopBufferPct / 100;
const longStopFor = (level: number): number => level * (1 - buf);
const shortStopFor = (level: number): number => level * (1 + DEFAULT_RISK.setupAStopBufferPct / 100);

// A permissive config so the sizing arithmetic can be checked without the cap binding.
const wide: RiskConfig = { ...DEFAULT_RISK, maxPositionNotionalPct: 100 };

test("intended risk is exactly 0.5% of equity and size = risk / stopDistance", () => {
  const level = 9_950;
  const entry = 10_000;
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: level }), entryPrice: entry }, wide);
  assert.equal(plan.approved, true, plan.reasons.join("; "));

  const stop = longStopFor(level);
  const stopDistance = entry - stop;
  const riskBudget = (base.equity * DEFAULT_RISK.riskPerTradePct) / 100;

  assert.equal(plan.intendedRiskPct, DEFAULT_RISK.riskPerTradePct);
  assert.equal(plan.stopLoss, stop, "the stop is the structural level less the buffer, not the level itself");
  assert.ok(Math.abs(plan.intendedQuantity - riskBudget / stopDistance) < 1e-6, "size must equal riskBudget / stopDistance");
  assert.ok(Math.abs(plan.quantity - plan.intendedQuantity) < 1e-6, "no cap should bind at a 100% notional cap");
  assert.ok(Math.abs(plan.riskAmount - riskBudget) < 0.01, `risk taken ${plan.riskAmount} should equal the ${riskBudget} budget`);
  assert.equal(plan.bindingConstraint, "risk-budget");
  assert.equal(plan.notionalCapApplied, false);
  assert.equal(plan.actualRiskPct, plan.intendedRiskPct, "with no cap binding, actual risk equals intended risk");
  assert.ok(Math.abs(plan.quantity * stopDistance - plan.riskAmount) < 0.01, "riskAmount must equal quantity x stopDistance");
});

test("risk is clamped to the 1% specification ceiling", () => {
  const reckless: RiskConfig = { ...wide, riskPerTradePct: 5, maxRiskPerTradePct: 1 };
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, reckless);
  assert.equal(plan.intendedRiskPct, 1, "must clamp to maxRiskPerTradePct");
  assert.ok(plan.intendedRiskPct <= 1.0, "specification ceiling is 1%");
});

test("minimum 1.5 R:R is enforced", () => {
  const weak: RiskConfig = { ...wide, tp1Multiple: 1.2 };
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, weak);
  assert.equal(plan.approved, false, "R:R below 1.5 must not be approved");
  assert.ok(plan.reasons.some((r) => r.includes("below minimum")), `expected an R:R rejection, got ${plan.reasons.join("; ")}`);
  const ok = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(ok.riskRewardRatio, 1.5);
  assert.equal(ok.approved, true, ok.reasons.join("; "));
});

test("targets are exact multiples of the stop distance in the correct direction", () => {
  const long = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(long.stopLoss, longStopFor(9_950));
  const dist = 10_000 - long.stopLoss;
  assert.ok(Math.abs(long.takeProfit1 - (10_000 + 1.5 * dist)) < 1e-9, "TP1 must be entry + 1.5R above for a long");
  assert.ok(Math.abs(long.takeProfit2 - (10_000 + 2.5 * dist)) < 1e-9, "TP2 must be entry + 2.5R above for a long");
  assert.ok(long.stopLoss < 10_000 && long.takeProfit1 > 10_000, "long stop below entry, targets above");

  const short = evaluateRisk({ ...base, signal: shortSignal(), entryPrice: 10_000 }, wide);
  assert.equal(short.stopLoss, shortStopFor(10_100));
  const sdist = short.stopLoss - 10_000;
  assert.ok(Math.abs(short.takeProfit1 - (10_000 - 1.5 * sdist)) < 1e-9, "TP1 must be entry - 1.5R below for a short");
  assert.ok(short.stopLoss > 10_000 && short.takeProfit1 < 10_000, "short stop above entry, targets below");
});

test("maximum 3 concurrent positions is enforced", () => {
  for (const open of [0, 1, 2]) {
    const plan = evaluateRisk({ ...base, openPositions: open, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
    assert.equal(plan.approved, true, `${open} open positions should still be allowed: ${plan.reasons.join("; ")}`);
  }
  const blocked = evaluateRisk({ ...base, openPositions: 3, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(blocked.approved, false);
  assert.ok(blocked.reasons.some((r) => r.includes("max concurrent positions")), blocked.reasons.join("; "));
  assert.equal(blocked.quantity, 0, "a rejected plan must not carry a size");
});

test("2% daily loss cap stops new entries", () => {
  const at1_9 = evaluateRisk({ equity: 9_810, dayStartEquity: 10_000, openPositions: 0, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(at1_9.approved, true, "1.9% down must still trade");
  const at2 = evaluateRisk({ equity: 9_800, dayStartEquity: 10_000, openPositions: 0, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(at2.approved, false, "exactly 2% down must stop new entries");
  assert.ok(at2.reasons.some((r) => r.includes("daily loss cap")), at2.reasons.join("; "));
  const at5 = evaluateRisk({ equity: 9_500, dayStartEquity: 10_000, openPositions: 0, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(at5.approved, false, "5% down must stop new entries");
});

test("notional cap can only REDUCE risk, and says so explicitly", () => {
  const level = 9_950;
  const entry = 10_000;
  const capped: RiskConfig = { ...DEFAULT_RISK, maxPositionNotionalPct: 20 };
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: level }), entryPrice: entry }, capped);
  const widePlan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: level }), entryPrice: entry }, wide);

  assert.equal(plan.notionalCapApplied, true);
  assert.equal(plan.bindingConstraint, "notional-cap");
  assert.equal(plan.notional, (base.equity * 20) / 100, "capped notional is exactly 20% of equity");
  assert.ok(plan.notional < widePlan.intendedNotional, "the cap must bind on this geometry");
  assert.equal(plan.intendedNotional, widePlan.intendedNotional, "the intended (uncapped) figure must still be reported");
  assert.equal(plan.intendedQuantity, widePlan.intendedQuantity);
  assert.equal(plan.intendedRiskPct, DEFAULT_RISK.riskPerTradePct);
  assert.ok(plan.quantity < plan.intendedQuantity, "the cap must shrink the size");
  assert.ok(plan.actualRiskPct < plan.intendedRiskPct, "the cap must reduce risk, never increase it");
  assert.ok(Math.abs(plan.actualRiskPct - (plan.quantity * (entry - plan.stopLoss) / base.equity) * 100) < 0.001, "actualRiskPct must equal the risk really at hazard");
  assert.equal(plan.approved, true, "a cap-shrunk trade is still a valid trade");
  assert.ok(plan.riskAmount > 0);
});

test("notional cap never increases risk when the risk budget is already smaller", () => {
  // Wide stop -> small intended notional, so the cap should not bind at all.
  const capped: RiskConfig = { ...DEFAULT_RISK, maxPositionNotionalPct: 20 };
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 9_000 }), entryPrice: 10_000 }, capped);
  assert.equal(plan.notionalCapApplied, false);
  assert.equal(plan.bindingConstraint, "risk-budget");
  assert.equal(plan.actualRiskPct, plan.intendedRiskPct);
  assert.ok(plan.notional < 2_000, `expected notional under the cap, got ${plan.notional}`);
});

test("degenerate stops are rejected rather than sized into a meaningless R:R", () => {
  // The stop buffer is applied to the STRUCTURAL LEVEL, so the degenerate case is a flipped
  // level sitting just above entry: 10040 * (1 - 0.4%) = 9999.84, i.e. 0.0016% below entry.
  // Size would explode, the notional cap would clamp it, actual risk would collapse towards
  // zero while costs stayed proportional to notional - a trade that can only lose its costs.
  const plan = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 10_040 }), entryPrice: 10_000 }, wide);
  assert.equal(plan.approved, false);
  assert.ok(plan.reasons.some((r) => r.includes("degenerate stop")), plan.reasons.join("; "));
  assert.ok(plan.stopDistancePct < DEFAULT_RISK.minStopDistancePct, `stop distance ${plan.stopDistancePct}% should be under the ${DEFAULT_RISK.minStopDistancePct}% floor`);
  assert.equal(plan.quantity, 0, "a rejected degenerate stop must carry no size");

  // Just outside the floor is still tradeable - the gate is a floor, not a blanket ban.
  // Want stopDistance = 2x the floor BELOW entry, so invert stop = level * (1 - buffer).
  const wantDistancePct = DEFAULT_RISK.minStopDistancePct * 2;
  const okLevel = (10_000 * (1 - wantDistancePct / 100)) / (1 - DEFAULT_RISK.setupBStopBufferPct / 100);
  const ok = evaluateRisk({ ...base, signal: longSignal({ supportLevel: okLevel }), entryPrice: 10_000 }, wide);
  assert.equal(ok.approved, true, `a ${ok.stopDistancePct}% stop should pass: ${ok.reasons.join("; ")}`);
  assert.ok(ok.stopDistancePct >= DEFAULT_RISK.minStopDistancePct);
});

test("stop must sit on the correct side of entry", () => {
  const badLong = evaluateRisk({ ...base, signal: longSignal({ supportLevel: 10_500 }), entryPrice: 10_000 }, wide);
  assert.equal(badLong.approved, false, "a long stop above entry is invalid");
  assert.ok(badLong.reasons.some((r) => r.includes("stop not below entry")), badLong.reasons.join("; "));
  const badShort = evaluateRisk({ ...base, signal: shortSignal({ swingHigh: 9_000 }), entryPrice: 10_000 }, wide);
  assert.equal(badShort.approved, false, "a short stop below entry is invalid");
  assert.ok(badShort.reasons.some((r) => r.includes("stop not above entry")), badShort.reasons.join("; "));
});

test("missing structure, NO_TRADE and bad prices are all rejected with a reason", () => {
  const noStructure = evaluateRisk({ ...base, signal: longSignal({ supportLevel: null, swingLow: null }), entryPrice: 10_000 }, wide);
  assert.equal(noStructure.approved, false);
  assert.ok(noStructure.reasons.some((r) => r.includes("missing structural support")), noStructure.reasons.join("; "));

  const nt = evaluateRisk({ ...base, signal: noTrade(), entryPrice: 10_000 }, wide);
  assert.equal(nt.approved, false);
  assert.ok(nt.reasons.some((r) => r.includes("no deterministic signal")), nt.reasons.join("; "));

  const zeroEquity = evaluateRisk({ equity: 0, dayStartEquity: 0, openPositions: 0, signal: longSignal(), entryPrice: 10_000 }, wide);
  assert.equal(zeroEquity.approved, false);
  const badEntry = evaluateRisk({ ...base, signal: longSignal(), entryPrice: 0 }, wide);
  assert.equal(badEntry.approved, false);
});

test("multiple breaches accumulate instead of short-circuiting (full audit trail)", () => {
  const plan = evaluateRisk({ equity: 9_700, dayStartEquity: 10_000, openPositions: 3, signal: longSignal({ supportLevel: 9_999.9 }), entryPrice: 10_000 }, DEFAULT_RISK);
  assert.equal(plan.approved, false);
  assert.ok(plan.reasons.length >= 2, `expected several reasons, got ${plan.reasons.join("; ")}`);
});

test("rejections carry a zeroed plan so nothing can be traded by accident", () => {
  const plan = evaluateRisk({ ...base, openPositions: 3, signal: longSignal({ supportLevel: 9_950 }), entryPrice: 10_000 }, wide);
  assert.equal(plan.approved, false);
  assert.equal(plan.quantity, 0);
  assert.equal(plan.notional, 0);
  assert.equal(plan.riskAmount, 0);
  assert.equal(plan.actualRiskAmount, 0);
});
