import type { Candle, CipherBState, EquityPoint, ExecutionDecision, RiskPlan, StrategySignal, TradeRecord } from "../types.ts";
import type { AppConfig } from "../config.ts";
import { computeCipherB } from "../indicators/cipherB.ts";
import { refineDecision } from "../llm/layer.ts";
import { MockLlmProvider } from "../llm/mock.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { evaluateRisk } from "../risk/engine.ts";
import { evaluateAll } from "../strategy/engine.ts";
import { applyHtfStructure, buildHtfIndex } from "../strategy/mtf.ts";
import { loadCandles } from "../data/source.ts";
import type { DataProvenance } from "../data/source.ts";
import { resample } from "../data/resample.ts";
import { granularityMs, isoUtc } from "../util/time.ts";
import { openPosition, stepPosition, forceClose, unrealizedPnl } from "./portfolio.ts";
import type { OpenPosition } from "./portfolio.ts";

const DAY_MS = 86_400_000;

export interface BacktestInput {
  cfg: AppConfig;
  dataDir: string;
  /** Overrides (used for the documented notional-cap sensitivity comparison, never for tuning). */
  symbols?: string[];
  days?: number;
  outOfSampleDays?: number;
  startingCapital?: number;
  maxPositionNotionalPct?: number;
  triggerGranularity?: string;
  structureGranularity?: string;
  useLlm?: boolean;
  llmProvider?: LlmProvider | null;
  collectDecisions?: boolean;
  onProgress?: (msg: string) => void;
}

export interface DecisionEntry {
  ts: number;
  symbol: string;
  signalBarTs: number;
  decision: ExecutionDecision;
  plan: RiskPlan;
  riskApproved: boolean;
  riskReasons: string[];
  executed: boolean;
  tradeId: string | null;
}

export interface SeriesStats {
  symbol: string;
  triggerBars: number;
  structureBars: number;
  barsInWindow: number;
  deterministicSetups: number;
  htfVetoed: number;
  htfAnchored: number;
  entries: number;
  riskRejections: number;
  llmVetoed: number;
}

export interface Funnel {
  barsEvaluated: number;
  deterministicSetups: number;
  htfVetoed: number;
  htfAnchored: number;
  llmVetoed: number;
  riskRejected: number;
  executed: number;
}

export interface BacktestWindow {
  from: number;
  to: number;
  outOfSampleFrom: number;
  fromIso: string;
  toIso: string;
  outOfSampleFromIso: string;
  days: number;
  outOfSampleDays: number;
}

export interface BacktestResult {
  generatedAt: string;
  configHash: string;
  config: AppConfig;
  overrides: Record<string, unknown>;
  window: BacktestWindow;
  provenance: DataProvenance[];
  seriesStats: SeriesStats[];
  funnel: Funnel;
  trades: TradeRecord[];
  equity: EquityPoint[];
  decisions: DecisionEntry[];
}

interface SymbolSeries {
  symbol: string;
  trigger: Candle[];
  structure: Candle[];
  signals: StrategySignal[];
  cipher: CipherBState[];
  indexByTs: Map<number, number>;
  provenance: DataProvenance[];
  stats: SeriesStats;
}

/** Prefer a native file at the wanted granularity; otherwise resample a finer committed series. */
async function loadSeries(
  dataDir: string,
  symbol: string,
  want: string,
  fallbackFrom: string | null,
  allowNetwork: boolean,
): Promise<{ candles: Candle[]; provenance: DataProvenance[] }> {
  const provenance: DataProvenance[] = [];
  try {
    const loaded = await loadCandles({ dataDir, symbol, granularity: want, allowNetwork });
    provenance.push(loaded.provenance);
    return { candles: loaded.candles, provenance };
  } catch (err) {
    if (!fallbackFrom) throw err;
    const finer = await loadCandles({ dataDir, symbol, granularity: fallbackFrom, allowNetwork });
    provenance.push(finer.provenance);
    const up = resample(finer.candles, want);
    provenance.push({
      symbol,
      granularity: want,
      source: finer.provenance.source,
      path: finer.provenance.path,
      bars: up.length,
      firstTs: up.length > 0 ? (up[0] as Candle).ts : null,
      lastTs: up.length > 0 ? (up[up.length - 1] as Candle).ts : null,
    });
    return { candles: up, provenance };
  }
}

