// OPC Radar MCP 服务（stdio，按行分隔的 JSON-RPC 2.0）。只读访问本地情报库。
import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { latestBrief } from '../../packs/radar/analyze.ts';
import { getItem, listItems } from '../../packs/radar/query.ts';
import type { ItemView } from '../../packs/radar/query.ts';
import { loadTopics } from '../../packs/radar/text.ts';

const cfg = loadConfig();
const topics = loadTopics();
let db: DB | null = null;

function database(): DB {
  if (db) return db;
  if (!fs.existsSync(cfg.dbPath)) throw new Error(`情报库不存在：${cfg.dbPath}。请先启动 OPC Radar 采集。`);
  db = openDb(cfg.dbPath, { readOnly: true });
  return db;
}

const TOPIC_IDS = topics.map((t) => t.id);

export const TOOLS = [
  {
    name: 'radar_latest',
    description: '获取最近的 AI 技术动态（已去重，含中文摘要与分析）。可按主题和重要度过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: TOPIC_IDS, description: `主题：${topics.map((t) => `${t.id}=${t.label}`).join('，')}` },
        days: { type: 'integer', minimum: 1, maximum: 90, default: 3 },
        min_importance: { type: 'integer', minimum: 1, maximum: 5, description: '最低重要度（1-5）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'radar_search',
    description: '在本地情报库中全文搜索（标题、正文、中文摘要）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'radar_item',
    description: '读取单条资讯的完整内容、分析与译文。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'radar_brief',
    description: '读取最近一次生成的每日 AI 简报（含编号来源）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

function fmt(items: ItemView[]): string {
  if (!items.length) return '没有匹配的条目。';
  const label = Object.fromEntries(topics.map((t) => [t.id, t.label]));
  return items
    .map((it) => {
      const lines = [
        `#${it.id} ${it.title_zh || it.title}${it.importance ? `（重要度 ${it.importance}/5）` : ''}`,
        `  来源：${it.source_name} · ${new Date(it.published_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${it.url}`,
      ];
      if (it.title_zh && it.title_zh !== it.title) lines.push(`  原标题：${it.title}`);
      if (it.topics.length) lines.push(`  主题：${it.topics.map((t) => label[t] ?? t).join('、')}`);
      if (it.summary_zh) lines.push(`  摘要：${it.summary_zh}`);
      for (const a of it.analysis) lines.push(`  - ${a}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function callTool(name: string, args: Record<string, unknown>): string {
  const d = database();
  switch (name) {
    case 'radar_latest': {
      const topic = typeof args.topic === 'string' && TOPIC_IDS.includes(args.topic) ? args.topic : undefined;
      return fmt(
        listItems(d, {
          topic,
          days: num(args.days, 3, 1, 90),
          minImportance: args.min_importance === undefined ? undefined : num(args.min_importance, 1, 1, 5),
          limit: num(args.limit, 20, 1, 50),
        }),
      );
    }
    case 'radar_search': {
      const q = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
      if (!q) throw new Error('query 不能为空');
      return fmt(listItems(d, { q, days: num(args.days, 30, 1, 365), limit: num(args.limit, 20, 1, 50) }));
    }
    case 'radar_item': {
      const it = getItem(d, num(args.id, 0, 0, Number.MAX_SAFE_INTEGER));
      if (!it) throw new Error('条目不存在');
      return [fmt([it]), '', '正文：', it.content || '（无）', ...(it.translation_zh ? ['', '中文译文：', it.translation_zh] : [])].join('\n');
    }
    case 'radar_brief': {
      const b = latestBrief(d);
      if (!b) return '还没有生成过简报。';
      return `${b.content}\n\n来源：\n${b.items.map((x) => `[${x.n}] ${x.title} — ${x.url}`).join('\n')}`;
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

type Req = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown> };

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(req: Req): void {
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;
  try {
    let result: unknown;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'opc-radar', version: '0.1.0' },
          instructions: 'OPC Radar：本地 AI 技术情报库。回答 AI 新闻/模型发布/Agent/RAG/记忆/语音等问题时，先用 radar_latest 或 radar_search 查询，引用时附上条目 URL。',
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        try {
          result = { content: [{ type: 'text', text: callTool(name, args) }], isError: false };
        } catch (e) {
          result = { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
        break;
      }
      default:
        if (isNotification) return;
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    if (!isNotification) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('server.ts')) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Req;
    try {
      msg = JSON.parse(line) as Req;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) for (const m of msg as Req[]) handle(m);
    else handle(msg);
  });
  rl.on('close', () => {
    db?.close();
    process.exit(0);
  });
}
