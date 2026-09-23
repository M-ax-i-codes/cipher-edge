/**
 * Paper-trading record layer.
 *
 * Converts closed backtest/replay trades into the run-record schema the hackathon
 * requires - timestamp, instrument, direction, price, quantity and account balance
 * change - plus a richer event log that also carries the plan (stop, TP1, TP2),
 * the risk actually taken, and the modelled cost split.
 *
 * ACCOUNTING NOTE (stated so nothing is implied that is not true): CipherEdge sizes
 * off mark-to-market equity and settles fees, slippage and funding together with the
 * realised PnL when a position closes. An ENTRY event therefore changes the settled
 * balance by 0; the whole net effect lands on the EXIT event. Summing
 * `account_balance_change` over every event reproduces `ending_balance - starting_balance`.
 */
import type { ExecutionDecision, PaperRecord, TradeRecord } from "../types.ts";
import { isoUtc } from "../util/time.ts";
import { round } from "../util/math.ts";

/** One row of the event log: an entry or an exit, in the order it happened. */
export interface PaperEvent {
  timestamp: string;
  instrument: string;
  timeframe: string;
  action: "ENTRY" | "EXIT";
  direction: string;
  setup_type: string;
  price: number;
  quantity: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  risk_amount: number;
  fees: number;
  slippage: number;
  funding: number;
  realized_pnl: number;
  account_balance_change: number;
  account_balance: number;
  confidence: number;
  intended_risk_pct: number;
  actual_risk_pct: number;
  notional_cap_applied: boolean;
  binding_constraint: string;
  exit_reason: string;
  trade_id: string;
}

export const PAPER_EVENT_COLUMNS: Array<keyof PaperEvent> = [
  "timestamp", "instrument", "timeframe", "action", "direction", "setup_type",
  "price", "quantity", "stop_loss", "take_profit_1", "take_profit_2", "risk_amount",
  "fees", "slippage", "funding", "realized_pnl", "account_balance_change", "account_balance",
  "confidence", "intended_risk_pct", "actual_risk_pct", "notional_cap_applied",
  "binding_constraint", "exit_reason", "trade_id",
];

export const PAPER_RECORD_COLUMNS: Array<keyof PaperRecord> = [
  "timestamp", "instrument", "timeframe", "direction", "setup_type", "entry_price",
  "stop_loss", "take_profit_1", "take_profit_2", "quantity", "risk_amount",
  "fees", "slippage", "funding", "realized_pnl", "account_balance_change",
];

export interface PaperLedger {
  mode: "replay" | "signal";
  generatedAt: string;
  startingBalance: number;
  endingBalance: number;
  netChange: number;
  netChangePct: number;
  events: number;
  roundTrips: number;
  wins: number;
  losses: number;
  totalFees: number;
  totalSlippage: number;
  totalFunding: number;
  placesRealOrders: false;
  /** Honest labelling: replay is derived from committed historical candles, not a live feed. */
  dataSource: string;
  windowFromIso: string | null;
  windowToIso: string | null;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv<T extends object>(rows: T[], columns: Array<keyof T>): string {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => csvCell(row[col])).join(",")).join("\n");
  return rows.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
}

/** Closed-trade summary rows in the exact hackathon run-record field order. */
export function tradesToPaperRecords(trades: TradeRecord[], startingBalance: number): PaperRecord[] {
  let balance = startingBalance;
  // Sorted by ENTRY time so the file is chronological in the `timestamp` column it prints,
  // and so it agrees row-for-row with paper-events.csv. (Sorting by exit time while stamping
  // the entry time would produce a log whose timestamps jump backwards.)
  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs || a.exitTs - b.exitTs || a.symbol.localeCompare(b.symbol));
  return sorted.map((t) => {
    balance += t.realizedPnl;
    return {
      timestamp: isoUtc(t.entryTs),
      instrument: t.symbol,
      timeframe: t.timeframe,
      direction: t.direction,
      setup_type: t.setupType,
      entry_price: round(t.entryPrice, 8),
      // The PLANNED stop, not the managed one: after TP1 the managed stop moves to
      // breakeven, which would misrepresent the risk that was actually accepted at entry.
      stop_loss: round(t.initialStopLoss, 8),
      take_profit_1: round(t.takeProfit1, 8),
      take_profit_2: round(t.takeProfit2, 8),
      quantity: round(t.quantity, 8),
      risk_amount: round(t.riskAmount, 6),
      fees: round(t.fees, 6),
      slippage: round(t.slippage, 6),
      funding: round(t.funding, 6),
      realized_pnl: round(t.realizedPnl, 6),
      account_balance_change: round(t.realizedPnl, 6),
    };
  });
}

