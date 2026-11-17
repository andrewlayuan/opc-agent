import { allowHost, apiPost } from './net.ts';

/** 多模态内容块；图片只能出现在 user 消息里 */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** on / off 时发送 thinking 参数；null 或缺省时不发送 */
  thinking?: 'on' | 'off' | null;
  concurrency: number;
}

export class LlmError extends Error {}

export interface ChatOptions { json?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number }
type Post = typeof apiPost;

/** 输出达到上限后，最多自动续写的次数 */
export const CONTINUE_MAX = 2;
const CONTINUE_PROMPT = '你上一条回复因长度限制被截断。请从中断处直接接着写，不要重复已经写过的内容，不要加任何开场白、标记或说明。';

export class Llm {
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly opts: LlmOptions;
  private readonly post: Post;

  constructor(opts: LlmOptions, post: Post = apiPost) {
    this.opts = opts;
    this.post = post;
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

  async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    return (await this.complete(messages, o)).content;
  }

  /** 长文输出：被长度截断时从断点续写，最多 CONTINUE_MAX 次；仍未写完时 truncated 为 true */
  async chatLong(messages: ChatMessage[], o: ChatOptions = {}): Promise<{ content: string; truncated: boolean }> {
    let r = await this.complete(messages, o);
    let content = r.content;
    for (let i = 0; i < CONTINUE_MAX && r.finish === 'length'; i++) {
      r = await this.complete([...messages, { role: 'assistant', content }, { role: 'user', content: CONTINUE_PROMPT }], o);
      content += r.content;
    }
    return { content, truncated: r.finish === 'length' };
  }

  private async complete(messages: ChatMessage[], o: ChatOptions): Promise<{ content: string; finish: string }> {
    if (!this.enabled) throw new LlmError('未配置 DEEPSEEK_API_KEY，无法调用模型');
    return this.slot(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await this.post(
            `${this.opts.baseUrl}/chat/completions`,
            { authorization: `Bearer ${this.opts.apiKey}` },
            {
              model: this.opts.model,
              messages,
              temperature: o.temperature ?? 0.3,
              max_tokens: o.maxTokens ?? 1200,
              stream: false,
              ...(o.json ? { response_format: { type: 'json_object' } } : {}),
              ...(this.opts.thinking ? { thinking: { type: this.opts.thinking === 'on' ? 'enabled' : 'disabled' } } : {}),
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
          const choice = (res.json as { choices?: { message?: { content?: string }; finish_reason?: string }[] } | null)?.choices?.[0];
          const content = choice?.message?.content;
          if (typeof content !== 'string') throw new LlmError('模型返回格式异常');
          return { content, finish: String(choice?.finish_reason ?? '') };
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
