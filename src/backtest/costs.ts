export interface CostConfig {
  /** Taker fee in basis points, charged on entry and on every exit leg. */
  takerFeeBps: number;
  /** Adverse slippage in basis points applied to every fill price. */
  slippageBps: number;
  /** Funding in basis points per 8h, accrued pro-rata while a position is open. */
  fundingBpsPer8h: number;
}

export const DEFAULT_COSTS: CostConfig = { takerFeeBps: 10, slippageBps: 5, fundingBpsPer8h: 1 };

export const MINUTES_PER_FUNDING_PERIOD = 480;

export function bps(value: number, basisPoints: number): number {
  return (Math.abs(value) * basisPoints) / 10_000;
}

/** Taker fee charged on a fill of `quantity` at `price`. */
export function feeOn(price: number, quantity: number, cfg: CostConfig = DEFAULT_COSTS): number {
  return bps(price * quantity, cfg.takerFeeBps);
}

/**
 * Adverse slippage: a buy always fills higher and a sell always fills lower than the
 * intended price. This is deliberately pessimistic - it never helps the strategy.
 */
export function applySlippage(price: number, side: "buy" | "sell", cfg: CostConfig = DEFAULT_COSTS): number {
  const factor = cfg.slippageBps / 10_000;
  return side === "buy" ? price * (1 + factor) : price * (1 - factor);
}

/** Dollar cost of slippage between the intended and the actual fill price. */
export function slippageCost(intendedPrice: number, filledPrice: number, quantity: number): number {
  return Math.abs(filledPrice - intendedPrice) * quantity;
}

/** Funding accrued for one bar of `barMinutes` on a notional exposure. */
export function fundingForBar(notional: number, barMinutes: number, cfg: CostConfig = DEFAULT_COSTS): number {
  return bps(notional, cfg.fundingBpsPer8h) * (barMinutes / MINUTES_PER_FUNDING_PERIOD);
}
