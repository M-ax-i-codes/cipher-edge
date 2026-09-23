/**
 * STRATEGY FIDELITY TESTS.
 *
 * The written specification is the source of truth: Setup A needs structure +
 * divergence + exhaustion + red dot + rejection; Setup B needs breakout-retest +
 * momentum reset + trigger. EVERY condition is mandatory, NO_TRADE is the default,
 * and no downstream layer (including the LLM) may waive one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSetupA } from "../src/strategy/setupA.ts";
import { evaluateSetupB } from "../src/strategy/setupB.ts";
import { evaluateAll, DEFAULT_STRATEGY } from "../src/strategy/engine.ts";
import { buildHtfIndex, applyHtfStructure, DEFAULT_HTF } from "../src/strategy/mtf.ts";
import type { CipherBState } from "../src/types.ts";
import type { SetupInput } from "../src/strategy/context.ts";
import { candle, flatSeries, walkSeries, shapedSeries, toHourly, T0, M15, H1 } from "./helpers.ts";

/** A fully-satisfied Cipher B state: overbought, red dot, bearish divergence. */
function cipherB(over: Partial<CipherBState> = {}): CipherBState {
  return {
    ts: T0,
    wt: { ap: 100, esa: 95, d: 2, ci: 80, os1: 70, os2: 65 },
    momentumWave: 70,
    dot: 1,
    overbought: true,
    oversold: false,
    bearishDivergence: true,
    bullishDivergence: false,
    ...over,
  };
}

/** Setup A input with every mandatory condition satisfied, so tests can break ONE at a time. */
function setupAInput(over: Partial<SetupInput> = {}): SetupInput {
  return {
    t: 50,
    candle: candle(T0, 100.5, 101.2, 99.8, 99.9), // closes DOWN = rejection, high sweeps 101
    prevCandle: candle(T0 - M15, 100, 101.1, 99.9, 100.5),
    cipher: cipherB(),
    prevCipher: cipherB({ ts: T0 - M15 }),
    wave: 70,
    wavePrev: 72,
    wavePrev2: 74,
    refSwingHigh: 101,
    retestLevel: null,
    retestNow: false,
    overbought: 60,
    oversold: -60,
    sweepTolerancePct: 0.3,
    momentumCoolMax: 0,
    ...over,
  };
}

/** Setup B input with every mandatory condition satisfied. */
function setupBInput(over: Partial<SetupInput> = {}): SetupInput {
  return {
    t: 50,
    candle: candle(T0, 100, 100.6, 99.9, 100.5),
    prevCandle: candle(T0 - M15, 99.8, 100.1, 99.7, 100),
    cipher: cipherB({ momentumWave: -5, dot: -1, overbought: false, oversold: false, bearishDivergence: false }),
    prevCipher: cipherB({ ts: T0 - M15, momentumWave: -9, dot: 0, overbought: false, oversold: false }),
    wave: -5,
    wavePrev: -9,
    wavePrev2: -13,
    refSwingHigh: null,
    retestLevel: 99.5,
    retestNow: true,
    overbought: 60,
    oversold: -60,
    sweepTolerancePct: 0.3,
    momentumCoolMax: 0,
    ...over,
  };
}

test("Setup A passes only when ALL five mandatory conditions hold", () => {
  const v = evaluateSetupA(setupAInput());
  assert.equal(v.pass, true, "the fully-satisfied baseline must pass");
  assert.deepEqual(v.conditions, {
    structure: true, divergence: true, exhaustion: true, redDot: true, rejection: true,
  });
});

test("Setup A fails when ANY single mandatory condition is missing", () => {
  const cases: Array<[string, SetupInput, keyof ReturnType<typeof evaluateSetupA>["conditions"]]> = [
    // no confirmed swing high => no supply zone to fade
    ["structure (no reference swing high)", setupAInput({ refSwingHigh: null }), "structure"],
    // price far below the supply zone => never swept it
    ["structure (price nowhere near the zone)", setupAInput({ candle: candle(T0, 90, 90.5, 89.5, 89.8) }), "structure"],
    ["divergence", setupAInput({ cipher: cipherB({ bearishDivergence: false }) }), "divergence"],
    // neither the current nor the previous bar was overbought
    [
      "exhaustion",
      setupAInput({
        cipher: cipherB({ overbought: false, momentumWave: 20 }),
        prevCipher: cipherB({ overbought: false, momentumWave: 22 }),
        wave: 20, wavePrev: 22,
      }),
      "exhaustion",
    ],
    [
      "redDot",
      setupAInput({ cipher: cipherB({ dot: 0 }), prevCipher: cipherB({ dot: 0 }) }),
      "redDot",
    ],
    // a bar that closes UP is not a rejection
    ["rejection (bar closed up)", setupAInput({ candle: candle(T0, 100, 101.2, 99.8, 101.1) }), "rejection"],
  ];
  for (const [label, input, key] of cases) {
    const v = evaluateSetupA(input);
    assert.equal(v.pass, false, `Setup A must NOT pass when ${label} is missing`);
    assert.equal(v.conditions[key], false, `${label} must be reported as unsatisfied`);
  }
});

