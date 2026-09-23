/**
 * Paper-trading harness.
 *
 * CipherEdge NEVER places a real order. This module has two modes and both are
 * simulation only:
 *
 *   replay  (default, offline) - replays the committed historical candles bar by bar
 *           through the exact same deterministic engine, risk gate and cost model used
 *           by the backtest, and writes an append-only paper ledger. Every number in the
 *           ledger is OBSERVED from that replay; nothing is projected or fabricated.
 *           Because it replays history, it is labelled a replay, not live paper trading.
 *
 *   signal  (opt-in, read-only network) - pulls the latest PUBLIC candles from Bitget's
 *           keyless spot REST endpoint and emits the strict-JSON ExecutionDecision for the
 *           most recent closed bars. It signs nothing, reads no API key, and sends no
 *           order. Prices in this mode are indicative reference prices, because the real
 *           entry would be the next bar's open, which does not exist yet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { resolveDataDir } from "../config.ts";
import type { Candle, ExecutionDecision, TradeRecord } from "../types.ts";
import { runBacktest } from "../backtest/engine.ts";
import type { BacktestResult } from "../backtest/engine.ts";
import { writeReport } from "../report/report.ts";
import { preflightData, assertPreflightOk, preflightMarkdown, usableSymbols } from "../data/preflight.ts";
import { BitgetCandleClient } from "../data/bitget.ts";
import { computeCipherB } from "../indicators/cipherB.ts";
import { evaluateAll } from "../strategy/engine.ts";
import { applyHtfStructure, buildHtfIndex } from "../strategy/mtf.ts";
import { evaluateRisk } from "../risk/engine.ts";
import { refineDecision } from "../llm/layer.ts";
import { MockLlmProvider } from "../llm/mock.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { granularityMs, isoUtc } from "../util/time.ts";
import {
  buildPaperLedger,
  paperEventsCsv,
  paperRecordsCsv,
  tradesToPaperEvents,
  tradesToPaperRecords,
} from "./records.ts";
import type { PaperEvent, PaperLedger } from "./records.ts";
import type { PaperRecord } from "../types.ts";

/** Hard stop: refuse to run at all if the config claims it can place real orders. */
export function assertNoRealOrders(cfg: AppConfig): void {
  if (cfg.meta.placesRealOrders !== false) {
    throw new Error("meta.placesRealOrders must be false - CipherEdge is a research/paper-trading agent and cannot place real orders");
  }
}

export interface PaperReplayOptions {
  cfg: AppConfig;
  runId: string;
  outDir: string;
  dataDir?: string;
  symbols?: string[];
  days?: number;
  outOfSampleDays?: number;
  startingCapital?: number;
  triggerGranularity?: string;
  structureGranularity?: string;
  useLlm?: boolean;
  llmProvider?: LlmProvider | null;
  /** Skip the strict gate (used only for the labelled lower-completeness sensitivity run). */
  skipPreflight?: boolean;
  onProgress?: (msg: string) => void;
}

export interface PaperReplayResult {
  runId: string;
  mode: "replay";
  dir: string;
  files: string[];
  ledger: PaperLedger;
  records: PaperRecord[];
  events: PaperEvent[];
  backtest: BacktestResult;
  preflight: string;
  validatedUniverse: boolean;
}

/**
 * Replay paper trading over committed candles, then write the ledger and the full
 * backtest report into the same run directory so the two can never drift apart.
 */
