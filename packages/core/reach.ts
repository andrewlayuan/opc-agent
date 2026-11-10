// Agent-Reach（https://github.com/Panniantong/Agent-Reach）子进程客户端。
// 安全约束：不经过 shell；只允许白名单内的渠道/动作和校验过的参数；子进程只拿到最小环境变量（不含 API Key）；
// 有超时和输出上限；同一渠道串行并保持最小间隔。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { checkPublicUrl } from './net.ts';

export interface ReachItem {
  title: string | null;
  url: string | null;
  author: string | null;
  published_at: string | null;
  text: string | null;
}

export class ReachError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

type Validator = (args: string[]) => string[];

const LIMIT = (v: string | undefined, def: number): string[] => {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ReachError('BAD_INPUT', 'limit 必须是 1-50 的整数');
  return ['--limit', String(n)];
};

/** 允许的命令：channel action -> 参数校验并返回规范化的参数列表 */
const ALLOWED: Record<string, Validator> = {
  'v2ex hot': ([limit]) => LIMIT(limit, 10),
  'v2ex node': ([node, limit]) => {
    if (!node || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(node)) throw new ReachError('BAD_INPUT', 'V2EX 节点名不合法');
    return [node, ...LIMIT(limit, 10)];
  },
  'web read': ([url]) => {
    const u = checkPublicUrl(url ?? '');
    return [u.href];
  },
};

/** 每个渠道的最小调用间隔（毫秒）。web 走 Jina Reader，无 Key 时限额 20 次/分钟 */
const MIN_INTERVAL: Record<string, number> = { web: 3500, v2ex: 1500 };

export function reachCommandAllowed(args: string[]): boolean {
  return Boolean(args.length >= 2 && ALLOWED[`${args[0]} ${args[1]}`]);
}

export class Reach {
  readonly bin: string;
  readonly enabled: boolean;
  private queues = new Map<string, Promise<unknown>>();

  constructor(opts: { bin?: string; enabled?: boolean } = {}) {
    this.bin = opts.bin || process.env.OPC_AGENT_REACH_BIN?.trim() || path.join(ROOT, 'bin', 'agent-reach');
    const flag = process.env.OPC_AGENT_REACH?.trim().toLowerCase();
    const off = flag === '0' || flag === 'false' || flag === 'off';
    this.enabled = (opts.enabled ?? !off) && fs.existsSync(this.bin);
  }

  private serial<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(channel) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const gap = MIN_INTERVAL[channel] ?? 1000;
    const wait = () => new Promise((r) => setTimeout(r, gap));
    this.queues.set(channel, run.then(wait, wait));
    return run;
  }

  /** 执行一条白名单命令，例如 run(['v2ex', 'node', 'openai', '20']) */
  async run(args: string[], timeoutMs = 90000): Promise<ReachItem[]> {
    if (!this.enabled) throw new ReachError('NEED_SETUP', '未安装或已停用 Agent-Reach（bin/agent-reach）');
    if (!reachCommandAllowed(args)) throw new ReachError('BAD_INPUT', `不允许的 Agent-Reach 命令：${args.slice(0, 2).join(' ')}`);
    const [channel, action, ...rest] = args;
    const argv = [channel, action, ...ALLOWED[`${channel} ${action}`](rest)];
    return this.serial(channel, () => this.exec(argv, timeoutMs));
  }

  private exec(argv: string[], timeoutMs: number): Promise<ReachItem[]> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONIOENCODING: 'utf-8',
    };
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (process.env[k]) env[k] = process.env[k];
    return new Promise((resolve, reject) => {
      execFile(this.bin, argv, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        let data: { ok?: boolean; items?: ReachItem[]; error?: { code?: string; message?: string } } | null = null;
        try {
          data = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop() ?? '');
        } catch {
          data = null;
        }
        if (data?.ok === true) return resolve(Array.isArray(data.items) ? data.items : []);
        if (data?.error) return reject(new ReachError(String(data.error.code ?? 'ERROR'), String(data.error.message ?? '未知错误').slice(0, 300)));
        const killed = err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        reject(new ReachError(killed ? 'TIMEOUT' : 'ERROR', killed ? 'Agent-Reach 超时' : `Agent-Reach 执行失败：${err?.message.slice(0, 200) ?? '无输出'}`));
      });
    });
  }
}

/** 把 Jina/Exa 返回的 Markdown 清理为纯文本 */
export function cleanMarkdown(md: string, maxLen = 30000): string {
  let s = md
    .replace(/<[^>]{0,500}>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .replace(/^\s*(={3,}|-{3,}|\*{3,})\s*$/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}