test("Setup A accepts a red dot or overbought reading on the PREVIOUS bar (both are past bars)", () => {
  const dotOnPrev = evaluateSetupA(setupAInput({
    cipher: cipherB({ dot: 0 }),
    prevCipher: cipherB({ dot: 1 }),
  }));
  assert.equal(dotOnPrev.pass, true, "a dot confirmed one bar ago is still causal evidence");
});

test("Setup B passes only when ALL three mandatory conditions hold", () => {
  const v = evaluateSetupB(setupBInput());
  assert.equal(v.pass, true, "the fully-satisfied baseline must pass");
  assert.deepEqual(v.conditions, { breakoutRetest: true, momentumReset: true, trigger: true });
});

test("Setup B fails when ANY single mandatory condition is missing", () => {
  const cases: Array<[string, SetupInput]> = [
    ["no breakout-retest in progress", setupBInput({ retestNow: false })],
    ["momentum never cooled to the zero-line", setupBInput({ wave: 25, wavePrev: 22, wavePrev2: 20, cipher: cipherB({ dot: -1, momentumWave: 25 }) })],
    ["no green dot and no bullish curvature", setupBInput({
      cipher: cipherB({ dot: 0 }),
      prevCipher: cipherB({ dot: 0 }),
      wave: -5, wavePrev: -3, wavePrev2: -1, // falling => no curvature
    })],
  ];
  for (const [label, input] of cases) {
    const v = evaluateSetupB(input);
    assert.equal(v.pass, false, `Setup B must NOT pass when ${label}`);
  }
});

test("Setup B: bullish curvature alone is NOT a trigger unless the wave has also cooled", () => {
  const hot = evaluateSetupB(setupBInput({
    cipher: cipherB({ dot: 0 }),
    prevCipher: cipherB({ dot: 0 }),
    wave: 40, wavePrev: 35, wavePrev2: 30, // rising, but nowhere near the zero-line
  }));
  assert.equal(hot.pass, false);
  assert.equal(hot.conditions.momentumReset, false, "an uncooled wave must not reset momentum");
});

test("NO_TRADE is the default: flat and random series without structure produce no signals", () => {
  for (const [label, series] of [["flat", flatSeries(300)], ["random walk", walkSeries(300, { seed: 4242 })]] as const) {
    const signals = evaluateAll(series, "TESTUSDT");
    assert.equal(signals.length, series.length, `${label}: one signal per bar`);
    for (const s of signals) {
      assert.ok(
        s.direction === "LONG" || s.direction === "SHORT" || s.direction === "NO_TRADE",
        `${label}: direction must stay inside the schema`,
      );
      if (s.direction === "NO_TRADE") {
        assert.equal(s.setupType, "NONE", `${label}: NO_TRADE must carry setupType NONE`);
      } else {
        assert.notEqual(s.setupType, "NONE", `${label}: a directional signal must name its setup`);
      }
    }
  }
  const flat = evaluateAll(flatSeries(300), "TESTUSDT");
  assert.ok(flat.every((s) => s.direction === "NO_TRADE"), "a perfectly flat series can never produce a setup");
});

test("warm-up bars are silent: nothing can fire before warmupBars", () => {
  const cfg = { ...DEFAULT_STRATEGY, warmupBars: 60 };
  const series = shapedSeries().concat(walkSeries(200, { seed: 7, startTs: T0 + shapedSeries().length * M15 }));
  const signals = evaluateAll(series, "TESTUSDT", cfg);
  for (let t = 0; t < cfg.warmupBars; t += 1) {
    assert.equal(signals[t]!.direction, "NO_TRADE", `bar ${t} is inside warm-up and must be silent`);
    assert.equal(signals[t]!.setupType, "NONE");
    assert.deepEqual(signals[t]!.conditions, {}, "warm-up bars report no conditions - nothing was evaluated");
  }
});

test("signal cooldown suppresses repeats for the configured number of bars", () => {
  const cfg = { ...DEFAULT_STRATEGY, warmupBars: 20, signalCooldownBars: 3 };
  // Build a series long enough that the engine has produced at least one directional signal.
  const series = walkSeries(600, { seed: 99, vol: 0.01 });
  const signals = evaluateAll(series, "TESTUSDT", cfg);
  const fired: number[] = [];
  signals.forEach((s, t) => { if (s.direction !== "NO_TRADE") fired.push(t); });
  for (let i = 1; i < fired.length; i += 1) {
    const gap = (fired[i] as number) - (fired[i - 1] as number);
    assert.ok(gap > cfg.signalCooldownBars, `two signals ${gap} bars apart violate the ${cfg.signalCooldownBars}-bar cooldown`);
  }
});