export async function runPaperReplay(opts: PaperReplayOptions): Promise<PaperReplayResult> {
  const { cfg } = opts;
  assertNoRealOrders(cfg);
  const log = opts.onProgress ?? (() => undefined);
  const dataDir = opts.dataDir ?? resolveDataDir(cfg.backtest.dataDir);
  const triggerGran = opts.triggerGranularity ?? cfg.backtest.triggerGranularity;
  const structureGran = opts.structureGranularity ?? cfg.backtest.structureGranularity;
  const requested = opts.symbols ?? cfg.backtest.symbols;

  const gate = await preflightData({
    dataDir,
    symbols: requested,
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    resampleFrom: cfg.backtest.resampleFrom,
    gate: cfg.dataQuality,
    allowNetwork: false,
  });
  if (!opts.skipPreflight) assertPreflightOk(gate);
  const symbols = opts.skipPreflight ? requested : usableSymbols(gate);
  if (symbols.length === 0) throw new Error("no symbols passed the data-quality gate - nothing to replay");
  const validatedUniverse = gate.allPassed && requested.join(",") === cfg.backtest.symbols.join(",");
  log(`preflight: ${gate.symbolsPassed.length}/${gate.symbolsChecked.length} symbols passed the data-quality gate`);

  const result = await runBacktest({
    cfg,
    dataDir,
    symbols,
    days: opts.days,
    outOfSampleDays: opts.outOfSampleDays,
    startingCapital: opts.startingCapital,
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    useLlm: opts.useLlm,
    llmProvider: opts.llmProvider,
    collectDecisions: true,
    onProgress: log,
  });

  const startingBalance = opts.startingCapital ?? cfg.backtest.startingCapital;
  const records = tradesToPaperRecords(result.trades, startingBalance);
  const events = tradesToPaperEvents(result.trades, startingBalance);
  const ledger = buildPaperLedger(events, startingBalance, {
    mode: "replay",
    dataSource: `replay of committed Bitget public spot candles (${triggerGran} trigger / ${structureGran} structure) - NOT a live feed`,
    windowFromIso: result.window.fromIso,
    windowToIso: result.window.toIso,
  });

  const notes = [
    "## Data quality gate (pre-flight)",
    "",
    `Gate: completeness >= ${cfg.dataQuality.requireCompletenessPct}%, max adjacent gap <= ${cfg.dataQuality.maxAdjacentGapBars} bars, strict=${cfg.dataQuality.strict}.`,
    "",
    preflightMarkdown(gate),
    "",
    validatedUniverse
      ? "All requested symbols passed, so this run uses the validated universe."
      : "Some requested symbols did NOT pass the gate; this run is a labelled lower-completeness sensitivity run and must not be quoted as validated.",
    "",
    "## Paper-trading ledger",
    "",
    `- Mode: **replay** of committed historical candles. This is simulation, not live execution and not live paper trading.`,
    `- Places real orders: **no** (\`meta.placesRealOrders=false\`, enforced by \`assertNoRealOrders\`).`,
    `- Files: \`paper-trades.csv\` (required run-record schema), \`paper-events.csv\` (entry/exit log with running balance).`,
    `- Starting balance ${ledger.startingBalance}, ending balance ${ledger.endingBalance}, net change ${ledger.netChange} (${ledger.netChangePct}%). All OBSERVED from this replay.`,
    `- Round trips ${ledger.roundTrips} (wins ${ledger.wins}, losses ${ledger.losses}).`,
    `- MODELLED costs deducted: fees ${ledger.totalFees}, slippage ${ledger.totalSlippage}, funding ${ledger.totalFunding}. These are assumptions from \`config/default.json\`, not observed fills.`,
    `- Entry events settle 0 balance change: fees, slippage and funding are settled with realised PnL at exit, matching the backtest ledger.`,
  ];

  const dir = join(opts.outDir, opts.runId);
  mkdirSync(dir, { recursive: true });
  const written = writeReport(result, { runId: opts.runId, outDir: dir, barMinutes: granularityMs(triggerGran) / 60_000 }, notes);
  const files = [...written.files];

  const write = (name: string, text: string): void => {
    const p = join(dir, name);
    writeFileSync(p, text, "utf8");
    files.push(p);
  };
  write("paper-trades.csv", paperRecordsCsv(records));
  write("paper-events.csv", paperEventsCsv(events));
  write("paper-summary.json", `${JSON.stringify({ ledger, gate: { checkedAt: gate.checkedAt, gate: gate.gate, symbolsPassed: gate.symbolsPassed, symbolsFailed: gate.symbolsFailed, allPassed: gate.allPassed }, validatedUniverse }, null, 2)}\n`);

  return { runId: opts.runId, mode: "replay", dir, files, ledger, records, events, backtest: result, preflight: preflightMarkdown(gate), validatedUniverse };
}

export interface SignalSeries {
  symbol: string;
  trigger: Candle[];
  structure: Candle[];
}

export interface SignalDecision {
  signalTs: number;
  signalIso: string;
  decision: ExecutionDecision;
  approved: boolean;
  reasons: string[];
  /** Reference equity used for sizing; in signal mode this is the configured paper capital. */
  equity: number;
}

export interface SignalResult {
  mode: "signal";
  generatedAt: string;
  triggerGranularity: string;
  structureGranularity: string;
  barsUsed: number;
  decisions: SignalDecision[];
  placesRealOrders: false;
  note: string;
}

/**
 * Pure decision pass over already-loaded candles: evaluate the strategy on the most
 * recent CLOSED bars and emit the strict-JSON ExecutionDecision for each.
 *
 * Deterministic core, so it is unit-testable with no network. `equity` is only a sizing
 * reference - no order is created, sent or simulated as filled here.
 */
