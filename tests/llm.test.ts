/**
 * LLM-LAYER TESTS.
 *
 * The invariant: the LLM is a CONFLUENCE COMMENTATOR, not a decision maker. It may
 * move `confidence_score` inside a bounded range and add rationale; it may never set
 * or flip `direction`, never invent a setup, never turn a NO_TRADE into a trade, and
 * never touch the execution prices, stop or targets produced by the risk engine.
 * A failing provider must degrade to the deterministic rule-derived decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refineDecision } from "../src/llm/layer.ts";
import { MockLlmProvider } from "../src/llm/mock.ts";
import { buildLlmInput, buildPrompt, PROMPT_VERSION } from "../src/llm/normalize.ts";
import { validateConfluence, validateExecutionDecision } from "../src/llm/schema.ts";
import type { LlmProvider } from "../src/llm/provider.ts";
import type { CipherBState, ExecutionDecision, RiskPlan, SetupType, StrategySignal } from "../src/types.ts";
import { T0 } from "./helpers.ts";

const META = { model: "test-model", promptVersion: PROMPT_VERSION };

function plan(over: Partial<RiskPlan> = {}): RiskPlan {
  return {
    approved: true, reasons: [], entryPrice: 100, stopLoss: 99, takeProfit1: 101.5,
    takeProfit2: 102.5, quantity: 5, notional: 500, riskAmount: 50, riskRewardRatio: 2.5,
    stopDistancePct: 1, intendedRiskPct: 0.5, intendedQuantity: 5, intendedNotional: 500,
    notionalCapApplied: false, actualRiskPct: 0.5, actualRiskAmount: 50,
    bindingConstraint: "risk-budget", ...over,
  };
}

function cipher(over: Partial<CipherBState> = {}): CipherBState {
  return {
    ts: T0, wt: { ap: 100, esa: 95, d: 2, ci: 80, os1: 70, os2: 65 }, momentumWave: 70,
    dot: 1, overbought: true, oversold: false, bearishDivergence: true, bullishDivergence: false,
    ...over,
  };
}

function signal(direction: "LONG" | "SHORT" | "NO_TRADE", setupType: SetupType, conditions: Record<string, boolean>): StrategySignal {
  return {
    ts: T0, symbol: "BTCUSDT", direction, setupType, conditions,
    swingHigh: direction === "SHORT" ? 101 : null,
    swingLow: direction === "LONG" ? 99 : null,
    supportLevel: direction === "LONG" ? 99 : null,
    resistanceLevel: direction === "SHORT" ? 101 : null,
  };
}

const shortSignal = () => signal("SHORT", "BEARISH_DIVERGENCE", {
  structure: true, divergence: true, exhaustion: true, redDot: true, rejection: true,
});
const longSignal = () => signal("LONG", "BREAKOUT_RETEST", { breakoutRetest: true, momentumReset: true, trigger: true });
const noTradeSignal = () => signal("NO_TRADE", "NONE", { structure: false, divergence: true });

/** A provider that returns whatever text it is told to. */
function scripted(text: string, model = "scripted"): LlmProvider {
  return { name: "scripted", model, async complete(): Promise<string> { return text; } };
}
function failing(): LlmProvider {
  return {
    name: "failing", model: "failing",
    async complete(): Promise<string> { throw new Error("provider unavailable"); },
  };
}

test("MockLlmProvider is deterministic: same prompt always yields the same JSON", async () => {
  const mock = new MockLlmProvider();
  const prompt = buildPrompt(buildLlmInput(shortSignal(), cipher(), plan()));
  const first = await mock.complete(prompt);
  for (let i = 0; i < 5; i += 1) assert.equal(await mock.complete(prompt), first, "the mock must never vary between calls");
  const parsed = validateConfluence(JSON.parse(first));
  assert.equal(parsed.ok, true);
  assert.equal(mock.model, "mock-deterministic-v1");
});

