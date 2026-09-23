/**
 * CONFIG GUARDRAIL TESTS.
 *
 * Every number in the written strategy specification is enforced here at load time, so a
 * weakened config throws instead of silently trading differently. Also covers the stable
 * config hash that makes a report reproducible, and the committed default config itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { loadConfig, assertGuardrails, configHash, defaultConfigPath, repoRoot, resolveDataDir } from "../src/config.ts";
import { evaluateRisk, DEFAULT_RISK } from "../src/risk/engine.ts";
import type { StrategySignal } from "../src/types.ts";
import { T0 } from "./helpers.ts";
import type { AppConfig } from "../src/config.ts";

const real = loadConfig();

/** Deep-clone with one override applied, so each case isolates a single weakened guardrail. */
function mutate(patch: (c: AppConfig) => void): AppConfig {
  const copy = JSON.parse(JSON.stringify(real)) as AppConfig;
  patch(copy);
  return copy;
}

function rejects(patch: (c: AppConfig) => void, needle: string, label: string): void {
  const cfg = mutate(patch);
  assert.throws(() => assertGuardrails(cfg), (err: unknown) => {
    const msg = (err as Error).message;
    assert.match(msg, /config guardrails failed/, `${label}: must fail as a guardrail violation`);
    assert.ok(msg.includes(needle), `${label}: expected the message to mention "${needle}", got: ${msg}`);
    return true;
  }, `${label}: guardrails must reject this config`);
}

test("the committed default config passes every guardrail", () => {
  assert.doesNotThrow(() => assertGuardrails(real));
  assert.equal(real.meta.placesRealOrders, false, "CipherEdge never places real orders");
  assert.equal(real.meta.track, "Agentic Trading");
  assert.equal(real.risk.riskPerTradePct, 0.5, "0.5% intended risk per the specification");
  assert.equal(real.risk.maxRiskPerTradePct, 1.0, "1% risk ceiling per the specification");
  assert.equal(real.risk.minRiskReward, 1.5, "minimum 1.5 R:R per the specification");
  assert.equal(real.risk.maxConcurrentPositions, 3, "maximum 3 concurrent positions per the specification");
  assert.equal(real.risk.dailyLossCapPct, 2.0, "2% daily loss cap per the specification");
  assert.equal(real.execution.pessimisticIntraBar, true, "the stop-first intra-bar assumption stays on");
  assert.equal(real.backtest.days, 90, "90-day total window");
  assert.equal(real.backtest.outOfSampleDays, 30, "30-day out-of-sample window");
  assert.ok(real.backtest.days >= 60, "satisfies the 60-day minimum the run records require");
  assert.ok(real.backtest.outOfSampleDays >= 30, "satisfies the 30-day out-of-sample minimum");
  assert.equal(real.backtest.allowNetwork, false, "committed runs are offline and reproducible");
});

test("the momentum-wave formula is declared an UNVERIFIED ASSUMPTION in the config itself", () => {
  const text = readFileSync(defaultConfigPath(), "utf8");
  assert.match(text, /unverifiedAssumptions/);
  assert.ok(real.meta.unverifiedAssumptions.length > 0, "assumptions must be listed, not implied");
  assert.ok(
    real.meta.unverifiedAssumptions.some((a) => /momentumWave/i.test(a) && /not published|UNVERIFIED|has not/i.test(a)),
    "the momentum-wave formula must be flagged as unverified",
  );
  assert.ok(
    real.meta.unverifiedAssumptions.some((a) => /MODELLED|modeled/i.test(a)),
    "fees/slippage/funding must be flagged as MODELLED, not observed",
  );
});

test("placesRealOrders can never be enabled", () => {
  rejects((c) => { c.meta.placesRealOrders = true; }, "placesRealOrders", "real orders enabled");
});

test("per-trade risk cannot exceed the 1% specification ceiling", () => {
  rejects((c) => { c.risk.riskPerTradePct = 1.5; }, "riskPerTradePct", "risk per trade above ceiling");
  rejects((c) => { c.risk.maxRiskPerTradePct = 1.5; }, "maxRiskPerTradePct", "risk ceiling raised");
  rejects((c) => { c.risk.riskPerTradePct = 1.0; c.risk.maxRiskPerTradePct = 0.5; }, "exceeds risk.maxRiskPerTradePct", "intended risk above its own ceiling");
});

test("the 1.5 R:R floor cannot be lowered", () => {
  rejects((c) => { c.risk.minRiskReward = 1.0; }, "minRiskReward", "R:R floor weakened");
  rejects((c) => { c.risk.minRiskReward = 0; }, "minRiskReward", "R:R floor removed");
  rejects((c) => { c.risk.tp1Multiple = 1.0; }, "tp1Multiple", "TP1 inside the minimum R:R");
});

