import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_COSTS } from "./backtest/costs.ts";
import type { CostConfig } from "./backtest/costs.ts";
import { DEFAULT_EXECUTION } from "./backtest/portfolio.ts";
import type { ExecutionConfig } from "./backtest/portfolio.ts";
import type { DivergenceParams } from "./indicators/divergence.ts";
import type { WaveTrendParams } from "./indicators/wavetrend.ts";
import { DEFAULT_RISK } from "./risk/engine.ts";
import type { RiskConfig } from "./risk/engine.ts";
import type { BreakoutParams } from "./structure/breakout.ts";
import { DEFAULT_STRATEGY } from "./strategy/engine.ts";
import type { StrategyConfig } from "./strategy/engine.ts";
import { DEFAULT_HTF } from "./strategy/mtf.ts";
import type { HtfConfig } from "./strategy/mtf.ts";
import { stableStringify } from "./util/json.ts";

export interface MetaSettings {
  project: string;
  track: string;
  mode: string;
  placesRealOrders: boolean;
  unverifiedAssumptions: string[];
}

export interface TimeframeSettings {
  structure: string;
  trigger: string;
  secondaryTrigger: string;
}

export interface BacktestSettings {
  startingCapital: number;
  days: number;
  outOfSampleDays: number;
  dataDir: string;
  triggerGranularity: string;
  structureGranularity: string;
  /** Finer granularity used to resample a missing trigger series. */
  resampleFrom: string;
  allowNetwork: boolean;
  /** The validated universe: 24/7 pairs whose committed series pass the data-quality gate. */
  symbols: string[];
  /**
   * Wider universe kept for the labelled lower-completeness sensitivity run only.
   * rToken series carry US market-close gaps, so their results are reported as
   * NOT VALIDATED rather than being folded into the headline numbers.
   */
  extendedSymbols: string[];
}

/**
 * Data-quality gate. A series must be complete enough, and contiguous enough, to be
 * used in a run that is allowed to call itself validated. Indicators and next-bar
 * fills silently assume adjacent bars are adjacent in time, so a large gap is a
 * correctness problem, not just a cosmetic one.
 */
export interface DataQualitySettings {
  /** Minimum completeness percent (bars / expected bars) for a series to be usable. */
  requireCompletenessPct: number;
  /** Largest tolerated gap between adjacent bars, measured in bars. */
  maxAdjacentGapBars: number;
  /** When true a failing series aborts the run; when false it is skipped with a warning. */
  strict: boolean;
}

export interface LlmSettings {
  enabled: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  baseUrl: string;
  apiKeyEnv: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Optional veto floor: the LLM may lower confidence, and this may skip a trade. It can never create one. */
  minConfidenceToTrade: number;
}

export interface AppConfig {
  meta: MetaSettings;
  timeframes: TimeframeSettings;
  strategy: StrategyConfig;
  htf: HtfConfig;
  risk: RiskConfig;
  execution: ExecutionConfig;
  costs: CostConfig;
  backtest: BacktestSettings;
  dataQuality: DataQualitySettings;
  llm: LlmSettings;
  sourcePath: string;
  hash: string;
}

interface RawStrategy {
  wavetrend?: WaveTrendParams;
  momentumSmooth?: number;
  overbought?: number;
  oversold?: number;
  divergence?: DivergenceParams;
  breakout?: BreakoutParams;
  sweepTolerancePct?: number;
  momentumCoolMax?: number;
  maxSwingAgeBars?: number;
  signalCooldownBars?: number;
  warmupBars?: number;
  htf?: HtfConfig;
}

interface RawConfig {
  meta?: Partial<MetaSettings>;
  timeframes?: Partial<TimeframeSettings>;
  strategy?: RawStrategy;
  risk?: Partial<RiskConfig>;
  execution?: Partial<ExecutionConfig>;
  costs?: Partial<CostConfig>;
  backtest?: Partial<BacktestSettings>;
  dataQuality?: Partial<DataQualitySettings>;
  llm?: Partial<LlmSettings>;
}

const DEFAULT_BACKTEST: BacktestSettings = {
  startingCapital: 10_000,
  days: 90,
  outOfSampleDays: 30,
  dataDir: "data/candles",
  triggerGranularity: "15m",
  structureGranularity: "1h",
  resampleFrom: "5m",
  allowNetwork: false,
  symbols: ["BTCUSDT"],
  extendedSymbols: ["BTCUSDT"],
};

const DEFAULT_DATA_QUALITY: DataQualitySettings = {
  requireCompletenessPct: 99,
  maxAdjacentGapBars: 4,
  strict: true,
};

const DEFAULT_LLM: LlmSettings = {
  enabled: false,
  provider: "mock",
  model: "mock-deterministic-v1",
  promptVersion: "cipheredge-llm-v1",
  baseUrl: "",
  apiKeyEnv: "BITGET_QWEN_API_KEY",
  temperature: 0.1,
  maxTokens: 800,
  timeoutMs: 60_000,
  minConfidenceToTrade: 0,
};

