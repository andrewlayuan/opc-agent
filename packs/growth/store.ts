import crypto from 'node:crypto';
import type { DB } from '../../packages/core/db.ts';
import { getProduct } from '../compliance/store.ts';
import { lineDiff } from '../wiki/diff.ts';
import type { DiffLine } from '../wiki/diff.ts';
import { NO_CTX, carryKept, check } from './checker.ts';
import type { CheckResult, Ctx, Kept } from './checker.ts';
import { PLATFORMS, cps, getPlatform, missingPaths, pathLabel, renderCopy, setTextAt, textAt, validateFields } from './platforms.ts';
import type { Fields, Platform, PlatformId } from './platforms.ts';
import { GrowthError } from './types.ts';
import type { GrowthIssue } from './types.ts';

export type Tone = 'pro' | 'warm' | 'lively';
export const TONES: { id: Tone; label: string }[] = [
  { id: 'pro', label: '专业' },
  { id: 'warm', label: '亲切' },
  { id: 'lively', label: '活泼' },
];
export type Origin = 'generate' | 'edit' | 'replace' | 'restore';
export const REV_MAX = 50;

export interface CampaignData {
  name: string;
  product_id: number | null;
  product_name: string;
  product_desc: string;
  points: string[];
  audience: string;
  offer: string;
  tone: Tone;
}

export interface ReviewItem {
  quote: string;
  issue: string;
  suggestion: string;
}

export interface CopyView {
  id: number;
  platform: PlatformId;
  rev: number;
  status: 'draft' | 'final';
  origin: Origin | null;
  updated_at: number;
  fields: Fields;
  check: CheckResult;
  missing: string[];
  stale: boolean;
  review: ReviewItem[] | null;
  review_base: number | null;
  reviewed_at: number | null;
}

export interface CampaignView extends CampaignData {
  id: number;
  created_at: number;
  updated_at: number;
  ctx: Ctx;
  copies: CopyView[];
}

const STALE = '内容已在别处更新，请刷新';
const FINAL = '文案已定稿，先取消定稿';
const ORDER = new Map(PLATFORMS.map((p, i) => [p.id, i]));

function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown, label: string, min: number, max: number): string {
  const s = v == null ? '' : typeof v === 'string' ? v.trim() : null;
  if (s == null || cps(s) < min || cps(s) > max) throw new GrowthError(400, `${label}需在 ${min}–${max} 字之间`);
  return s;
}

function checkCampaign(db: DB, input: unknown): CampaignData {
  if (!isObj(input)) throw new GrowthError(400, '投放格式不对');
  const name = text(input.name, '投放名称', 1, 60);
  let product_id: number | null = null;
  if (input.product_id != null && input.product_id !== '') {
    const pid = Number(input.product_id);
    if (!Number.isSafeInteger(pid) || !db.prepare('SELECT 1 FROM cp_products WHERE id = ?').get(pid)) throw new GrowthError(400, '关联的合规产品不存在');
    product_id = pid;
  }
  if (typeof input.product_name !== 'string' || !input.product_name.trim()) throw new GrowthError(400, '请填写产品名');
  const product_name = text(input.product_name, '产品名', 1, 60);
  const product_desc = text(input.product_desc, '产品描述', 0, 2000);
  const raw = Array.isArray(input.points) ? input.points : [];
  const points = raw.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  if (!points.length) throw new GrowthError(400, '请至少填写一条卖点');
  if (points.length > 10) throw new GrowthError(400, '卖点需在 1–10 条之间');
  for (const p of points) text(p, '卖点', 1, 100);
  const audience = text(input.audience, '目标用户', 0, 200);
  const offer = text(input.offer, '活动信息', 0, 200);
  const tone = input.tone == null || input.tone === '' ? 'warm' : input.tone;
  if (!TONES.some((t) => t.id === tone)) throw new GrowthError(400, '语气不对');
  return { name, product_id, product_name, product_desc, points, audience, offer, tone: tone as Tone };
}