test("the 3-position and 2% daily-cap limits cannot be raised", () => {
  rejects((c) => { c.risk.maxConcurrentPositions = 4; }, "maxConcurrentPositions", "more than 3 concurrent positions");
  rejects((c) => { c.risk.maxConcurrentPositions = 100; }, "maxConcurrentPositions", "position limit removed");
  rejects((c) => { c.risk.dailyLossCapPct = 5; }, "dailyLossCapPct", "daily loss cap raised");
  rejects((c) => { c.risk.dailyLossCapPct = 2.01; }, "dailyLossCapPct", "daily loss cap nudged above 2%");
  rejects((c) => { c.risk.dailyLossCapPct = Number.NaN; }, "dailyLossCapPct", "NaN daily loss cap");
});

test("a zero or negative daily-loss cap is FAIL-CLOSED (halts all entries), never fail-open", () => {
  // The engine test is `dayLossPct >= dailyLossCapPct`, so a cap of 0 blocks every entry
  // including on a flat day. That is the safe direction: tightening, not disabling.
  const sig: StrategySignal = {
    ts: T0, symbol: "BTCUSDT", direction: "LONG", setupType: "BREAKOUT_RETEST",
    conditions: { breakoutRetest: true, momentumReset: true, trigger: true },
    swingHigh: null, swingLow: 99, supportLevel: 99, resistanceLevel: null,
  };
  const input = { equity: 10_000, dayStartEquity: 10_000, openPositions: 0, signal: sig, entryPrice: 100 };
  for (const cap of [0, -1]) {
    const p = evaluateRisk(input, { ...DEFAULT_RISK, dailyLossCapPct: cap, maxPositionNotionalPct: 100 });
    assert.equal(p.approved, false, `a ${cap}% daily cap must reject the entry`);
    assert.equal(p.quantity, 0, `a rejected plan must carry a zeroed size (cap ${cap})`);
    assert.ok(p.reasons.some((r) => r.includes("daily loss cap")), `the rejection must name the daily cap (cap ${cap})`);
  }
  // And the same setup IS approved at the specification cap, proving 0 is not just "always reject".
  const ok = evaluateRisk(input, { ...DEFAULT_RISK, dailyLossCapPct: 2, maxPositionNotionalPct: 100 });
  assert.equal(ok.approved, true, "the same signal is tradeable at the 2% specification cap");
});

test("the notional cap must stay a sane percentage of equity", () => {
  rejects((c) => { c.risk.maxPositionNotionalPct = 0; }, "maxPositionNotionalPct", "zero notional cap");
  rejects((c) => { c.risk.maxPositionNotionalPct = -5; }, "maxPositionNotionalPct", "negative notional cap");
  rejects((c) => { c.risk.maxPositionNotionalPct = 101; }, "maxPositionNotionalPct", "notional cap above 100%");
  // 33% is a legitimate sensitivity value, so it must be ACCEPTED - the guardrail is about
  // sanity, not about forbidding the documented comparison run.
  assert.doesNotThrow(() => assertGuardrails(mutate((c) => { c.risk.maxPositionNotionalPct = 33; })));
  assert.doesNotThrow(() => assertGuardrails(mutate((c) => { c.risk.maxPositionNotionalPct = 100; })));
});

test("the degenerate-stop gate cannot be disabled", () => {
  rejects((c) => { c.risk.minStopDistancePct = 0; }, "minStopDistancePct", "zero minimum stop distance");
  rejects((c) => { c.risk.minStopDistancePct = -1; }, "minStopDistancePct", "negative minimum stop distance");
});

test("the pessimistic stop-first fill assumption cannot be turned off", () => {
  rejects((c) => { c.execution.pessimisticIntraBar = false; }, "pessimisticIntraBar", "optimistic intra-bar fills");
});

test("overbought/oversold thresholds must stay on the correct side of zero", () => {
  rejects((c) => { c.strategy.cipherB.overbought = -60; }, "overbought", "negative overbought threshold");
  rejects((c) => { c.strategy.cipherB.oversold = 60; }, "oversold", "positive oversold threshold");
});

test("the backtest window cannot be shortened below the run-record minimums", () => {
  rejects((c) => { c.backtest.days = 30; }, "backtest.days", "30-day total window");
  rejects((c) => { c.backtest.days = 59; }, "backtest.days", "59-day total window");
  rejects((c) => { c.backtest.outOfSampleDays = 7; }, "outOfSampleDays", "7-day out-of-sample");
  rejects((c) => { c.backtest.outOfSampleDays = 29; }, "outOfSampleDays", "29-day out-of-sample");
  rejects((c) => { c.backtest.days = 60; c.backtest.outOfSampleDays = 60; }, "outOfSampleDays", "OOS equal to the whole window");
  rejects((c) => { c.backtest.days = 90; c.backtest.outOfSampleDays = 0; }, "outOfSampleDays", "no out-of-sample period");
});

test("the data-quality gate cannot be loosened below the validated-run floor", () => {
  rejects((c) => { c.dataQuality.requireCompletenessPct = 90; }, "requireCompletenessPct", "completeness floor below 95%");
  rejects((c) => { c.dataQuality.maxAdjacentGapBars = 0; }, "maxAdjacentGapBars", "gap tolerance of zero bars");
  rejects((c) => { c.dataQuality.maxAdjacentGapBars = 999; }, "maxAdjacentGapBars", "unbounded gap tolerance");
});

