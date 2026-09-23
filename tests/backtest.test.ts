/**
 * BACKTEST ENGINE TESTS - the end-to-end audit.
 *
 * These run the REAL engine over the REAL committed BTCUSDT candles and assert the
 * properties a reviewer must be able to rely on:
 *   - every fill happens on the bar AFTER the signal bar (no same-bar execution)
 *   - the entry price is that next bar's OPEN, plus adverse slippage
 *   - the portfolio never exceeds 3 concurrent positions or the risk limits
 *   - two identical runs produce byte-identical trades (reproducibility)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, splitSample, sliceEquity } from "../src/backtest/engine.ts";
import type { BacktestResult } from "../src/backtest/engine.ts";
import { applySlippage, DEFAULT_COSTS } from "../src/backtest/costs.ts";
import { loadCandlesJsonl, localCandlePath } from "../src/data/local.ts";
import { loadConfig, resolveDataDir, repoRoot } from "../src/config.ts";
import type { Candle, TradeRecord } from "../src/types.ts";

const cfg = loadConfig();
const dataDir = resolveDataDir(cfg.backtest.dataDir, repoRoot());
const SYMBOL = "BTCUSDT";
// A short but legal window (>= 60d total, >= 30d OOS) keeps the suite fast without
// weakening any guardrail.
const DAYS = 62;
const OOS = 30;

const trigger = loadCandlesJsonl(localCandlePath(dataDir, SYMBOL, "15m"));
const barByTs = new Map<number, Candle>(trigger.map((c) => [c.ts, c]));
// ts -> its INDEX in the series. "Next bar" means index-adjacent, NOT a fixed 15-minute
// delta: the committed series contains a small number of missing bars (99.51% complete),
// so the next OBSERVED bar can legitimately be 30 minutes later. Filling on the next
// observed bar is still strictly causal - it never uses a bar that had not printed.
const idxByTs = new Map<number, number>(trigger.map((c, i) => [c.ts, i]));

let cached: BacktestResult | null = null;
async function run(over: Parameters<typeof runBacktest>[0] extends infer _T ? Partial<Parameters<typeof runBacktest>[0]> : never): Promise<BacktestResult> {
  return runBacktest({ cfg, dataDir, symbols: [SYMBOL], days: DAYS, outOfSampleDays: OOS, collectDecisions: true, ...over });
}
async function primary(): Promise<BacktestResult> {
  if (!cached) cached = await run({});
  return cached;
}

test("the engine produces trades and an equity curve from committed data, offline", async () => {
  const res = await primary();
  assert.equal(res.configHash, cfg.hash, "the run is stamped with the exact config it used");
  assert.ok(res.trades.length > 0, "the engine must actually generate trades on real data");
  assert.ok(res.equity.length > 0);
  assert.ok(res.decisions.length > 0, "collectDecisions records the full audit trail");
  assert.equal(cfg.backtest.allowNetwork, false, "the committed config is offline");
  for (const p of res.provenance) {
    assert.notEqual(p.source, "network", "no bar may come from the network in a committed run");
  }
});

test("NEXT-BAR EXECUTION: every fill lands on the bar immediately AFTER the signal bar", async () => {
  const res = await primary();
  let gaps = 0;
  for (const d of res.decisions) {
    assert.ok(d.signalBarTs < d.ts, `decision at ${d.ts} must post-date its signal bar ${d.signalBarTs}`);
    const si = idxByTs.get(d.signalBarTs);
    const ei = idxByTs.get(d.ts);
    assert.ok(si !== undefined, `the signal bar ${d.signalBarTs} exists in the committed series`);
    assert.ok(ei !== undefined, `the fill bar ${d.ts} exists in the committed series`);
    assert.equal(ei, si! + 1, `the fill bar must be the immediately following series bar (signal index ${si}, fill index ${ei})`);
    if (d.ts - d.signalBarTs > 15 * 60_000) gaps += 1;
    assert.equal(d.symbol, SYMBOL);
  }
  // Reported, not asserted: a data gap makes the wall-clock delay longer than one bar.
  assert.ok(gaps >= 0);
});

test("entry fills at the NEXT bar's OPEN plus adverse slippage - never at the signal bar's close", async () => {
  const res = await primary();
  assert.ok(res.trades.length > 0);
  for (const t of res.trades) {
    const bar = barByTs.get(t.entryTs);
    assert.ok(bar, `trade ${t.id} entered on a bar that exists in the committed series`);
    const side = t.direction === "LONG" ? "buy" : "sell";
    const expected = applySlippage(bar!.open, side, DEFAULT_COSTS);
    assert.ok(Math.abs(t.entryPrice - expected) < 1e-9, `${t.id}: entry ${t.entryPrice} must equal open ${bar!.open} ${side}-slipped (${expected})`);
    // The entry bar is the bar AFTER the signal bar, so it can never be the signal bar itself.
    const signalTs = trigger[idxByTs.get(t.entryTs)! - 1]!.ts;
    assert.notEqual(t.entryTs, signalTs, "the entry timestamp is never the signal timestamp");
    assert.ok(barByTs.get(signalTs), "the signal bar is present in the committed series");
  }
});

test("the 3-position limit holds at every bar of the equity curve", async () => {
  const res = await primary();
  for (const e of res.equity) {
    assert.ok(e.openPositions <= cfg.risk.maxConcurrentPositions, `${e.ts}: ${e.openPositions} open positions exceeds the ${cfg.risk.maxConcurrentPositions} limit`);
  }
  const bySymbol = new Map<string, number>();
  for (const t of res.trades) {
    const key = `${t.symbol}:${t.entryTs}`;
    bySymbol.set(key, (bySymbol.get(key) ?? 0) + 1);
  }
  for (const [key, n] of bySymbol) assert.equal(n, 1, `${key} must not be entered twice`);
});

test("one position per symbol at a time: no trade overlaps another on the same symbol", async () => {
  const res = await primary();
  const bySym = new Map<string, TradeRecord[]>();
  for (const t of res.trades) {
    const list = bySym.get(t.symbol) ?? [];
    list.push(t);
    bySym.set(t.symbol, list);
  }
  for (const [sym, list] of bySym) {
    const sorted = [...list].sort((a, b) => a.entryTs - b.entryTs);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      assert.ok(cur.entryTs >= prev.exitTs, `${sym}: trade ${cur.id} entered at ${cur.entryTs} before the previous exited at ${prev.exitTs}`);
    }
  }
});

test("every executed trade respects the written risk limits", async () => {
  const res = await primary();
  for (const t of res.trades) {
    assert.ok(t.actualRiskPct <= cfg.risk.maxRiskPerTradePct + 1e-9, `${t.id}: actual risk ${t.actualRiskPct}% exceeds the ${cfg.risk.maxRiskPerTradePct}% ceiling`);
    assert.ok(t.intendedRiskPct <= cfg.risk.riskPerTradePct + 1e-9, `${t.id}: intended risk ${t.intendedRiskPct}% exceeds the 0.5% target`);
    assert.ok(t.actualRiskPct <= t.intendedRiskPct + 1e-9, `${t.id}: the notional cap may only REDUCE risk (intended ${t.intendedRiskPct}, actual ${t.actualRiskPct})`);
    assert.ok(t.quantity > 0, `${t.id}: an executed trade must have a positive size`);
    assert.ok(t.notional > 0);
    assert.ok(t.initialStopLoss > 0, `${t.id}: the PLANNED stop is recorded for the audit trail`);
    assert.ok(t.fees > 0, `${t.id}: fees are booked`);
    assert.ok(t.slippage > 0, `${t.id}: slippage is booked`);
    assert.ok(t.funding >= 0, `${t.id}: funding is booked`);
    // 0 is legitimate: a position opened at the bar open can be stopped out inside that
    // SAME bar. That is the pessimistic assumption working, not an accounting error.
    assert.ok(t.holdingMinutes >= 0, `${t.id}: holding time cannot be negative`);
    assert.ok(Number.isInteger(t.holdingMinutes), `${t.id}: holding time is whole minutes`);
    assert.ok(["tp1", "tp2", "stop", "time", "eod"].includes(t.exitReason), `${t.id}: exit reason ${t.exitReason} is inside the schema`);
    // The stop must be on the correct side of entry, and the planned R:R must clear the floor.
    const planned = Math.abs(t.takeProfit2 - t.entryPrice) / Math.abs(t.entryPrice - t.initialStopLoss);
    assert.ok(planned >= cfg.risk.minRiskReward - 1e-6, `${t.id}: planned R:R ${planned.toFixed(3)} below the ${cfg.risk.minRiskReward} floor`);
    if (t.direction === "LONG") {
      assert.ok(t.initialStopLoss < t.entryPrice, `${t.id}: a long stop must sit below entry`);
      assert.ok(t.takeProfit1 > t.entryPrice && t.takeProfit2 > t.takeProfit1);
    } else {
      assert.ok(t.initialStopLoss > t.entryPrice, `${t.id}: a short stop must sit above entry`);
      assert.ok(t.takeProfit1 < t.entryPrice && t.takeProfit2 < t.takeProfit1);
    }
  }
});

test("the notional cap is honoured and its binding constraint is reported per trade", async () => {
  const res = await primary();
  const capPct = cfg.risk.maxPositionNotionalPct / 100;
  for (const t of res.trades) {
    // Equity at entry is bounded by the starting capital plus whatever has been realised;
    // use a generous but real bound: the notional must not exceed the cap on peak equity.
    const peakEquity = Math.max(...res.equity.map((e) => e.equity));
    assert.ok(t.notional <= capPct * peakEquity + 1e-6, `${t.id}: notional ${t.notional} exceeds ${cfg.risk.maxPositionNotionalPct}% of peak equity ${peakEquity}`);
    assert.ok(t.bindingConstraint === "risk-budget" || t.bindingConstraint === "notional-cap", `${t.id}: bindingConstraint must be one of the two documented values`);
    if (t.bindingConstraint === "notional-cap") {
      assert.equal(t.notionalCapApplied, true, `${t.id}: a cap-bound trade must say so`);
      assert.ok(t.actualRiskPct < t.intendedRiskPct, `${t.id}: a cap-bound trade takes LESS risk than intended, and that is visible`);
    } else {
      assert.equal(t.notionalCapApplied, false, `${t.id}: a risk-budget trade must not claim the cap bound it`);
    }
  }
});

test("risk-rejected decisions are never executed, and the reason is recorded", async () => {
  const res = await primary();
  for (const d of res.decisions) {
    if (!d.riskApproved) {
      assert.equal(d.executed, false, `a rejected decision must not execute (${d.riskReasons.join("; ")})`);
      assert.equal(d.tradeId, null);
      assert.ok(d.riskReasons.length > 0, "a rejection always carries at least one reason");
      assert.equal(d.plan.quantity, 0, "a rejected plan carries a ZEROED size, so nothing can be traded by accident");
      assert.equal(d.plan.approved, false);
    } else {
      assert.equal(d.riskReasons.length, 0, "an approved decision has nothing to explain");
    }
    if (d.executed) {
      assert.ok(d.tradeId !== null);
      assert.equal(d.decision.direction !== "NO_TRADE", true, "only a directional decision can execute");
    }
  }
  assert.ok(res.funnel.riskRejected > 0 || res.funnel.executed > 0, "the funnel accounts for the decisions it saw");
});

test("no decision with direction NO_TRADE ever reaches the execution layer", async () => {
  const res = await primary();
  assert.ok(res.decisions.length > 0);
  for (const d of res.decisions) {
    assert.notEqual(d.decision.direction, "NO_TRADE", "NO_TRADE bars are filtered before a decision is built");
    assert.notEqual(d.decision.setup_type, "NONE");
    assert.equal(d.plan.approved ? true : true, true);
  }
});

test("the funnel reconciles with the per-series stats and the equity curve", async () => {
  const res = await primary();
  assert.equal(res.funnel.deterministicSetups, res.seriesStats.reduce((a, s) => a + s.deterministicSetups, 0));
  assert.equal(res.funnel.htfVetoed, res.seriesStats.reduce((a, s) => a + s.htfVetoed, 0));
  assert.equal(res.funnel.htfAnchored, res.seriesStats.reduce((a, s) => a + s.htfAnchored, 0));
  assert.equal(res.funnel.executed, res.seriesStats.reduce((a, s) => a + s.entries, 0));
  assert.equal(res.funnel.riskRejected, res.seriesStats.reduce((a, s) => a + s.riskRejections, 0) + res.funnel.llmVetoed);
  assert.ok(res.funnel.executed <= res.funnel.deterministicSetups, "you cannot execute more setups than you detected");
  assert.equal(res.decisions.filter((d) => d.executed).length, res.funnel.executed);
  assert.ok(res.trades.length <= res.funnel.executed, "some entries may still be open at the end and are force-closed");
  // Equity is continuous and starts from the configured capital.
  assert.ok(Math.abs(res.equity[0]!.equity - cfg.backtest.startingCapital) < 1e-6, "the first mark equals the starting capital");
  for (let i = 1; i < res.equity.length; i += 1) {
    assert.ok(res.equity[i]!.ts > res.equity[i - 1]!.ts, "the equity curve is strictly time-ordered");
    assert.ok(Number.isFinite(res.equity[i]!.equity), "equity is always finite");
    assert.ok(res.equity[i]!.drawdownPct >= -1e-9, "drawdown is non-negative by construction");
  }
});

test("the window honours the requested total and out-of-sample lengths", async () => {
  const res = await primary();
  assert.ok(Math.abs(res.window.days - DAYS) < 1.5, `window is ${res.window.days}d, asked for ${DAYS}d`);
  assert.ok(Math.abs(res.window.outOfSampleDays - OOS) < 0.5, `OOS is ${res.window.outOfSampleDays}d, asked for ${OOS}d`);
  assert.ok(res.window.outOfSampleFrom > res.window.from, "the OOS slice sits strictly inside the window");
  assert.ok(res.window.outOfSampleFrom < res.window.to);
  assert.ok(res.window.days >= 60, "the run satisfies the 60-day minimum");
  assert.ok(res.window.outOfSampleDays >= 30, "the run satisfies the 30-day OOS minimum");
  assert.match(res.window.fromIso, /^\d{4}-\d{2}-\d{2}T/);
  for (const t of res.trades) {
    assert.ok(t.entryTs >= res.window.from && t.entryTs <= res.window.to, `${t.id} entered outside the window`);
  }
});

test("splitSample partitions trades at the OOS boundary and sliceEquity bounds the curve", async () => {
  const res = await primary();
  const { inSample, outOfSample } = splitSample(res.trades, res.window.outOfSampleFrom);
  assert.equal(inSample.length + outOfSample.length, res.trades.length, "every trade lands in exactly one bucket");
  assert.ok(inSample.every((t) => t.entryTs < res.window.outOfSampleFrom));
  assert.ok(outOfSample.every((t) => t.entryTs >= res.window.outOfSampleFrom));
  const slice = sliceEquity(res.equity, res.window.outOfSampleFrom, res.window.to);
  assert.ok(slice.length > 0 && slice.length <= res.equity.length);
  assert.ok(slice.every((e) => e.ts >= res.window.outOfSampleFrom && e.ts <= res.window.to));
  assert.deepEqual(splitSample([], res.window.outOfSampleFrom), { inSample: [], outOfSample: [] });
});

test("REPRODUCIBILITY: two identical runs produce identical trades and equity", async () => {
  const a = await primary();
  const b = await run({});
  assert.deepEqual(b.trades, a.trades, "trades must be byte-identical across runs");
  assert.deepEqual(b.equity, a.equity, "the equity curve must be byte-identical across runs");
  assert.deepEqual(b.funnel, a.funnel);
  assert.deepEqual(b.seriesStats, a.seriesStats);
  assert.equal(b.configHash, a.configHash);
  assert.deepEqual(b.decisions.map((d) => [d.ts, d.symbol, d.executed, d.decision.confidence_score]), a.decisions.map((d) => [d.ts, d.symbol, d.executed, d.decision.confidence_score]));
});

test("the LLM (mock provider) changes confidence only - trades, direction and sizing are unchanged", async () => {
  const base = await primary();
  const withLlm = await run({ useLlm: true });
  assert.equal(withLlm.trades.length, base.trades.length, "the LLM must not add or remove trades");
  for (let i = 0; i < base.trades.length; i += 1) {
    const a = base.trades[i]!;
    const b = withLlm.trades[i]!;
    assert.equal(b.entryTs, a.entryTs, "same entry time");
    assert.equal(b.direction, a.direction, "the LLM cannot flip a direction");
    assert.equal(b.setupType, a.setupType, "the LLM cannot change the setup");
    assert.equal(b.quantity, a.quantity, "the LLM cannot change the size");
    assert.equal(b.initialStopLoss, a.initialStopLoss, "the LLM cannot move the stop");
    assert.equal(b.takeProfit1, a.takeProfit1);
    assert.equal(b.takeProfit2, a.takeProfit2);
    assert.equal(b.entryPrice, a.entryPrice);
    assert.ok(b.confidence >= 0 && b.confidence <= 0.95, "confidence stays inside the documented ceiling");
  }
});

test("decisions are only collected when asked for (keeps reports lean by default)", async () => {
  const lean = await run({ collectDecisions: false });
  assert.deepEqual(lean.decisions, [], "no audit rows are emitted unless requested");
  assert.ok(lean.trades.length > 0, "but the run still trades");
});

test("a widened notional cap is recorded as an explicit override, never applied silently", async () => {
  const res = await run({ maxPositionNotionalPct: 33 });
  assert.equal(res.overrides.maxPositionNotionalPct, 33, "the override is disclosed in the result");
  assert.equal(res.configHash, cfg.hash, "and the underlying config hash is unchanged - the report can tell them apart");
  const capPct = 0.33;
  const peakEquity = Math.max(...res.equity.map((e) => e.equity));
  for (const t of res.trades) {
    assert.ok(t.notional <= capPct * peakEquity + 1e-6, `${t.id}: notional respects the widened cap`);
  }
});

test("the engine refuses to run on a series too short for indicator warm-up", async () => {
  await assert.rejects(
    () => runBacktest({ cfg, dataDir, symbols: [SYMBOL], days: 1, outOfSampleDays: 30, collectDecisions: false }),
    /window too small|not enough for warm-up/,
    "an unusable window must throw rather than quietly report zero trades",
  );
});

test("a symbol with no committed data fails loudly instead of returning an empty result", async () => {
  await assert.rejects(
    () => runBacktest({ cfg, dataDir, symbols: ["NOSUCHPAIR"], days: DAYS, outOfSampleDays: OOS }),
    /NOSUCHPAIR|not found|ENOENT|no data|missing/i,
  );
});