test("cooldown bars are explicitly labelled so the audit trail shows why nothing fired", () => {
  const cfg = { ...DEFAULT_STRATEGY, warmupBars: 20, signalCooldownBars: 3 };
  const signals = evaluateAll(walkSeries(600, { seed: 99, vol: 0.01 }), "TESTUSDT", cfg);
  const first = signals.findIndex((s) => s.direction !== "NO_TRADE");
  if (first < 0) return; // no signal in this seed - nothing to assert
  for (let t = first + 1; t <= Math.min(first + cfg.signalCooldownBars, signals.length - 1); t += 1) {
    assert.equal(signals[t]!.direction, "NO_TRADE");
    assert.equal(signals[t]!.conditions.cooldown, true, `bar ${t} must be marked as cooldown-suppressed`);
  }
});

test("every directional signal names a setup and exposes its mandatory-condition audit", () => {
  const signals = evaluateAll(walkSeries(900, { seed: 2026, vol: 0.012 }), "TESTUSDT");
  for (const s of signals) {
    if (s.direction === "SHORT") {
      assert.equal(s.setupType, "BEARISH_DIVERGENCE");
      for (const k of ["structure", "divergence", "exhaustion", "redDot", "rejection"]) {
        assert.equal(s.conditions[k], true, `a SHORT signal must prove ${k} was satisfied`);
      }
    }
    if (s.direction === "LONG") {
      assert.equal(s.setupType, "BREAKOUT_RETEST");
      for (const k of ["breakoutRetest", "momentumReset", "trigger"]) {
        assert.equal(s.conditions[k], true, `a LONG signal must prove ${k} was satisfied`);
      }
    }
  }
});

test("signal timestamps are the bar's own open time (never a future bar)", () => {
  const series = walkSeries(400, { seed: 31337 });
  const signals = evaluateAll(series, "TESTUSDT");
  signals.forEach((s, t) => {
    assert.equal(s.ts, series[t]!.ts, `bar ${t} must be stamped with its own candle ts`);
    assert.ok(s.ts <= series[series.length - 1]!.ts);
  });
});

test("HTF veto: a deterministic setup with no 1h structure is forced to NO_TRADE", () => {
  const trigger = flatSeries(50, 100, M15);
  const index = buildHtfIndex([], "1h"); // no higher-timeframe bars at all
  assert.equal(index.bars, 0);

  const shortSignal = {
    ts: trigger[10]!.ts, symbol: "TESTUSDT", direction: "SHORT" as const, setupType: "BEARISH_DIVERGENCE" as const,
    conditions: { structure: true, divergence: true, exhaustion: true, redDot: true, rejection: true },
    swingHigh: 101, swingLow: null, supportLevel: null, resistanceLevel: 101,
  };
  const longSignal = { ...shortSignal, direction: "LONG" as const, setupType: "BREAKOUT_RETEST" as const, conditions: { breakoutRetest: true, momentumReset: true, trigger: true }, swingHigh: null, swingLow: 99, supportLevel: 99, resistanceLevel: null };

  const signals = trigger.map((c, t) => (t === 10 ? shortSignal : t === 20 ? longSignal : { ...shortSignal, direction: "NO_TRADE" as const, setupType: "NONE" as const, conditions: {}, ts: c.ts, swingHigh: null, swingLow: null, supportLevel: null, resistanceLevel: null }));
  const res = applyHtfStructure(signals, trigger, "15m", index, DEFAULT_HTF);

  assert.equal(res.checked, 2, "both deterministic setups were checked against HTF structure");
  assert.equal(res.vetoed, 2, "with no 1h bars both must be vetoed");
  assert.equal(res.anchored, 0);
  assert.equal(res.signals[10]!.direction, "NO_TRADE", "the vetoed SHORT cannot survive");
  assert.equal(res.signals[10]!.setupType, "NONE");
  assert.equal(res.signals[10]!.conditions.htfStructure, false, "the veto reason is recorded in the audit trail");
  assert.equal(res.signals[20]!.direction, "NO_TRADE", "the vetoed LONG cannot survive");
  assert.equal(res.signals[10]!.resistanceLevel, null, "a vetoed signal must not carry a price reference into the risk engine");
  assert.equal(res.signals[20]!.supportLevel, null);
});

