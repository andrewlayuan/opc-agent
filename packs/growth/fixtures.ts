import type { Ctx } from './checker.ts';

// 规则样例集：正例（应命中）与反例（容易误报的说法）。checker.test.ts 要求 100% 判对。
// 新增或修改规则时必须同步补样例。expect 按命中在原文中的位置排序。

export interface Fixture {
  text: string;
  ctx?: Partial<Ctx>;
  expect: { rule: string; text: string }[];
}

const hit = (rule: string, text: string) => ({ rule, text });

export const FIXTURES: Fixture[] = [
  // 极限用语
  { text: '这是业内最好的写作工具', expect: [hit('superlative', '最好')] },
  { text: '全网销量第一', expect: [hit('superlative', '第一')] },
  { text: '国家级技术团队打造', expect: [hit('superlative', '国家级')] },
  { text: '独一无二的体验', expect: [hit('superlative', '独一无二')] },
  { text: '效率工具 No.1', expect: [hit('superlative', 'No.1')] },
  { text: '顶级的 AI 模型，最佳选择', expect: [hit('superlative', '顶级'), hit('superlative', '最佳')] },
  { text: '国内首家支持语音周报', expect: [hit('superlative', '首家')] },
  { text: '功能最全面的笔记应用', expect: [hit('superlative', '最全面')] },
  // 绝对化承诺
  { text: '100% 好评', expect: [hit('absolute', '100%')] },
  { text: '永久免费使用', expect: [hit('absolute', '永久'), hit('price', '免费')] },
  { text: '彻底解决拖延问题', expect: [hit('absolute', '彻底')] },
  { text: '保证有效，零风险', expect: [hit('absolute', '保证有效'), hit('absolute', '零风险')] },
  // 疾病与疗效
  { text: '帮助改善失眠', expect: [hit('medical', '改善失眠')] },
  { text: '可以治疗颈椎病', expect: [hit('medical', '治疗')] },
  { text: '医用级材料，根治痘痘', expect: [hit('medical', '医用级'), hit('medical', '根治')] },
  // 收益承诺
  { text: '跟着用，月入 3 万', expect: [hit('finance', '月入 3 万')] },
  { text: '稳赚不赔的理财助手', expect: [hit('finance', '稳赚不赔')] },
  { text: '年化 8% 起，保本', expect: [hit('finance', '年化 8% 起'), hit('finance', '保本')] },
  { text: '在家躺赚', expect: [hit('finance', '躺赚')] },
  // 诱导未成年人
  { text: '快让爸妈给你买', expect: [hit('minors', '让爸妈给你买')] },
  { text: '同学都有了，你还没有？', expect: [hit('minors', '同学都有了')] },
  { text: '小朋友都在用', ctx: { minors: true }, expect: [hit('minors', '小朋友都在用')] },
  { text: '快叫家长来看', expect: [hit('minors', '快叫家长')] },
  // AI 能力夸大
  { text: '可以完全替代人工客服', expect: [hit('ai_overclaim', '完全替代人工')] },
  { text: '绝不出错的 AI 助手', expect: [hit('ai_overclaim', '绝不出错')] },
  { text: '回答 100% 准确', ctx: { ai: true }, expect: [hit('ai_overclaim', '100% 准确')] },
  { text: '回答 100% 准确', expect: [hit('absolute', '100%')] },
  { text: '它比你更懂你', expect: [hit('ai_overclaim', '比你更懂你')] },
  // 价格与优惠条件
  { text: '新用户限时 5 折', expect: [hit('price', '限时'), hit('price', '5 折')] },
  { text: '注册即送会员', expect: [hit('price', '送')] },
  { text: '现在下单立减 50 元', expect: [hit('price', '立减')] },
  { text: '特价优惠中', expect: [hit('price', '特价'), hit('price', '优惠')] },
  { text: '买一年送三个月', expect: [hit('price', '送')] },
  // 贬低竞品
  { text: '吊打同类产品', expect: [hit('disparage', '吊打')] },
  { text: '秒杀其他工具', expect: [hit('disparage', '秒杀其他')] },
  { text: '甩竞品几条街', expect: [hit('disparage', '甩竞品几条街')] },
  { text: '性能碾压对手', expect: [hit('disparage', '碾压')] },
  // 无出处数据
  { text: '写作效率提升 300%', expect: [hit('data', '提升 300%')] },
  { text: '已有 10 万用户', expect: [hit('data', '10 万用户')] },
  { text: '每周节省 5 小时', expect: [hit('data', '节省 5 小时')] },
  { text: '速度快 3 倍', expect: [hit('data', '3 倍')] },

  // 反例：不应命中
  { text: '最近更新了导出功能', expect: [] },
  { text: '最后一步，点击发布', expect: [] },
  { text: '第一步：注册账号', expect: [] },
  { text: '第一次使用会有引导', expect: [] },
  { text: '升级到最新版本即可', expect: [] },
  { text: '每条记录都有唯一标识', expect: [] },
  { text: '截至 12 月 31 日免费', expect: [] },
  { text: '据 2026 年内测数据，效率提升 30%', expect: [] },
  { text: '第一时间收到通知', expect: [] },
  { text: '最初的想法很简单', expect: [] },
  { text: '最终效果以实际为准', expect: [] },
  { text: '消息发送成功', expect: [] },
  { text: '支持一键导出 PDF', expect: [] },
  { text: '用户 ID 唯一编号', expect: [] },
  { text: '第一章 产品介绍', expect: [] },
  { text: '仅限前 100 名，限时 5 折', expect: [] },
  { text: '数据来源：2025 年用户调研，满意度 92%', expect: [] },
  { text: '活动时间 11 月 1 日至 11 月 11 日，全场 8 折', expect: [] },
  { text: '本产品不能替代医生诊断', expect: [] },
  { text: '我们会持续优化体验', expect: [] },
  { text: '先看看第一印象', expect: [] },
  { text: '每周一次自动整理笔记', expect: [] },
  { text: '帮你把周报写得更好', expect: [] },
  { text: '传送门在评论区', expect: [] },
  { text: '最大化利用碎片时间', expect: [] },
  { text: '以第一人称记录日常', expect: [] },
  { text: 'Top 10 效率工具推荐', expect: [] },
  { text: '使用前最好先备份数据', expect: [] },
  { text: '处理数据更安全', expect: [] },
  { text: '体验很稳定，界面也清爽', expect: [] },
];