test("MockLlmProvider maps satisfied-condition count to confluence bands", async () => {
  const mock = new MockLlmProvider();
  const strong = validateConfluence(JSON.parse(await mock.complete(buildPrompt({ conditions_satisfied: ["a", "b", "c", "d", "e"] }))));
  const moderate = validateConfluence(JSON.parse(await mock.complete(buildPrompt({ conditions_satisfied: ["a", "b", "c"] }))));
  const weak = validateConfluence(JSON.parse(await mock.complete(buildPrompt({ conditions_satisfied: ["a"] }))));
  assert.equal(strong.value?.confluence, "strong");
  assert.equal(moderate.value?.confluence, "moderate");
  assert.equal(weak.value?.confluence, "weak");
  assert.ok((strong.value?.confidence_adjustment ?? 0) > (weak.value?.confidence_adjustment ?? 0));
});

test("the LLM can move confidence but NEVER the direction", async () => {
  const attempts = [
    '{"confluence":"strong","confidence_adjustment":0.15,"notes":["n"]}',
    '{"confluence":"weak","confidence_adjustment":-0.15,"notes":["n"]}',
    '{"confluence":"strong","confidence_adjustment":99,"notes":["n"]}', // out of range, must be clamped
    '{"confluence":"weak","confidence_adjustment":-99,"notes":["n"]}',
  ];
  for (const raw of attempts) {
    for (const sig of [shortSignal(), longSignal()]) {
      const d = await refineDecision(sig, cipher(), plan(), scripted(raw), META);
      assert.equal(d.direction, sig.direction, `direction must equal the deterministic signal for ${raw}`);
      assert.equal(d.setup_type, sig.setupType, `setup_type must equal the deterministic signal for ${raw}`);
      assert.equal(d.provenance.deterministicGate, sig.setupType);
      assert.ok(d.confidence_score >= 0 && d.confidence_score <= 1, "confidence stays inside [0,1]");
      assert.ok(d.confidence_score <= 0.95 + 1e-12, "confidence is hard-capped at 0.95");
    }
  }
});

test("a NO_TRADE signal can never be promoted to a trade, whatever the LLM says", async () => {
  const hostile = [
    '{"confluence":"strong","confidence_adjustment":0.15,"notes":["take the trade"]}',
    '{"direction":"LONG","setup_type":"BREAKOUT_RETEST","confidence_score":1}', // schema-violating override attempt
    "not json at all",
  ];
  for (const raw of hostile) {
    const d = await refineDecision(noTradeSignal(), cipher(), plan(), scripted(raw), META);
    assert.equal(d.direction, "NO_TRADE", `NO_TRADE must survive ${raw}`);
    assert.equal(d.setup_type, "NONE");
    assert.equal(d.confidence_score, 0);
    assert.equal(d.provenance.llmUsed, false, "the LLM is not even consulted on a NO_TRADE");
    assert.deepEqual(d.execution, {
      entry_price: 0, stop_loss: 0, take_profit_1: 0, take_profit_2: 0, risk_reward_ratio: 0,
    }, "a NO_TRADE must carry a zeroed execution block");
    assert.ok(d.rationale.some((r) => r.includes("mandatory conditions not satisfied")));
    assert.ok(d.rationale.join(" ").includes("structure"), "the unmet condition is named in the rationale");
  }
});

test("the LLM cannot alter entry, stop or targets - those come from the risk engine", async () => {
  const p = plan({ entryPrice: 123.456789, stopLoss: 120, takeProfit1: 126, takeProfit2: 130, riskRewardRatio: 2.1 });
  const d = await refineDecision(shortSignal(), cipher(), p, scripted('{"confluence":"strong","confidence_adjustment":0.1,"notes":["x"]}'), META);
  assert.equal(d.execution.entry_price, Math.round(p.entryPrice * 1e6) / 1e6);
  assert.equal(d.execution.stop_loss, p.stopLoss);
  assert.equal(d.execution.take_profit_1, p.takeProfit1);
  assert.equal(d.execution.take_profit_2, p.takeProfit2);
  assert.equal(d.execution.risk_reward_ratio, 2.1);
});