test("HTF anchoring only ever uses levels from 1h bars that had already CLOSED", () => {
  // 20 1h bars: peak (high 110.5) at index 10, trough (low 99.5) at index 15.
  // With arm=2 the peak is confirmed at index 12 and the trough at index 17.
  const levels = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
    108, 106, 104, 102, 100,
    101, 102, 103, 104,
  ];
  const htf = levels.map((lvl, i) =>
    candle(T0 + i * H1, lvl, lvl + 0.5, lvl - 0.5, lvl, 1000));
  const cfg = { ...DEFAULT_HTF, arm: 2 };
  const index = buildHtfIndex(htf, "1h", cfg);

  // --- Causality: walk forward one bar at a time and watch structure appear LATE.
  // The peak cannot be referenced before bar 12 has closed (ts >= T0 + 13h).
  for (let k = 0; k <= 12; k += 1) {
    const lvl = index.at(T0 + k * H1, 105);
    assert.notEqual(lvl.resistance, 110.5, `the 110.5 swing high must not be visible at closed-bar index ${k}`);
  }
  const afterConfirm = index.at(T0 + 13 * H1, 110);
  assert.equal(afterConfirm.resistance, 110.5, "once bar 12 has CLOSED the confirmed swing high becomes usable");

  // The trough cannot be referenced before bar 17 has closed (ts >= T0 + 18h).
  for (let k = 0; k <= 17; k += 1) {
    const lvl = index.at(T0 + k * H1, 100);
    assert.notEqual(lvl.support, 99.5, `the 99.5 swing low must not be visible at closed-bar index ${k}`);
  }
  assert.equal(index.at(T0 + 18 * H1, 100).support, 99.5, "the trough becomes usable only after its confirmation bar closes");

  // Before ANY 1h bar has closed there is no structure at all.
  assert.deepEqual(index.at(T0 - 1, 105), { resistance: null, support: null });

  // --- Anchoring: a surviving SHORT is re-pointed onto the 1h resistance,
  //     and a surviving LONG onto the 1h support.
  // Trigger bars AFTER every 1h bar has closed, priced inside the 0.6% HTF tolerance:
  // the SHORT sits at the 1h swing high, the LONG at the 1h swing low.
  const trigger = flatSeries(10, 105, M15, T0 + 20 * H1);
  trigger[2] = candle(trigger[2]!.ts, 110, 110.4, 109.6, 110);
  trigger[4] = candle(trigger[4]!.ts, 100, 100.4, 99.6, 100);
  const shortSignal = {
    ts: trigger[2]!.ts, symbol: "TESTUSDT", direction: "SHORT" as const, setupType: "BEARISH_DIVERGENCE" as const,
    conditions: { structure: true, divergence: true, exhaustion: true, redDot: true, rejection: true },
    swingHigh: 109.9, swingLow: null, supportLevel: null, resistanceLevel: 109.9,
  };
  const longSignal = {
    ts: trigger[4]!.ts, symbol: "TESTUSDT", direction: "LONG" as const, setupType: "BREAKOUT_RETEST" as const,
    conditions: { breakoutRetest: true, momentumReset: true, trigger: true },
    swingHigh: null, swingLow: 100.1, supportLevel: 100.1, resistanceLevel: null,
  };
  const signals = trigger.map((c, t) =>
    t === 2 ? shortSignal : t === 4 ? longSignal : { ...shortSignal, ts: c.ts, direction: "NO_TRADE" as const, setupType: "NONE" as const, conditions: {} });
  const res = applyHtfStructure(signals, trigger, "15m", index, cfg);
  assert.equal(res.vetoed, 0, "with confirmed 1h structure in tolerance nothing should be vetoed");
  assert.equal(res.anchored, 2);
  assert.equal(res.signals[2]!.resistanceLevel, 110.5, "the SHORT stop reference is re-anchored onto the 1h swing high");
  assert.equal(res.signals[2]!.swingHigh, 110.5);
  assert.equal(res.signals[4]!.supportLevel, 99.5, "the LONG stop reference is re-anchored onto the 1h swing low");
  assert.equal(res.signals[4]!.swingLow, 99.5);
});

test("applyHtfStructure with htf disabled is a pass-through (no silent veto, no anchoring)", () => {
  const trigger = flatSeries(30, 100, M15);
  const index = buildHtfIndex([], "1h");
  const signal = {
    ts: trigger[5]!.ts, symbol: "TESTUSDT", direction: "SHORT" as const, setupType: "BEARISH_DIVERGENCE" as const,
    conditions: { structure: true }, swingHigh: 101, swingLow: null, supportLevel: null, resistanceLevel: 101,
  };
  const signals = trigger.map((c, t) => (t === 5 ? signal : { ...signal, ts: c.ts, direction: "NO_TRADE" as const, setupType: "NONE" as const, conditions: {} }));
  const res = applyHtfStructure(signals, trigger, "15m", index, { ...DEFAULT_HTF, enabled: false });
  assert.equal(res.vetoed, 0);
  assert.equal(res.anchored, 0);
  assert.equal(res.signals[5]!.direction, "SHORT", "disabling the HTF leg must not alter the deterministic signal");
});