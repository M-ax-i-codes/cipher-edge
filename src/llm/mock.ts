import type { LlmProvider } from "./provider.ts";

/**
 * Deterministic mock provider for tests and offline/reproducible runs. It derives a
 * confluence label from the satisfied-condition count in the prompt - no randomness,
 * no network - so backtests remain byte-reproducible.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  async complete(prompt: string): Promise<string> {
    const m = /"conditions_satisfied":\s*\[([^\]]*)\]/.exec(prompt);
    const count = m ? m[1]!.split(",").filter((s) => s.trim().length > 0).length : 0;
    const confluence = count >= 5 ? "strong" : count >= 3 ? "moderate" : "weak";
    const adjustment = confluence === "strong" ? 0.1 : confluence === "moderate" ? 0.0 : -0.05;
    return JSON.stringify({
      confluence,
      confidence_adjustment: adjustment,
      notes: [`mock confluence=${confluence} from ${count} satisfied conditions`],
    });
  }
}
