// 材料模板的类型与工具：占位、取资料、问卷答案转文字、章节构造。模板数据见 templates-public.ts / templates-filing.ts
import type { Entity, Facts, Sdk } from './facts.ts';
import { fieldLabel } from './facts.ts';
import { QUESTIONS, type Answers } from './rules.ts';

export interface Ctx {
  entity: Entity;
  facts: Facts;
  answers: Answers;
  product: { name: string; description: string };
}

export interface Chapter {
  key: string;
  title: string;
  mode: 'fixed' | 'model';
  /** 不满足则该章不出现 */
  when?: (a: Answers) => boolean;
  /** 用到的资料字段（'entity.x' / 'facts.x'），用于缺项提示与「资料已更新」判断 */
  uses: string[];
  render?: (c: Ctx) => string;
  points?: string[];
}

export interface DocTemplate {
  kind: string;
  name: string;
  usage: 'public' | 'filing';
  items: string[];
  version: number;
  chapters: Chapter[];
}

export const PLACEHOLDER_RE = /【待填：([^】\n]{1,40})】/g;
export const ph = (label: string): string => `【待填：${label}】`;

/** 文中出现的占位字段名，去重保序 */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/** 取资料字段；空则返回占位 */
export function v(c: Ctx, path: string): string {
  const [scope, key] = path.split('.');
  const src = scope === 'entity' ? c.entity : c.facts;
  const val = src[key];
  return typeof val === 'string' && val.trim() ? val.trim() : ph(fieldLabel(path));
}

/** 对外名称，未填用产品名（不出占位） */
export const productName = (c: Ctx): string => {
  const n = c.facts.public_name;
  return typeof n === 'string' && n.trim() ? n.trim() : c.product.name;
};

export const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : []);
export const has = (a: Answers, q: string, value: string): boolean => list(a[q]).includes(value);

export function optLabel(q: string, value: string): string {
  return QUESTIONS.find((x) => x.id === q)?.options.find((o) => o.value === value)?.label ?? value;
}
export const optLabels = (a: Answers, q: string): string => list(a[q]).map((x) => optLabel(q, x)).join('、');

/** 问卷答案按题目顺序转为「题目：选项、选项」 */
export function answerText(a: Answers): string[] {
  return QUESTIONS.filter((q) => a[q.id] !== undefined).map((q) => `${q.title}：${optLabels(a, q.id)}`);
}

/** 表格单元格：换行变空格，| 转义 */
export const cell = (s: unknown): string => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

export const fixed = (key: string, title: string, uses: string[], render: (c: Ctx) => string, when?: (a: Answers) => boolean): Chapter => ({
  key, title, mode: 'fixed', uses, render, ...(when ? { when } : {}),
});
export const model = (key: string, title: string, points: string[], o: { uses?: string[]; when?: (a: Answers) => boolean } = {}): Chapter => ({
  key, title, mode: 'model', uses: o.uses ?? [], points, ...(o.when ? { when: o.when } : {}),
});

export const usesAi = (a: Answers): boolean => a.ai_use !== undefined && a.ai_use !== 'none';

export function sdkTable(sdks: Sdk[]): string {
  const rows = sdks.map((s) => `| ${cell(s.name)} | ${cell(s.purpose) || '—'} | ${cell(s.data) || '—'} | ${cell(s.policy_url) || '—'} |`);
  return ['| 名称 | 用途 | 收集的信息 | 隐私政策 |', '| --- | --- | --- | --- |', ...rows].join('\n');
}