export function inputHash(c: CampaignData): string {
  const v = [c.product_id, c.product_name, c.product_desc, c.points, c.audience, c.offer, c.tone];
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

const AI_ITEMS = new Set(['aigc_label', 'model_disclosure', 'genai_filing', 'genai_register']);

/** 合规产品最新判定得到的自查上下文；未关联、不存在或未判定时全假 */
export function contextFor(db: DB, productId: number | null): Ctx {
  if (productId == null) return { ...NO_CTX };
  let a;
  try {
    a = getProduct(db, productId).assessment;
  } catch {
    return { ...NO_CTX };
  }
  if (!a) return { ...NO_CTX };
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  return {
    minors: ['maybe', 'mainly'].includes(String(a.answers.minors)),
    ai: a.result.items.some((i) => AI_ITEMS.has(i.id)),
    paid: list(a.answers.charge).some((v) => ['paid', 'ads', 'commerce'].includes(v)),
  };
}

type Row = Record<string, unknown>;

function campaignRow(db: DB, id: number): Row {
  const r = db.prepare('SELECT * FROM gr_campaigns WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new GrowthError(404, '投放不存在');
  return r;
}

function toCampaign(r: Row): CampaignData & { id: number; created_at: number; updated_at: number } {
  return {
    id: Number(r.id),
    name: String(r.name),
    product_id: r.product_id == null ? null : Number(r.product_id),
    product_name: String(r.product_name),
    product_desc: String(r.product_desc),
    points: JSON.parse(String(r.points)) as string[],
    audience: String(r.audience),
    offer: String(r.offer),
    tone: String(r.tone) as Tone,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function copyRow(db: DB, id: number): Row {
  const r = db.prepare('SELECT * FROM gr_copies WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new GrowthError(404, '文案不存在');
  return r;
}

function revRow(db: DB, copyId: number, n: number): Row | undefined {
  return db.prepare('SELECT * FROM gr_revisions WHERE copy_id = ? AND n = ?').get(copyId, n) as Row | undefined;
}

const keptOf = (r: Row): Kept => JSON.parse(String(r.kept)) as Kept;
const reviewOf = (r: Row | undefined): ReviewItem[] | null => (r?.review == null ? null : (JSON.parse(String(r.review)) as ReviewItem[]));
const EMPTY_CHECK: CheckResult = { hits: [], lengths: [], mustOpen: 0, warnOpen: 0 };

function fieldsOf(p: Platform, rev: Row | undefined): Fields {
  return rev ? (JSON.parse(String(rev.fields)) as Fields) : validateFields(p, {}, 1);
}

function viewCopy(db: DB, r: Row, camp: CampaignData, ctx: Ctx): CopyView {
  const p = getPlatform(r.platform);
  const n = Number(r.rev);
  const rev = n > 0 ? revRow(db, Number(r.id), n) : undefined;
  const fields = fieldsOf(p, rev);
  return {
    id: Number(r.id),
    platform: p.id,
    rev: n,
    status: r.status === 'final' ? 'final' : 'draft',
    origin: rev ? (String(rev.origin) as Origin) : null,
    updated_at: Number(r.updated_at),
    fields,
    check: rev ? check(p, fields, ctx, keptOf(r)) : EMPTY_CHECK,
    missing: rev ? missingPaths(p, fields) : [],
    stale: r.gen_hash != null && r.gen_hash !== inputHash(camp),
    review: reviewOf(rev),
    review_base: rev?.review_base == null ? null : Number(rev.review_base),
    reviewed_at: rev?.reviewed_at == null ? null : Number(rev.reviewed_at),
  };
}

export function createCampaign(db: DB, input: unknown, platforms: unknown, now = Date.now()): number {
  const c = checkCampaign(db, input);
  const ids = [...new Set(Array.isArray(platforms) ? platforms : [])].map((x) => getPlatform(x).id);
  if (!ids.length) throw new GrowthError(400, '至少选择一个平台');
  ids.sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
  return tx(db, () => {
    const r = db
      .prepare('INSERT INTO gr_campaigns(name, product_id, product_name, product_desc, points, audience, offer, tone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.name, c.product_id, c.product_name, c.product_desc, JSON.stringify(c.points), c.audience, c.offer, c.tone, now, now);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO gr_copies(campaign_id, platform, created_at, updated_at) VALUES (?, ?, ?, ?)');
    for (const p of ids) ins.run(id, p, now, now);
    return id;
  });
}

export function updateCampaign(db: DB, id: number, input: unknown, now = Date.now()): void {
  campaignRow(db, id);
  const c = checkCampaign(db, input);
  db.prepare('UPDATE gr_campaigns SET name = ?, product_id = ?, product_name = ?, product_desc = ?, points = ?, audience = ?, offer = ?, tone = ?, updated_at = ? WHERE id = ?').run(
    c.name, c.product_id, c.product_name, c.product_desc, JSON.stringify(c.points), c.audience, c.offer, c.tone, now, id,
  );
}

export function deleteCampaign(db: DB, id: number): void {
  campaignRow(db, id);
  db.prepare('DELETE FROM gr_campaigns WHERE id = ?').run(id);
}

const copyRows = (db: DB, campaignId: number) =>
  (db.prepare('SELECT * FROM gr_copies WHERE campaign_id = ?').all(campaignId) as Row[]).sort((a, b) => ORDER.get(a.platform as PlatformId)! - ORDER.get(b.platform as PlatformId)!);

export function listCampaigns(db: DB): { id: number; name: string; product_name: string; updated_at: number; copies: { platform: PlatformId; state: 'empty' | 'must' | 'warn' | 'ok' | 'final' }[] }[] {
  const rows = db.prepare('SELECT * FROM gr_campaigns ORDER BY updated_at DESC, id DESC').all() as Row[];
  return rows.map((r) => {
    const c = toCampaign(r);
    const ctx = contextFor(db, c.product_id);
    return {
      id: c.id,
      name: c.name,
      product_name: c.product_name,
      updated_at: c.updated_at,
      copies: copyRows(db, c.id).map((x) => {
        const v = viewCopy(db, x, c, ctx);
        const state = v.rev === 0 ? 'empty' : v.status === 'final' ? 'final' : v.check.mustOpen ? 'must' : v.check.warnOpen ? 'warn' : 'ok';
        return { platform: v.platform, state };
      }),
    };
  });
}

export function getCampaign(db: DB, id: number): CampaignView {
  const c = toCampaign(campaignRow(db, id));
  const ctx = contextFor(db, c.product_id);
  return { ...c, ctx, copies: copyRows(db, id).map((r) => viewCopy(db, r, c, ctx)) };
}

function copyContext(db: DB, r: Row) {
  const c = toCampaign(campaignRow(db, Number(r.campaign_id)));
  return { c, ctx: contextFor(db, c.product_id) };
}

export function getCopy(db: DB, id: number): CopyView {
  const r = copyRow(db, id);
  const { c, ctx } = copyContext(db, r);
  return viewCopy(db, r, c, ctx);
}

/** 生成与复核用：文案所属投放、上下文与当前内容 */
export function copyCampaign(db: DB, id: number): { campaign: CampaignData; ctx: Ctx; platform: Platform; rev: number; status: 'draft' | 'final'; fields: Fields } {
  const r = copyRow(db, id);
  const { c, ctx } = copyContext(db, r);
  const p = getPlatform(r.platform);
  const n = Number(r.rev);
  return { campaign: c, ctx, platform: p, rev: n, status: r.status === 'final' ? 'final' : 'draft', fields: fieldsOf(p, n > 0 ? revRow(db, id, n) : undefined) };
}

export function addCopy(db: DB, campaignId: number, platform: unknown, now = Date.now()): CopyView {
  campaignRow(db, campaignId);
  const p = getPlatform(platform);
  if (db.prepare('SELECT 1 FROM gr_copies WHERE campaign_id = ? AND platform = ?').get(campaignId, p.id)) throw new GrowthError(409, '该平台的文案已存在');
  const r = db.prepare('INSERT INTO gr_copies(campaign_id, platform, created_at, updated_at) VALUES (?, ?, ?, ?)').run(campaignId, p.id, now, now);
  db.prepare('UPDATE gr_campaigns SET updated_at = ? WHERE id = ?').run(now, campaignId);
  return getCopy(db, Number(r.lastInsertRowid));
}

export function deleteCopy(db: DB, id: number): void {
  copyRow(db, id);
  db.prepare('DELETE FROM gr_copies WHERE id = ?').run(id);
}

function assertDraft(r: Row): void {
  if (r.status === 'final') throw new GrowthError(409, FINAL);
}

/** 写一个新版本（事务内重查：不存在 404、已定稿 409、版本不符 409）；保留按前后文对到新命中；手改与替换继承上一版、回退继承目标版本中仍在原文里的复核条目 */
export function writeRevision(db: DB, id: number, fields: Fields, origin: Origin, o: { expectRev?: number; genHash?: string; from?: number }, now = Date.now()): CopyView {
  tx(db, () => {
    const r = copyRow(db, id);
    assertDraft(r);
    const cur = Number(r.rev);
    if (o.expectRev !== undefined && o.expectRev !== cur) throw new GrowthError(409, STALE);
    const p = getPlatform(r.platform);
    const n = cur + 1;
    let review: ReviewItem[] | null = null;
    let base: number | null = null;
    let at: number | null = null;
    const prev = cur > 0 ? revRow(db, id, cur) : undefined;
    const src = origin === 'edit' || origin === 'replace' ? prev : origin === 'restore' && o.from !== undefined ? revRow(db, id, o.from) : undefined;
    const srcReview = reviewOf(src);
    if (srcReview) {
      const t = renderCopy(p, fields);
      review = srcReview.filter((x) => t.includes(x.quote));
      base = src!.review_base == null ? null : Number(src!.review_base);
      at = src!.reviewed_at == null ? null : Number(src!.reviewed_at);
    }
    db.prepare('INSERT INTO gr_revisions(copy_id, n, created_at, origin, fields, review, review_base, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, n, now, origin, JSON.stringify(fields), review == null ? null : JSON.stringify(review), base, at,
    );
    db.prepare('DELETE FROM gr_revisions WHERE copy_id = ? AND n <= ?').run(id, n - REV_MAX);
    const { ctx } = copyContext(db, r);
    const oldKept = keptOf(r);
    let kept: Kept = {};
    if (prev && Object.keys(oldKept).length) {
      const oldF = fieldsOf(p, prev);
      kept = carryKept(oldF, check(p, oldF, ctx, oldKept).hits, fields, check(p, fields, ctx, {}).hits);
    }
    db.prepare('UPDATE gr_copies SET rev = ?, kept = ?, gen_hash = COALESCE(?, gen_hash), updated_at = ? WHERE id = ?').run(n, JSON.stringify(kept), o.genHash ?? null, now, id);
    db.prepare('UPDATE gr_campaigns SET updated_at = ? WHERE id = ?').run(now, Number(r.campaign_id));
  });
  return getCopy(db, id);
}

function revNo(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new GrowthError(400, '版本号不对');
  return n;
}

export function saveCopy(db: DB, id: number, fields: unknown, baseRev: unknown, now = Date.now()): CopyView {
  const r = copyRow(db, id);
  assertDraft(r);
  const b = revNo(baseRev);
  const p = getPlatform(r.platform);
  const f = validateFields(p, fields, 3);
  const cur = Number(r.rev);
  if (b === cur && cur > 0 && JSON.stringify(fieldsOf(p, revRow(db, id, cur))) === JSON.stringify(f)) return getCopy(db, id);
  return writeRevision(db, id, f, 'edit', { expectRev: b }, now);
}

export function replaceHits(db: DB, id: number, baseRev: unknown, items: unknown, now = Date.now()): CopyView {
  const r = copyRow(db, id);
  assertDraft(r);
  const b = revNo(baseRev);
  if (!Array.isArray(items) || !items.length || !items.every((x) => isObj(x) && typeof x.key === 'string' && typeof x.with === 'string')) throw new GrowthError(400, '替换内容不对');
  if (new Set(items.map((x) => x.key)).size !== items.length) throw new GrowthError(400, '替换内容不对');
  if (b !== Number(r.rev) || b === 0) throw new GrowthError(409, STALE);
  const { c, ctx } = copyContext(db, r);
  const cur = viewCopy(db, r, c, ctx);
  const byKey = new Map(cur.check.hits.map((h) => [h.key, h]));
  const todo = (items as { key: string; with: string }[]).map((x) => {
    const h = byKey.get(x.key);
    const w = x.with.trim();
    if (!h || !w) throw new GrowthError(409, STALE);
    return { h, w };
  });
  todo.sort((a, z) => (a.h.path < z.h.path ? -1 : a.h.path > z.h.path ? 1 : z.h.start - a.h.start));
  let f = cur.fields;
  for (const { h, w } of todo) {
    const chars = Array.from(textAt(f, h.path)!);
    chars.splice(h.start, h.end - h.start, ...Array.from(w));
    f = setTextAt(f, h.path, chars.join(''));
  }
  const p = getPlatform(r.platform);
  return writeRevision(db, id, validateFields(p, f, 3), 'replace', { expectRev: b }, now);
}

export function keepHit(db: DB, id: number, key: unknown, reason: unknown, now = Date.now()): CopyView {
  const r = copyRow(db, id);
  assertDraft(r);
  if (typeof key !== 'string' || !key) throw new GrowthError(400, '保留的命中不对');
  const why = typeof reason === 'string' ? reason.trim() : '';
  const kept = keptOf(r);
  if (!why) delete kept[key];
  else {
    if (cps(why) > 200) throw new GrowthError(400, '保留理由需在 1–200 字之间');
    if (!getCopy(db, id).check.hits.some((h) => h.key === key)) throw new GrowthError(409, STALE);
    kept[key] = { reason: why, at: now };
  }
  db.prepare('UPDATE gr_copies SET kept = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(kept), now, id);
  return getCopy(db, id);
}

export function listRevisions(db: DB, id: number): { n: number; origin: Origin; created_at: number; reviewed: boolean }[] {
  copyRow(db, id);
  return (db.prepare('SELECT n, origin, created_at, review FROM gr_revisions WHERE copy_id = ? ORDER BY n DESC').all(id) as Row[]).map((r) => ({
    n: Number(r.n),
    origin: String(r.origin) as Origin,
    created_at: Number(r.created_at),
    reviewed: r.review != null,
  }));
}

export function getRevision(
  db: DB,
  id: number,
  n: number,
  withDiff: boolean,
): { revision: { n: number; origin: Origin; created_at: number; fields: Fields; text: string }; diff?: { lines: DiffLine[]; clipped: boolean } } {
  const r = copyRow(db, id);
  const p = getPlatform(r.platform);
  const rev = revRow(db, id, n);
  if (!rev) throw new GrowthError(404, '版本不存在');
  const fields = fieldsOf(p, rev);
  const text = renderCopy(p, fields);
  const out: ReturnType<typeof getRevision> = { revision: { n, origin: String(rev.origin) as Origin, created_at: Number(rev.created_at), fields, text } };
  if (withDiff) out.diff = lineDiff(text, renderCopy(p, fieldsOf(p, revRow(db, id, Number(r.rev)))));
  return out;
}

export function restoreRevision(db: DB, id: number, n: unknown, now = Date.now()): CopyView {
  const r = copyRow(db, id);
  assertDraft(r);
  const k = revNo(n);
  const rev = revRow(db, id, k);
  if (!rev) throw new GrowthError(404, '版本不存在');
  if (k === Number(r.rev)) return getCopy(db, id);
  return writeRevision(db, id, fieldsOf(getPlatform(r.platform), rev), 'restore', { from: k }, now);
}

export function finalizeCopy(db: DB, id: number, now = Date.now()): CopyView {
  const r = copyRow(db, id);
  if (r.status === 'final') return getCopy(db, id);
  const v = getCopy(db, id);
  const p = getPlatform(r.platform);
  const issues: GrowthIssue[] =
    v.rev === 0
      ? [{ path: '', text: '还没有生成或填写文案', label: '未生成' }]
      : [
          ...v.missing.map((path) => ({ path, text: '未填写', label: pathLabel(p, path) })),
          ...v.check.hits.filter((h) => h.level === 'must' && !h.kept).map((h) => ({ path: h.path, text: h.text, label: h.label })),
        ];
  if (issues.length) throw new GrowthError(400, '还有必须修改的问题', issues);
  db.prepare("UPDATE gr_copies SET status = 'final', updated_at = ? WHERE id = ?").run(now, id);
  return getCopy(db, id);
}

export function unfinalizeCopy(db: DB, id: number, now = Date.now()): CopyView {
  copyRow(db, id);
  db.prepare("UPDATE gr_copies SET status = 'draft', updated_at = ? WHERE id = ?").run(now, id);
  return getCopy(db, id);
}

/** 复核结果写到版本 n；若当前版本更新且还没有更近的复核，按 quote 仍在原文中同步过去 */
export function saveReview(db: DB, id: number, n: number, items: ReviewItem[], now = Date.now()): void {
  tx(db, () => {
    const r = copyRow(db, id);
    db.prepare('UPDATE gr_revisions SET review = ?, review_base = ?, reviewed_at = ? WHERE copy_id = ? AND n = ?').run(JSON.stringify(items), n, now, id, n);
    const cur = Number(r.rev);
    if (cur <= n) return;
    const top = revRow(db, id, cur);
    if (!top || (top.review_base != null && Number(top.review_base) >= n)) return;
    const t = renderCopy(getPlatform(r.platform), fieldsOf(getPlatform(r.platform), top));
    db.prepare('UPDATE gr_revisions SET review = ?, review_base = ?, reviewed_at = ? WHERE copy_id = ? AND n = ?').run(
      JSON.stringify(items.filter((x) => t.includes(x.quote))), n, now, id, cur,
    );
  });
}
