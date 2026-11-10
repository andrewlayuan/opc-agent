import { allowHost, apiPost } from './net.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  concurrency: number;
}

export class LlmError extends Error {}

export class Llm {
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly opts: LlmOptions;

  constructor(opts: LlmOptions) {
    this.opts = opts;
    if (opts.apiKey) allowHost(new URL(opts.baseUrl).hostname);
  }

  get enabled(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  async chat(messages: ChatMessage[], o: { json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<string> {
    if (!this.enabled) throw new LlmError('未配置 DEEPSEEK_API_KEY，无法调用模型');
    return this.slot(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await apiPost(
            `${this.opts.baseUrl}/chat/completions`,
            { authorization: `Bearer ${this.opts.apiKey}` },
            {
              model: this.opts.model,
              messages,
              temperature: o.temperature ?? 0.3,
              max_tokens: o.maxTokens ?? 1200,
              stream: false,
              ...(o.json ? { response_format: { type: 'json_object' } } : {}),
            },
            o.timeoutMs,
          );
          if (res.status === 429 || res.status >= 500) {
            lastErr = new LlmError(`模型服务暂时不可用（HTTP ${res.status}）`);
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          if (res.status !== 200) {
            const msg = (res.json as { error?: { message?: string } } | null)?.error?.message ?? res.text.slice(0, 200);
            throw new LlmError(`模型调用失败（HTTP ${res.status}）：${msg}`);
          }
          const content = (res.json as { choices?: { message?: { content?: string } }[] } | null)?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') throw new LlmError('模型返回格式异常');
          return content;
        } catch (e) {
          if (e instanceof LlmError && !String(e.message).includes('暂时不可用')) throw e;
          lastErr = e;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
    });
  }

  async json<T>(messages: ChatMessage[], maxTokens = 1200): Promise<T> {
    const text = await this.chat(messages, { json: true, maxTokens });
    try {
      return JSON.parse(text) as T;
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as T;
      throw new LlmError('模型未返回合法 JSON');
    }
  }
}
