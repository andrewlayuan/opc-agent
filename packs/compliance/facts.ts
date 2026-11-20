// 合规材料的资料：全局主体（cp_entity 单行）与产品资料（cp_products.facts）。字段清单即校验规则，清单外字段丢弃
import type { DB } from '../../packages/core/db.ts';
import { CpError } from './store.ts';

export interface FieldDef {
  key: string;
  label: string;
  group?: '对外信息' | '模型' | '数据' | '未成年人';
  type: 'text' | 'date' | 'select' | 'sdks';
  max?: number;
  options?: [string, string][];
  /** 文本格式校验（空串不校验） */
  pattern?: RegExp;
}

export interface Sdk { name: string; purpose: string; data: string; policy_url: string }
export type Entity = Record<string, string>;
export type Facts = { [k: string]: string | Sdk[] | undefined; sdks?: Sdk[] };

const CREDIT_RE = /^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ENTITY_FIELDS: FieldDef[] = [
  { key: 'company_name', label: '公司全称', type: 'text', max: 100 },
  { key: 'credit_code', label: '统一社会信用代码', type: 'text', max: 18, pattern: CREDIT_RE },
  { key: 'address', label: '注册地址', type: 'text', max: 200 },
  { key: 'contact_email', label: '联系邮箱', type: 'text', max: 100, pattern: EMAIL_RE },
  { key: 'contact_phone', label: '联系电话', type: 'text', max: 30 },
  { key: 'pi_officer', label: '个人信息保护负责人', type: 'text', max: 30 },
  { key: 'pi_officer_contact', label: '负责人联系方式', type: 'text', max: 100 },
];

export const FACT_FIELDS: FieldDef[] = [
  { key: 'public_name', label: '对外名称', group: '对外信息', type: 'text', max: 60 },
  { key: 'site', label: '网址或 App 名称', group: '对外信息', type: 'text', max: 200 },
  { key: 'complaint', label: '投诉举报渠道', group: '对外信息', type: 'text', max: 200 },
  { key: 'effective_date', label: '材料生效日期', group: '对外信息', type: 'date' },
  { key: 'model_name', label: '所用模型名称', group: '模型', type: 'text', max: 100 },
  { key: 'model_filing_no', label: '备案号或上线编号', group: '模型', type: 'text', max: 100 },
  { key: 'model_provider', label: '模型提供方', group: '模型', type: 'text', max: 100 },
  { key: 'data_location', label: '数据存放地', group: '数据', type: 'text', max: 100 },
  { key: 'retention', label: '个人信息保存期限', group: '数据', type: 'text', max: 200 },
  { key: 'sdks', label: '第三方 SDK', group: '数据', type: 'sdks' },
  { key: 'minor_mode', label: '是否有未成年人模式', group: '未成年人', type: 'select', options: [['', '未填'], ['yes', '有'], ['no', '没有']] },
];

export const SDK_MAX = 30;
const SDK_COLS: { key: keyof Sdk; label: string; max: number }[] = [
  { key: 'name', label: '名称', max: 60 },
  { key: 'purpose', label: '用途', max: 100 },
  { key: 'data', label: '收集的信息', max: 200 },
  { key: 'policy_url', label: '隐私政策链接', max: 300 },
];

const len = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function text(v: unknown, label: string, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new CpError(400, `${label}格式不对`);
  const s = v.trim();
  if (len(s) > max) throw new CpError(400, `${label}不超过 ${max} 字`);
  return s;
}

function validSdks(v: unknown): Sdk[] {
  if (!Array.isArray(v)) throw new CpError(400, '第三方 SDK格式不对');
  if (v.length > SDK_MAX) throw new CpError(400, `第三方 SDK 不超过 ${SDK_MAX} 行`);
  return v.map((row, i) => {
    const at = `第三方 SDK 第 ${i + 1} 行`;
    if (!isObj(row)) throw new CpError(400, `${at}格式不对`);
    const out = {} as Sdk;
    for (const c of SDK_COLS) out[c.key] = text(row[c.key], `${at}${c.label}`, c.max);
    if (!out.name) throw new CpError(400, `${at}名称不能为空`);
    if (out.policy_url) {
      let ok = false;
      try {
        ok = new URL(out.policy_url).protocol === 'https:' && /^https:\/\//i.test(out.policy_url);
      } catch {
        ok = false;
      }
      if (!ok) throw new CpError(400, `${at}隐私政策链接需以 https:// 开头`);
    }
    return out;
  });
}

function validate(defs: FieldDef[], input: unknown): Facts {
  if (!isObj(input)) throw new CpError(400, '资料格式不对');
  const out: Facts = {};
  for (const f of defs) {
    const v = input[f.key];
    if (f.type === 'sdks') {
      if (v !== undefined && v !== null) out.sdks = validSdks(v);
      continue;
    }
    const s = text(v, f.label, f.max ?? 200);
    if (!s) continue;
    if (f.type === 'date' && !validDate(s)) throw new CpError(400, `${f.label}格式不对`);
    if (f.type === 'select' && !f.options!.some(([k]) => k === s)) throw new CpError(400, `${f.label}格式不对`);
    if (f.pattern && !f.pattern.test(s)) throw new CpError(400, `${f.label}格式不对`);
    out[f.key] = s;
  }
  return out;
}

export const validateEntity = (input: unknown): Entity => validate(ENTITY_FIELDS, input) as Entity;
export const validateFacts = (input: unknown): Facts => validate(FACT_FIELDS, input);

const LABELS = new Map<string, string>([
  ...ENTITY_FIELDS.map((f) => [`entity.${f.key}`, f.label] as [string, string]),
  ...FACT_FIELDS.map((f) => [`facts.${f.key}`, f.label] as [string, string]),
]);

/** 'entity.company_name' → '公司全称'；未知路径抛错（模板引用了不存在的字段属于编码错误） */
export function fieldLabel(path: string): string {
  const l = LABELS.get(path);
  if (!l) throw new Error(`未知资料字段：${path}`);
  return l;
}

const parse = (s: unknown): Record<string, unknown> => {
  try {
    const v = JSON.parse(String(s ?? '{}'));
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
};

export function getEntity(db: DB): Entity {
  const r = db.prepare('SELECT data FROM cp_entity WHERE id = 1').get() as { data: string } | undefined;
  return r ? (parse(r.data) as Entity) : {};
}

export function saveEntity(db: DB, input: unknown, now = Date.now()): Entity {
  const e = validateEntity(input);
  db.prepare('INSERT INTO cp_entity(id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(JSON.stringify(e), now);
  return e;
}

export function getFacts(db: DB, productId: number): Facts {
  const r = db.prepare('SELECT facts FROM cp_products WHERE id = ?').get(productId) as { facts: string } | undefined;
  if (!r) throw new CpError(404, '产品不存在');
  return parse(r.facts) as Facts;
}

export function saveFacts(db: DB, productId: number, input: unknown, now = Date.now()): Facts {
  getFacts(db, productId);
  const f = validateFacts(input);
  db.prepare('UPDATE cp_products SET facts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(f), now, productId);
  return f;
}
