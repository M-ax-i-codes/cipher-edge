/** A single OHLCV candle. `ts` is the bar OPEN time in epoch milliseconds. */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
}

/** WaveTrend oscillator state for one bar. */
export interface WaveTrendState {
  /** Typical price ap = (h + l + c) / 3. */
  ap: number;
  /** Channel midpoint EMA(ap, n1). */
  esa: number;
  /** Mean deviation d = EMA(|ap - esa|, n1). */
  d: number;
  /** Channel index ci = (ap - esa) / (0.015 * d). */
  ci: number;
  /** os1 = EMA(ci, n2) - the fast WaveTrend line. */
  os1: number;
  /** os2 = SMA(os1, 4) - the slow WaveTrend line. */
  os2: number;
}

/** Full VMC Cipher B state for one bar (CipherEdge interpretation - see indicators/cipherB.ts). */
export interface CipherBState {
  ts: number;
  wt: WaveTrendState;
  /** Smoothed momentum wave (documented interpretation of the Cipher B "momentum wave"). */
  momentumWave: number;
  /** +1 top red dot fired on this bar, -1 bottom green dot, 0 none. */
  dot: -1 | 0 | 1;
  /** True while momentum wave is in the overbought zone (> overbought threshold). */
  overbought: boolean;
  /** True while momentum wave is in the oversold zone (< oversold threshold). */
  oversold: boolean;
  /** Bearish divergence active (price higher-high vs wave lower-high). */
  bearishDivergence: boolean;
  /** Bullish divergence active (price lower-low vs wave higher-low). */
  bullishDivergence: boolean;
}

export type Direction = "LONG" | "SHORT" | "NO_TRADE";
export type SetupType = "BEARISH_DIVERGENCE" | "BREAKOUT_RETEST" | "NONE";

/** Deterministic strategy signal produced by the rules engine (before any LLM input). */
export interface StrategySignal {
  ts: number;
  symbol: string;
  direction: Direction;
  setupType: SetupType;
  /** Which mandatory conditions were satisfied (audit trail). */
  conditions: Record<string, boolean>;
  /** Reference prices used to build the trade plan. */
  swingHigh: number | null;
  swingLow: number | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
}

/** Strict-JSON execution decision (the CipherEdge schema). */
export interface ExecutionDecision {
  symbol: string;
  direction: Direction;
  setup_type: SetupType;
  confidence_score: number;
  execution: {
    entry_price: number;
    stop_loss: number;
    take_profit_1: number;
    take_profit_2: number;
    risk_reward_ratio: number;
  };
  rationale: string[];
  /** Provenance: model + prompt/version, recorded for every decision. */
  provenance: {
    model: string;
    promptVersion: string;
    llmUsed: boolean;
    deterministicGate: SetupType | "NONE";
  };
}

/** Which constraint determined the final position size. */
export type BindingConstraint = "risk-budget" | "notional-cap";

/**
 * Risk-engine output for a candidate trade.
 *
 * Sizing transparency is explicit: `intended*` is what the risk budget alone would have
 * produced, `quantity`/`notional`/`actualRisk*` is what will really be traded after the
 * notional cap. The cap can only ever REDUCE risk - it never increases it, and the
 * reduction is reported rather than silently absorbed.
 */
export interface RiskPlan {
  approved: boolean;
  reasons: string[];
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  quantity: number;
  notional: number;
  riskAmount: number;
  riskRewardRatio: number;
  stopDistancePct: number;
  /** Risk the strategy intended to take, percent of equity. */
  intendedRiskPct: number;
  /** Size the risk budget alone would have produced. */
  intendedQuantity: number;
  intendedNotional: number;
  /** True when maxPositionNotionalPct shrank the position below the risk budget. */
  notionalCapApplied: boolean;
  /** Risk actually at hazard after the cap, in percent of equity and in quote currency. */
  actualRiskPct: number;
  actualRiskAmount: number;
  bindingConstraint: BindingConstraint;
}

/** A closed (or mark-to-market) trade record. */
export interface TradeRecord {
  id: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  /** Confidence from the execution decision. The LLM may adjust confidence only, never direction. */
  confidence: number;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  /**
   * The stop as planned at entry, BEFORE any breakeven move. Kept separately because
   * `stopLoss` below is the managed stop and can legitimately become the entry price
   * once TP1 fills - reporting only the managed value would hide the real R:R and make
   * the audit trail unverifiable.
   */
  initialStopLoss: number;
  /** Final managed stop at exit (may equal entryPrice after a breakeven move). */
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  quantity: number;
  /** Entry notional actually deployed. */
  notional: number;
  riskAmount: number;
  /** Risk the strategy intended to take, percent of equity at entry. */
  intendedRiskPct: number;
  /** Risk actually at hazard as a percent of equity at entry, after any notional cap. */
  actualRiskPct: number;
  /** True when the notional cap shrank this position below its risk budget. */
  notionalCapApplied: boolean;
  /** Which constraint set the final size. */
  bindingConstraint: BindingConstraint;
  fees: number;
  slippage: number;
  funding: number;
  realizedPnl: number;
  rMultiple: number;
  holdingMinutes: number;
  exitReason: "tp1" | "tp2" | "stop" | "time" | "eod";
}

/** Paper-trading record in the exact schema required by the hackathon run-records. */
export interface PaperRecord {
  timestamp: string;
  instrument: string;
  timeframe: string;
  direction: string;
  setup_type: string;
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  quantity: number;
  risk_amount: number;
  fees: number;
  slippage: number;
  funding: number;
  realized_pnl: number;
  account_balance_change: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  cash: number;
  openPositions: number;
  drawdownPct: number;
  /** Total open notional at this bar close, and the same figure as a percent of equity. */
  exposureNotional: number;
  exposurePct: number;
}