test("several violations at once are ALL reported (full audit trail, no short-circuit)", () => {
  const cfg = mutate((c) => {
    c.meta.placesRealOrders = true;
    c.risk.riskPerTradePct = 3;
    c.risk.minRiskReward = 0.5;
    c.risk.maxConcurrentPositions = 50;
    c.execution.pessimisticIntraBar = false;
  });
  assert.throws(() => assertGuardrails(cfg), (err: unknown) => {
    const msg = (err as Error).message;
    for (const needle of ["placesRealOrders", "riskPerTradePct", "minRiskReward", "maxConcurrentPositions", "pessimisticIntraBar"]) {
      assert.ok(msg.includes(needle), `expected "${needle}" in the guardrail report`);
    }
    return true;
  });
});

test("configHash is stable, order-independent and sensitive to real changes", () => {
  const { hash: _h, sourcePath: _s, ...body } = real;
  void _h; void _s;
  const a = configHash(body);
  const b = configHash(JSON.parse(JSON.stringify(body)));
  assert.equal(a, b, "the same resolved config always hashes identically");
  assert.match(a, /^[0-9a-f]{16}$/, "the hash is a 16-char hex digest");

  // Key insertion order must not change the hash (stableStringify).
  const reordered = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const keys = Object.keys(reordered).reverse();
  const shuffled: Record<string, unknown> = {};
  for (const k of keys) shuffled[k] = reordered[k];
  assert.equal(configHash(shuffled as unknown as typeof body), a, "key order must not affect the hash");

  // Any real change must change the hash, so a report can be tied to its exact config.
  const bumped = JSON.parse(JSON.stringify(body)) as typeof body;
  bumped.risk.riskPerTradePct = 0.4;
  assert.notEqual(configHash(bumped), a, "a changed risk parameter must change the hash");
  const bumped2 = JSON.parse(JSON.stringify(body)) as typeof body;
  bumped2.backtest.symbols = [...bumped2.backtest.symbols, "XRPUSDT"];
  assert.notEqual(configHash(bumped2), a, "a changed universe must change the hash");
});

test("loadConfig is deterministic and stamps the hash used by every report", () => {
  const again = loadConfig();
  assert.equal(again.hash, real.hash, "loading the same file twice yields the same hash");
  assert.equal(again.sourcePath, defaultConfigPath());
  assert.ok(real.hash.length === 16);
});

test("loadConfig throws on a missing config file rather than falling back silently", () => {
  assert.throws(() => loadConfig("config/does-not-exist.json"), /config not found/);
});

test("loadConfig rejects a tampered config file that weakens the specification", () => {
  const tampered = JSON.parse(readFileSync(defaultConfigPath(), "utf8")) as Record<string, Record<string, unknown>>;
  (tampered.risk as Record<string, unknown>).riskPerTradePct = 5;
  const path = `${repoRoot()}${sep}work${sep}tampered-config.json`;
  // work/ is gitignored scratch space - never part of the committed config surface.
  mkdirSync(`${repoRoot()}${sep}work`, { recursive: true });
  writeFileSync(path, JSON.stringify(tampered, null, 2));
  assert.throws(() => loadConfig(path), /riskPerTradePct/, "a tampered file must fail at load, not at trade time");
});

test("paths: repoRoot holds package.json and resolveDataDir honours absolute input", () => {
  assert.ok(existsSync(`${repoRoot()}${sep}package.json`), "repoRoot must be the directory holding package.json");
  const abs = resolveDataDir("data/candles");
  assert.ok(abs.startsWith(repoRoot()), "a relative dataDir resolves against the repository root");
  const explicit = process.platform === "win32" ? "C:\\somewhere\\else" : "/somewhere/else";
  assert.equal(resolveDataDir(explicit), explicit, "an absolute dataDir is used as-is");
});

test("the validated universe excludes the gapped rToken series; the extended list keeps them for the labelled sensitivity run", () => {
  for (const s of real.backtest.symbols) {
    assert.match(s, /^(BTC|ETH|SOL)USDT$/, `only 24/7 crypto pairs may be in the validated universe, found ${s}`);
  }
  assert.ok(real.backtest.extendedSymbols.length > real.backtest.symbols.length, "the extended universe is wider");
  for (const s of real.backtest.symbols) {
    assert.ok(real.backtest.extendedSymbols.includes(s), `${s} must also appear in the extended universe`);
  }
});

test("no secret material is committed in the config file", () => {
  const text = readFileSync(defaultConfigPath(), "utf8");
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), "no API key literal");
  assert.ok(!/"apiKey"\s*:\s*"[^"]+"/.test(text), "no inline apiKey value");
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), "no private key block");
  // The key is referenced by ENV VAR NAME only, never by value.
  assert.equal(real.llm.apiKeyEnv, "BITGET_QWEN_API_KEY");
  assert.ok(!Object.values(real.llm).some((v) => typeof v === "string" && /^[A-Za-z0-9]{32,}$/.test(v)), "no long opaque token strings in the llm block");
});