async function buildSeries(input: BacktestInput, symbol: string): Promise<SymbolSeries> {
  const { cfg, dataDir } = input;
  const triggerGran = input.triggerGranularity ?? cfg.backtest.triggerGranularity;
  const structureGran = input.structureGranularity ?? cfg.backtest.structureGranularity;
  const allowNetwork = cfg.backtest.allowNetwork;

  const trig = await loadSeries(dataDir, symbol, triggerGran, cfg.backtest.resampleFrom, allowNetwork);
  let struct = await loadSeries(dataDir, symbol, structureGran, triggerGran, allowNetwork);
  if (struct.candles.length === 0) struct = trig;

  if (trig.candles.length <= cfg.strategy.warmupBars + 5) {
    throw new Error(`${symbol}: only ${trig.candles.length} ${triggerGran} bars - not enough for warm-up (${cfg.strategy.warmupBars})`);
  }

  const rawSignals = evaluateAll(trig.candles, symbol, cfg.strategy);
  const htfIndex = buildHtfIndex(struct.candles, structureGran, cfg.htf);
  const htf = applyHtfStructure(rawSignals, trig.candles, triggerGran, htfIndex, cfg.htf);
  const cipher = computeCipherB(trig.candles, cfg.strategy.cipherB);

  const indexByTs = new Map<number, number>();
  trig.candles.forEach((c, i) => indexByTs.set(c.ts, i));

  const setups = htf.signals.reduce((n, s) => n + (s.direction === "NO_TRADE" ? 0 : 1), 0);
  const rawSetups = rawSignals.reduce((n, s) => n + (s.direction === "NO_TRADE" ? 0 : 1), 0);

  return {
    symbol,
    trigger: trig.candles,
    structure: struct.candles,
    signals: htf.signals,
    cipher,
    indexByTs,
    provenance: [...trig.provenance, ...struct.provenance],
    stats: {
      symbol,
      triggerBars: trig.candles.length,
      structureBars: struct.candles.length,
      barsInWindow: 0,
      deterministicSetups: rawSetups,
      htfVetoed: htf.vetoed,
      htfAnchored: htf.anchored,
      entries: 0,
      riskRejections: 0,
      llmVetoed: 0,
    },
  };
}

function resolveWindow(series: SymbolSeries[], days: number, outOfSampleDays: number): BacktestWindow {
  const lasts = series.map((s) => (s.trigger[s.trigger.length - 1] as Candle).ts);
  const firsts = series.map((s) => (s.trigger[0] as Candle).ts);
  const to = Math.min(...lasts);
  const dataStart = Math.max(...firsts);
  const from = Math.max(dataStart, to - days * DAY_MS);
  const outOfSampleFrom = to - outOfSampleDays * DAY_MS;
  if (outOfSampleFrom <= from) {
    throw new Error(`window too small: from=${isoUtc(from)} oos=${isoUtc(outOfSampleFrom)} to=${isoUtc(to)}`);
  }
  return {
    from,
    to,
    outOfSampleFrom,
    fromIso: isoUtc(from),
    toIso: isoUtc(to),
    outOfSampleFromIso: isoUtc(outOfSampleFrom),
    days: Math.round(((to - from) / DAY_MS) * 100) / 100,
    outOfSampleDays: Math.round(((to - outOfSampleFrom) / DAY_MS) * 100) / 100,
  };
}

/**
 * Chronological, portfolio-level walk forward over real candles.
 *
 * NO LOOK-AHEAD, by construction:
 *   - indicators/swings/divergence/HTF levels only ever see bars <= the signal bar
 *   - a signal on bar t is entered at bar t+1's OPEN, never at bar t's close
 *   - intra-bar fills assume the STOP fills first when a bar touches both stop and target
 *   - equity for risk sizing is snapshotted at the START of each bar, so intra-bar
 *     processing order across symbols cannot change the result
 */
