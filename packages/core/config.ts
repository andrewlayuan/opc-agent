import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export interface AppConfig {
  env: string;
  host: string;
  port: number;
  publicOrigin: string;
  /** 前面有本机反代（Caddy）时设为 true，按 X-Forwarded-For 取客户端 IP */
  trustProxy: boolean;
  dataDir: string;
  dbPath: string;
  adminUser: string;
  adminHash: string;
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    concurrency: number;
    analyzeLimitPerRun: number;
  };
  fetchIntervalMin: number;
  maxAgeDays: number;
  /** 每轮最多用 Agent-Reach 补全多少条正文（Jina 无 Key 限额 20 次/分钟） */
  fulltextLimit: number;
}

export function loadConfig(opts: { requireAuth?: boolean } = {}): AppConfig {
  const port = int('OPC_PORT', 4180, 1, 65535);
  const dataDir = path.resolve(process.env.OPC_DATA_DIR?.trim() || path.join(ROOT, 'data'));
  const cfg: AppConfig = {
    env: process.env.NODE_ENV?.trim() || 'production',
    host: process.env.OPC_HOST?.trim() || '127.0.0.1',
    port,
    publicOrigin: (process.env.OPC_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    trustProxy: ['1', 'true', 'on'].includes(process.env.OPC_TRUST_PROXY?.trim().toLowerCase() ?? ''),
    dataDir,
    dbPath: path.join(dataDir, 'opc.db'),
    adminUser: process.env.OPC_ADMIN_USER?.trim() || '',
    adminHash: process.env.OPC_ADMIN_HASH?.trim() || '',
    llm: {
      apiKey: process.env.DEEPSEEK_API_KEY?.trim() || '',
      baseUrl: (process.env.OPC_LLM_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: process.env.OPC_LLM_MODEL?.trim() || 'deepseek-chat',
      concurrency: int('OPC_LLM_CONCURRENCY', 4, 1, 16),
      analyzeLimitPerRun: int('OPC_ANALYZE_LIMIT', 80, 0, 2000),
    },
    fetchIntervalMin: int('OPC_FETCH_INTERVAL_MIN', 60, 5, 24 * 60),
    maxAgeDays: int('OPC_MAX_AGE_DAYS', 14, 1, 365),
    fulltextLimit: int('OPC_FULLTEXT_LIMIT', 25, 0, 500),
  };
  if (opts.requireAuth) {
    if (!cfg.adminUser || !cfg.adminHash) {
      throw new Error('必须设置 OPC_ADMIN_USER 与 OPC_ADMIN_HASH（用 npm run hash-password 生成）');
    }
    if (!cfg.adminHash.startsWith('scrypt$')) throw new Error('OPC_ADMIN_HASH 格式应为 scrypt$N$r$p$salt$hash');
  }
  if (!/^https:\/\//.test(cfg.llm.baseUrl)) throw new Error('OPC_LLM_BASE_URL 必须是 https 地址');
  return cfg;
}
