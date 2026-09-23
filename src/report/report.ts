import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EquityPoint, TradeRecord } from "../types.ts";
import type { BacktestResult, Funnel, SeriesStats } from "../backtest/engine.ts";
import { splitSample } from "../backtest/engine.ts";
import type { DataProvenance } from "../data/source.ts";
import { granularityMs, isoUtc } from "../util/time.ts";
import { round } from "../util/math.ts";
import { summarizeReturns, summarizeTrades } from "./metrics.ts";
import type { ReturnStats, TradeStats } from "./metrics.ts";

export interface SampleBlock {
  returns: ReturnStats;
  trades: TradeStats;
}

export interface ReportMetrics {
  runId: string;
  generatedAt: string;
  configHash: string;
  node: string;
  mode: string;
  placesRealOrders: boolean;
  window: BacktestResult["window"];
  full: SampleBlock;
  inSample: SampleBlock;
  outOfSample: SampleBlock;
  funnel: Funnel;
  seriesStats: SeriesStats[];
  provenance: DataProvenance[];
  overrides: Record<string, unknown>;
  unverifiedAssumptions: string[];
  costBasis: {
    fees: "MODELLED - Bitget spot taker bps from config; no live fills exist";
    slippage: "MODELLED - flat adverse bps; not measured against an order book";
    funding: "MODELLED - flat bps per 8h; spot rToken funding was not sampled";
    observedExecutionCosts: "NONE - CipherEdge has never placed an order";
  };
}

export interface ReportOptions {
  runId: string;
  outDir: string;
  barMinutes?: number;
  title?: string;
}

function block(equity: EquityPoint[], trades: TradeRecord[], startCapital: number, barMinutes: number): SampleBlock {
  return { returns: summarizeReturns(equity, startCapital, barMinutes), trades: summarizeTrades(trades) };
}

/** Assemble every OBSERVED metric for a completed backtest run. */
export function buildMetrics(result: BacktestResult, runId: string, barMinutes: number): ReportMetrics {
  const startCapital = result.config.backtest.startingCapital;
  const oosFrom = result.window.outOfSampleFrom;
  const { inSample, outOfSample } = splitSample(result.trades, oosFrom);

  const isEquity = result.equity.filter((e) => e.ts < oosFrom);
  const oosEquity = result.equity.filter((e) => e.ts >= oosFrom);
  const capitalAtOos = oosEquity.length > 0
    ? (isEquity.length > 0 ? (isEquity[isEquity.length - 1] as EquityPoint).equity : startCapital)
    : startCapital;

  return {
    runId,
    generatedAt: result.generatedAt,
    configHash: result.configHash,
    node: process.version,
    mode: result.config.meta.mode,
    placesRealOrders: result.config.meta.placesRealOrders,
    window: result.window,
    full: block(result.equity, result.trades, startCapital, barMinutes),
    inSample: block(isEquity, inSample, startCapital, barMinutes),
    outOfSample: block(oosEquity, outOfSample, capitalAtOos, barMinutes),
    funnel: result.funnel,
    seriesStats: result.seriesStats,
    provenance: result.provenance,
    overrides: result.overrides,
    unverifiedAssumptions: result.config.meta.unverifiedAssumptions,
    costBasis: {
      fees: "MODELLED - Bitget spot taker bps from config; no live fills exist",
      slippage: "MODELLED - flat adverse bps; not measured against an order book",
      funding: "MODELLED - flat bps per 8h; spot rToken funding was not sampled",
      observedExecutionCosts: "NONE - CipherEdge has never placed an order",
    },
  };
}

const n = (v: number | null, dp = 2): string => (v === null || !Number.isFinite(v) ? "n/a" : String(round(v, dp)));

function returnsRow(label: string, r: ReturnStats): string {
  return `| ${label} | ${n(r.startingCapital)} | ${n(r.finalEquity)} | ${n(r.totalReturnPct, 3)}% | ${n(r.maxDrawdownPct, 3)}% | ${n(r.sharpe, 3)} | ${n(r.sortino, 3)} | ${n(r.volatilityPctAnnualized)}% | ${r.bars} |`;
}

function tradesRow(label: string, t: TradeStats): string {
  return `| ${label} | ${t.trades} | ${n(t.winRatePct, 1)}% | ${n(t.netPnl)} | ${n(t.profitFactor, 3)} | ${n(t.avgR, 3)} | ${n(t.expectancy)} | ${n(t.avgHoldingMinutes, 0)}m | ${t.longs}/${t.shorts} | ${t.setupA}/${t.setupB} |`;
}

