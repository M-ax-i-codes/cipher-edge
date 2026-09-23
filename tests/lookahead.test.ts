/**
 * LOOK-AHEAD BIAS TESTS.
 *
 * The invariant under test is truncate-invariance: for any prefix of the data, every
 * value computed for a bar inside that prefix must be identical to the value computed
 * from the full dataset. If any indicator, swing detector, divergence scanner, breakout
 * detector or strategy rule ever consults a future bar, appending bars changes a past
 * value and these tests fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCipherB, DEFAULT_CIPHERB } from "../src/indicators/cipherB.ts";
import { computeWaveTrend } from "../src/indicators/wavetrend.ts";
import { computeMomentumWave } from "../src/indicators/momentumWave.ts";
import { detectDots } from "../src/indicators/dots.ts";
import { computeDivergence } from "../src/indicators/divergence.ts";
import { confirmedSwingHighs, confirmedSwingLows } from "../src/structure/swings.ts";
import { detectBreakoutRetest } from "../src/structure/breakout.ts";
import { evaluateAll } from "../src/strategy/engine.ts";
import { buildHtfIndex, DEFAULT_HTF } from "../src/strategy/mtf.ts";
import { walkSeries, shapedSeries, toHourly, prefixEqual, H1, M15 } from "./helpers.ts";

const full = walkSeries(400, { seed: 987654321 });
const shaped = shapedSeries();

test("wavetrend is truncate-invariant (no future bar influences a past value)", () => {
  const whole = computeWaveTrend(full);
  for (const cut of [80, 150, 260, 399]) {
    const part = computeWaveTrend(full.slice(0, cut));
    assert.ok(prefixEqual(whole.os1.slice(0, cut), part.os1), `os1 changed when truncated to ${cut}`);
    assert.ok(prefixEqual(whole.os2.slice(0, cut), part.os2), `os2 changed when truncated to ${cut}`);
    assert.ok(prefixEqual(whole.ci.slice(0, cut), part.ci), `ci changed when truncated to ${cut}`);
  }
});

test("momentum wave and dots are truncate-invariant", () => {
  const os1 = computeWaveTrend(full).os1;
  const wholeWave = computeMomentumWave(os1, 3);
  const wholeDots = detectDots(wholeWave, 60, -60);
  for (const cut of [80, 200, 399]) {
    const partWave = computeMomentumWave(os1.slice(0, cut), 3);
    assert.ok(prefixEqual(wholeWave.slice(0, cut), partWave), `wave changed at cut ${cut}`);
    const partDots = detectDots(partWave, 60, -60);
    assert.deepEqual(partDots, wholeDots.slice(0, cut), `dots changed at cut ${cut}`);
  }
});

test("dots only ever reference the past two bars", () => {
  const wave = [0, 10, 70, 80, 60, 20, -70, -80, -60, 0];
  const dots = detectDots(wave, 60, -60);
  // peak at index 3 (80) confirmed on index 4; trough at index 7 (-80) confirmed on index 8
  assert.equal(dots[4], 1, "top red dot must fire on the confirmation bar, not the peak bar");
  assert.equal(dots[3], 0, "the peak bar itself must not fire - that would need bar 4 to exist");
  assert.equal(dots[8], -1, "bottom green dot must fire on the confirmation bar");
  assert.equal(dots[7], 0, "the trough bar itself must not fire");
});

test("divergence is truncate-invariant on both random and scripted shapes", () => {
  for (const series of [full, shaped]) {
    const wave = computeMomentumWave(computeWaveTrend(series).os1, 3);
    const whole = computeDivergence(series, wave);
    for (const cut of [60, 120, Math.floor(series.length / 2), series.length - 1]) {
      if (cut < 10) continue;
      const part = computeDivergence(series.slice(0, cut), wave.slice(0, cut));
      assert.deepEqual(part.bearish, whole.bearish.slice(0, cut), `bearish divergence changed at cut ${cut}`);
      assert.deepEqual(part.bullish, whole.bullish.slice(0, cut), `bullish divergence changed at cut ${cut}`);
    }
  }
});

test("O(n) cursor divergence equals the naive per-bar rescan", () => {
  const wave = computeMomentumWave(computeWaveTrend(full).os1, 3);
  const fast = computeDivergence(full, wave);
  const params = { swingLookback: 5, minSwingBars: 2, maxSwingAgeBars: 60 };
  // Naive reference: at every bar, rescan only the bars up to and including it.
  const naiveBearish: boolean[] = [];
  const naiveBullish: boolean[] = [];
  for (let t = 0; t < full.length; t += 1) {
    const win = full.slice(0, t + 1);
    const highs = win.map((c) => c.high);
    const lows = win.map((c) => c.low);
    const sh = confirmedSwingHighs(highs, params.swingLookback, params.swingLookback, t);
    const sl = confirmedSwingLows(lows, params.swingLookback, params.swingLookback, t);
    let bear = false;
    let bull = false;
    if (sh.length >= 2) {
      const s2 = sh[sh.length - 1]!;
      const s1 = sh[sh.length - 2]!;
      const w1 = wave[s1.index] as number;
      const w2 = wave[s2.index] as number;
      if (t - s2.index <= params.maxSwingAgeBars && s2.index - s1.index >= params.minSwingBars &&
          Number.isFinite(w1) && Number.isFinite(w2) && s2.value > s1.value && w2 < w1) bear = true;
    }
    if (sl.length >= 2) {
      const s2 = sl[sl.length - 1]!;
      const s1 = sl[sl.length - 2]!;
      const w1 = wave[s1.index] as number;
      const w2 = wave[s2.index] as number;
      if (t - s2.index <= params.maxSwingAgeBars && s2.index - s1.index >= params.minSwingBars &&
          Number.isFinite(w1) && Number.isFinite(w2) && s2.value < s1.value && w2 > w1) bull = true;
    }
    naiveBearish.push(bear);
    naiveBullish.push(bull);
  }
  assert.deepEqual(fast.bearish, naiveBearish, "O(n) bearish divergence diverges from the naive rescan");
  assert.deepEqual(fast.bullish, naiveBullish, "O(n) bullish divergence diverges from the naive rescan");
});

test("confirmed swings never appear before their right-hand bars exist", () => {
  const highs = full.map((c) => c.high);
  const all = confirmedSwingHighs(highs, 5, 5, full.length - 1);
  assert.ok(all.length > 0, "test data should contain at least one swing high");
  for (const s of all) {
    assert.equal(s.confirmedAt, s.index + 5, "confirmedAt must be index + right arm");
    const early = confirmedSwingHighs(highs, 5, 5, s.confirmedAt - 1);
    assert.ok(!early.some((e) => e.index === s.index), `swing at ${s.index} visible at bar ${s.confirmedAt - 1} - look-ahead`);
    const onTime = confirmedSwingHighs(highs, 5, 5, s.confirmedAt);
    assert.ok(onTime.some((e) => e.index === s.index), `swing at ${s.index} must be visible at bar ${s.confirmedAt}`);
  }
  const lows = full.map((c) => c.low);
  const allLows = confirmedSwingLows(lows, 5, 5, full.length - 1);
  for (const s of allLows) {
    const early = confirmedSwingLows(lows, 5, 5, s.confirmedAt - 1);
    assert.ok(!early.some((e) => e.index === s.index), `swing low at ${s.index} visible too early`);
  }
});

test("breakout/retest detection is truncate-invariant", () => {
  const whole = detectBreakoutRetest(full);
  for (const cut of [100, 220, 399]) {
    const part = detectBreakoutRetest(full.slice(0, cut));
    assert.deepEqual(part.breakout, whole.breakout.slice(0, cut), `breakout flags changed at cut ${cut}`);
    assert.deepEqual(part.retest, whole.retest.slice(0, cut), `retest flags changed at cut ${cut}`);
    assert.deepEqual(part.retestLevel, whole.retestLevel.slice(0, cut), `retest levels changed at cut ${cut}`);
  }
});

test("cipher B state is truncate-invariant", () => {
  const whole = computeCipherB(full);
  for (const cut of [100, 250, 399]) {
    const part = computeCipherB(full.slice(0, cut));
    for (let i = 0; i < cut; i += 1) {
      assert.equal(part[i]!.momentumWave, whole[i]!.momentumWave, `momentumWave changed at bar ${i} (cut ${cut})`);
      assert.equal(part[i]!.dot, whole[i]!.dot, `dot changed at bar ${i} (cut ${cut})`);
      assert.equal(part[i]!.bearishDivergence, whole[i]!.bearishDivergence, `bearishDivergence changed at bar ${i}`);
      assert.equal(part[i]!.bullishDivergence, whole[i]!.bullishDivergence, `bullishDivergence changed at bar ${i}`);
      assert.equal(part[i]!.overbought, whole[i]!.overbought, `overbought changed at bar ${i}`);
    }
  }
});

test("strategy signals are truncate-invariant (no rule peeks ahead)", () => {
  const whole = evaluateAll(full, "TEST");
  for (const cut of [120, 260, 399]) {
    const part = evaluateAll(full.slice(0, cut), "TEST");
    for (let i = 0; i < cut; i += 1) {
      assert.equal(part[i]!.direction, whole[i]!.direction, `direction changed at bar ${i} (cut ${cut})`);
      assert.equal(part[i]!.setupType, whole[i]!.setupType, `setupType changed at bar ${i} (cut ${cut})`);
      assert.deepEqual(part[i]!.conditions, whole[i]!.conditions, `conditions changed at bar ${i} (cut ${cut})`);
      assert.equal(part[i]!.swingHigh, whole[i]!.swingHigh, `swingHigh changed at bar ${i} (cut ${cut})`);
    }
  }
});

test("higher-timeframe index only sees bars that had already CLOSED", () => {
  const hourly = toHourly(full);
  assert.ok(hourly.length > 20, "need enough hourly bars");
  const fullIndex = buildHtfIndex(hourly, "1h", DEFAULT_HTF);
  const g = H1;

  let checked = 0;
  for (let k = 10; k < hourly.length; k += 7) {
    // The trigger-bar timestamp at which the k-th hourly bar has JUST closed.
    const ts = (hourly[k]!.ts) + g;
    const price = hourly[k]!.close;
    const fromFull = fullIndex.at(ts, price);

    // Rebuild the index using ONLY hourly bars closed by `ts` - if any later bar leaked
    // into the full-index answer, these two must differ.
    const visible = hourly.filter((c) => c.ts + g <= ts);
    const causalIndex = buildHtfIndex(visible, "1h", DEFAULT_HTF);
    const fromCausal = causalIndex.at(ts, price);

    assert.deepEqual(fromFull, fromCausal, `HTF levels at ${new Date(ts).toISOString()} used bars that had not closed`);

    // And one millisecond earlier the k-th bar must NOT be visible yet.
    const before = fullIndex.at(ts - 1, price);
    const visibleBefore = hourly.filter((c) => c.ts + g <= ts - 1);
    const beforeCausal = buildHtfIndex(visibleBefore, "1h", DEFAULT_HTF).at(ts - 1, price);
    assert.deepEqual(before, beforeCausal, `HTF levels at ts-1 used a bar that had not closed`);
    checked += 1;
  }
  assert.ok(checked >= 5, `expected to probe several timestamps, checked ${checked}`);
});

test("higher-timeframe index returns nothing before the first bar closes", () => {
  const hourly = toHourly(full);
  const index = buildHtfIndex(hourly, "1h", DEFAULT_HTF);
  const first = hourly[0]!;
  assert.deepEqual(index.at(first.ts, first.close), { resistance: null, support: null }, "an open bar must not be usable");
  assert.deepEqual(index.at(first.ts + H1 - 1, first.close), { resistance: null, support: null }, "a bar must not be usable 1ms before it closes");
});

test("appending future bars cannot change the 15m signal already emitted", () => {
  const signals = evaluateAll(shaped, "SHAPED");
  const anySetup = signals.findIndex((s) => s.direction !== "NO_TRADE");
  const extended = evaluateAll([...shaped, ...walkSeries(40, { start: shaped[shaped.length - 1]!.close, seed: 555, granularity: M15, startTs: shaped[shaped.length - 1]!.ts + M15 })], "SHAPED");
  for (let i = 0; i < shaped.length; i += 1) {
    assert.equal(extended[i]!.direction, signals[i]!.direction, `signal at ${i} changed after appending future bars`);
    assert.equal(extended[i]!.setupType, signals[i]!.setupType, `setup at ${i} changed after appending future bars`);
  }
  void anySetup;
});
