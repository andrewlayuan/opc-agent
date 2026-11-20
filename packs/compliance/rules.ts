// 合规判定规则表（规则版本 1）。纯函数，不依赖数据库与网络。
// 依据条款均对照官方原文核对；未核对的只写法规名。

export const RULES_VERSION = 1;

export type Level = 'required' | 'maybe' | 'na';
export type Answers = Record<string, string | string[]>;

export interface Question {
  id: string;
  title: string;
  multi: boolean;
  options: { value: string; label: string }[];
  exclusive?: string;
  when?: (a: Answers) => boolean;
  dependsOn?: { q: string; in: string[] };
}

const opts = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const dep = (q: string, values: string[]) => ({
  dependsOn: { q, in: values },
  when: (a: Answers) => typeof a[q] === 'string' && values.includes(a[q] as string),
});

export const QUESTIONS: Question[] = [
  { id: 'forms', title: '产品形态', multi: true, options: opts([['web', '网站'], ['app', 'App'], ['miniapp', '小程序'], ['api', 'API 或 SDK'], ['desktop', '桌面或本地软件']]) },
  { id: 'audience', title: '面向谁', multi: false, options: opts([['public', '境内公众'], ['b2b', '仅企业客户（不面向个人）'], ['internal', '仅内部使用']]) },
  { id: 'overseas', title: '是否有境外用户', multi: false, options: opts([['no', '否'], ['yes', '是']]) },
  { id: 'charge', title: '怎么收入', multi: true, exclusive: 'free', options: opts([['free', '不收费'], ['paid', '向用户收费'], ['ads', '广告'], ['commerce', '电商或撮合交易']]) },
  { id: 'ai_use', title: '怎么用 AI', multi: false, options: opts([['none', '不用'], ['cn_api', '调用他人已备案模型 API'], ['foreign_api', '调用境外模型 API'], ['own', '自研、微调或私有部署']]) },
  { id: 'ai_output', title: '对模型输出做了什么', multi: false, options: opts([['raw', '原样展示'], ['processed', '有过滤、改写、拼接等二次加工']]), ...dep('ai_use', ['cn_api', 'foreign_api']) },
  { id: 'ai_media', title: '生成哪些内容', multi: true, exclusive: 'none', options: opts([['text', '文字'], ['image', '图片'], ['audio', '音频'], ['video', '视频'], ['none', '不直接生成内容']]), ...dep('ai_use', ['cn_api', 'foreign_api', 'own']) },
  { id: 'algo', title: '是否有推荐、排序、个性化推送', multi: false, options: opts([['no', '否'], ['yes', '是']]) },
  { id: 'social', title: '是否有公开传播功能', multi: true, exclusive: 'none', options: opts([['none', '无'], ['post', '发帖或评论'], ['profile', '公开主页或分享'], ['group', '群聊'], ['live', '直播']]) },
  { id: 'companion', title: '是否提供持续性情感陪伴、角色扮演', multi: false, options: opts([['no', '否'], ['yes', '是']]) },
  { id: 'scale', title: '用户规模', multi: false, options: opts([['prelaunch', '未上线'], ['small', '注册 <100 万且月活 <10 万'], ['large', '注册 ≥100 万或月活 ≥10 万']]) },
  { id: 'pi', title: '收集哪些个人信息', multi: true, exclusive: 'none', options: opts([['none', '不收集'], ['general', '一般个人信息（手机号、昵称等）'], ['sensitive', '敏感个人信息（身份证、人脸、健康、金融、行踪、14 岁以下未成年人信息）']]) },
  { id: 'minors', title: '用户是否可能包含未成年人', multi: false, options: opts([['no', '否'], ['maybe', '可能'], ['mainly', '主要面向未成年人']]) },
  { id: 'cross_border', title: '是否向境外提供个人信息', multi: false, options: opts([['no', '否'], ['lt10w', '是，当年累计不足 10 万人且不含敏感信息'], ['10w_100w', '是，10 万至 100 万人或敏感信息不足 1 万人'], ['gt100w', '是，超过 100 万人或敏感信息超过 1 万人']]) },
];

export interface CatalogItem {
  id: string;
  name: string;
  authority: string;
  basis: string;
  timing: string;
  timingOrder: 0 | 1 | 2 | 3;
  links: { label: string; url: string }[];
  validity?: { years?: number; yearlyReminder?: boolean };
}

