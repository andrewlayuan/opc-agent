import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取 pm-skills（https://github.com/phuryn/pm-skills，MIT）的技能文本。
 * 只读取 <dir>/pm-<plugin>/skills/<skill>/SKILL.md 这一固定层级的纯文本，不执行其中任何脚本；
 * 拒绝符号链接与越出目录的路径，单文件限制 64KB。
 */

export interface PmSkill {
  name: string;
  plugin: string;
  description: string;
  body: string;
}

export const PLUGIN_LABELS: Record<string, string> = {
  'pm-product-discovery': '产品发现',
  'pm-product-strategy': '产品战略',
  'pm-market-research': '市场研究',
  'pm-go-to-market': '上市策略',
  'pm-marketing-growth': '营销增长',
  'pm-execution': '执行落地',
  'pm-data-analytics': '数据分析',
};

/** 与“商业化产品评审”无关的插件（法律文书、简历、代码评审）不加载 */
const EXCLUDED_PLUGINS = new Set(['pm-toolkit', 'pm-ai-shipping']);
const MAX_FILE = 64 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function defaultSkillsDir(): string {
  return process.env.OPC_PM_SKILLS_DIR?.trim() || path.join(ROOT, 'pm-skills');
}

function unquote(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

/** 只解析单行 name/description 的 YAML 头，其余字段忽略 */
export function parseSkill(text: string): { name: string; description: string; body: string } | null {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return null;
  const head = src.slice(4, end);
  const body = src.slice(src.indexOf('\n', end + 1) + 1).trim();
  let name = '';
  let description = '';
  for (const line of head.split('\n')) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'name') name = unquote(m[2]);
    else description = unquote(m[2]);
  }
  if (!NAME_RE.test(name) || !description || !body) return null;
  return { name, description: description.slice(0, 600), body };
}

function isPlainDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadPmSkills(dir = defaultSkillsDir()): PmSkill[] {
  if (!isPlainDir(dir)) return [];
  const realRoot = fs.realpathSync(dir);
  const out: PmSkill[] = [];
  const seen = new Set<string>();
  for (const plugin of fs.readdirSync(dir).sort()) {
    if (!/^pm-[a-z0-9-]+$/.test(plugin) || EXCLUDED_PLUGINS.has(plugin)) continue;
    const skillsDir = path.join(dir, plugin, 'skills');
    if (!isPlainDir(path.join(dir, plugin)) || !isPlainDir(skillsDir)) continue;
    for (const entry of fs.readdirSync(skillsDir).sort()) {
      if (!NAME_RE.test(entry)) continue;
      const sd = path.join(skillsDir, entry);
      const file = path.join(sd, 'SKILL.md');
      if (!isPlainDir(sd)) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE) continue;
      if (!fs.realpathSync(file).startsWith(realRoot + path.sep)) continue;
      const parsed = parseSkill(fs.readFileSync(file, 'utf8'));
      if (!parsed || seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      out.push({ ...parsed, plugin });
    }
  }
  return out;
}
