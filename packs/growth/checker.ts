import type { Fields, Platform } from './platforms.ts';
import { lengthNotes, textAt, textPaths } from './platforms.ts';

/*
 * 发布前本地规则自查：纯函数，不读数据库、不调模型，结果确定、可离线。
 *
 * 依据（查询日期 2026-11-23）：
 * - 《中华人民共和国广告法》（2021 年修正）：第八条（价格、赠送标明条件）、第九条第三项（国家级、最高级、最佳等用语）、
 *   第十一条第二款（引用数据标明出处）、第十三条（不得贬低其他经营者）、第十七条（非医疗广告不得涉及疾病治疗功能）、
 *   第二十五条第一款第一项（不得对收益作保证性承诺）、第四十条第二款第一项（不得劝诱未成年人要求家长购买）。
 *   国家法律法规数据库 https://flk.npc.gov.cn/ ；中国政府网 https://www.gov.cn/guoqing/2021-10/29/content_5647620.htm
 * - 《人工智能生成合成内容标识办法》（国信办通字〔2025〕2 号）第十条第一款。
 *   https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
 * 「绝对化承诺」「AI 能力夸大」没有直接对应的条款，只写法规名。规则表与设计文档第 5.2 节保持一致。
 */

export interface Ctx {
  minors: boolean;
  ai: boolean;
  paid: boolean;
}
export const NO_CTX: Ctx = Object.freeze({ minors: false, ai: false, paid: false });

export type Level = 'must' | 'warn';

export interface Scan {
  rule: string;
  level: Level;
  start: number;
  end: number;
  text: string;
  suggest: string[];
}

export interface Hit extends Scan {
  key: string;
  label: string;
  path: string;
  reason: string;
  basis: string;
  kept: { reason: string; at: number } | null;
}

export interface CheckResult {
  hits: Hit[];
  lengths: { path: string; text: string }[];
  mustOpen: number;
  warnOpen: number;
}

export type Kept = Record<string, { reason: string; at: number }>;

export const AI_NOTICE = '文案由 AI 起草，发布时请用平台的「AI 生成」声明功能标注（《人工智能生成合成内容标识办法》第十条第一款）。';

interface RuleDef {
  id: string;
  label: string;
  basis: string;
  reason: string;
  /** 词表摘要：用于提示词与界面说明 */
  words: string[];
  level: (ctx: Ctx) => Level;
  re: RegExp;
  /** 同一段文本里出现这些说法时整条规则不报 */
  unless?: RegExp;
  suggest: (text: string) => string[];
}

const must = () => 'must' as const;
const warn = () => 'warn' as const;
const none = () => [];
const table = (m: Record<string, string[]>) => (t: string) => m[t] ?? [];

const SUP_SUGGEST: Record<string, string[]> = {
  最佳: ['出色', '优秀'],
  最好: ['很好用', '出色'],
  最强: ['强大'],
  最优: ['更优', '出色'],
  最先进: ['先进'],
  最高级: ['高级'],
  最低价: ['实惠价', '优惠价'],
  最便宜: ['实惠'],
  最全: ['全面', '丰富'],
  最全面: ['全面', '丰富'],
  最大: ['很大'],
  最快: ['快速', '很快'],
  最专业: ['专业'],
  第一: ['深受欢迎'],
  唯一: ['少有'],
  独一无二: ['与众不同'],
  世界级: ['高水准'],
  顶级: ['高品质'],
  顶尖: ['优秀'],
  极致: ['出色'],
  王牌: ['主打'],
};

const ABS_SUGGEST: Record<string, string[]> = {
  百分之百: ['大幅'],
  永久: ['长期'],
  永不: ['不易'],
  彻底: ['明显'],
  绝对: ['非常'],
  保证有效: ['多数用户反馈有效'],
  零风险: ['低风险'],
  万能: ['多用途'],
  一劳永逸: ['省心'],
};

