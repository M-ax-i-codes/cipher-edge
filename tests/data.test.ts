/**
 * DATA-INTEGRITY AND RESAMPLING TESTS.
 *
 * Indicators, swing confirmation and next-bar fills all assume adjacent bars are adjacent
 * in TIME. A gappy or partial series silently corrupts them, so the gate is tested here as
 * hard as the strategy: it must pass the committed 24/7 crypto series and FAIL the gappy
 * rToken series rather than quietly trading them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resample, barsPerDay } from "../src/data/resample.ts";
import { verifySeries, integrityTableRow } from "../src/data/integrity.ts";
import { parseCandleLine, normalizeCandles, localCandlePath, listLocalSymbols, sliceByTime } from "../src/data/local.ts";
import {
  maxAdjacentGap, lastBarIsPartial, assessSeries, preflightData,
  assertPreflightOk, usableSymbols, preflightMarkdown,
} from "../src/data/preflight.ts";
import { loadConfig, resolveDataDir, repoRoot } from "../src/config.ts";
import { granularityMs } from "../src/util/time.ts";
import { candle, flatSeries, T0, M15, H1, MIN } from "./helpers.ts";

const cfg = loadConfig();
const dataDir = resolveDataDir(cfg.backtest.dataDir, repoRoot());

test("resample aligns buckets to UTC bar-open boundaries and aggregates OHLCV correctly", () => {
  // Four 15m bars starting exactly on the hour -> one 1h bar.
  const base = T0 - (T0 % H1);
  const src = [
    candle(base, 100, 105, 99, 103, 10),
    candle(base + M15, 103, 107, 102, 106, 20),
    candle(base + 2 * M15, 106, 108, 104, 105, 30),
    candle(base + 3 * M15, 105, 106, 101, 102, 40),
    // A second, complete hour.
    candle(base + H1, 102, 104, 100, 103, 50),
    candle(base + H1 + M15, 103, 109, 103, 108, 60),
    candle(base + H1 + 2 * M15, 108, 110, 107, 109, 70),
    candle(base + H1 + 3 * M15, 109, 111, 108, 110, 80),
  ];
  const hourly = resample(src, "1h", { dropIncomplete: false });
  assert.equal(hourly.length, 2, "eight 15m bars make exactly two 1h bars");
  assert.equal(hourly[0]!.ts, base, "the bucket is stamped with its bar OPEN time");
  assert.equal(hourly[0]!.open, 100, "open = first constituent open");
  assert.equal(hourly[0]!.high, 108, "high = max constituent high");
  assert.equal(hourly[0]!.low, 99, "low = min constituent low");
  assert.equal(hourly[0]!.close, 102, "close = last constituent close");
  assert.equal(hourly[0]!.volume, 100, "volume is summed");
  assert.equal(hourly[1]!.high, 111);
  assert.equal(hourly[1]!.volume, 260);
});

test("resample drops the final partial bucket by default (no partial-bar bias)", () => {
  const base = T0 - (T0 % H1);
  const src = [
    candle(base, 100, 105, 99, 103, 10),
    candle(base + M15, 103, 107, 102, 106, 20),
    // Only two of four constituent bars exist for the second bucket.
    candle(base + H1, 106, 108, 104, 107, 30),
    candle(base + H1 + M15, 107, 109, 106, 108, 40),
  ];
  const kept = resample(src, "1h");
  assert.equal(kept.length, 1, "the incomplete final bucket must be dropped");
  assert.equal(kept[0]!.ts, base);
  const all = resample(src, "1h", { dropIncomplete: false });
  assert.equal(all.length, 2, "opting out keeps it - proving the drop is deliberate");
  assert.equal(all[1]!.high, 109, "and it is visibly built from only 2 of 4 bars");
});

test("resample floors misaligned source timestamps into the correct bucket", () => {
  const base = T0 - (T0 % H1);
  const src = [candle(base + 3 * MIN, 100, 101, 99, 100, 1), candle(base + 20 * MIN, 100, 102, 99, 101, 1)];
  const out = resample(src, "15m", { dropIncomplete: false });
  assert.equal(out.length, 2, "00:03 lands in the 00:00 bucket, 00:20 in the 00:15 bucket");
  assert.equal(out[0]!.ts, base);
  assert.equal(out[1]!.ts, base + M15);
});

test("resample rejects an unknown granularity instead of guessing", () => {
  assert.throws(() => resample(flatSeries(4), "7x"), /unknown granularity/);
});

test("resample preserves quote volume when present and barsPerDay matches the granularity", () => {
  const base = T0 - (T0 % H1);
  const src = [
    { ...candle(base, 100, 101, 99, 100, 1), quoteVolume: 100 },
    { ...candle(base + M15, 100, 101, 99, 100, 1), quoteVolume: 250 },
    { ...candle(base + 2 * M15, 100, 101, 99, 100, 1), quoteVolume: 50 },
    { ...candle(base + 3 * M15, 100, 101, 99, 100, 1), quoteVolume: 500 },
  ];
  const out = resample(src, "1h", { dropIncomplete: false });
  assert.equal(out[0]!.quoteVolume, 900, "quote volume is summed like volume");
  assert.equal(barsPerDay("15m"), 96);
  assert.equal(barsPerDay("1h"), 24);
  assert.equal(barsPerDay("5m"), 288);
  assert.equal(granularityMs("4h"), 4 * H1);
});

test("verifySeries flags a clean series as CLEAN and reports exact coverage", () => {
  const clean = flatSeries(100, 100, M15);
  const r = verifySeries(clean, "15m");
  assert.equal(r.clean, true);
  assert.equal(r.bars, 100);
  assert.equal(r.expectedBars, 100);
  assert.equal(r.completenessPct, 100);
  assert.equal(r.totalMissingBars, 0);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.duplicates, 0);
  assert.equal(r.unsorted, 0);
  assert.equal(r.malformedOhlc, 0);
  assert.equal(r.nonPositivePrice, 0);
  assert.equal(r.firstTs, T0);
  assert.equal(r.lastTs, T0 + 99 * M15);
  assert.match(r.firstIso as string, /^2026-01-01T00:00:00\.000Z$/);
  assert.equal(r.spanDays, Math.round(((99 * M15) / 86_400_000) * 100) / 100);
});

test("verifySeries detects gaps, duplicates, unsorted bars and malformed OHLC", () => {
  const gappy = [
    candle(T0, 100, 101, 99, 100),
    candle(T0 + M15, 100, 101, 99, 100),
    candle(T0 + 5 * M15, 100, 101, 99, 100), // three missing bars
  ];
  const g = verifySeries(gappy, "15m");
  assert.equal(g.clean, false);
  assert.equal(g.totalMissingBars, 3, "exactly three bars are missing between bar 2 and bar 3");
  assert.equal(g.gaps.length, 1);
  assert.equal(g.gaps[0]!.missingBars, 3);
  assert.equal(g.gaps[0]!.missingMinutes, 45);
  assert.equal(g.expectedBars, 6, "the span T0..T0+5*15m holds 6 bar slots");
  assert.equal(g.completenessPct, 50, "3 of 6 expected bars present");

  const duped = [candle(T0, 100, 101, 99, 100), candle(T0, 100, 101, 99, 101), candle(T0 + M15, 100, 101, 99, 100)];
  assert.equal(verifySeries(duped, "15m").duplicates, 1, "a repeated timestamp is counted");
  assert.equal(verifySeries(duped, "15m").clean, false);

  const unsorted = [candle(T0 + M15, 100, 101, 99, 100), candle(T0, 100, 101, 99, 100)];
  assert.equal(verifySeries(unsorted, "15m").unsorted, 1, "a backwards timestamp is counted");
  assert.equal(verifySeries(unsorted, "15m").clean, false);

  // (a) high below open, (b) low above close, (c) high below low, (d) non-finite OHLC.
  const malformed = [
    candle(T0, 100, 99, 98, 100),
    candle(T0 + M15, 100, 101, 100.5, 100),
    candle(T0 + 2 * M15, 100, 99, 100.5, 100),
    { ts: T0 + 3 * M15, open: Number.NaN, high: 101, low: 99, close: 100, volume: 1 },
  ];
  const m = verifySeries(malformed, "15m");
  assert.equal(m.malformedOhlc, 4, "every OHLC ordering and finiteness violation is counted");
  assert.equal(m.clean, false);

  // A consistently NEGATIVE bar is internally ordered, so it is caught by the separate
  // non-positive-price check rather than the ordering check. Both must fail the series.
  const negative = verifySeries([candle(T0, -5, 5, -6, -4)], "15m");
  assert.equal(negative.malformedOhlc, 0, "a negative bar can still be correctly ordered");
  assert.equal(negative.nonPositivePrice, 1, "but it is flagged as a non-positive price");
  assert.equal(negative.clean, false);

  const negVol = [{ ...candle(T0, 100, 101, 99, 100), volume: -1 }];
  assert.equal(verifySeries(negVol, "15m").negativeVolume, 1);
  assert.equal(verifySeries(negVol, "15m").clean, false, "negative volume makes the series unclean");
  assert.equal(verifySeries([candle(T0, 100, 101, 99, 100, 0)], "15m").zeroVolumeBars, 1);
  assert.equal(verifySeries([], "15m").clean, false, "an empty series is never reported clean");
  assert.equal(verifySeries([], "15m").expectedBars, 0);
});

test("integrityTableRow renders one pipe-delimited row for the integrity report", () => {
  const row = integrityTableRow("BTCUSDT", "15m", verifySeries(flatSeries(10), "15m"));
  const cells = row.split(" | ");
  assert.equal(cells[0], "BTCUSDT");
  assert.equal(cells[1], "15m");
  assert.equal(cells[cells.length - 1], "CLEAN");
  assert.ok(row.includes("100%"), "completeness is rendered");
});

test("JSONL parsing: malformed lines are skipped, valid ones normalised", () => {
  assert.equal(parseCandleLine(""), null);
  assert.equal(parseCandleLine("   "), null);
  assert.equal(parseCandleLine("not json"), null);
  assert.equal(parseCandleLine('{"ts":"abc","o":1,"h":2,"l":0.5,"c":1.5}'), null, "a non-numeric ts is rejected");
  assert.equal(parseCandleLine('{"ts":1,"o":1,"h":2,"l":0.5}'), null, "a missing close is rejected");
  const ok = parseCandleLine('{"ts":1000,"o":1,"h":2,"l":0.5,"c":1.5,"v":10,"qv":15}');
  assert.deepEqual(ok, { ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, quoteVolume: 15 });
  const noVol = parseCandleLine('{"ts":1000,"o":1,"h":2,"l":0.5,"c":1.5}');
  assert.equal(noVol!.volume, 0, "a missing volume defaults to 0 rather than NaN");
  assert.equal(noVol!.quoteVolume, undefined);
});

test("normalizeCandles de-duplicates by timestamp and sorts ascending", () => {
  const rows = [
    candle(T0 + 2 * M15, 1, 1, 1, 1),
    candle(T0, 1, 1, 1, 1),
    candle(T0 + M15, 1, 1, 1, 1),
    candle(T0, 2, 2, 2, 2), // duplicate ts - the later one wins
  ];
  const out = normalizeCandles(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.ts), [T0, T0 + M15, T0 + 2 * M15]);
  assert.equal(out[0]!.open, 2, "the last write for a timestamp wins, deterministically");
});

test("sliceByTime is inclusive on bar OPEN time", () => {
  const s = flatSeries(10, 100, M15);
  assert.equal(sliceByTime(s, s[2]!.ts, s[5]!.ts).length, 4);
  assert.equal(sliceByTime(s, undefined, s[0]!.ts).length, 1);
  assert.equal(sliceByTime(s, s[9]!.ts).length, 1);
  assert.equal(sliceByTime(s).length, 10);
});

test("maxAdjacentGap measures the worst hole in bars and minutes", () => {
  assert.equal(maxAdjacentGap(flatSeries(50), "15m").bars, 1, "a contiguous series has a 1-bar gap");
  assert.equal(maxAdjacentGap(flatSeries(50), "15m").minutes, 15);
  const gappy = [candle(T0, 1, 1, 1, 1), candle(T0 + M15, 1, 1, 1, 1), candle(T0 + 10 * M15, 1, 1, 1, 1)];
  assert.equal(maxAdjacentGap(gappy, "15m").bars, 9);
  assert.equal(maxAdjacentGap(gappy, "15m").minutes, 135);
  assert.equal(maxAdjacentGap([], "15m").bars, 1, "an empty series cannot report a negative gap");
  assert.equal(maxAdjacentGap([candle(T0, 1, 1, 1, 1)], "15m").bars, 1, "a single bar has no adjacent pair");
});

test("lastBarIsPartial is true only while the final bar has not closed", () => {
  const s = flatSeries(5, 100, M15, T0);
  const lastClose = s[4]!.ts + M15;
  assert.equal(lastBarIsPartial(s, "15m", lastClose - 1), true, "before the close time the bar is still forming");
  assert.equal(lastBarIsPartial(s, "15m", lastClose), false, "at the close time the bar is final");
  assert.equal(lastBarIsPartial(s, "15m", lastClose + H1), false);
  assert.equal(lastBarIsPartial([], "15m", T0), false);
});

test("assessSeries applies the configured completeness and contiguity gates", () => {
  const gate = { requireCompletenessPct: 99, maxAdjacentGapBars: 4, strict: true };
  const good = assessSeries("GOOD", "15m", flatSeries(200, 100, M15), gate, [], T0 + 200 * M15);
  assert.equal(good.passes, true, "a complete contiguous series passes");
  assert.deepEqual(good.reasons, []);

  const gappy = flatSeries(100, 100, M15).filter((_, i) => i < 40 || i > 60);
  const bad = assessSeries("GAPPY", "15m", gappy, gate, [], T0 + 100 * M15);
  assert.equal(bad.passes, false);
  assert.equal(bad.passesContiguity, false, "a 21-bar hole breaches a 4-bar tolerance");
  // Dropping indices 40..60 (21 bars) leaves bar 39 and bar 61 adjacent, i.e. a 22-bar step.
  assert.equal(bad.maxAdjacentGapBars, 22, "the gap is measured in bar STEPS between surviving bars");
  assert.equal(bad.integrity.totalMissingBars, 21, "and 21 bars are genuinely absent");
  assert.ok(bad.reasons.some((r) => r.includes("largest adjacent gap")));

  const sparse = flatSeries(1000, 100, M15).filter((_, i) => i % 3 === 0);
  const thin = assessSeries("THIN", "15m", sparse, gate, [], T0 + 1000 * M15);
  assert.equal(thin.passesCompleteness, false, "one third of the bars present cannot pass a 99% gate");
  assert.ok(thin.reasons.some((r) => r.includes("completeness")));

  const empty = assessSeries("EMPTY", "15m", [], gate, [], T0);
  assert.equal(empty.passes, false);
  assert.ok(empty.reasons.some((r) => r.includes("empty")));

  const partial = assessSeries("PARTIAL", "15m", flatSeries(10, 100, M15, T0), gate, [], T0 + 10 * M15 - 1);
  assert.equal(partial.lastBarPartial, true);
  assert.ok(partial.reasons.some((r) => r.includes("partial candle")), "an unclosed final bar is reported");
});

test("the committed crypto series PASS the gate and the gappy rToken series FAIL it", async () => {
  const gate = cfg.dataQuality;
  const crypto = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const rTokens = ["RNVDAUSDT", "RTSLAUSDT", "RAAPLUSDT"];

  const cryptoRes = await preflightData({
    dataDir, symbols: crypto, triggerGranularity: cfg.backtest.triggerGranularity,
    structureGranularity: cfg.backtest.structureGranularity, resampleFrom: cfg.backtest.resampleFrom,
    gate, allowNetwork: false,
  });
  assert.equal(cryptoRes.allPassed, true, `the validated universe must pass its own gate: ${JSON.stringify(cryptoRes.symbolsFailed)}`);
  assert.deepEqual(cryptoRes.symbolsPassed, crypto);
  assert.deepEqual(cryptoRes.symbolsFailed, []);
  assert.deepEqual(usableSymbols(cryptoRes), crypto, "usableSymbols is exactly the passing set");
  assert.ok(cryptoRes.commonFromIso && cryptoRes.commonToIso, "a common window is reported");
  for (const q of cryptoRes.series) {
    assert.ok(q.integrity.completenessPct >= gate.requireCompletenessPct, `${q.symbol} ${q.granularity} completeness ${q.integrity.completenessPct}%`);
    assert.ok(q.maxAdjacentGapBars <= gate.maxAdjacentGapBars, `${q.symbol} ${q.granularity} max gap ${q.maxAdjacentGapBars}`);
    assert.equal(q.integrity.duplicates, 0);
    assert.equal(q.integrity.unsorted, 0);
    assert.equal(q.integrity.malformedOhlc, 0);
    assert.equal(q.integrity.nonPositivePrice, 0);
    assert.equal(q.lastBarPartial, false, "the committed dataset must not end on an unclosed bar");
  }
  assert.doesNotThrow(() => assertPreflightOk(cryptoRes), "a passing preflight must not throw even in strict mode");

  const rRes = await preflightData({
    dataDir, symbols: rTokens, triggerGranularity: cfg.backtest.triggerGranularity,
    structureGranularity: cfg.backtest.structureGranularity, resampleFrom: cfg.backtest.resampleFrom,
    gate, allowNetwork: false,
  });
  assert.equal(rRes.allPassed, false, "the rToken series carry US market-close gaps and must fail");
  assert.deepEqual(rRes.symbolsPassed, [], "no rToken series may enter the validated universe");
  assert.deepEqual(rRes.symbolsFailed, rTokens);
  assert.throws(() => assertPreflightOk(rRes), (err: unknown) => {
    const msg = (err as Error).message;
    assert.match(msg, /data-quality gate failed/);
    assert.match(msg, /strict is true/, "strict mode must say the run is aborted");
    for (const s of rTokens) assert.ok(msg.includes(s), `the failure report must name ${s}`);
    return true;
  }, "strict mode must abort rather than trade gappy data");
});

test("assertPreflightOk only THROWS in strict mode; non-strict reports and skips", async () => {
  const rTokens = ["RNVDAUSDT"];
  const base = { dataDir, symbols: rTokens, triggerGranularity: cfg.backtest.triggerGranularity, structureGranularity: cfg.backtest.structureGranularity, resampleFrom: cfg.backtest.resampleFrom, allowNetwork: false };
  const strict = await preflightData({ ...base, gate: { ...cfg.dataQuality, strict: true } });
  const lenient = await preflightData({ ...base, gate: { ...cfg.dataQuality, strict: false } });
  assert.equal(strict.allPassed, false);
  assert.equal(lenient.allPassed, false, "leniency does not make bad data good - it only changes the reaction");
  assert.throws(() => assertPreflightOk(strict));
  assert.doesNotThrow(() => assertPreflightOk(lenient), "non-strict mode must not abort the run");
  assert.deepEqual(usableSymbols(lenient), [], "and nothing is actually traded");
});

test("preflight reports a missing series as a failure instead of throwing", async () => {
  const res = await preflightData({
    dataDir, symbols: ["NOTAREALSYMBOL"], triggerGranularity: "15m", structureGranularity: "1h",
    resampleFrom: null, gate: cfg.dataQuality, allowNetwork: false,
  });
  assert.equal(res.allPassed, false);
  assert.deepEqual(res.symbolsFailed, ["NOTAREALSYMBOL"]);
  assert.ok(res.series.every((q) => q.reasons.length > 0), "the reason is recorded for the report");
  assert.equal(res.commonFromIso, null, "no passing trigger series means no common window");
});

test("preflightMarkdown renders a table with a verdict column for every checked series", async () => {
  const res = await preflightData({
    dataDir, symbols: ["BTCUSDT", "RNVDAUSDT"], triggerGranularity: "15m", structureGranularity: "1h",
    resampleFrom: cfg.backtest.resampleFrom, gate: cfg.dataQuality, allowNetwork: false,
  });
  const md = preflightMarkdown(res);
  assert.match(md, /\| symbol \| gran \| bars \|/);
  assert.match(md, /PASS/);
  assert.match(md, /FAIL:/, "a failing series must show its reasons in the report");
  assert.match(md, /BTCUSDT/);
  assert.match(md, /RNVDAUSDT/);
  // The two header lines start with "|"; data rows start with the symbol name.
  const lines = md.split("\n");
  assert.equal(lines.length, res.series.length + 2, "one row per (symbol, granularity) plus two header lines");
  const dataRows = lines.slice(2);
  assert.ok(dataRows.every((l) => !l.startsWith("|")), "data rows are symbol-led");
  assert.ok(dataRows.every((l) => l.split(" | ").length === 11), "every row has all 11 columns");
});

test("the committed dataset on disk matches the configured universe and layout", () => {
  const listed = listLocalSymbols(dataDir, "15m");
  assert.ok(listed.length >= cfg.backtest.extendedSymbols.length, "every extended symbol has a 15m file");
  for (const s of cfg.backtest.extendedSymbols) {
    assert.ok(listed.includes(s), `${s} is configured but missing from ${dataDir}`);
    for (const g of ["5m", "15m", "1h"]) {
      assert.ok(localCandlePath(dataDir, s, g).endsWith(`${s}.${g}.jsonl`));
    }
  }
  assert.deepEqual(listed, [...listed].sort(), "the listing is sorted, so runs are reproducible");
  assert.deepEqual(listLocalSymbols(`${dataDir}-does-not-exist`, "15m"), [], "a missing directory yields no symbols, not an exception");
});

test("every committed crypto series covers at least the configured backtest window", async () => {
  const res = await preflightData({
    dataDir, symbols: cfg.backtest.symbols, triggerGranularity: cfg.backtest.triggerGranularity,
    structureGranularity: cfg.backtest.structureGranularity, resampleFrom: cfg.backtest.resampleFrom,
    gate: cfg.dataQuality, allowNetwork: false,
  });
  for (const q of res.series.filter((s) => s.granularity === cfg.backtest.triggerGranularity)) {
    assert.ok(q.integrity.spanDays >= cfg.backtest.days, `${q.symbol} spans ${q.integrity.spanDays}d, need >= ${cfg.backtest.days}d`);
    assert.ok(q.integrity.spanDays >= cfg.backtest.days + cfg.backtest.outOfSampleDays - cfg.backtest.days, "sanity: span covers the OOS slice");
  }
});