test("a failing provider degrades to the deterministic rule-derived decision", async () => {
  const withLlm = await refineDecision(shortSignal(), cipher(), plan(), null, META);
  const failed = await refineDecision(shortSignal(), cipher(), plan(), failing(), META);
  assert.equal(failed.direction, withLlm.direction, "same direction as the no-provider baseline");
  assert.equal(failed.confidence_score, withLlm.confidence_score, "a failed provider must fall back to the identical confidence");
  assert.deepEqual(failed.execution, withLlm.execution);
  assert.equal(failed.provenance.llmUsed, false);
  assert.equal(failed.provenance.model, META.model, "the fallback reports the configured model, not the dead provider");
  assert.ok(failed.rationale.some((r) => r.includes("llm unavailable")), "the fallback is disclosed in the rationale");
});

test("malformed or schema-violating LLM output is rejected, not trusted", async () => {
  const garbage = ["", "null", "[]", '{"confluence":"maybe"}', '{"confidence_adjustment":"abc"}', "{broken json"];
  const baseline = await refineDecision(shortSignal(), cipher(), plan(), null, META);
  for (const raw of garbage) {
    const d = await refineDecision(shortSignal(), cipher(), plan(), scripted(raw), META);
    assert.equal(d.provenance.llmUsed, false, `${JSON.stringify(raw)} must not count as LLM input`);
    assert.equal(d.confidence_score, baseline.confidence_score, `${JSON.stringify(raw)} must not move confidence`);
  }
});

test("JSON embedded in prose is still parsed, and provenance records the real model", async () => {
  const d = await refineDecision(
    shortSignal(), cipher(), plan(),
    scripted('Sure! Here you go:\n```json\n{"confluence":"moderate","confidence_adjustment":0.02,"notes":["mixed"]}\n```\nHope that helps.'),
    META,
  );
  assert.equal(d.provenance.llmUsed, true, "JSON inside prose must still be extracted");
  assert.equal(d.provenance.model, "scripted", "provenance names the provider that actually answered");
  assert.equal(d.provenance.promptVersion, PROMPT_VERSION);
  assert.ok(d.rationale.some((r) => r === "mixed"), "LLM notes are surfaced in the rationale");
});

