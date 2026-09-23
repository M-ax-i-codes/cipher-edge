export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the raw text completion. */
  complete(prompt: string): Promise<string>;
}

export interface HttpLlmOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** OpenAI-compatible /chat/completions provider (e.g. the Bitget hackathon Qwen endpoint). */
export class HttpLlmProvider implements LlmProvider {
  readonly name = "http";
  readonly model: string;
  private opts: HttpLlmOptions;
  constructor(opts: HttpLlmOptions) {
    this.opts = opts;
    this.model = opts.model;
  }
  async complete(prompt: string): Promise<string> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60000),
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature ?? 0.1,
        max_tokens: this.opts.maxTokens ?? 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`llm HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  }
}