const DEFAULT_META: MetaSettings = {
  project: "CipherEdge",
  track: "Agentic Trading",
  mode: "research-and-paper-trading-only",
  placesRealOrders: false,
  unverifiedAssumptions: [],
};

const DEFAULT_TIMEFRAMES: TimeframeSettings = { structure: "1h", trigger: "15m", secondaryTrigger: "5m" };

/** Absolute path of the repository root (the directory holding package.json). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultConfigPath(): string {
  return resolve(repoRoot(), "config", "default.json");
}

/** Short stable hash of the resolved config - printed in every report for reproducibility. */
export function configHash(cfg: Omit<AppConfig, "hash" | "sourcePath">): string {
  const { sourcePath: _ignoredPath, hash: _ignoredHash, ...rest } = cfg as AppConfig;
  void _ignoredPath;
  void _ignoredHash;
  return createHash("sha256").update(stableStringify(rest)).digest("hex").slice(0, 16);
}

/**
 * Hard invariants taken straight from the written strategy specification. A config that
 * would weaken them is rejected at load time rather than silently traded.
 */
export function assertGuardrails(cfg: AppConfig): void {
  const problems: string[] = [];

  // A non-finite limit fails OPEN, not closed: `NaN > 2` is false so the guardrail passes,
  // and `dayLossPct >= NaN` is false so the engine never trips. Reject every numeric
  // guardrail field up front so a malformed config can never silently disable a limit.
  const numeric: Array<[string, unknown]> = [
    ["risk.riskPerTradePct", cfg.risk.riskPerTradePct],
    ["risk.maxRiskPerTradePct", cfg.risk.maxRiskPerTradePct],
    ["risk.setupAStopBufferPct", cfg.risk.setupAStopBufferPct],
    ["risk.setupBStopBufferPct", cfg.risk.setupBStopBufferPct],
    ["risk.minRiskReward", cfg.risk.minRiskReward],
    ["risk.maxConcurrentPositions", cfg.risk.maxConcurrentPositions],
    ["risk.dailyLossCapPct", cfg.risk.dailyLossCapPct],
    ["risk.maxPositionNotionalPct", cfg.risk.maxPositionNotionalPct],
    ["risk.minStopDistancePct", cfg.risk.minStopDistancePct],
    ["risk.tp1Multiple", cfg.risk.tp1Multiple],
    ["risk.tp2Multiple", cfg.risk.tp2Multiple],
    ["execution.tp1ExitPct", cfg.execution.tp1ExitPct],
    ["execution.timeStopMinutes", cfg.execution.timeStopMinutes],
    ["costs.takerFeeBps", cfg.costs.takerFeeBps],
    ["costs.slippageBps", cfg.costs.slippageBps],
    ["costs.fundingBpsPer8h", cfg.costs.fundingBpsPer8h],
    ["backtest.startingCapital", cfg.backtest.startingCapital],
    ["backtest.days", cfg.backtest.days],
    ["backtest.outOfSampleDays", cfg.backtest.outOfSampleDays],
    ["dataQuality.requireCompletenessPct", cfg.dataQuality.requireCompletenessPct],
    ["dataQuality.maxAdjacentGapBars", cfg.dataQuality.maxAdjacentGapBars],
    ["llm.minConfidenceToTrade", cfg.llm.minConfidenceToTrade],
  ];
  for (const [name, value] of numeric) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${name} must be a finite number (got ${typeof value === "number" ? String(value) : typeof value})`);
    }
  }
  // Costs may be zero (a fee-free assumption) but never negative - a negative cost would
  // credit the account on every fill and flatter the reported PnL.
  for (const [name, value] of [["costs.takerFeeBps", cfg.costs.takerFeeBps], ["costs.slippageBps", cfg.costs.slippageBps]] as Array<[string, number]>) {
    if (Number.isFinite(value) && value < 0) problems.push(`${name} must not be negative - a negative cost would credit the account on every fill`);
  }
  if (Number.isFinite(cfg.backtest.startingCapital) && cfg.backtest.startingCapital <= 0) {
    problems.push(`backtest.startingCapital ${cfg.backtest.startingCapital} must be > 0`);
  }

  if (cfg.meta.placesRealOrders !== false) problems.push("meta.placesRealOrders must be false - CipherEdge never places real orders");
  if (cfg.risk.riskPerTradePct > 1.0) problems.push(`risk.riskPerTradePct ${cfg.risk.riskPerTradePct} exceeds the 1% specification ceiling`);
  if (cfg.risk.maxRiskPerTradePct > 1.0) problems.push(`risk.maxRiskPerTradePct ${cfg.risk.maxRiskPerTradePct} exceeds the 1% specification ceiling`);
  if (cfg.risk.riskPerTradePct > cfg.risk.maxRiskPerTradePct) problems.push("risk.riskPerTradePct exceeds risk.maxRiskPerTradePct");
  if (cfg.risk.minRiskReward < 1.5) problems.push(`risk.minRiskReward ${cfg.risk.minRiskReward} below the 1.5 specification floor`);
  if (!(cfg.risk.minStopDistancePct > 0)) problems.push("risk.minStopDistancePct must be > 0 so degenerate stops are rejected");
  if (cfg.risk.maxPositionNotionalPct <= 0 || cfg.risk.maxPositionNotionalPct > 100) {
    problems.push(`risk.maxPositionNotionalPct ${cfg.risk.maxPositionNotionalPct} must be in (0, 100]`);
  }
  if (cfg.risk.maxConcurrentPositions > 3) problems.push(`risk.maxConcurrentPositions ${cfg.risk.maxConcurrentPositions} exceeds the 3-position specification limit`);
  if (cfg.risk.dailyLossCapPct > 2.0) problems.push(`risk.dailyLossCapPct ${cfg.risk.dailyLossCapPct} exceeds the 2% specification cap`);
  if (cfg.risk.tp1Multiple < cfg.risk.minRiskReward) problems.push("risk.tp1Multiple below risk.minRiskReward");
  if (cfg.execution.pessimisticIntraBar !== true) problems.push("execution.pessimisticIntraBar must stay true (stop-first intra-bar assumption)");
  if (cfg.strategy.cipherB.overbought <= 0 || cfg.strategy.cipherB.oversold >= 0) problems.push("overbought must be > 0 and oversold < 0");
  if (cfg.backtest.outOfSampleDays <= 0 || cfg.backtest.outOfSampleDays >= cfg.backtest.days) {
    problems.push("backtest.outOfSampleDays must be > 0 and < backtest.days");
  }
  if (cfg.backtest.days < 60) problems.push(`backtest.days ${cfg.backtest.days} below the 60-day minimum the run records require`);
  if (cfg.backtest.outOfSampleDays < 30) problems.push(`backtest.outOfSampleDays ${cfg.backtest.outOfSampleDays} below the 30-day out-of-sample minimum`);
  if (cfg.dataQuality.requireCompletenessPct < 95) {
    problems.push(`dataQuality.requireCompletenessPct ${cfg.dataQuality.requireCompletenessPct} below the 95% floor for a validated run`);
  }
  if (cfg.dataQuality.maxAdjacentGapBars < 1 || cfg.dataQuality.maxAdjacentGapBars > 8) {
    problems.push("dataQuality.maxAdjacentGapBars must be between 1 and 8 bars");
  }
  if (problems.length > 0) throw new Error(`config guardrails failed:\n  - ${problems.join("\n  - ")}`);
}

export function loadConfig(configPath?: string): AppConfig {
  const sourcePath = configPath
    ? (isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath))
    : defaultConfigPath();
  if (!existsSync(sourcePath)) throw new Error(`config not found: ${sourcePath}`);
  const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as RawConfig;
  const s = raw.strategy ?? {};

  const strategy: StrategyConfig = {
    cipherB: {
      wavetrend: s.wavetrend ?? DEFAULT_STRATEGY.cipherB.wavetrend,
      momentumSmooth: s.momentumSmooth ?? DEFAULT_STRATEGY.cipherB.momentumSmooth,
      overbought: s.overbought ?? DEFAULT_STRATEGY.cipherB.overbought,
      oversold: s.oversold ?? DEFAULT_STRATEGY.cipherB.oversold,
      divergence: s.divergence ?? DEFAULT_STRATEGY.cipherB.divergence,
    },
    breakout: s.breakout ?? DEFAULT_STRATEGY.breakout,
    sweepTolerancePct: s.sweepTolerancePct ?? DEFAULT_STRATEGY.sweepTolerancePct,
    momentumCoolMax: s.momentumCoolMax ?? DEFAULT_STRATEGY.momentumCoolMax,
    maxSwingAgeBars: s.maxSwingAgeBars ?? DEFAULT_STRATEGY.maxSwingAgeBars,
    signalCooldownBars: s.signalCooldownBars ?? DEFAULT_STRATEGY.signalCooldownBars,
    warmupBars: s.warmupBars ?? DEFAULT_STRATEGY.warmupBars,
  };

  const withoutHash: Omit<AppConfig, "hash"> = {
    meta: { ...DEFAULT_META, ...(raw.meta ?? {}) },
    timeframes: { ...DEFAULT_TIMEFRAMES, ...(raw.timeframes ?? {}) },
    strategy,
    htf: s.htf ?? DEFAULT_HTF,
    risk: { ...DEFAULT_RISK, ...(raw.risk ?? {}) },
    execution: { ...DEFAULT_EXECUTION, ...(raw.execution ?? {}) },
    costs: { ...DEFAULT_COSTS, ...(raw.costs ?? {}) },
    backtest: { ...DEFAULT_BACKTEST, ...(raw.backtest ?? {}) },
    dataQuality: { ...DEFAULT_DATA_QUALITY, ...(raw.dataQuality ?? {}) },
    llm: { ...DEFAULT_LLM, ...(raw.llm ?? {}) },
    sourcePath,
  };

  const cfg = { ...withoutHash, hash: configHash(withoutHash) } as AppConfig;
  assertGuardrails(cfg);
  return cfg;
}

/** Resolve a possibly-relative data directory against the repository root. */
export function resolveDataDir(dataDir: string, root: string = repoRoot()): string {
  return isAbsolute(dataDir) ? dataDir : resolve(root, dataDir);
}