test("validateConfluence clamps the adjustment into [-0.15, 0.15] and rejects bad payloads", () => {
  assert.equal(validateConfluence(null).ok, false);
  assert.equal(validateConfluence("nope").ok, false);
  assert.equal(validateConfluence({ confluence: "extreme", confidence_adjustment: 0 }).ok, false);
  assert.equal(validateConfluence({ confluence: "strong", confidence_adjustment: NaN }).ok, false);
  const clamped = validateConfluence({ confluence: "strong", confidence_adjustment: 5 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.value?.confidence_adjustment, 0.15, "the adjustment is bounded so the LLM cannot force certainty");
  assert.equal(validateConfluence({ confluence: "weak", confidence_adjustment: -5 }).value?.confidence_adjustment, -0.15);
  const notes = validateConfluence({ confluence: "moderate", confidence_adjustment: 0, notes: ["a", 1, null, "b"] });
  assert.deepEqual(notes.value?.notes, ["a", "b"], "non-string notes are dropped");
});

test("validateExecutionDecision enforces the published CipherEdge output schema", () => {
  const good = {
    symbol: "BTCUSDT", direction: "SHORT", setup_type: "BEARISH_DIVERGENCE", confidence_score: 0.7,
    execution: { entry_price: 100, stop_loss: 101, take_profit_1: 98, take_profit_2: 96, risk_reward_ratio: 2 },
    rationale: ["a", "b"],
  };
  assert.equal(validateExecutionDecision(good).ok, true);
  assert.equal(validateExecutionDecision(null).ok, false);
  assert.equal(validateExecutionDecision({ ...good, direction: "SIDEWAYS" }).ok, false, "direction must stay inside the enum");
  assert.equal(validateExecutionDecision({ ...good, setup_type: "YOLO" }).ok, false, "setup_type must stay inside the enum");
  assert.equal(validateExecutionDecision({ ...good, confidence_score: 1.5 }).ok, false);
  assert.equal(validateExecutionDecision({ ...good, confidence_score: -0.1 }).ok, false);
  assert.equal(validateExecutionDecision({ ...good, execution: { ...good.execution, stop_loss: "soon" } }).ok, false);
  assert.equal(validateExecutionDecision({ ...good, execution: undefined }).ok, false);
  assert.equal(validateExecutionDecision({ ...good, rationale: "not an array" }).ok, false);
  assert.equal(validateExecutionDecision({ ...good, rationale: ["ok", 42] }).ok, false);
  const errors = validateExecutionDecision({ ...good, direction: "NOPE", confidence_score: 9 }).errors;
  assert.ok(errors.length >= 2, "every violation is reported, not just the first");
});

test("the prompt tells the LLM it may not change direction, and leaks no secrets or future bars", () => {
  const input = buildLlmInput(shortSignal(), cipher(), plan());
  const prompt = buildPrompt(input);
  assert.match(prompt, /must not change it/, "the prompt states the direction is already decided");
  assert.match(prompt, /confluence/, "the LLM is scoped to confluence assessment");
  assert.ok(!/api[_-]?key/i.test(prompt), "no key material in the prompt");
  assert.ok(!/authorization/i.test(prompt), "no auth headers in the prompt");
  assert.ok(!/C:\\\\|\/Users\/|\/home\//.test(prompt), "no local filesystem paths in the prompt");
  // Only bounded, de-identified numbers are shared - no raw candle arrays.
  assert.ok(!Array.isArray((input as Record<string, unknown>).candles), "raw candles are never sent to the model");
  const keys = Object.keys(input);
  for (const k of ["setup_type", "direction", "conditions_satisfied", "momentum_wave", "stop_distance_pct", "risk_reward_ratio"]) {
    assert.ok(keys.includes(k), `the normalized input must include ${k}`);
  }
});

test("confidence floor: a veto can skip a trade but can never create one", async () => {
  // The floor is applied by the backtest engine, not by refineDecision; here we assert the
  // numbers the engine compares against behave as documented.
  const high = await refineDecision(shortSignal(), cipher(), plan(), scripted('{"confluence":"strong","confidence_adjustment":0.15,"notes":[]}'), META);
  const low = await refineDecision(shortSignal(), cipher({ dot: 0, overbought: false, bearishDivergence: false }), plan(), scripted('{"confluence":"weak","confidence_adjustment":-0.15,"notes":[]}'), META);
  assert.ok(high.confidence_score > low.confidence_score, "a weak confluence must score below a strong one");
  // 0.95 is the hard ceiling in refineDecision: base confidence 0.80 + a maximal 0.15
  // adjustment. A floor ABOVE that ceiling therefore vetoes everything, which is the
  // only way the LLM layer can suppress a trade - it can never create one.
  assert.equal(high.confidence_score, 0.95, "the strongest reachable confidence is exactly the 0.95 ceiling");
  assert.ok(low.confidence_score < 0.95, "a weak confluence stays below the ceiling");
  const vetoEverything = 0.96;
  assert.equal(high.confidence_score < vetoEverything, true, "a floor above the ceiling vetoes even the strongest setup");
  // A floor BETWEEN the two scores vetoes the weak setup only - the veto is selective,
  // and it only ever removes trades.
  const selective = (high.confidence_score + low.confidence_score) / 2;
  assert.equal(low.confidence_score < selective, true, "the weak setup is vetoed by a mid-range floor");
  assert.equal(high.confidence_score >= selective, true, "the strong setup survives the same floor");
  const noTrade = await refineDecision(noTradeSignal(), cipher(), plan(), scripted('{"confluence":"strong","confidence_adjustment":0.15,"notes":[]}'), META);
  assert.equal(noTrade.confidence_score, 0, "a NO_TRADE scores 0, so a floor can only ever suppress it further");
});

test("refineDecision is deterministic for a deterministic provider (reproducible runs)", async () => {
  const mock = new MockLlmProvider();
  const a: ExecutionDecision = await refineDecision(shortSignal(), cipher(), plan(), mock, META);
  const b: ExecutionDecision = await refineDecision(shortSignal(), cipher(), plan(), mock, META);
  assert.deepEqual(a, b, "two identical runs must produce byte-identical decisions");
});