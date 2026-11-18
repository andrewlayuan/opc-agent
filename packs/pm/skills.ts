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

/** 框架中文名：界面显示用；发给模型和存库仍用英文名 */
export const SKILL_LABELS: Record<string, string> = {
  // 数据分析
  'ab-test-analysis': 'A/B 测试分析',
  'cohort-analysis': '同期群分析',
  'sql-queries': 'SQL 查询',
  // 执行落地
  'brainstorm-okrs': 'OKR 制定',
  'create-prd': 'PRD 撰写',
  'dummy-dataset': '模拟测试数据',
  'job-stories': '工作故事',
  'live-polls': '现场投票',
  'live-qa': '现场问答',
  'outcome-roadmap': '成果导向路线图',
  'pre-mortem': '事前验尸',
  'prioritization-frameworks': '优先级框架',
  'release-notes': '发布说明',
  retro: '复盘回顾',
  'sprint-plan': '迭代计划',
  'stakeholder-map': '干系人地图',
  'strategy-red-team': '战略红队',
  'summarize-meeting': '会议纪要',
  'test-scenarios': '测试场景',
  'user-stories': '用户故事',
  wwas: '需求条目（WWA 格式）',
  // 上市策略
  'beachhead-segment': '滩头市场',
  'competitive-battlecard': '竞争对比卡',
  'growth-loops': '增长飞轮',
  'gtm-motions': '获客方式',
  'gtm-strategy': '上市方案',
  'ideal-customer-profile': '理想客户画像',
  // 市场研究
  'competitor-analysis': '竞品分析',
  'customer-journey-map': '客户旅程地图',
  'market-segments': '市场细分',
  'market-sizing': '市场规模测算',
  'sentiment-analysis': '用户反馈情感分析',
  'survey-design': '问卷设计',
  'user-personas': '用户画像',
  'user-segmentation': '用户分群',
  // 营销增长
  'marketing-ideas': '营销创意',
  'north-star-metric': '北极星指标',
  'positioning-ideas': '定位构思',
  'product-name': '产品命名',
  'value-prop-statements': '价值主张文案',
  // 产品发现
  'analyze-feature-requests': '功能需求分析',
  'brainstorm-experiments-existing': '实验设计（已有产品）',
  'brainstorm-experiments-new': '实验设计（新产品）',
  'brainstorm-ideas-existing': '创意发散（已有产品）',
  'brainstorm-ideas-new': '创意发散（新产品）',
  'identify-assumptions-existing': '风险假设识别（已有产品）',
  'identify-assumptions-new': '风险假设识别（新产品）',
  'interview-script': '用户访谈提纲',
  'metrics-dashboard': '指标看板',
  'opportunity-solution-tree': '机会解决方案树',
  'prioritize-assumptions': '假设优先级',
  'prioritize-features': '功能优先级',
  'summarize-interview': '访谈总结',
  // 产品战略
  'ansoff-matrix': '安索夫矩阵',
  'business-model': '商业模式画布',
  'lean-canvas': '精益画布',
  'monetization-strategy': '变现策略',
  'pestle-analysis': 'PESTLE 宏观环境分析',
  'porters-five-forces': '波特五力',
  'pricing-strategy': '定价策略',
  'product-strategy': '战略规划',
  'product-vision': '产品愿景',
  'startup-canvas': '创业画布',
  'swot-analysis': 'SWOT 分析',
  'value-proposition': '价值主张设计',
};

export const skillLabel = (name: string): string => SKILL_LABELS[name] ?? name;

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