export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  const { cfg } = input;
  const symbols = input.symbols ?? cfg.backtest.symbols;
  const days = input.days ?? cfg.backtest.days;
  const oosDays = input.outOfSampleDays ?? cfg.backtest.outOfSampleDays;
  const startingCapital = input.startingCapital ?? cfg.backtest.startingCapital;
  const riskCfg = { ...cfg.risk, ...(input.maxPositionNotionalPct !== undefined ? { maxPositionNotionalPct: input.maxPositionNotionalPct } : {}) };
  const triggerGran = input.triggerGranularity ?? cfg.backtest.triggerGranularity;
  const structureGran = input.structureGranularity ?? cfg.backtest.structureGranularity;
  const barMinutes = granularityMs(triggerGran) / 60_000;
  const log = input.onProgress ?? (() => undefined);

  const provider: LlmProvider | null = input.useLlm
    ? (input.llmProvider ?? (cfg.llm.provider === "mock" ? new MockLlmProvider() : null))
    : null;

  log(`loading ${symbols.length} symbols from ${input.dataDir}`);
  const series: SymbolSeries[] = [];
  for (const symbol of symbols) {
    series.push(await buildSeries({ ...input, symbols: [symbol] }, symbol));
    log(`  ${symbol}: ${series[series.length - 1]!.stats.triggerBars} ${triggerGran} bars, ${series[series.length - 1]!.stats.deterministicSetups} raw setups`);
  }

  const window = resolveWindow(series, days, oosDays);
  log(`window ${window.fromIso} -> ${window.toIso} (${window.days}d), OOS from ${window.outOfSampleFromIso} (${window.outOfSampleDays}d)`);

  const timelineSet = new Set<number>();
  for (const s of series) {
    for (const c of s.trigger) if (c.ts >= window.from && c.ts <= window.to) timelineSet.add(c.ts);
  }
  const timeline = [...timelineSet].sort((a, b) => a - b);

  const positions = new Map<string, OpenPosition>();
  const lastPrice = new Map<string, number>();
  const trades: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  const decisions: DecisionEntry[] = [];
  let cash = startingCapital;
  let dayKey = "";
  let dayStartEquity = startingCapital;
  let peak = startingCapital;
  let barsEvaluated = 0;
  let riskRejected = 0;
  let llmVetoed = 0;
  let executed = 0;

  const markEquity = (): number => {
    let eq = cash;
    for (const p of positions.values()) eq += unrealizedPnl(p, lastPrice.get(p.symbol) ?? p.entryPrice, cfg.costs);
    return eq;
  };

  for (const ts of timeline) {
    const equityAtBarStart = markEquity();
    const openAtBarStart = positions.size;
    const dk = new Date(ts).toISOString().slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      dayStartEquity = equityAtBarStart;
    }

    for (const s of series) {
      const i = s.indexByTs.get(ts);
      if (i === undefined) continue;
      const bar = s.trigger[i] as Candle;
      barsEvaluated += 1;
      lastPrice.set(s.symbol, bar.close);

      // --- ENTRY: the previous bar's confirmed signal, filled at THIS bar's open ---
      if (i >= 1 && !positions.has(s.symbol)) {
        const signal = s.signals[i - 1] as StrategySignal;
        if (signal.direction !== "NO_TRADE" && (signal.ts >= window.from || ts >= window.from)) {
          const signalCipher = s.cipher[i - 1] as CipherBState;
          const intendedEntry = bar.open;
          const plan = evaluateRisk(
            { equity: equityAtBarStart, dayStartEquity, openPositions: openAtBarStart, signal, entryPrice: intendedEntry },
            riskCfg,
          );
          const decision = await refineDecision(signal, signalCipher, plan, provider, {
            model: provider?.model ?? cfg.llm.model,
            promptVersion: cfg.llm.promptVersion,
          });

          let skipReasons = [...plan.reasons];
          const confidenceFloor = cfg.llm.minConfidenceToTrade;
          const belowFloor = provider !== null && confidenceFloor > 0 && decision.confidence_score < confidenceFloor;
          if (belowFloor) {
            llmVetoed += 1;
            s.stats.llmVetoed += 1;
            skipReasons = [...skipReasons, `confidence ${decision.confidence_score} below floor ${confidenceFloor}`];
          }
          if (!plan.approved || belowFloor) riskRejected += 1;
          if (!plan.approved) s.stats.riskRejections += 1;

          const willExecute = plan.approved && !belowFloor;
          const tradeId = `${s.symbol}-${ts}`;
          if (willExecute) {
            const pos = openPosition({
              id: tradeId,
              symbol: s.symbol,
              timeframe: triggerGran,
              direction: signal.direction === "SHORT" ? "SHORT" : "LONG",
              setupType: signal.setupType,
              confidence: decision.confidence_score,
              entryTs: ts,
              intendedEntryPrice: intendedEntry,
              stopLoss: plan.stopLoss,
              takeProfit1: plan.takeProfit1,
              takeProfit2: plan.takeProfit2,
              quantity: plan.quantity,
              riskAmount: plan.actualRiskAmount,
              intendedRiskPct: plan.intendedRiskPct,
              actualRiskPct: plan.actualRiskPct,
              notionalCapApplied: plan.notionalCapApplied,
              bindingConstraint: plan.bindingConstraint,
              costs: cfg.costs,
            });
            positions.set(s.symbol, pos);
            executed += 1;
            s.stats.entries += 1;
          }
          if (input.collectDecisions) {
            decisions.push({
              ts,
              symbol: s.symbol,
              signalBarTs: signal.ts,
              decision,
              plan,
              riskApproved: plan.approved && !belowFloor,
              riskReasons: skipReasons,
              executed: willExecute,
              tradeId: willExecute ? tradeId : null,
            });
          }
        }
      }

      // --- MANAGE: walk every open position for this symbol through the bar ---
      const pos = positions.get(s.symbol);
      if (pos) {
        const res = stepPosition(pos, bar, barMinutes, cfg.execution, cfg.costs);
        if (res.closed && res.trade) {
          trades.push(res.trade);
          positions.delete(s.symbol);
          cash += res.trade.realizedPnl;
        }
      }
    }

    const eq = markEquity();
    if (eq > peak) peak = eq;
    let exposureNotional = 0;
    for (const p of positions.values()) exposureNotional += p.quantity * (lastPrice.get(p.symbol) ?? p.entryPrice);
    equity.push({
      ts,
      equity: eq,
      cash,
      openPositions: positions.size,
      drawdownPct: peak > 0 ? ((peak - eq) / peak) * 100 : 0,
      exposureNotional,
      exposurePct: eq > 0 ? (exposureNotional / eq) * 100 : 0,
    });
  }

  // Force-close anything still open at each symbol's final bar (labelled "eod").
  for (const s of series) {
    const pos = positions.get(s.symbol);
    if (!pos) continue;
    const lastBar = s.trigger[s.trigger.length - 1] as Candle;
    const trade = forceClose(pos, lastBar, "eod", cfg.costs);
    trades.push(trade);
    positions.delete(s.symbol);
    cash += trade.realizedPnl;
  }

  for (const s of series) {
    let n = 0;
    for (const c of s.trigger) if (c.ts >= window.from && c.ts <= window.to) n += 1;
    s.stats.barsInWindow = n;
  }

  trades.sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol));

  const funnel: Funnel = {
    barsEvaluated,
    deterministicSetups: series.reduce((a, s) => a + s.stats.deterministicSetups, 0),
    htfVetoed: series.reduce((a, s) => a + s.stats.htfVetoed, 0),
    htfAnchored: series.reduce((a, s) => a + s.stats.htfAnchored, 0),
    llmVetoed,
    riskRejected,
    executed,
  };

  const overrides: Record<string, unknown> = {};
  if (input.maxPositionNotionalPct !== undefined) overrides.maxPositionNotionalPct = input.maxPositionNotionalPct;
  if (input.symbols) overrides.symbols = input.symbols.length;
  if (input.days !== undefined) overrides.days = input.days;
  if (input.triggerGranularity) overrides.triggerGranularity = input.triggerGranularity;
  if (input.useLlm) overrides.useLlm = true;

  return {
    generatedAt: new Date().toISOString(),
    configHash: cfg.hash,
    config: cfg,
    overrides,
    window,
    provenance: series.flatMap((s) => s.provenance),
    seriesStats: series.map((s) => s.stats),
    funnel,
    trades,
    equity,
    decisions,
  };
}

/** Split trades into in-sample and out-of-sample by entry time. */
export function splitSample(trades: TradeRecord[], outOfSampleFrom: number): { inSample: TradeRecord[]; outOfSample: TradeRecord[] } {
  return {
    inSample: trades.filter((t) => t.entryTs < outOfSampleFrom),
    outOfSample: trades.filter((t) => t.entryTs >= outOfSampleFrom),
  };
}

/** Slice the equity curve to a sub-window (used for the OOS equity series). */
export function sliceEquity(equity: EquityPoint[], from: number, to: number): EquityPoint[] {
  return equity.filter((e) => e.ts >= from && e.ts <= to);
}
