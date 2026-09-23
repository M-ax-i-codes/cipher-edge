/**
 * CipherEdge CLI.
 *
 *   node src/cli.ts doctor                       environment + config + dataset gate
 *   node src/cli.ts backtest                     validated-universe backtest + report
 *   node src/cli.ts backtest --extended          labelled lower-completeness sensitivity run
 *   node src/cli.ts backtest --trigger 5m        labelled 5m-trigger sensitivity run (NOT validated)
 *   node src/cli.ts sensitivity                  notional-cap comparison (20% primary vs 33%)
 *   node src/cli.ts paper                        replay paper-trading ledger + report
 *   node src/cli.ts signal                       read-only "what would it say now" (network)
 *   node src/cli.ts report <runDir>              re-print metrics from an existing run
 *   node src/cli.ts fetch-data --days 92         refresh the committed public dataset
 *
 * No command places an order. `config/default.json` pins meta.placesRealOrders=false and
 * loadConfig refuses to load a config that says otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, repoRoot, resolveDataDir } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { runBacktest, splitSample } from "./backtest/engine.ts";
import { writeReport } from "./report/report.ts";
import { preflightData, preflightMarkdown, assertPreflightOk, usableSymbols } from "./data/preflight.ts";
import { makeRunId, runPaperReplay, runPaperSignal } from "./paper/harness.ts";
import { buildIntegrityMarkdown, fetchDataset } from "./data/fetch.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { granularityMs } from "./util/time.ts";
import { summarizeTrades } from "./report/metrics.ts";

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["--llm", "--extended", "--skip-preflight", "--help", "--json", "--collect-decisions"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    if (BOOLEAN_FLAGS.has(token)) { booleans.add(token); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { booleans.add(token); continue; }
    flags.set(token, next);
    i += 1;
  }
  return { command: positionals[0] ?? "help", positionals: positionals.slice(1), flags, booleans };
}

function str(args: Args, name: string, fallback: string): string {
  return args.flags.get(name) ?? fallback;
}
function num(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`flag ${name} expects a number, got "${raw}"`);
  return value;
}
function optNum(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`flag ${name} expects a number, got "${raw}"`);
  return value;
}

function usage(): string {
  return [
    "CipherEdge - VMC Cipher B research / paper-trading agent (never places real orders)",
    "",
    "Commands:",
    "  doctor                       environment, config guardrails and dataset quality gate",
    "  backtest                     run the validated-universe backtest and write a report",
    "  sensitivity                  notional-cap comparison: primary cap vs the documented alternative",
    "  paper                        replay paper-trading ledger plus the matching report",
    "  signal                       read-only decisions for the latest closed bars (needs network)",
    "  report <runDir>              re-print metrics from an existing run directory",
    "  fetch-data                   refresh the committed public Bitget candle dataset",
    "",
    "Flags:",
    "  --config <path>              config file (default config/default.json)",
    "  --symbols <A,B,C>            override the symbol universe",
    "  --extended                   use backtest.extendedSymbols and skip the strict gate",
    "                               (results are labelled NOT VALIDATED)",
    "  --days <n> --oos <n>         window length and out-of-sample length in days",
    "  --capital <n>                starting capital",
    "  --trigger <15m|5m>           trigger granularity (5m is a sensitivity path, not validated)",
    "  --structure <1h>             structure granularity",
    "  --notional-cap <pct>         single-position notional cap (sensitivity only)",
    "  --out <dir>                  report root (default reports)",
    "  --run-id <id>                run id (default auto timestamp)",
    "  --llm                        enable the LLM refinement layer (mock provider by default)",
    "  --skip-preflight             do not abort on data-quality failures",
    "  --bars <n>                   bars to inspect in signal mode (default 1)",
  ].join("\n");
}

function resolveCfg(args: Args): AppConfig {
  const configPath = args.flags.get("--config");
  return loadConfig(configPath);
}

function resolveSymbols(args: Args, cfg: AppConfig): { symbols: string[]; extended: boolean } {
  const explicit = args.flags.get("--symbols");
  if (explicit) {
    return { symbols: explicit.split(",").map((s) => s.trim()).filter((s) => s.length > 0), extended: false };
  }
  if (args.booleans.has("--extended")) return { symbols: cfg.backtest.extendedSymbols, extended: true };
  return { symbols: cfg.backtest.symbols, extended: false };
}

async function preflight(cfg: AppConfig, args: Args, symbols: string[], dataDir: string, triggerGran: string, structureGran: string) {
  const gate = await preflightData({
    dataDir,
    symbols,
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    resampleFrom: cfg.backtest.resampleFrom,
    gate: cfg.dataQuality,
    allowNetwork: false,
  });
  if (!args.booleans.has("--skip-preflight")) assertPreflightOk(gate);
  return gate;
}

function reportRoot(args: Args): string {
  return resolve(repoRoot(), str(args, "--out", "reports"));
}

function headline(label: string, m: ReturnType<typeof summarizeTrades>, ret: { totalReturnPct: number; maxDrawdownPct: number; sharpe: number | null; sortino: number | null }): string {
  return [
    `${label}: trades=${m.trades} winRate=${m.winRatePct === null ? "n/a" : `${m.winRatePct}%`} netPnl=${m.netPnl} pf=${m.profitFactor ?? "n/a"} avgR=${m.avgR ?? "n/a"}`,
    `  return=${ret.totalReturnPct}% maxDD=${ret.maxDrawdownPct}% sharpe=${ret.sharpe ?? "n/a"} sortino=${ret.sortino ?? "n/a"} modelledCosts=${m.totalModelledCosts}`,
  ].join("\n");
}

async function cmdDoctor(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const dataDir = resolveDataDir(str(args, "--data-dir", cfg.backtest.dataDir));
  const triggerGran = str(args, "--trigger", cfg.backtest.triggerGranularity);
  const structureGran = str(args, "--structure", cfg.backtest.structureGranularity);
  const { symbols } = resolveSymbols(args, cfg);

  console.log(`CipherEdge doctor`);
  console.log(`  node           ${process.version}`);
  console.log(`  repoRoot       ${repoRoot()}`);
  console.log(`  config         ${cfg.sourcePath} (hash ${cfg.hash})`);
  console.log(`  mode           ${cfg.meta.mode}`);
  console.log(`  placesRealOrders ${cfg.meta.placesRealOrders}`);
  console.log(`  track          ${cfg.meta.track}`);
  console.log(`  guardrails     PASS (assertGuardrails ran during loadConfig)`);
  console.log(`  timeframes     structure=${cfg.timeframes.structure} trigger=${cfg.timeframes.trigger} secondary=${cfg.timeframes.secondaryTrigger}`);
  console.log(`  risk           ${cfg.risk.riskPerTradePct}% intended / ${cfg.risk.maxRiskPerTradePct}% ceiling, minR:R ${cfg.risk.minRiskReward}, maxPos ${cfg.risk.maxConcurrentPositions}, dailyCap ${cfg.risk.dailyLossCapPct}%, notionalCap ${cfg.risk.maxPositionNotionalPct}%`);
  console.log(`  costs (MODELLED) fee ${cfg.costs.takerFeeBps}bps, slippage ${cfg.costs.slippageBps}bps, funding ${cfg.costs.fundingBpsPer8h}bp/8h`);
  console.log(`  window         ${cfg.backtest.days}d total, ${cfg.backtest.outOfSampleDays}d out-of-sample`);
  console.log(`  dataDir        ${dataDir} (exists=${existsSync(dataDir)})`);
  console.log(`  universe       ${symbols.join(", ")}`);
  console.log(`  unverified assumptions:`);
  for (const a of cfg.meta.unverifiedAssumptions) console.log(`    - ${a}`);
  console.log("");

  const gate = await preflightData({
    dataDir,
    symbols,
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    resampleFrom: cfg.backtest.resampleFrom,
    gate: cfg.dataQuality,
    allowNetwork: false,
  });
  console.log(`data-quality gate: completeness >= ${cfg.dataQuality.requireCompletenessPct}%, max adjacent gap <= ${cfg.dataQuality.maxAdjacentGapBars} bars`);
  console.log(preflightMarkdown(gate));
  console.log("");
  console.log(`passed ${gate.symbolsPassed.length}/${gate.symbolsChecked.length}: ${gate.symbolsPassed.join(", ") || "(none)"}`);
  if (gate.symbolsFailed.length > 0) console.log(`failed: ${gate.symbolsFailed.join(", ")}`);
  console.log(`common window: ${gate.commonFromIso ?? "-"} -> ${gate.commonToIso ?? "-"}`);
  return gate.allPassed ? 0 : 1;
}

async function cmdBacktest(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const dataDir = resolveDataDir(str(args, "--data-dir", cfg.backtest.dataDir));
  const triggerGran = str(args, "--trigger", cfg.backtest.triggerGranularity);
  const structureGran = str(args, "--structure", cfg.backtest.structureGranularity);
  const { symbols, extended } = resolveSymbols(args, cfg);
  const runId = str(args, "--run-id", makeRunId(extended ? "backtest-extended" : "backtest"));
  const outDir = join(reportRoot(args), runId);

  const gate = await preflight(cfg, args, symbols, dataDir, triggerGran, structureGran);
  const use = args.booleans.has("--skip-preflight") || extended ? symbols : usableSymbols(gate);
  console.log(`run ${runId}: ${use.length} symbols, trigger=${triggerGran}, structure=${structureGran}, extended=${extended}`);

  const result = await runBacktest({
    cfg,
    dataDir,
    symbols: use,
    days: optNum(args, "--days"),
    outOfSampleDays: optNum(args, "--oos"),
    startingCapital: optNum(args, "--capital"),
    maxPositionNotionalPct: optNum(args, "--notional-cap"),
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    useLlm: args.booleans.has("--llm") || undefined,
    collectDecisions: args.booleans.has("--collect-decisions") || undefined,
    onProgress: (m) => console.log(`  ${m}`),
  });

  const labels: string[] = [];
  if (extended) labels.push("LOWER-COMPLETENESS SENSITIVITY RUN - NOT VALIDATED (some series failed the data-quality gate)");
  if (!gate.allPassed) labels.push(`data-quality gate: ${gate.symbolsFailed.length} symbol(s) failed and were excluded or run unvalidated`);
  if (triggerGran !== "15m") labels.push(`TRIGGER ${triggerGran} SENSITIVITY PATH - the validated MVP path is 15m trigger / 1h structure`);
  if (args.booleans.has("--llm")) labels.push("LLM refinement layer ENABLED (confidence only; cannot create or flip a setup)");
  labels.push("## Data quality gate (pre-flight)", "", preflightMarkdown(gate));

  const written = writeReport(result, { runId, outDir, barMinutes: granularityMs(triggerGran) / 60_000 }, labels);
  const barMinutes = granularityMs(triggerGran) / 60_000;
  const metrics = written.metrics;
  const split = splitSample(result.trades, result.window.outOfSampleFrom);
  console.log("");
  console.log(headline("FULL   ", metrics.full.trades, metrics.full.returns));
  console.log(headline("IN-SAMP", metrics.inSample.trades, metrics.inSample.returns));
  console.log(headline("OUT-OSM", metrics.outOfSample.trades, metrics.outOfSample.returns));
  console.log(`funnel: bars=${result.funnel.barsEvaluated} setups=${result.funnel.deterministicSetups} htfVetoed=${result.funnel.htfVetoed} riskRejected=${result.funnel.riskRejected} executed=${result.funnel.executed}`);
  console.log(`in-sample trades=${split.inSample.length} out-of-sample trades=${split.outOfSample.length}`);
  console.log("");
  for (const f of written.files) console.log(`  -> ${f}`);
  void barMinutes;
  return 0;
}

async function cmdSensitivity(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const dataDir = resolveDataDir(str(args, "--data-dir", cfg.backtest.dataDir));
  const triggerGran = str(args, "--trigger", cfg.backtest.triggerGranularity);
  const structureGran = str(args, "--structure", cfg.backtest.structureGranularity);
  const { symbols } = resolveSymbols(args, cfg);
  const primaryCap = cfg.risk.maxPositionNotionalPct;
  const altCap = num(args, "--alt-cap", 33);
  const runId = str(args, "--run-id", makeRunId("sensitivity-notional-cap"));
  const outDir = join(reportRoot(args), runId);

  const gate = await preflight(cfg, args, symbols, dataDir, triggerGran, structureGran);
  const use = args.booleans.has("--skip-preflight") ? symbols : usableSymbols(gate);

  console.log(`notional-cap sensitivity: primary ${primaryCap}% (config default, unchanged) vs alternative ${altCap}%`);
  console.log(`The default config is NOT modified by this command; the alternative is an override for one run only.`);

  const runs = [];
  for (const cap of [primaryCap, altCap]) {
    const r = await runBacktest({
      cfg, dataDir, symbols: use,
      days: optNum(args, "--days"), outOfSampleDays: optNum(args, "--oos"),
      startingCapital: optNum(args, "--capital"),
      maxPositionNotionalPct: cap,
      triggerGranularity: triggerGran, structureGranularity: structureGran,
      collectDecisions: true,
      onProgress: (m) => console.log(`  [cap ${cap}%] ${m}`),
    });
    runs.push({ cap, result: r });
  }

  mkdirSync(outDir, { recursive: true });
  const rows = runs.map(({ cap, result }) => {
    const m = writeReport(result, { runId: `${runId}_cap${cap}`, outDir: join(outDir, `cap-${cap}`), barMinutes: granularityMs(triggerGran) / 60_000 }, [`Notional cap override: ${cap}% (primary config default is ${primaryCap}%)`, "", "## Data quality gate (pre-flight)", "", preflightMarkdown(gate)]);
    const capped = result.trades.filter((t) => t.notionalCapApplied).length;
    const byConstraint = result.trades.reduce<Record<string, number>>((acc, t) => { acc[t.bindingConstraint] = (acc[t.bindingConstraint] ?? 0) + 1; return acc; }, {});
    return {
      notionalCapPct: cap,
      isConfigDefault: cap === primaryCap,
      trades: m.metrics.full.trades.trades,
      cappedTrades: capped,
      bindingConstraint: byConstraint,
      avgIntendedRiskPct: m.metrics.full.trades.avgIntendedRiskPct,
      avgActualRiskPct: m.metrics.full.trades.avgActualRiskPct,
      totalReturnPct: m.metrics.full.returns.totalReturnPct,
      maxDrawdownPct: m.metrics.full.returns.maxDrawdownPct,
      netPnl: m.metrics.full.trades.netPnl,
      maxExposurePct: result.equity.reduce((a, e) => Math.max(a, e.exposurePct), 0),
    };
  });

  const comparison = {
    generatedAt: new Date().toISOString(),
    configHash: cfg.hash,
    primaryCapPct: primaryCap,
    alternativeCapPct: altCap,
    note: "OBSERVED from two runs of identical code and data; only maxPositionNotionalPct differs. The default config was not changed.",
    runs: rows,
  };
  writeFileSync(join(outDir, "notional-cap-comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

  const md = [
    `# Notional-cap sensitivity (OBSERVED)`,
    "",
    `Config default \`risk.maxPositionNotionalPct\` = **${primaryCap}%** and was **not** changed.`,
    `The alternative cap **${altCap}%** was applied as a per-run override only.`,
    "",
    "| cap % | default? | trades | capped trades | binding constraint | avg intended risk % | avg actual risk % | return % | maxDD % | netPnl | max exposure % |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => [
      String(r.notionalCapPct), r.isConfigDefault ? "yes" : "no", String(r.trades), String(r.cappedTrades),
      JSON.stringify(r.bindingConstraint), String(r.avgIntendedRiskPct ?? "n/a"), String(r.avgActualRiskPct ?? "n/a"),
      String(r.totalReturnPct), String(r.maxDrawdownPct), String(r.netPnl), String(Math.round(r.maxExposurePct * 100) / 100),
    ].join(" | ")),
    "",
    "Reading this table: `avg intended risk %` is what the 0.5% risk budget asked for;",
    "`avg actual risk %` is what was really at hazard after the cap. A cap can only reduce risk,",
    "never increase it, and the reduction is reported here rather than absorbed silently.",
  ].join("\n");
  writeFileSync(join(outDir, "notional-cap-comparison.md"), `${md}\n`, "utf8");

  console.log("");
  console.log(md);
  console.log("");
  console.log(`  -> ${join(outDir, "notional-cap-comparison.json")}`);
  console.log(`  -> ${join(outDir, "notional-cap-comparison.md")}`);
  return 0;
}

async function cmdPaper(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const dataDir = resolveDataDir(str(args, "--data-dir", cfg.backtest.dataDir));
  const triggerGran = str(args, "--trigger", cfg.backtest.triggerGranularity);
  const structureGran = str(args, "--structure", cfg.backtest.structureGranularity);
  const { symbols, extended } = resolveSymbols(args, cfg);
  const runId = str(args, "--run-id", makeRunId(extended ? "paper-extended" : "paper"));

  const out = await runPaperReplay({
    cfg,
    runId,
    outDir: reportRoot(args),
    dataDir,
    symbols,
    days: optNum(args, "--days"),
    outOfSampleDays: optNum(args, "--oos"),
    startingCapital: optNum(args, "--capital"),
    triggerGranularity: triggerGran,
    structureGranularity: structureGran,
    useLlm: args.booleans.has("--llm") || undefined,
    skipPreflight: args.booleans.has("--skip-preflight") || extended,
    onProgress: (m) => console.log(`  ${m}`),
  });

  console.log("");
  console.log(`paper replay ${out.runId} (${out.validatedUniverse ? "validated universe" : "NOT validated universe"})`);
  console.log(`  round trips   ${out.ledger.roundTrips} (wins ${out.ledger.wins}, losses ${out.ledger.losses})`);
  console.log(`  balance       ${out.ledger.startingBalance} -> ${out.ledger.endingBalance} (${out.ledger.netChangePct}%) OBSERVED`);
  console.log(`  modelled cost fees ${out.ledger.totalFees}, slippage ${out.ledger.totalSlippage}, funding ${out.ledger.totalFunding}`);
  console.log(`  places real orders: NO`);
  console.log("");
  for (const f of out.files) console.log(`  -> ${f}`);
  return 0;
}

async function cmdSignal(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const { symbols } = resolveSymbols(args, cfg);
  const runId = str(args, "--run-id", makeRunId("signal"));
  const result = await runPaperSignal({
    cfg,
    symbols,
    bars: num(args, "--bars", 1),
    outDir: reportRoot(args),
    runId,
    equity: optNum(args, "--capital"),
    useLlm: args.booleans.has("--llm"),
    onProgress: (m) => console.log(`  ${m}`),
  });
  console.log("");
  console.log(result.note);
  for (const d of result.decisions) {
    console.log(`${d.signalIso} ${d.decision.symbol} ${d.decision.direction} ${d.decision.setup_type} conf=${d.decision.confidence_score} riskApproved=${d.approved}${d.reasons.length > 0 ? ` reasons=${d.reasons.join("; ")}` : ""}`);
    if (args.booleans.has("--json")) console.log(JSON.stringify(d.decision, null, 2));
  }
  const actionable = result.decisions.filter((d) => d.decision.direction !== "NO_TRADE" && d.approved);
  console.log("");
  console.log(`${result.decisions.length} decisions, ${actionable.length} actionable. Nothing was ordered - CipherEdge is paper/research only.`);
  return 0;
}

function cmdReport(args: Args): number {
  const dir = args.positionals[0];
  if (!dir) throw new Error("usage: node src/cli.ts report <runDir>");
  const path = resolve(process.cwd(), dir);
  const metricsPath = join(path, "metrics.json");
  if (!existsSync(metricsPath)) throw new Error(`no metrics.json in ${path}`);
  const m = JSON.parse(readFileSync(metricsPath, "utf8"));
  console.log(`run ${m.runId} (config ${m.configHash}) mode=${m.mode} placesRealOrders=${m.placesRealOrders}`);
  console.log(`window ${m.window.fromIso} -> ${m.window.toIso}, OOS from ${m.window.outOfSampleFromIso}`);
  for (const key of ["full", "inSample", "outOfSample"]) {
    const b = m[key];
    console.log(headline(key.padEnd(7), b.trades, b.returns));
  }
  return 0;
}

async function cmdFetchData(args: Args): Promise<number> {
  const cfg = resolveCfg(args);
  const dataDir = resolveDataDir(str(args, "--data-dir", cfg.backtest.dataDir));
  const granularities = str(args, "--granularities", "5m,15m,1h").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const { symbols } = resolveSymbols(args, cfg);
  mkdirSync(dataDir, { recursive: true });
  const result = await fetchDataset({
    dataDir,
    symbols,
    granularities,
    days: num(args, "--days", 92),
    concurrency: num(args, "--concurrency", 4),
    onProgress: (m) => console.log(m),
  });
  const integrityPath = resolve(dataDir, "..", "INTEGRITY.md");
  writeFileSync(integrityPath, buildIntegrityMarkdown(result, []), "utf8");
  writeFileSync(resolve(dataDir, "..", "provenance.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`fetched ${result.entries.length} series, ${result.errors.length} errors -> ${integrityPath}`);
  return result.errors.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.booleans.has("--help") || args.command === "help") { console.log(usage()); return 0; }
  switch (args.command) {
    case "doctor": return cmdDoctor(args);
    case "backtest": return cmdBacktest(args);
    case "sensitivity": return cmdSensitivity(args);
    case "paper": return cmdPaper(args);
    case "signal": return cmdSignal(args);
    case "report": return cmdReport(args);
    case "fetch-data": return cmdFetchData(args);
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.error(usage());
      return 2;
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
