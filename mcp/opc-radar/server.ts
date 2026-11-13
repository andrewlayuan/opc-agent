// OPC Radar MCP 服务（stdio，按行分隔的 JSON-RPC 2.0）。只读访问本地情报库。
import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { getDoc } from '../../packs/kb/docs.ts';
import { searchKb } from '../../packs/kb/search.ts';
import { KB_LIMITS } from '../../packs/kb/types.ts';
import { recallHistory } from '../../packs/memory/context.ts';
import { profileMarkdown } from '../../packs/memory/store.ts';
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
  {
    name: 'memory_profile',
    description: '读取用户画像与记忆（事实、偏好、决定、关注），用于了解用户背景。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'history_search',
    description: '检索用户过去的产品评审与讨论，返回 #id 日期 需求摘要｜命中片段｜最新结论。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_search',
    description: '在用户的知识库（上传资料、评审、资讯、笔记）中全文搜索，每行返回 #docId 目录路径/标题 › 小节｜命中片段。只读；评审类条目可能不是最新版本。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_doc',
    description: `读取知识库条目的标题、目录、来源与正文（每页 ${KB_LIMITS.mcpPage} 字，用 page 翻页）。只读；评审类条目可能不是最新版本。`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 }, page: { type: 'integer', minimum: 1, default: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
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

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function kbSearch(d: DB, args: Record<string, unknown>): string {
  const q = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
  if (!q) throw new Error('query 不能为空');
  let hits: ReturnType<typeof searchKb>;
  try {
    hits = searchKb(d, q, num(args.limit, 5, 1, 10));
  } catch {
    hits = [];
  }
  if (!hits.length) return '知识库中没有找到相关内容';
  return hits.map((h) => `#${h.doc.id} ${h.doc.path}/${h.doc.title}${h.heading ? ` › ${h.heading}` : ''}｜${h.snippet}`).join('\n');
}

function kbDoc(d: DB, args: Record<string, unknown>): string {
  let r;
  try {
    r = getDoc(d, num(args.id, 0, 0, Number.MAX_SAFE_INTEGER));
  } catch {
    r = null;
  }
  if (!r) throw new Error('条目不存在');
  const { doc } = r;
  let source = doc.kind === 'note' ? '笔记' : `上传文件 ${doc.file_name ?? ''}`.trim();
  if (doc.kind === 'review') source = `评审 #${doc.review_id}`;
  if (doc.kind === 'item') {
    const it = d.prepare('SELECT url FROM items WHERE id = ?').get(doc.item_id) as { url: string } | undefined;
    source = `资讯 #${doc.item_id}${it ? ` ${it.url}` : ''}`;
  }
  const head = [`标题：${doc.title}`, `目录：${doc.path}`, `来源：${source}`];
  if (doc.status === 'orphan') return [...head, '', '来源已删除，正文已清空。'].join('\n');
  if (doc.status === 'processing') return [...head, '', '文件仍在处理中。'].join('\n');
  if (doc.status === 'error') return [...head, '', `处理失败：${doc.error ?? ''}`].join('\n');
  let text = r.body;
  if (text == null) {
    let last = '';
    text = r.chunks
      .map((c) => {
        const h = c.heading && c.heading !== last ? `## ${c.heading}\n` : '';
        last = c.heading;
        return h + c.body;
      })
      .join('\n\n');
  }
  const cps = [...text];
  const pages = Math.max(1, Math.ceil(cps.length / KB_LIMITS.mcpPage));
  const page = num(args.page, 1, 1, Number.MAX_SAFE_INTEGER);
  if (page > pages) throw new Error(`页码超出范围（共 ${pages} 页）`);
  const body = cps.slice((page - 1) * KB_LIMITS.mcpPage, page * KB_LIMITS.mcpPage).join('');
  return [...head, ...(doc.truncated ? ['（条目过长，只索引了前面部分）'] : []), '', body || '（无正文）', '', `（第 ${page}/${pages} 页）`].join('\n');
}

/** d 仅供测试注入；默认打开配置中的只读库 */
export function callTool(name: string, args: Record<string, unknown>, d: DB = database()): string {
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
    case 'memory_profile':
      return profileMarkdown(d, 6000);
    case 'history_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const n = [...q].length;
      if (n < 2 || n > 200) throw new Error('query 需为 2–200 字');
      const hits = recallHistory(d, q, { limit: num(args.limit, 5, 1, 10) });
      if (!hits.length) return '没有找到相关的历史讨论。';
      return hits.map((h) => `#${h.review_id} ${day(h.created_at)} ${h.input}｜${h.snippet}｜${h.conclusion}`).join('\n');
    }
    case 'kb_search':
      return kbSearch(d, args);
    case 'kb_doc':
      return kbDoc(d, args);
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
          instructions: 'OPC Radar：本地 AI 技术情报库。回答 AI 新闻/模型发布/Agent/RAG/记忆/语音等问题时，先用 radar_latest 或 radar_search 查询，引用时附上条目 URL。了解用户背景用 memory_profile，查过去讨论用 history_search，查用户自己的资料与笔记用 kb_search / kb_doc。',
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
