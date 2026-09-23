import type { Candle, CipherBState } from "../types.ts";

/** Everything a setup predicate may inspect at bar index t. All values are causal (bars <= t). */
export interface SetupInput {
  t: number;
  candle: Candle;
  prevCandle: Candle | null;
  cipher: CipherBState;
  prevCipher: CipherBState | null;
  wave: number;
  wavePrev: number;
  wavePrev2: number;
  /** Nearest recent confirmed swing high (Setup A supply reference), or null. */
  refSwingHigh: number | null;
  /** Broken level being retested as support (Setup B), or null. */
  retestLevel: number | null;
  /** Whether a breakout occurred recently and is awaiting/just completed a retest. */
  retestNow: boolean;
  overbought: number;
  oversold: number;
  /** Setup A: price must have reached within this % of the reference swing high. */
  sweepTolerancePct: number;
  /** Setup B: momentum wave must be at/below this value to count as "cooled". */
  momentumCoolMax: number;
}