export function decideRecentBars(
  cfg: AppConfig,
  series: SignalSeries[],
  opts: { bars?: number; equity?: number; provider?: LlmProvider | null } = {},
): Promise<SignalDecision[]> {
  const bars = opts.bars ?? 1;
  const equity = opts.equity ?? cfg.backtest.startingCapital;
  const provider = opts.provider ?? null;
  const triggerGran = cfg.backtest.triggerGranularity;
  const structureGran = cfg.backtest.structureGranularity;
  const out: SignalDecision[] = [];

  const work = series.map((s) => {
    const raw = evaluateAll(s.trigger, s.symbol, cfg.strategy);
    const index = buildHtfIndex(s.structure, structureGran, cfg.htf);
    const htf = applyHtfStructure(raw, s.trigger, triggerGran, index, cfg.htf);
    const cipher = computeCipherB(s.trigger, cfg.strategy.cipherB);
    return { s, signals: htf.signals, cipher };
  });

  const tasks: Array<Promise<void>> = [];
  for (const { s, signals, cipher } of work) {
    const last = signals.length - 1;
    for (let i = Math.max(0, last - bars + 1); i <= last; i += 1) {
      const signal = signals[i];
      if (!signal) continue;
      const candle = s.trigger[i] as Candle;
      const risk = evaluateRisk(
        { equity, dayStartEquity: equity, openPositions: 0, signal, entryPrice: candle.close },
        cfg.risk,
      );
      const cipherState = cipher[i];
      tasks.push(
        refineDecision(signal, cipherState, risk, provider, {
          model: provider?.model ?? cfg.llm.model,
          promptVersion: cfg.llm.promptVersion,
        }).then((decision) => {
          out.push({
            signalTs: candle.ts,
            signalIso: isoUtc(candle.ts),
            decision,
            approved: risk.approved,
            reasons: risk.reasons,
            equity,
          });
        }),
      );
    }
  }

  return Promise.all(tasks).then(() => {
    out.sort((a, b) => a.signalTs - b.signalTs || a.decision.symbol.localeCompare(b.decision.symbol));
    return out;
  });
}

export interface PaperSignalOptions {
  cfg: AppConfig;
  symbols?: string[];
  bars?: number;
  outDir?: string;
  runId?: string;
  equity?: number;
  useLlm?: boolean;
  client?: BitgetCandleClient;
  onProgress?: (msg: string) => void;
}

/**
 * Read-only "what would CipherEdge say right now" pass over the latest PUBLIC candles.
 * Requires network. Signs nothing and places nothing.
 */
export async function runPaperSignal(opts: PaperSignalOptions): Promise<SignalResult> {
  const { cfg } = opts;
  assertNoRealOrders(cfg);
  const log = opts.onProgress ?? (() => undefined);
  const symbols = opts.symbols ?? cfg.backtest.symbols;
  const triggerGran = cfg.backtest.triggerGranularity;
  const structureGran = cfg.backtest.structureGranularity;
  const client = opts.client ?? new BitgetCandleClient();
  const now = Date.now();
  const from = now - 20 * 86_400_000;

  const series: SignalSeries[] = [];
  for (const symbol of symbols) {
    const trigger = await client.fetchRange(symbol, triggerGran, from, now);
    const structure = await client.fetchRange(symbol, structureGran, from, now);
    // Drop a still-open final bar: acting on it would be acting on an unfinished candle.
    const g = granularityMs(triggerGran);
    const closedTrigger = trigger.filter((c) => c.ts + g <= now);
    const hg = granularityMs(structureGran);
    const closedStructure = structure.filter((c) => c.ts + hg <= now);
    log(`${symbol}: ${closedTrigger.length} closed ${triggerGran} bars, ${closedStructure.length} closed ${structureGran} bars`);
    series.push({ symbol, trigger: closedTrigger, structure: closedStructure });
  }

  const provider: LlmProvider | null = opts.useLlm
    ? (cfg.llm.provider === "mock" ? new MockLlmProvider() : null)
    : null;
  const decisions = await decideRecentBars(cfg, series, { bars: opts.bars ?? 1, equity: opts.equity, provider });

  const result: SignalResult = {
    mode: "signal",
    generatedAt: new Date().toISOString(),
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    barsUsed: opts.bars ?? 1,
    decisions,
    placesRealOrders: false,
    note: "Read-only public market data. entry_price is an indicative reference (the last closed bar's close); real execution would be the NEXT bar's open. No order was created, signed or sent.",
  };

  if (opts.outDir && opts.runId) {
    const dir = join(opts.outDir, opts.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "signal-decisions.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    log(`signal decisions -> ${join(dir, "signal-decisions.json")}`);
  }
  return result;
}

/** Convenience for the CLI: a stable, sortable run id. */
export function makeRunId(prefix: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${prefix}_${stamp}Z`;
}

export type { PaperLedger, PaperEvent };
export type { TradeRecord };