const RULE_DEFS: RuleDef[] = [
  {
    id: 'superlative',
    label: '极限用语',
    basis: '《广告法》第九条第三项',
    reason: '广告不得使用「国家级」「最高级」「最佳」等用语。',
    words: ['最佳', '最好', '最强', '最优', '最先进', '最低价', '最全', '最快', '第一', '首个', '首家', '唯一', '独一无二', '国家级', '世界级', '顶级', '顶尖', '极致', '王牌', 'No.1', 'TOP1'],
    level: must,
    re: new RegExp(
      [
        '最先进',
        '最高级',
        '最低价',
        '最便宜',
        '最专业',
        '最全面?',
        '最佳',
        '最好(?!先|别|不要|还是)',
        '最强',
        '最优',
        '最大(?!化)',
        '最快',
        '第一(?!步|次|章|节|天|周|个月|期|版|条|项|点|部分|批|轮|时间|眼|印象|人称)',
        '独一无二',
        '首个',
        '首家',
        '唯一(?!标识|编号|ID)',
        '国家级',
        '世界级',
        '顶级',
        '顶尖',
        '极致',
        '王牌',
        '(?<![A-Za-z])(?:No\\.?\\s?1|TOP\\s?1)(?!\\d)',
      ].join('|'),
      'gi',
    ),
    suggest: (t) => (/^(no|top)/i.test(t) ? ['热门之选'] : SUP_SUGGEST[t] ?? []),
  },
  {
    id: 'absolute',
    label: '绝对化承诺',
    basis: '《广告法》',
    reason: '绝对化的效果承诺难以证实，容易被认定为虚假或引人误解的宣传。',
    words: ['100%', '百分之百', '永久', '永不', '彻底', '绝对', '保证有效', '零风险', '无副作用', '万能', '一劳永逸'],
    level: must,
    re: /100\s*[%％]|百分之百|永久|永不|彻底|绝对|保证有效|零风险|无副作用|万能|一劳永逸/g,
    suggest: (t) => (/^100/.test(t) ? ['大幅'] : ABS_SUGGEST[t] ?? []),
  },
  {
    id: 'medical',
    label: '疾病与疗效',
    basis: '《广告法》第十七条',
    reason: '除医疗、药品、医疗器械广告外，其他广告不得涉及疾病治疗功能，不得使用医疗用语。',
    words: ['治疗', '治愈', '根治', '疗效', '药到病除', '康复', '抗癌', '降血压', '降血糖', '改善失眠', '医用级'],
    level: must,
    re: /药到病除|改善失眠|降血压|降血糖|医用级|治疗|治愈|根治|疗效|康复|抗癌/g,
    suggest: none,
  },
  {
    id: 'finance',
    label: '收益承诺',
    basis: '《广告法》第二十五条第一款第一项',
    reason: '有投资回报预期的商品或服务广告，不得对未来效果、收益作保证性承诺。',
    words: ['稳赚', '保本', '保收益', '躺赚', '无风险收益', '月入 N 万', '日入 N 元', '年化 N% 起'],
    level: must,
    re: /稳赚不赔|稳赚|保本|保收益|躺赚|无风险收益|月入\s*[\d一二三四五六七八九十百千]+(?:\.\d+)?\s*[万千]?|日入\s*[\d一二三四五六七八九十百千万]+(?:\.\d+)?\s*[元块]?|年化(?:收益率?)?\s*\d+(?:\.\d+)?\s*[%％]\s*起/g,
    suggest: none,
  },
  {
    id: 'minors',
    label: '诱导未成年人',
    basis: '《广告法》第四十条第二款第一项',
    reason: '针对不满十四周岁未成年人的广告，不得劝诱其要求家长购买。',
    words: ['让爸妈给你买', '快叫家长', '同学都有了', '小朋友都在用'],
    level: (c) => (c.minors ? 'must' : 'warn'),
    re: /让(?:爸爸|妈妈|爸妈|家长|父母)(?:给你)?买|快叫家长|同学都有了|小朋友都在用/g,
    suggest: none,
  },
  {
    id: 'ai_overclaim',
    label: 'AI 能力夸大',
    basis: '《广告法》',
    reason: '夸大 AI 能力（完全替代人、绝不出错）可能构成虚假或引人误解的宣传。',
    words: ['完全替代人工', '绝不出错', '零错误', '100% 准确', '比你更懂你'],
    level: (c) => (c.ai ? 'must' : 'warn'),
    re: /完全替代(?:人工|人类|律师|医生|老师)|绝不出错|零错误|100\s*[%％]\s*准确|比你更懂你/g,
    suggest: (t) => {
      if (t === '完全替代人工') return ['帮你节省大量人工'];
      if (t.startsWith('完全替代')) return [`辅助${t.slice(4)}`];
      if (t === '零错误') return ['错误率低'];
      if (t === '绝不出错' || /准确$/.test(t)) return ['准确率高'];
      return [];
    },
  },
  {
    id: 'price',
    label: '价格与优惠条件',
    basis: '《广告法》第八条',
    reason: '价格、优惠、赠送应清楚标明条件、期限和数量。',
    words: ['免费', '限时', 'N 折', '特价', '优惠', '立减', '赠送'],
    level: warn,
    re: /免费|限时|\d+(?:\.\d+)?\s*折|[一二三四五六七八九]折|特价|优惠|立减|赠送|(?<=买[^，。,.！!？?\n]{0,8})送|送(?=\d|[一二三四五六七八九十两半]|会员|好礼|礼品)/g,
    unless: /截至|截止|至\s*\d+\s*月|有效期|期限|仅限|限前\s*\d+|活动时间|规则详见/,
    suggest: none,
  },
  {
    id: 'disparage',
    label: '贬低竞品',
    basis: '《广告法》第十三条',
    reason: '广告不得贬低其他生产经营者的商品或者服务。',
    words: ['吊打', '碾压', '完爆', '秒杀同类', '甩几条街'],
    level: warn,
    re: /吊打|碾压|完爆|秒杀(?:其他|同类|竞品)|(?:其他|同类)产品都是垃圾|甩.{1,6}几条街/g,
    suggest: none,
  },
  {
    id: 'data',
    label: '无出处数据',
    basis: '《广告法》第十一条第二款',
    reason: '引用数据、统计资料应真实准确，并标明出处。',
    words: ['提升 N%', 'N 倍', 'N 万用户', '节省 N 小时'],
    level: warn,
    re: /(?:(?:提升|节省|提高|减少)了?\s*)?\d+(?:\.\d+)?\s*(?:%|％|倍|万用户|万人|亿)|(?:提升|节省)了?\s*\d+(?:\.\d+)?\s*(?:小时|分钟|天|周|个月|元)?/g,
    unless: /(?<!数)据|来源|数据来自|统计|调查|内测|实测|截至/,
    suggest: none,
  },
];

