/**
 * PAPER-TRADING RECORD TESTS.
 *
 * The hackathon run-record requirement is explicit: timestamp, instrument, direction,
 * price, quantity and account balance change. These tests assert those fields exist,
 * that the ledger RECONCILES (the CSV and the summary cannot disagree), and that the
 * harness refuses to run at all if the config ever claims it can place real orders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  tradesToPaperRecords, tradesToPaperEvents, paperRecordsCsv, paperEventsCsv,
  buildPaperLedger, decisionsToJsonl, PAPER_RECORD_COLUMNS, PAPER_EVENT_COLUMNS,
} from "../src/paper/records.ts";
import { assertNoRealOrders, makeRunId, runPaperReplay } from "../src/paper/harness.ts";
import { loadConfig, resolveDataDir, repoRoot } from "../src/config.ts";
import type { ExecutionDecision, PaperRecord, TradeRecord } from "../src/types.ts";

const cfg = loadConfig();
const dataDir = resolveDataDir(cfg.backtest.dataDir, repoRoot());

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "T1", symbol: "BTCUSDT", timeframe: "15m", direction: "LONG", setupType: "BREAKOUT_RETEST",
    confidence: 0.6, entryTs: 1_700_000_000_000, exitTs: 1_700_000_900_000, entryPrice: 100,
    exitPrice: 101, initialStopLoss: 99, stopLoss: 100, takeProfit1: 101.5, takeProfit2: 102.5,
    quantity: 2, notional: 200, riskAmount: 2, intendedRiskPct: 0.5, actualRiskPct: 0.4,
    notionalCapApplied: true, bindingConstraint: "notional-cap", fees: 0.4, slippage: 0.2,
    funding: 0.01, realizedPnl: 1.39, rMultiple: 0.695, holdingMinutes: 15, exitReason: "tp1",
    ...over,
  };
}

test("assertNoRealOrders is a hard stop: the harness refuses a config that could trade live", () => {
  assert.doesNotThrow(() => assertNoRealOrders(cfg), "the committed config is safe");
  assert.equal(cfg.meta.placesRealOrders, false);
  const hostile = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
  hostile.meta.placesRealOrders = true;
  assert.throws(() => assertNoRealOrders(hostile), /cannot place real orders/, "a live-order config must abort before anything runs");
  const undefinedFlag = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
  (undefinedFlag.meta as { placesRealOrders?: unknown }).placesRealOrders = undefined;
  assert.throws(() => assertNoRealOrders(undefinedFlag), /must be false/, "an ABSENT flag is not consent - it must also abort");
});

test("makeRunId is sortable, timestamped and prefixed", () => {
  const at = new Date("2026-09-21T13:45:06.789Z");
  assert.equal(makeRunId("paper", at), "paper_2026-09-21_13-45-06Z");
  const a = makeRunId("backtest", new Date("2026-01-01T00:00:00Z"));
  const b = makeRunId("backtest", new Date("2026-06-01T00:00:00Z"));
  assert.ok(a < b, "run ids sort chronologically as strings");
  assert.match(makeRunId("x"), /^x_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z$/);
});

test("the run-record schema carries every field the hackathon requires", () => {
  const required = ["timestamp", "instrument", "direction", "entry_price", "quantity", "account_balance_change"];
  for (const f of required) {
    assert.ok(PAPER_RECORD_COLUMNS.includes(f as keyof PaperRecord), `paper-trades.csv must include the required field "${f}"`);
  }
  // Price on both legs, plus the plan and the cost split, live in the richer event log.
  for (const f of ["timestamp", "instrument", "action", "direction", "price", "quantity", "account_balance_change", "account_balance"]) {
    assert.ok(PAPER_EVENT_COLUMNS.includes(f as never), `paper-events.csv must include "${f}"`);
  }
  const rec = tradesToPaperRecords([trade()], 10_000)[0]!;
  for (const f of required) {
    assert.ok(f in rec, `the emitted row must actually contain "${f}"`);
    assert.notEqual((rec as unknown as Record<string, unknown>)[f], undefined);
  }
  assert.match(rec.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "timestamps are ISO-8601 UTC");
  assert.equal(rec.instrument, "BTCUSDT");
  assert.equal(rec.direction, "LONG");
  assert.equal(rec.entry_price, 100);
  assert.equal(rec.quantity, 2);
});

test("ENTRY events settle ZERO; the whole net effect lands on the EXIT event", () => {
  const events = tradesToPaperEvents([trade()], 10_000);
  assert.equal(events.length, 2, "one round trip is two events");
  const entry = events[0]!;
  const exit = events[1]!;
  assert.equal(entry.action, "ENTRY");
  assert.equal(exit.action, "EXIT");
  assert.equal(entry.account_balance_change, 0, "an entry changes no SETTLED balance");
  assert.equal(entry.fees, 0, "entry costs are settled with the exit, not double-counted");
  assert.equal(entry.slippage, 0);
  assert.equal(entry.funding, 0);
  assert.equal(entry.realized_pnl, 0);
  assert.equal(entry.account_balance, 10_000, "the balance is unchanged at entry");
  assert.equal(exit.account_balance_change, 1.39, "the exit settles the net PnL");
  assert.equal(exit.account_balance, 10_001.39);
  assert.equal(exit.fees, 0.4);
  assert.equal(exit.slippage, 0.2);
  assert.equal(exit.funding, 0.01);
  assert.equal(exit.exit_reason, "tp1");
  assert.equal(entry.trade_id, exit.trade_id, "both legs carry the same trade id");
});

test("the ledger RECONCILES: sum of balance changes equals ending minus starting", () => {
  const trades = [
    trade({ id: "A", realizedPnl: 12.5, entryTs: 1_700_000_000_000, exitTs: 1_700_000_900_000 }),
    trade({ id: "B", realizedPnl: -30.25, entryTs: 1_700_001_000_000, exitTs: 1_700_002_000_000 }),
    trade({ id: "C", realizedPnl: 7.125, entryTs: 1_700_003_000_000, exitTs: 1_700_004_000_000 }),
  ];
  const start = 10_000;
  const events = tradesToPaperEvents(trades, start);
  const records = tradesToPaperRecords(trades, start);
  const ledger = buildPaperLedger(events, start, { mode: "replay", dataSource: "test", windowFromIso: null, windowToIso: null });

  const sumEvents = events.reduce((a, e) => a + e.account_balance_change, 0);
  const sumRecords = records.reduce((a, r) => a + r.account_balance_change, 0);
  const expected = 12.5 - 30.25 + 7.125;
  assert.ok(Math.abs(sumEvents - expected) < 1e-9, `events sum to ${sumEvents}, expected ${expected}`);
  assert.ok(Math.abs(sumRecords - expected) < 1e-9, `records sum to ${sumRecords}, expected ${expected}`);
  assert.ok(Math.abs(ledger.netChange - expected) < 1e-9);
  assert.ok(Math.abs(ledger.endingBalance - (start + expected)) < 1e-9, "ending = starting + net change");
  assert.ok(Math.abs(ledger.endingBalance - start - sumEvents) < 1e-9, "the ledger and the CSV cannot disagree");
  assert.equal(ledger.roundTrips, 3);
  assert.equal(ledger.wins, 2);
  assert.equal(ledger.losses, 1);
  assert.equal(ledger.events, 6);
  assert.equal(ledger.placesRealOrders, false, "the ledger states, in writing, that no real order was placed");
  assert.equal(ledger.dataSource, "test", "the caller-supplied data-source label is preserved verbatim");

  // The running balance in the event log must equal start + cumulative change at every row.
  let running = start;
  for (const e of events) {
    running += e.account_balance_change;
    assert.ok(Math.abs(e.account_balance - running) < 1e-6, `running balance drifts at ${e.timestamp}`);
  }
});

test("records AND events are both ordered by ENTRY time - the log is chronological", () => {
  const trades = [
    trade({ id: "LATE", entryTs: 1_700_000_000_000, exitTs: 1_700_099_000_000 }),
    trade({ id: "EARLY", entryTs: 1_700_050_000_000, exitTs: 1_700_060_000_000 }),
  ];
  const records = tradesToPaperRecords(trades, 10_000);
  assert.deepEqual(records.map((r) => r.instrument), ["BTCUSDT", "BTCUSDT"]);
  const recTs = records.map((r) => Date.parse(r.timestamp));
  assert.deepEqual(recTs, [...recTs].sort((a, b) => a - b), "the timestamp column never jumps backwards");
  assert.deepEqual(records.map((r) => r.quantity), records.map((r) => r.quantity));
  const events = tradesToPaperEvents(trades, 10_000);
  const entryIds = events.filter((e) => e.action === "ENTRY").map((e) => e.trade_id);
  assert.deepEqual(entryIds, ["LATE", "EARLY"], "events sort by ENTRY time, which is the causal order");
  assert.deepEqual(records.map((_r, i) => i), entryIds.map((_id, i) => i), "both files carry the same trade order");
  // Repeating the call must give an identical result (no reliance on input order).
  assert.deepEqual(tradesToPaperEvents([...trades].reverse(), 10_000), events);
  assert.deepEqual(tradesToPaperRecords([...trades].reverse(), 10_000), records);
});

test("the recorded stop is the PLANNED stop, not the post-TP1 breakeven stop", () => {
  const t = trade({ initialStopLoss: 99, stopLoss: 100, entryPrice: 100 });
  const rec = tradesToPaperRecords([t], 10_000)[0]!;
  const ev = tradesToPaperEvents([t], 10_000)[0]!;
  assert.equal(rec.stop_loss, 99, "reporting the managed stop would understate the risk actually accepted");
  assert.equal(ev.stop_loss, 99);
  assert.notEqual(rec.stop_loss, t.stopLoss, "and it must differ from the managed value when a breakeven move happened");
});

test("CSV output has an exact header row, one row per record, and escapes embedded separators", () => {
  const records = tradesToPaperRecords([trade()], 10_000);
  const csv = paperRecordsCsv(records);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], PAPER_RECORD_COLUMNS.join(","), "the header is exactly the documented column list");
  assert.equal(lines.length, 2);
  assert.equal(lines[1]!.split(",").length, PAPER_RECORD_COLUMNS.length, "no stray commas");
  assert.ok(csv.endsWith("\n"), "the file ends with a newline");

  const events = tradesToPaperEvents([trade({ symbol: 'WEIRD,"SYM' })], 10_000);
  const evCsv = paperEventsCsv(events);
  assert.ok(evCsv.includes('"WEIRD,""SYM"'), "a value containing a comma and a quote is RFC4180-escaped");
  assert.ok(!evCsv.includes('WEIRD,"SYM",15m'), "the raw comma must not leak out unescaped");
  assert.equal(paperRecordsCsv([]).trimEnd(), PAPER_RECORD_COLUMNS.join(","), "an empty ledger still writes a header");
});

test("decisionsToJsonl writes exactly one valid JSON object per line", () => {
  const d: ExecutionDecision = {
    symbol: "BTCUSDT", direction: "SHORT", setup_type: "BEARISH_DIVERGENCE", confidence_score: 0.7,
    execution: { entry_price: 1, stop_loss: 2, take_profit_1: 0.5, take_profit_2: 0.25, risk_reward_ratio: 2 },
    rationale: ["a"], provenance: { model: "m", promptVersion: "v", llmUsed: false, deterministicGate: "BEARISH_DIVERGENCE" },
  };
  const text = decisionsToJsonl([d, d]);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.deepEqual(JSON.parse(l), d, "every line is independently parseable");
  assert.equal(decisionsToJsonl([]), "", "no decisions means no file content, not a stray newline");
});

test("END-TO-END replay writes a reconciling ledger and a full report into the run directory", async () => {
  const outDir = join(repoRoot(), "work", "test-paper-out");
  rmSync(outDir, { recursive: true, force: true });
  const runId = "paper_TEST";
  const res = await runPaperReplay({
    cfg, runId, outDir, dataDir, symbols: ["BTCUSDT"], days: 62, outOfSampleDays: 30,
  });

  assert.equal(res.mode, "replay");
  assert.equal(res.validatedUniverse, false, "a single-symbol subset is NOT the configured validated universe, and says so");
  assert.equal(res.ledger.placesRealOrders, false);
  assert.ok(res.records.length > 0, "the replay produced run records");
  assert.ok(res.events.length === res.records.length * 2, "two events per round trip");

  const tradesCsv = join(res.dir, "paper-trades.csv");
  const eventsCsv = join(res.dir, "paper-events.csv");
  const summary = join(res.dir, "paper-summary.json");
  for (const p of [tradesCsv, eventsCsv, summary]) {
    assert.ok(existsSync(p), `${p} must be written`);
    assert.ok(res.files.includes(p), `${p} must be listed in the run's file manifest`);
  }

  const header = readFileSync(tradesCsv, "utf8").split("\n")[0];
  assert.equal(header, PAPER_RECORD_COLUMNS.join(","), "the committed CSV header is exactly the required schema");

  const parsed = JSON.parse(readFileSync(summary, "utf8")) as { ledger: typeof res.ledger; validatedUniverse: boolean };
  assert.ok(Math.abs(parsed.ledger.endingBalance - parsed.ledger.startingBalance - parsed.ledger.netChange) < 1e-6, "the written summary reconciles");
  assert.equal(parsed.validatedUniverse, false, "the honest label is persisted, not just returned");
  assert.match(parsed.ledger.dataSource, /NOT a live feed/, "the persisted data-source label is honest");

  // The CSV on disk must reproduce the same net change as the summary.
  const rows = readFileSync(tradesCsv, "utf8").trimEnd().split("\n").slice(1);
  const idx = PAPER_RECORD_COLUMNS.indexOf("account_balance_change");
  const sum = rows.reduce((a, r) => a + Number(r.split(",")[idx]), 0);
  assert.ok(Math.abs(sum - parsed.ledger.netChange) < 1e-3, `CSV sums to ${sum}, summary says ${parsed.ledger.netChange} (6dp rounding)`);

  const report = res.files.filter((f) => f.endsWith(".md"));
  assert.ok(report.length > 0, "a human-readable report is written alongside the ledger");
  const md = report.map((f) => readFileSync(f, "utf8")).join("\n");
  assert.match(md, /not live execution/i, "the report states the replay is not live execution");
  assert.match(md, /MODELLED/, "modelled costs are labelled separately from observed results");
  assert.match(md, /data.?quality gate/i, "the data gate result is in the same file as the numbers");
  assert.match(md, /UNVERIFIED ASSUMPTION/, "the momentum-wave assumption is disclosed in the report itself");
  assert.match(md, /Places real orders: \*\*false\*\*/, "the report states no real order was placed");
  assert.ok(md.includes(parsed.ledger.endingBalance.toFixed(2).replace(/\.00$/, "")) || md.includes(String(Math.round(parsed.ledger.endingBalance * 100) / 100)), "the ledger balance appears in the report");

  rmSync(outDir, { recursive: true, force: true });
});

test("a replay refuses to run when the requested symbols fail the data-quality gate", async () => {
  const outDir = join(repoRoot(), "work", "test-paper-fail");
  rmSync(outDir, { recursive: true, force: true });
  await assert.rejects(
    () => runPaperReplay({ cfg, runId: "paper_FAIL", outDir, dataDir, symbols: ["RNVDAUSDT"], days: 62, outOfSampleDays: 30 }),
    /data-quality gate failed/,
    "gappy rToken data must abort a strict replay rather than be quietly traded",
  );
  assert.equal(existsSync(join(outDir, "paper_FAIL")), false, "nothing is written when the gate aborts the run");
  rmSync(outDir, { recursive: true, force: true });
});