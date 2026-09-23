import type { SetupInput } from "./context.ts";
import type { SetupVerdict } from "./setupA.ts";

/**
 * SETUP B - BULLISH RETEST LONG. All conditions are mandatory.
 *
 *   breakoutRetest : a breakout above resistance has retested the level as support
 *                    and held (detected causally by structure/breakout.ts).
 *   momentumReset  : the momentum wave has cooled to/below the zero-line threshold.
 *   trigger        : a bottom green dot fired at t or t-1, OR bullish curvature
 *                    (two consecutive rising wave bars) while cooled.
 */
export function evaluateSetupB(input: SetupInput): SetupVerdict {
  const { cipher, prevCipher, wave, wavePrev, wavePrev2, retestNow, momentumCoolMax } = input;
  const breakoutRetest = retestNow;
  const cooled = Number.isFinite(wave) && wave <= momentumCoolMax;
  const momentumReset = cooled;
  const greenDot = cipher.dot === -1 || prevCipher?.dot === -1;
  const curvature = Number.isFinite(wave) && Number.isFinite(wavePrev) && Number.isFinite(wavePrev2) && wave > wavePrev && wavePrev > wavePrev2;
  const trigger = greenDot || (curvature && cooled);
  const conditions = { breakoutRetest, momentumReset, trigger };
  const pass = breakoutRetest && momentumReset && trigger;
  return { pass, conditions };
}