/** Entry/exit event log with a running settled balance. */
export function tradesToPaperEvents(trades: TradeRecord[], startingBalance: number): PaperEvent[] {
  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol));
  const events: PaperEvent[] = [];
  let balance = startingBalance;

  const base = (t: TradeRecord): Omit<PaperEvent, "timestamp" | "action" | "price" | "quantity" | "fees" | "slippage" | "funding" | "realized_pnl" | "account_balance_change" | "account_balance" | "exit_reason"> => ({
    instrument: t.symbol,
    timeframe: t.timeframe,
    direction: t.direction,
    setup_type: t.setupType,
    stop_loss: round(t.initialStopLoss, 8),
    take_profit_1: round(t.takeProfit1, 8),
    take_profit_2: round(t.takeProfit2, 8),
    risk_amount: round(t.riskAmount, 6),
    confidence: round(t.confidence, 3),
    intended_risk_pct: round(t.intendedRiskPct, 4),
    actual_risk_pct: round(t.actualRiskPct, 4),
    notional_cap_applied: t.notionalCapApplied,
    binding_constraint: t.bindingConstraint,
    trade_id: t.id,
  });

  for (const t of sorted) {
    events.push({
      ...base(t),
      timestamp: isoUtc(t.entryTs),
      action: "ENTRY",
      price: round(t.entryPrice, 8),
      quantity: round(t.quantity, 8),
      fees: 0,
      slippage: 0,
      funding: 0,
      realized_pnl: 0,
      account_balance_change: 0,
      account_balance: round(balance, 6),
      exit_reason: "",
    });
    balance += t.realizedPnl;
    events.push({
      ...base(t),
      timestamp: isoUtc(t.exitTs),
      action: "EXIT",
      price: round(t.exitPrice, 8),
      quantity: round(t.quantity, 8),
      fees: round(t.fees, 6),
      slippage: round(t.slippage, 6),
      funding: round(t.funding, 6),
      realized_pnl: round(t.realizedPnl, 6),
      account_balance_change: round(t.realizedPnl, 6),
      account_balance: round(balance, 6),
      exit_reason: t.exitReason,
    });
  }
  return events;
}

export function paperEventsCsv(events: PaperEvent[]): string {
  return toCsv(events, PAPER_EVENT_COLUMNS);
}

export function paperRecordsCsv(records: PaperRecord[]): string {
  return toCsv(records, PAPER_RECORD_COLUMNS);
}

/** Ledger totals, recomputed from the events so the CSV and the summary cannot disagree. */
export function buildPaperLedger(events: PaperEvent[], startingBalance: number, meta: {
  mode: "replay" | "signal";
  dataSource: string;
  windowFromIso: string | null;
  windowToIso: string | null;
}): PaperLedger {
  const exits = events.filter((e) => e.action === "EXIT");
  const netChange = exits.reduce((a, e) => a + e.account_balance_change, 0);
  const endingBalance = startingBalance + netChange;
  return {
    mode: meta.mode,
    generatedAt: new Date().toISOString(),
    startingBalance: round(startingBalance, 6),
    endingBalance: round(endingBalance, 6),
    netChange: round(netChange, 6),
    netChangePct: startingBalance > 0 ? round((netChange / startingBalance) * 100, 4) : 0,
    events: events.length,
    roundTrips: exits.length,
    wins: exits.filter((e) => e.realized_pnl > 0).length,
    losses: exits.filter((e) => e.realized_pnl <= 0).length,
    totalFees: round(exits.reduce((a, e) => a + e.fees, 0), 6),
    totalSlippage: round(exits.reduce((a, e) => a + e.slippage, 0), 6),
    totalFunding: round(exits.reduce((a, e) => a + e.funding, 0), 6),
    placesRealOrders: false,
    dataSource: meta.dataSource,
    windowFromIso: meta.windowFromIso,
    windowToIso: meta.windowToIso,
  };
}

/** The strict-JSON decision objects, one per line, for the paper decision log. */
export function decisionsToJsonl(decisions: ExecutionDecision[]): string {
  return decisions.length > 0 ? `${decisions.map((d) => JSON.stringify(d)).join("\n")}\n` : "";
}