export const RULES = RULE_DEFS.map(({ id, label, basis, reason, words }) => ({ id, label, basis, reason, words }));
const RULE_BY_ID = new Map(RULE_DEFS.map((r) => [r.id, r]));

/** UTF-16 下标 → 码点偏移 */
function cpIndex(text: string): (i: number) => number {
  const map = new Int32Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    map[i] = cp;
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) map[++i] = cp;
    }
    cp++;
  }
  map[text.length] = cp;
  return (i) => map[i];
}

/** 单段文本的命中：同一位置多条规则时保留级别高、跨度长的一条；按位置排序 */
export function scan(text: string, ctx: Ctx): Scan[] {
  const cp = cpIndex(text);
  const all: Scan[] = [];
  for (const r of RULE_DEFS) {
    if (r.unless?.test(text)) continue;
    const level = r.level(ctx);
    for (const m of text.matchAll(r.re)) {
      if (!m[0]) continue;
      all.push({ rule: r.id, level, start: cp(m.index), end: cp(m.index + m[0].length), text: m[0], suggest: r.suggest(m[0]) });
    }
  }
  all.sort((a, b) => (a.level === b.level ? 0 : a.level === 'must' ? -1 : 1) || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Scan[] = [];
  for (const h of all) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

export function check(p: Platform, f: Fields, ctx: Ctx, kept: Kept): CheckResult {
  const hits: Hit[] = [];
  for (const path of textPaths(p, f)) {
    const text = textAt(f, path) ?? '';
    const seen = new Map<string, number>();
    for (const s of scan(text, ctx)) {
      const base = `${s.rule}:${path}:${s.text}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = `${base}:${n}`;
      const r = RULE_BY_ID.get(s.rule)!;
      hits.push({ ...s, key, label: r.label, path, reason: r.reason, basis: r.basis, kept: kept[key] ?? null });
    }
  }
  const open = (l: Level) => hits.filter((h) => h.level === l && !h.kept).length;
  return { hits, lengths: lengthNotes(p, f), mustOpen: open('must'), warnOpen: open('warn') };
}