/** The human-readable validation report. Every number is OBSERVED or explicitly MODELLED. */
export function buildMarkdown(m: ReportMetrics, extraSections: string[] = []): string {
  const cfg = m;
  const t = m.full.trades;
  const r = m.full.returns;
  const L: string[] = [];

  L.push(`# CipherEdge backtest report - \`${m.runId}\``);
  L.push("");
  L.push(`Generated: ${m.generatedAt}  ·  config hash: \`${m.configHash}\`  ·  Node ${m.node}`);
  L.push(`Mode: **${m.mode}**. Places real orders: **${m.placesRealOrders}**.`);
  L.push("");
  L.push("## How to read this report");
  L.push("");
  L.push("- **OBSERVED** = computed from the committed candle dataset by the committed code. Reproducible.");
  L.push("- **MODELLED** = an assumption about execution cost. CipherEdge has never placed an order, so no");
  L.push("  empirically observed execution cost exists anywhere in this project.");
  L.push("- **TARGETED** = a goal, not a measurement.");
  L.push("- No figure in this report was tuned, selected or re-run to look better. Parameters are fixed a priori");
  L.push("  from the written strategy specification (see `config/default.json`).");
  L.push("");

  L.push("## Test period (OBSERVED)");
  L.push("");
  L.push("| window | start (UTC) | end (UTC) | days |");
  L.push("| --- | --- | --- | --- |");
  L.push(`| total | ${m.window.fromIso} | ${m.window.toIso} | ${m.window.days} |`);
  L.push(`| in-sample | ${m.window.fromIso} | ${m.window.outOfSampleFromIso} | ${round(m.window.days - m.window.outOfSampleDays, 2)} |`);
  L.push(`| out-of-sample | ${m.window.outOfSampleFromIso} | ${m.window.toIso} | ${m.window.outOfSampleDays} |`);
  L.push("");

  L.push("## Returns (OBSERVED, net of MODELLED costs)");
  L.push("");
  L.push("| window | start capital | final equity | total return | max drawdown | Sharpe | Sortino | ann. vol | equity bars |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  L.push(returnsRow("total", r));
  L.push(returnsRow("in-sample", m.inSample.returns));
  L.push(returnsRow("out-of-sample", m.outOfSample.returns));
  L.push("");
  L.push(`Sharpe/Sortino annualise a 365-day year (24/7 market) at ${n(r.periodsPerYear, 1)} periods/year, rf = 0.`);
  L.push("");

  L.push("## Trade statistics (OBSERVED)");
  L.push("");
  L.push("| window | trades | win rate | net PnL | profit factor | avg R | expectancy | avg hold | LONG/SHORT | setupA/setupB |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  L.push(tradesRow("total", t));
  L.push(tradesRow("in-sample", m.inSample.trades));
  L.push(tradesRow("out-of-sample", m.outOfSample.trades));
  L.push("");
  L.push(`Best R ${n(t.bestR, 3)} · worst R ${n(t.worstR, 3)} · median R ${n(t.medianR, 3)} · avg win ${n(t.avgWin)} · avg loss ${n(t.avgLoss)}`);
  L.push("");
  L.push("Exit reasons (OBSERVED): " + (Object.keys(t.exitReasons).length > 0
    ? Object.entries(t.exitReasons).map(([k, v]) => `${k}=${v}`).join(", ")
    : "none - no trades closed"));
  L.push("");

  L.push("## Costs");
  L.push("");
  L.push("| component | amount | basis |");
  L.push("| --- | --- | --- |");
  L.push(`| fees | ${n(t.fees)} | MODELLED (${cfg.costBasis.fees}) |`);
  L.push(`| slippage | ${n(t.slippage)} | MODELLED (${cfg.costBasis.slippage}) - already embedded in fill prices, not deducted twice |`);
  L.push(`| funding | ${n(t.funding)} | MODELLED (${cfg.costBasis.funding}) |`);
  L.push(`| observed execution costs | 0 | ${cfg.costBasis.observedExecutionCosts} |`);
  L.push("");
  L.push(`Turnover notional (OBSERVED): ${n(t.turnoverNotional)} USDT over ${m.window.days} days.`);
  L.push("");

  L.push("## Sizing transparency (OBSERVED)");
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| positions where the notional cap bound | ${t.notionalCapApplied} / ${t.trades} |`);
  L.push(`| binding constraint counts | ${Object.entries(t.bindingConstraint).map(([k, v]) => `${k}=${v}`).join(", ") || "none"} |`);
  L.push(`| avg intended risk per trade | ${n(t.avgIntendedRiskPct, 4)}% |`);
  L.push(`| avg actual risk per trade | ${n(t.avgActualRiskPct, 4)}% |`);
  L.push(`| max actual risk per trade | ${n(t.maxActualRiskPct, 4)}% |`);
  L.push(`| avg exposure (notional / equity) | ${n(r.avgExposurePct ?? null)}% |`);
  L.push(`| max exposure (notional / equity) | ${n(r.maxExposurePct ?? null)}% |`);
  L.push(`| max concurrent open positions | ${r.maxOpenPositions} |`);
  L.push("");
  L.push("The notional cap can only REDUCE risk below the intended budget. When it binds, the intended risk");
  L.push("is forgone and reported here - it is never silently converted into a larger position.");
  L.push("");

  L.push("## Signal funnel (OBSERVED)");
  L.push("");
  L.push("| stage | count |");
  L.push("| --- | --- |");
  L.push(`| trigger bars evaluated | ${m.funnel.barsEvaluated} |`);
  L.push(`| deterministic setups fired (pre-HTF) | ${m.funnel.deterministicSetups} |`);
  L.push(`| vetoed: no 1h structure within tolerance | ${m.funnel.htfVetoed} |`);
  L.push(`| anchored onto a 1h level | ${m.funnel.htfAnchored} |`);
  L.push(`| vetoed: LLM confidence floor | ${m.funnel.llmVetoed} |`);
  L.push(`| rejected by the risk engine | ${m.funnel.riskRejected} |`);
  L.push(`| executed | ${m.funnel.executed} |`);
  L.push("");

  L.push("## Slices (OBSERVED)");
  L.push("");
  L.push("### By setup");
  L.push("");
  L.push("| setup | trades | net PnL | win rate | avg R |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const s of t.bySetup) L.push(`| ${s.group} | ${s.trades} | ${n(s.netPnl)} | ${n(s.winRatePct, 1)}% | ${n(s.avgR, 3)} |`);
  if (t.bySetup.length === 0) L.push("| - | 0 | - | - | - |");
  L.push("");
  L.push("### By direction");
  L.push("");
  L.push("| direction | trades | net PnL | win rate | avg R |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const s of t.byDirection) L.push(`| ${s.group} | ${s.trades} | ${n(s.netPnl)} | ${n(s.winRatePct, 1)}% | ${n(s.avgR, 3)} |`);
  if (t.byDirection.length === 0) L.push("| - | 0 | - | - | - |");
  L.push("");
  L.push("### By symbol");
  L.push("");
  L.push("| symbol | trades | net PnL | win rate | avg R |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const s of t.bySymbol) L.push(`| ${s.symbol} | ${s.trades} | ${n(s.netPnl)} | ${n(s.winRatePct, 1)}% | ${n(s.avgR, 3)} |`);
  if (t.bySymbol.length === 0) L.push("| - | 0 | - | - | - |");
  L.push("");

  L.push("## Per-symbol signal counts (OBSERVED)");
  L.push("");
  L.push("| symbol | trigger bars | bars in window | raw setups | HTF vetoed | HTF anchored | risk rejections | entries |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of m.seriesStats) {
    L.push(`| ${s.symbol} | ${s.triggerBars} | ${s.barsInWindow} | ${s.deterministicSetups} | ${s.htfVetoed} | ${s.htfAnchored} | ${s.riskRejections} | ${s.entries} |`);
  }
  L.push("");

  L.push("## Data provenance (OBSERVED)");
  L.push("");
  L.push("| symbol | granularity | source | bars | first (UTC) | last (UTC) |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const p of m.provenance) {
    L.push(`| ${p.symbol} | ${p.granularity} | ${p.source} | ${p.bars} | ${p.firstTs !== null ? isoUtc(p.firstTs) : "-"} | ${p.lastTs !== null ? isoUtc(p.lastTs) : "-"} |`);
  }
  L.push("");
  L.push("See `data/INTEGRITY.md` for the per-series gap / completeness audit.");
  L.push("");

  L.push("## Unverified assumptions");
  L.push("");
  for (const a of m.unverifiedAssumptions) L.push(`- **UNVERIFIED ASSUMPTION:** ${a}`);
  L.push("- **UNVERIFIED ASSUMPTION:** top red / bottom green dot placement (local extremum of the momentum wave inside an extreme zone).");
  L.push("- **MODELLED:** fills are bar-based. No order-book depth, no partial fills, no queue position, no exchange downtime handling.");
  L.push("- **MODELLED:** the same flat cost model is applied to BTC/ETH/SOL and to thin rToken pairs, which almost certainly");
  L.push("  understates real slippage on the rTokens.");
  L.push("");
  L.push("CipherEdge does **not** claim TradingView-equivalent VMC Cipher B calculations.");
  L.push("");

  for (const s of extraSections) {
    L.push(s);
    L.push("");
  }

  L.push("## Reproduce this run");
  L.push("");
  L.push("```bash");
  L.push("npm install            # optional - the project has zero runtime dependencies");
  L.push("npm run backtest       # regenerates reports/ from the committed data + config");
  L.push("npm test               # full test suite");
  L.push("```");
  L.push("");
  L.push(`Config hash \`${m.configHash}\` pins the exact parameters. The candle files are committed, so the run is`);
  L.push("reproducible offline with no network access and no API key.");
  L.push("");
  return L.join("\n");
}

export function tradesToCsv(trades: TradeRecord[], outOfSampleFrom: number): string {
  const header = [
    "id", "symbol", "timeframe", "direction", "setup_type", "sample", "confidence",
    "entry_ts", "entry_utc", "exit_ts", "exit_utc", "entry_price", "exit_price",
    "initial_stop_loss", "stop_loss", "take_profit_1", "take_profit_2", "quantity", "notional",
    "intended_risk_pct", "actual_risk_pct", "notional_cap_applied", "binding_constraint",
    "risk_amount", "fees", "slippage", "funding", "realized_pnl", "r_multiple",
    "holding_minutes", "exit_reason",
  ];
  const rows = trades.map((tr) => [
    tr.id, tr.symbol, tr.timeframe, tr.direction, tr.setupType,
    tr.entryTs >= outOfSampleFrom ? "out-of-sample" : "in-sample",
    tr.confidence, tr.entryTs, isoUtc(tr.entryTs), tr.exitTs, isoUtc(tr.exitTs),
    tr.entryPrice, tr.exitPrice, tr.initialStopLoss, tr.stopLoss, tr.takeProfit1, tr.takeProfit2,
    tr.quantity, round(tr.notional, 4), tr.intendedRiskPct, tr.actualRiskPct,
    tr.notionalCapApplied, tr.bindingConstraint, tr.riskAmount, round(tr.fees, 6),
    round(tr.slippage, 6), round(tr.funding, 6), round(tr.realizedPnl, 6),
    round(tr.rMultiple, 4), round(tr.holdingMinutes, 1), tr.exitReason,
  ]);
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export interface WrittenReport {
  dir: string;
  files: string[];
  metrics: ReportMetrics;
}

/** Write every artifact for a run into reports/<runId>/. */
export function writeReport(result: BacktestResult, opts: ReportOptions, extraSections: string[] = []): WrittenReport {
  const barMinutes = opts.barMinutes ?? granularityMs(result.config.backtest.triggerGranularity) / 60_000;
  const metrics = buildMetrics(result, opts.runId, barMinutes);
  const dir = opts.outDir;
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  const write = (name: string, text: string): void => {
    const p = join(dir, name);
    writeFileSync(p, text, "utf8");
    files.push(p);
  };

  write("report.md", buildMarkdown(metrics, extraSections));
  write("metrics.json", `${JSON.stringify(metrics, null, 2)}\n`);
  write("trades.csv", tradesToCsv(result.trades, result.window.outOfSampleFrom));
  write("equity.jsonl", `${result.equity.map((e) => JSON.stringify(e)).join("\n")}\n`);
  write("provenance.json", `${JSON.stringify({ window: result.window, provenance: result.provenance, seriesStats: result.seriesStats, funnel: result.funnel }, null, 2)}\n`);
  write("config.snapshot.json", `${JSON.stringify({ hash: result.configHash, overrides: result.overrides, config: result.config }, null, 2)}\n`);
  if (result.decisions.length > 0) {
    write("decisions.jsonl", `${result.decisions.map((d) => JSON.stringify(d)).join("\n")}\n`);
  }
  return { dir, files, metrics };
}