const L = {
  miitBeian: { label: 'ICP/IP 地址/域名信息备案管理系统', url: 'https://beian.miit.gov.cn/' },
  // 2026-11-09 起生成式人工智能、算法、深度合成、区块链备案统一在此系统办理，原算法备案系统停用
  cacBeian: { label: '互联网新技术新应用信息服务备案系统', url: 'https://beian.cac.gov.cn/' },
  cacBeianNotice: { label: '网信办：新技术新应用备案系统上线通告', url: 'https://www.cac.gov.cn/2026-11/09/c_1795978604463007.htm' },
  genaiNotice: { label: '网信办：生成式人工智能服务已备案信息公告', url: 'https://www.cac.gov.cn/2026-01/09/c_1769688009588554.htm' },
  genaiRules: { label: '生成式人工智能服务管理暂行办法', url: 'https://www.gov.cn/zhengce/zhengceku/202307/content_6891752.htm' },
  anthro: { label: '人工智能拟人化互动服务管理暂行办法', url: 'https://www.cac.gov.cn/2026-04/10/c_1777558395078289.htm' },
  pipl: { label: '中华人民共和国个人信息保护法', url: 'https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm' },
};

export const CATALOG: CatalogItem[] = [
  { id: 'icp_filing', name: 'ICP 备案', authority: '属地通信管理局', basis: '《互联网信息服务管理办法》第四条（非经营性互联网信息服务实行备案制度）', timing: '上线前', timingOrder: 0,
    links: [L.miitBeian, { label: '互联网信息服务管理办法', url: 'https://www.gov.cn/govweb/gongbao/content/2011/content_1860864.htm' }] },
  { id: 'icp_license', name: 'ICP 经营许可证（增值电信业务）', authority: '属地通信管理局 / 工业和信息化部', basis: '《互联网信息服务管理办法》第四条（经营性互联网信息服务实行许可制度）；《电信业务经营许可管理办法》（有效期与年报）', timing: '上线前；有效期 5 年，每年年报', timingOrder: 0,
    links: [{ label: '电信业务市场综合管理信息系统', url: 'https://dxzhgl.miit.gov.cn/' }], validity: { years: 5, yearlyReminder: true } },
  { id: 'app_filing', name: 'APP / 小程序备案', authority: '属地通信管理局', basis: '《工业和信息化部关于开展移动互联网应用程序备案工作的通知》（工信部信管〔2023〕105号）', timing: '上架前', timingOrder: 0,
    links: [L.miitBeian, { label: '工信部：APP 备案通知', url: 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html' }] },
  { id: 'psb_filing', name: '公安联网备案', authority: '属地公安机关网安部门', basis: '《计算机信息网络国际联网安全保护管理办法》第十二条（网络正式联通之日起三十日内）', timing: '开通后 30 日内', timingOrder: 2,
    links: [{ label: '全国互联网安全管理服务平台', url: 'https://www.beian.gov.cn/' }] },
  { id: 'mlps', name: '等保定级备案与测评', authority: '属地公安机关', basis: '《信息安全等级保护管理办法》第十四条（三级每年至少一次等级测评）、第十五条（二级以上 30 日内备案）；《网络安全法》', timing: '投入运行后定级备案；三级每年测评', timingOrder: 2,
    links: [{ label: '网络安全等级保护网', url: 'https://www.djbh.net/' }], validity: { yearlyReminder: true } },
  { id: 'genai_register', name: '大模型登记', authority: '属地省级网信办', basis: '国家网信办生成式人工智能服务已备案信息公告（直接调用已备案模型能力的应用或功能，由地方网信办登记）', timing: '上线前', timingOrder: 0,
    links: [L.genaiNotice, L.genaiRules] },
  { id: 'genai_filing', name: '大模型备案', authority: '属地省级网信办 / 国家网信办', basis: '《生成式人工智能服务管理暂行办法》第二条、第十七条', timing: '上线前', timingOrder: 0,
    links: [L.cacBeian, L.genaiRules, L.genaiNotice] },
  { id: 'algo_filing', name: '算法备案', authority: '国家网信办', basis: '《互联网信息服务算法推荐管理规定》第二十四条（提供服务之日起十个工作日内）；《生成式人工智能服务管理暂行办法》第十七条', timing: '提供服务之日起 10 个工作日内', timingOrder: 2,
    links: [L.cacBeian, L.cacBeianNotice] },
  { id: 'security_assess', name: '双新安全评估', authority: '属地网信办、公安机关', basis: '《具有舆论属性或社会动员能力的互联网信息服务安全评估规定》第二条、第三条', timing: '上线前 / 功能重大变更时', timingOrder: 0,
    links: [{ label: '安全评估规定', url: 'https://www.cac.gov.cn/2018-11/15/c_1123716072.htm' }] },
  { id: 'model_disclosure', name: '公示所用模型与备案号', authority: '属地网信办', basis: '国家网信办生成式人工智能服务已备案信息公告（已上线应用应公示模型名称、备案号或上线编号）', timing: '上线时', timingOrder: 1,
    links: [L.genaiNotice] },
  { id: 'aigc_label', name: 'AI 生成内容标识（显式 + 隐式）', authority: '网信、工信、公安、广电部门', basis: '《人工智能生成合成内容标识办法》第三条、第四条；GB 45438-2025', timing: '上线前', timingOrder: 0,
    links: [{ label: '人工智能生成合成内容标识办法', url: 'https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm' }] },
  { id: 'anthro_selfcheck', name: '拟人化互动服务自查', authority: '属地网信办', basis: '《人工智能拟人化互动服务管理暂行办法》第二条、第十八条', timing: '上线前', timingOrder: 0,
    links: [L.anthro] },
  { id: 'anthro_assess', name: '拟人化安全评估报送', authority: '属地省级网信办', basis: '《人工智能拟人化互动服务管理暂行办法》第二十二条', timing: '上线前；用户达到门槛或功能重大变化时再评估', timingOrder: 0,
    links: [L.anthro] },
  { id: 'privacy_policy', name: '隐私政策与个人信息自查', authority: '网信部门', basis: '《个人信息保护法》第十七条', timing: '上线前', timingOrder: 0,
    links: [L.pipl] },
  { id: 'pia', name: '个人信息保护影响评估', authority: '网信部门', basis: '《个人信息保护法》第五十五条', timing: '处理前', timingOrder: 0,
    links: [L.pipl] },
  { id: 'cross_border', name: '数据出境', authority: '属地省级网信办 / 国家网信办', basis: '《促进和规范数据跨境流动规定》第五条、第七条、第八条', timing: '出境前', timingOrder: 0,
    links: [{ label: '促进和规范数据跨境流动规定', url: 'https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm' }] },
  { id: 'minor_protect', name: '未成年人保护', authority: '网信部门', basis: '《未成年人网络保护条例》第四十二条、第四十三条', timing: '上线前', timingOrder: 0,
    links: [{ label: '未成年人网络保护条例', url: 'https://www.gov.cn/zhengce/content/202310/content_6911288.htm' }] },
];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** 单题答案是否合法：单选为选项内字符串；多选为非空、选项内的字符串数组，互斥项不与其他项同选 */
export function validOption(q: Question, v: unknown): boolean {
  const allowed = new Set(q.options.map((o) => o.value));
  if (!q.multi) return typeof v === 'string' && allowed.has(v);
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && allowed.has(x))) return false;
  return !(q.exclusive && v.includes(q.exclusive) && new Set(v).size > 1);
}

export function validateAnswers(a: unknown): { ok: true; answers: Answers } | { ok: false; missing: string[]; invalid: string[] } {
  const raw = isObj(a) ? a : {};
  const answers: Answers = {};
  const missing: string[] = [];
  const invalid: string[] = isObj(a) ? [] : ['answers'];
  for (const q of QUESTIONS) {
    if (q.when && !q.when(answers)) continue;
    const v = raw[q.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) { missing.push(q.id); continue; }
    if (!validOption(q, v)) { invalid.push(q.id); continue; }
    answers[q.id] = q.multi ? [...new Set(v as string[])] : (v as string);
  }
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  return { ok: true, answers };
}

export interface AssessedItem { id: string; level: Level; reasons: string[]; order: number }
export interface AssessResult { version: number; items: AssessedItem[]; social: { value: boolean; reason: string }; notes: string[] }

const Q = new Map(QUESTIONS.map((q) => [q.id, q]));
const label = (q: string, v: string) => Q.get(q)?.options.find((o) => o.value === v)?.label ?? v;
const list = (x: string | string[] | undefined): string[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const fact = (q: string, v: string) => (Q.get(q)!.multi ? `问卷：${Q.get(q)!.title}包含「${label(q, v)}」` : `问卷：${Q.get(q)!.title} — ${label(q, v)}`);

const FOREIGN_NOTE = '使用境外模型 API：境外模型通常无法完成国内登记，面向境内公众提供生成式服务前需更换为已备案模型或走备案。';
const CROSS_TIER: Record<string, string> = {
  lt10w: '档位：免申报 — 当年累计不满 10 万人非敏感个人信息，免予安全评估、标准合同与认证（第五条第四项）',
  '10w_100w': '档位：标准合同或认证 — 订立个人信息出境标准合同或通过个人信息保护认证（第八条）',
  gt100w: '档位：安全评估 — 通过所在地省级网信部门向国家网信部门申报数据出境安全评估（第七条）',
};

export function assess(a: Answers): AssessResult {
  const has = (q: string, v: string) => list(a[q]).includes(v);
  const hits = (q: string, vs: string[]) => list(a[q]).filter((v) => vs.includes(v));
  const out = new Map<string, { level: Level; reasons: string[] }>();
  const set = (id: string, level: Level, reasons: string[]) => out.set(id, { level, reasons });
  const notes: string[] = [];

  const audience = a.audience as string;
  const aiUse = a.ai_use as string;
  const internal = audience === 'internal';
  const pub = audience === 'public';
  const socialHits = hits('social', ['post', 'profile', 'group', 'live']);
  const social = socialHits.length > 0
    ? { value: true, reason: `具有公开传播功能：${socialHits.map((v) => label('social', v)).join('、')}` }
    : { value: false, reason: '无公开传播功能' };

  if (internal) notes.push('仅内部使用：面向公众的备案类事项不适用');
  if (has('overseas', 'yes')) notes.push('有境外用户：境外法规（如 GDPR、EU AI Act）另行评估');

  const webish = hits('forms', ['web', 'app', 'miniapp']);
  if (!internal && webish.length) {
    set('icp_filing', 'required', webish.map((v) => fact('forms', v)));
    const paid = hits('charge', ['paid', 'ads', 'commerce']);
    if (paid.length) set('icp_license', 'required', paid.map((v) => fact('charge', v)));
  }
  const apps = hits('forms', ['app', 'miniapp']);
  if (!internal && apps.length) set('app_filing', 'required', apps.map((v) => fact('forms', v)));
  if (!internal && has('forms', 'web')) set('psb_filing', 'required', [fact('forms', 'web')]);
  const systems = hits('forms', ['web', 'app', 'miniapp', 'api']);
  if (systems.length) set('mlps', 'required', systems.map((v) => fact('forms', v)));

  const aiFact = fact('ai_use', aiUse);
  if (pub && aiUse === 'cn_api') {
    if (a.ai_output === 'processed') set('genai_filing', 'maybe', [aiFact, fact('ai_output', 'processed'), '二次加工可能被认定为实质性修改，建议先咨询属地网信办']);
    else set('genai_register', 'required', [aiFact, fact('ai_output', 'raw'), fact('audience', 'public')]);
  }
  if (pub && aiUse === 'own') set('genai_filing', 'required', [aiFact, fact('audience', 'public')]);
  if (pub && aiUse === 'foreign_api') {
    set('genai_register', 'maybe', [aiFact, FOREIGN_NOTE]);
    set('genai_filing', 'maybe', [aiFact, FOREIGN_NOTE]);
    notes.push(FOREIGN_NOTE);
  }
  if (pub && (aiUse === 'cn_api' || aiUse === 'own')) set('model_disclosure', 'required', [aiFact, fact('audience', 'public')]);

  if (!internal && social.value) {
    const algoWhy = [...(has('algo', 'yes') ? [fact('algo', 'yes')] : []), ...(aiUse !== 'none' ? [aiFact] : [])];
    if (algoWhy.length) set('algo_filing', 'required', [social.reason, ...algoWhy]);
    set('security_assess', 'required', [social.reason]);
  }
  const media = hits('ai_media', ['text', 'image', 'audio', 'video']);
  if (!internal && aiUse !== 'none' && media.length) set('aigc_label', 'required', media.map((v) => fact('ai_media', v)));

  if (pub && has('companion', 'yes')) {
    set('anthro_selfcheck', 'required', [fact('companion', 'yes'), fact('audience', 'public')]);
    const why = ['上线拟人化互动服务即需开展安全评估并向省级网信部门提交报告（第二十二条第一项）'];
    if (has('scale', 'large')) why.push('用户规模达到注册 100 万或月活 10 万门槛（第二十二条第三项）');
    set('anthro_assess', 'required', why);
  }

  if (!has('pi', 'none')) set('privacy_policy', 'required', list(a.pi).map((v) => fact('pi', v)));
  const cross = a.cross_border as string;
  const piaWhy = [...(has('pi', 'sensitive') ? [fact('pi', 'sensitive')] : []), ...(cross !== 'no' ? [fact('cross_border', cross)] : [])];
  if (piaWhy.length) set('pia', 'required', piaWhy);
  if (cross !== 'no') set('cross_border', 'required', [fact('cross_border', cross), CROSS_TIER[cross]]);
  const minors = a.minors as string;
  if (!internal && (minors === 'maybe' || minors === 'mainly')) set('minor_protect', 'required', [fact('minors', minors)]);

  const items = CATALOG.map((c) => ({ id: c.id, level: out.get(c.id)?.level ?? ('na' as Level), reasons: out.get(c.id)?.reasons ?? [], order: c.timingOrder }));
  items.sort((x, y) => x.order - y.order);
  return { version: RULES_VERSION, items, social, notes };
}

const addYears = (t: number, n: number) => {
  const d = new Date(t);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
};

export function nextDates(item: string, doneAt: number): { due_at: number | null; remind_at: number | null } {
  const v = CATALOG.find((c) => c.id === item)?.validity;
  return {
    due_at: v?.years ? addYears(doneAt, v.years) : null,
    remind_at: v?.yearlyReminder ? addYears(doneAt, 1) : null,
  };
}
