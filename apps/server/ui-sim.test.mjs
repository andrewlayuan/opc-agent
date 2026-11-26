// 极简 DOM 模拟：用真实 index.html 的 id 与 app.js 跑一遍关键交互（不依赖浏览器）。随 npm test 运行；
// 单独运行：node --disable-warning=ExperimentalWarning apps/server/ui-sim.test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const PUB = process.env.PUB ?? fileURLToPath(new URL('./public', import.meta.url));
const html = fs.readFileSync(`${PUB}/index.html`, 'utf8');

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.hidden = 'hidden' in attrs;
    this.value = attrs.value ?? '';
    this.checked = 'checked' in attrs;
    this.disabled = false;
    this._text = '';
    this.className = attrs.class ?? '';
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5)] = v;
    if (tag === 'iframe') this.contentWindow = { postMessage: (msg, target) => iframeMessages.push({ msg, target, frame: this }) };
    const self = this;
    this.classList = {
      toggle(c, on) {
        const s = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on ?? !s.has(c)) s.add(c); else s.delete(c);
        self.className = [...s].join(' ');
      },
      add: (c) => self.classList.toggle(c, true),
      remove: (c) => self.classList.toggle(c, false),
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get value() {
    if (this.tagName === 'SELECT' && !this._value) return this.children.find((c) => c.tagName === 'OPTION')?.attrs.value ?? '';
    return this._value;
  }
  set value(v) { this._value = v; }
  get textContent() { return this._text + this.children.map((c) => c.textContent ?? '').join(''); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  append(...xs) { for (const x of xs) { const c = typeof x === 'string' ? { textContent: x } : x; if (c instanceof El) c.parentNode = this; this.children.push(c); } }
  replaceChildren(...xs) { for (const c of this.children) if (c instanceof El) c.parentNode = null; this.children = []; this._text = ''; this.append(...xs); }
  replaceWith() {}
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  insertBefore(node, ref) { if (node instanceof El) node.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node); }
  focus() {}
  querySelector() { return new El('button'); }
  get elements() { return { namedItem: () => new El('input') }; }
  reset() {}
  click() { return this.fire('click'); }
  async fire(type, extra = {}) {
    const ev = { type, preventDefault() { this.defaultPrevented = true; }, currentTarget: this, target: this, ...extra };
    for (const fn of this.listeners[type] ?? []) await fn(ev);
    return ev;
  }
}

const byId = new Map();
const tabs = [];
for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
  const attrs = {};
  for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
  const el = new El(m[1], attrs);
  if (attrs.id) byId.set(attrs.id, el);
  if (attrs['data-view']) tabs.push(el);
}

const tabList = new El('nav', { class: 'tabs' });
for (const t of tabs) tabList.append(t);
const calls = [];
const PRESETS = [
  { id: 'auto', label: '智能匹配（按内容自动选框架）', short: '智能匹配', skills: [] },
  { id: 'idea', label: '点子快评：x', short: '点子快评', skills: ['value-proposition', 'identify-assumptions-new', 'pre-mortem'] },
  { id: 'business', label: '商业模式与变现：x', short: '商业模式与变现', skills: ['lean-canvas', 'monetization-strategy', 'pricing-strategy'] },
  { id: 'redteam', label: '战略红队：x', short: '战略红队', skills: ['strategy-red-team', 'pre-mortem'] },
];
const routes = {
  'GET /api/meta': { topics: [{ id: 'llm', label: '大模型' }, { id: 'hardware', label: 'AI 硬件' }], groups: { lab: '官方' }, llm: { enabled: true }, reach: { enabled: true }, intervalMin: 60 },
  'GET /api/prefs/interests': { interests: { topics: [], minImportance: 3 } },
  'PUT /api/prefs/interests': { interests: { topics: ['hardware'], minImportance: 4 } },
  'GET /api/pm/meta': { enabled: true, skillsFound: 65, llm: true, maxSelected: 6, maxAdd: 3, maxReviewSkills: 12, presets: PRESETS, skills: [
    { name: 'lean-canvas', group: '产品战略', description: 'd' }, { name: 'swot-analysis', label: 'SWOT 分析', group: '产品战略', description: 'd' }, { name: 'pre-mortem', group: '执行落地', description: 'd' }] },
  'GET /api/pm/reviews': { reviews: [] },
  'POST /api/pm/reviews': { id: 7 },
  'GET /api/pm/reviews/7': { review: { id: 7, latest: 1, versions: [{ n: 1, source: 'ai_initial', created_at: Date.now(), note: null }], messages: [], updated_at: Date.now(), status: 'done', mode_label: '智能匹配', created_at: Date.now(), input: '一个足够长的点子描述', skills: ['lean-canvas'], content: '## 一句话结论\n- 有条件地做 [1]\n| a | b |\n|---|---|\n| 1 | 2 |', refs: [{ n: 1, url: 'https://a.com', title: 't', source: 's' }] } },
  'GET /api/status': { state: { running: false }, stats: { today: 1, pending: 0 } },
  'GET /api/items': { items: [] },
  'GET /api/kb/source': { docId: null },
  'GET /api/compliance/reminders': { reminders: [] },
};
const fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const p = url.split('?')[0];
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
  calls.push({ method, url, body, headers: opts.headers, raw: typeof opts.body === 'string' ? undefined : opts.body });
  let data = routes[`${method} ${p}`];
  if (!data && method === 'GET' && /^\/api\/pm\/reviews\/\d+\/prototypes$/.test(p)) data = { prototypes: [] };
  if (!data) throw new Error(`unmocked ${method} ${p}`);
  if (typeof data === 'function') data = await data(body, { ...opts, url });
  if (data && data.__status) return { ok: data.__status < 400, status: data.__status, json: async () => data.data };
  return { ok: true, status: 200, json: async () => data };
};

const toasts = [];
const confirms = [];
const prompts = [];
let promptAnswer = null;
const iframeMessages = [];
const winListeners = {};
const dispatchMessage = async (data, source) => {
  for (const fn of winListeners.message ?? []) await fn({ data, source });
};
// 旧键 opc.tabOrder 必须被忽略；新键 opc.tabOrder.v2 里是（含旧版子页面名的）已保存顺序，用来验证迁移
const store = new Map([['opc.tabOrder', '["memory","growth","kb"]'], ['opc.tabOrder.v2', '["pm","sources","feed","brief","kb","memory"]']]);
const ctx = {
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  document: {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t),
    body: new El('body'),
    createTextNode: (s) => ({ textContent: s }),
    querySelectorAll: (sel) => (sel === '.tabs button' ? tabList.children.filter((c) => c.tagName === 'BUTTON') : []),
  },
  Node: El,
  File: class { constructor(parts, name, o) { this.name = name; this.size = o?.size ?? 10; this.type = o?.type ?? ''; this.webkitRelativePath = o?.path ?? ''; } },
  fetch,
  location: { replace: (u) => { throw new Error(`redirect ${u}`); } },
  window: {
    scrollTo() {},
    addEventListener: (t, fn) => { (winListeners[t] ??= []).push(fn); },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  confirm: (msg) => (confirms.push(msg), true),
  prompt: (msg) => (prompts.push(msg), promptAnswer),
  setTimeout: (fn, ms) => (ms >= 3000 ? 0 : setTimeout(fn, ms)),
  clearTimeout, setInterval: () => 0, URL, URLSearchParams, console, Date, Promise, Map, Set, Number, String, JSON, Math, Object, Array, Error,
};
ctx.window = { ...ctx.window };
// toast 文本落在 #toast 上
let src = fs.readFileSync(`${PUB}/app.js`, 'utf8');
if (fs.existsSync(`${PUB}/proto-panel.js`)) {
  const pp = fs.readFileSync(`${PUB}/proto-panel.js`, 'utf8').replace(/^export /gm, '');
  src = pp + '\n' + src.replace(/^import .* from '\.\/proto-panel\.js';\n/m, '');
}
if (fs.existsSync(`${PUB}/pm-diff.js`)) {
  src = fs.readFileSync(`${PUB}/pm-diff.js`, 'utf8').replace(/^export /gm, '') + '\n' + src.replace(/^import .* from '\.\/pm-diff\.js';\n/m, '');
}
if (fs.existsSync(`${PUB}/growth.js`)) {
  src = fs.readFileSync(`${PUB}/growth.js`, 'utf8').replace(/^export /gm, '') + '\n' + src.replace(/^import .* from '\.\/growth\.js';\n/m, '');
}
if (fs.existsSync(`${PUB}/skills.js`)) {
  src = fs.readFileSync(`${PUB}/skills.js`, 'utf8').replace(/^export /gm, '') + '\n' + src.replace(/^import .* from '\.\/skills\.js';\n/m, '');
}
if (fs.existsSync(`${PUB}/kb.js`)) {
  let kb = fs.readFileSync(`${PUB}/kb.js`, 'utf8').replace(/^export /gm, '').replace(/^import .* from '\.\/wiki\.js';\n/m, '');
  if (fs.existsSync(`${PUB}/wiki.js`)) kb = fs.readFileSync(`${PUB}/wiki.js`, 'utf8').replace(/^export /gm, '') + '\n' + kb;
  src = kb + '\n' + src.replace(/^import .* from '\.\/kb\.js';\n/m, '');
}
if (fs.existsSync(`${PUB}/compliance.js`)) {
  let cpSrc = fs.readFileSync(`${PUB}/compliance.js`, 'utf8').replace(/^export /gm, '').replace(/^import .* from '\.\/compliance-docs\.js';\n/m, '');
  if (fs.existsSync(`${PUB}/compliance-docs.js`)) cpSrc = fs.readFileSync(`${PUB}/compliance-docs.js`, 'utf8').replace(/^export /gm, '') + '\n' + cpSrc;
  src = cpSrc + '\n' + src.replace(/^import .* from '\.\/compliance\.js';\n/m, '');
}
vm.createContext(ctx);
vm.runInContext(src + "\nwindow.proto = typeof proto === 'undefined' ? null : proto;", ctx, { filename: 'app.js' });
const tick = () => new Promise((r) => setTimeout(r, 30));
await tick();

assert.deepEqual(tabList.children.filter((c) => c.tagName === 'BUTTON').map((c) => c.dataset.view), ['pm', 'intel', 'kb', 'memory', 'growth', 'compliance'], '已保存的顺序迁移为「情报」（动态/简报/信息源合并）并保留，缺的菜单按新默认顺序（运营、合规）补在后面');

const $ = (id) => byId.get(id);
const intelSub = (t) => ($('intel-tabs')?.children ?? []).find((b) => b.textContent === t);
const goIntel = async (t) => { await tabs.find((x) => x.dataset.view === 'intel').fire('click'); await intelSub(t).fire('click'); await tick(); };
assert.match(html, /<title>天枢 Tianshu<\/title>/, '页面标题应为天枢');
assert.ok(!/Radar</.test(html) && !/OPC Radar/.test(html), '界面不再出现 Radar 品牌名');
const loginHtml = fs.readFileSync(`${PUB}/login.html`, 'utf8');
assert.match(loginHtml, /天枢/);
assert.ok(!/OPC Radar|>Radar</.test(loginHtml), '登录页不再出现 Radar 品牌名');
assert.equal($('pm-input').attrs.maxlength, '8000');
const errs = () => ($('toast').hidden ? '' : $('toast').textContent);
assert.equal(errs(), '', `init 报错：${errs()}`);

// 1. 点「产品顾问」
await tabs.find((t) => t.dataset.view === 'pm').fire('click');
await tick();
assert.equal($('view-pm').hidden, false, '产品顾问视图应显示');
assert.equal($('view-feed').hidden, true);
const chips = () => $('pm-presets').children;
const isOn = (c) => c.className.split(' ').includes('on');
const chip = (t) => chips().find((c) => c.textContent === t);
assert.equal(chips().length, PRESETS.length, '方案 chips 应渲染');
assert.ok(isOn(chip('智能匹配')), '默认智能匹配');
assert.match($('pm-hint').textContent, /自动挑选/);
console.log('✓ 产品顾问视图显示，方案 chips：', chips().map((c) => c.textContent).join(' / '));

// 2. 多选：点子快评 + 战略红队（pre-mortem 去重）+ 自选 swot
await chip('点子快评').fire('click');
await chip('战略红队').fire('click');
assert.ok(isOn(chip('点子快评')) && isOn(chip('战略红队')) && !isOn(chip('智能匹配')), '应同时选中两个方案');
const skillChip = (n) => $('pm-skills').children.flatMap((g) => g.children[1].children).find((c) => String(c.attrs?.title ?? '').split('\n')[0] === n);
const chipText = (n) => skillChip(n).textContent;
assert.ok(skillChip('pre-mortem').className.includes('via'), 'pre-mortem 应标记为已包含');
await skillChip('pre-mortem').fire('click');
assert.match(errs(), /已包含/);
await skillChip('swot-analysis').fire('click');
assert.ok(isOn(skillChip('swot-analysis')));
assert.match($('pm-hint').textContent, /将组合 5\/6 个框架/);
assert.ok(chipText('swot-analysis').startsWith('SWOT 分析') && chipText('swot-analysis').includes('swot-analysis'), '有中文名时按钮先显示中文名，再附英文名');
assert.equal(chipText('lean-canvas'), 'lean-canvas', '没有中文名时只显示英文名');
assert.match($('pm-hint').textContent, /SWOT 分析/, '提示里用中文名');
assert.doesNotMatch($('pm-hint').textContent, /swot-analysis/);
assert.equal($('pm-custom-count').textContent, '已选 1 个');
console.log('✓ 多选合并去重：', $('pm-hint').textContent);

// 3. 超过 6 个被拦截，选择不变
await chip('商业模式与变现').fire('click');
assert.match(errs(), /最多组合 6 个框架（这样选会有 8 个）/);
assert.ok(!isOn(chip('商业模式与变现')));
console.log('✓ 超过上限被拦截：', errs());

// 4. 点智能匹配清空选择
await chip('智能匹配').fire('click');
assert.ok(isOn(chip('智能匹配')) && !isOn(chip('点子快评')) && !isOn(skillChip('swot-analysis')));
await chip('点子快评').fire('click');
await chip('战略红队').fire('click');
await skillChip('swot-analysis').fire('click');
console.log('✓ 智能匹配与手动选择互斥');
$('toast').hidden = true;

// 3. 提交评审
$('pm-input').value = '一个足够长的点子描述';
await $('pm-input').fire('input');
assert.equal($('pm-count').textContent, '10/8000');
const ev = await $('pm-form').fire('submit');
await tick();
assert.ok(ev.defaultPrevented, '提交不应刷新页面');
const post = calls.find((c) => c.method === 'POST' && c.url === '/api/pm/reviews');
assert.deepEqual(post.body, { input: '一个足够长的点子描述', presets: ['idea', 'redteam'], skills: ['swot-analysis'], useRadar: true });
assert.equal($('pm-result').hidden, false, '结果区应显示');
assert.equal($('pm-form').hidden, true, '打开评审后隐藏新建表单');
assert.equal($('pm-new').hidden, false, '打开评审后显示「新建评审」');
const text = $('pm-result').textContent;
assert.match(text, /一句话结论/);
assert.equal(errs(), '', `提交报错：${errs()}`);
console.log('✓ 提交评审并渲染结果（含表格与引用）');

// 4. 我的关注：未设置时点击打开编辑器，保存后生效
await goIntel('动态');
const focusChip = $('topics').children[0];
assert.match(focusChip.textContent, /我的关注/);
await focusChip.fire('click');
assert.equal($('focus-edit').hidden, false, '应打开关注编辑器');
await $('focus-topics').children[1].fire('click'); // 选 AI 硬件
$('focus-min').value = '4';
const sev = await $('focus-edit').fire('submit');
await tick();
assert.ok(sev.defaultPrevented, '保存不应刷新页面');
const put = calls.find((c) => c.method === 'PUT');
assert.deepEqual(put.body, { topics: ['hardware'], minImportance: 4 });
assert.equal($('focus-edit').hidden, true);
const last = calls.filter((c) => c.url.startsWith('/api/items')).at(-1).url;
assert.match(last, /topics=hardware/);
assert.match(last, /min=4/);
console.log('✓ 我的关注保存后按 AI 硬件 + 重要度≥4 筛选：', last);

// 5. 已设置关注时，打开页面默认进入「我的关注」
routes['GET /api/prefs/interests'] = { interests: { topics: ['llm'], minImportance: 3 } };

// ---------------- 多轮对话、版本、编辑 ----------------
const walk = (el, out = []) => {
  for (const c of el.children ?? []) {
    if (c instanceof El) {
      out.push(c);
      walk(c, out);
    }
  }
  return out;
};
const all = (pred) => walk($('pm-result')).filter(pred);
const one = (pred) => all(pred)[0];
const cls = (c) => (el) => el.className.split(/\s+/).includes(c);
const verSel = () => one(cls('ver-select'));
const verOpts = () => (verSel()?.children ?? []).filter((c) => c.tagName === 'OPTION');
const pickVer = async (n) => { verSel().value = String(n); await verSel().fire('change'); await tick(); };
const tabBtn = (t) => one((el) => el.tagName === 'BUTTON' && cls('pm-tab')(el) && el.textContent.startsWith(t));
const pane = (k) => one((el) => cls('pm-pane')(el) && el.attrs['data-pane'] === k);
const docText = () => one(cls('pm-doc'))?.textContent ?? '';
const threadText = () => one(cls('pm-thread'))?.textContent ?? '';
const reply = () => one(cls('pm-reply'));
const replyInput = () => walk(reply()).find((el) => el.tagName === 'TEXTAREA');
const replyBtn = () => walk(reply()).find((el) => el.tagName === 'BUTTON' && el.attrs.type === 'submit');
const btnText = (t) => one((el) => el.tagName === 'BUTTON' && el.textContent === t);
const now = Date.now();
const R8 = {
  id: 8, status: 'done', mode_label: '点子快评', created_at: now, updated_at: now, input: '一个足够长的点子描述', skills: ['pre-mortem'], refs: [], error: null,
  latest: 1, versions: [{ n: 1, source: 'ai_initial', created_at: now, note: null }], messages: [], content: '# V1 内容',
};
const P8 = [];
routes['GET /api/pm/reviews/8'] = () => ({ review: structuredClone(R8) });
routes['GET /api/pm/reviews/8/prototypes'] = () => ({ prototypes: structuredClone(P8) });
routes['POST /api/pm/reviews/8/prototypes'] = (body) => {
  if (body.versionN === 2) {
    assert.deepEqual(body, { versionN: 2 });
    return { __status: 202, data: { prototype: {} } };
  }
  assert.deepEqual(body, { versionN: 1 });
  const v = { n: 1, status: 'running', progress: { stage: 'pages', done: 2, total: 5 }, request: '', note: '', base_version_n: 1, from_n: null, pages: [], error: null };
  P8.push(v);
  return { __status: 202, data: { prototype: v } };
};
routes['POST /api/pm/reviews/8/prototypes/1/revise'] = (body) => {
  assert.deepEqual(body, { text: '加微信登录' });
  const v = { n: 2, status: 'done', progress: { stage: 'pages', done: 3, total: 3 }, request: '加微信登录', note: '已加登录', base_version_n: 1, from_n: 1, pages: [{ slug: 'home', title: '首页' }, { slug: 'detail', title: '详情' }, { slug: 'login', title: '登录' }], error: null };
  P8.push(v);
  return { __status: 202, data: { prototype: v } };
};
routes['POST /api/pm/reviews/8/prototypes/3/retry'] = (body) => {
  assert.equal(body, undefined);
  P8[2].status = 'running';
  return { __status: 202, data: { prototype: P8[2] } };
};
routes['GET /api/pm/reviews'] = () => ({ reviews: [{ id: 8, status: 'done', mode_label: '点子快评', input: R8.input, created_at: now, updated_at: now, latest: R8.latest, turns: R8.messages.filter((m) => m.role === 'user').length }] });
let disabledAtPost = null;
let nextMsg = 1;
routes['POST /api/pm/reviews/8/messages'] = (body) => {
  disabledAtPost = replyBtn().disabled;
  R8.messages.push({ id: nextMsg++, role: 'user', kind: body.mode === 'revise' ? 'revise' : 'ask', content: body.text, status: 'done', version_n: null, error: null, created_at: now });
  R8.messages.push({ id: nextMsg++, role: 'assistant', kind: 'ask', content: '', status: 'running', version_n: null, error: null, created_at: now });
  return { __status: 202, data: { messageId: nextMsg - 1 } };
};

// 6.1 打开已完成的会话：版本栏 1 个版本 + 输入区
await ctx.openReview(8);
await tick();
assert.equal(verOpts().length, 1, '版本下拉应有 1 个版本');
assert.match(verOpts()[0].textContent, /^v1 · 首版/);
assert.ok(reply(), '应显示追问输入区');
assert.match(docText(), /V1 内容/);
assert.match($('pm-history').textContent, /v1 · 0 轮/);
assert.match(one(cls('proto-panel')).textContent, /PRD v1/);
console.log('✓ 打开会话：版本栏与输入区');

// 6.1b 标签页：默认文档；切到对话；同一评审记住标签；原型面板在原型页
assert.ok(tabBtn('文档') && tabBtn('对话') && tabBtn('原型'), '应有文档/对话/原型三个标签');
assert.equal(pane('doc').hidden, false);
assert.equal(pane('chat').hidden, true);
assert.equal(pane('proto').hidden, true);
assert.ok(cls('on')(tabBtn('文档')));
assert.ok(walk(pane('chat')).includes(reply()), '输入区在对话页');
assert.ok(walk(pane('proto')).includes(one(cls('proto-panel'))), '原型面板在原型页');
await tabBtn('对话').fire('click');
assert.equal(pane('chat').hidden, false);
assert.equal(pane('doc').hidden, true);
assert.equal(tabBtn('对话').attrs['aria-selected'], 'true');
await ctx.openReview(8);
await tick();
assert.equal(pane('chat').hidden, false, '刷新后仍停留在对话页');
await tabBtn('文档').fire('click');
const docEl = one(cls('pm-doc'));
await ctx.openReview(8);
await tick();
assert.equal(one(cls('pm-doc')), docEl, '内容未变时不重建文档区');
console.log('✓ 详情标签页：文档/对话/原型，记住标签与局部刷新');

// 6.1c 侧栏收起/展开并记住；新建评审
assert.equal($('pm-layout').className.includes('collapsed'), false);
await $('pm-side-toggle').fire('click');
assert.ok($('pm-layout').className.includes('collapsed'), '点击后收起侧栏');
assert.equal(store.get('opc.pmSide'), 'collapsed');
assert.equal($('pm-side-toggle').attrs['aria-expanded'], 'false');
await $('pm-side-toggle').fire('click');
assert.ok(!$('pm-layout').className.includes('collapsed'));
assert.equal(store.get('opc.pmSide'), 'open');
await $('pm-new').fire('click');
assert.equal($('pm-form').hidden, false, '新建评审显示表单');
assert.equal($('pm-result').hidden, true, '新建评审隐藏详情');
assert.equal($('pm-new').hidden, true);
await walk($('pm-history')).find((el) => el.tagName === 'A').fire('click');
await tick();
assert.equal($('pm-form').hidden, true);
assert.equal($('pm-result').hidden, false, '从列表重新打开评审');
console.log('✓ 历史侧栏收起记忆与新建评审');

// 9. 原型面板：生成、进度、预览、消息与版本切换
const pp = () => one(cls('proto-panel'));
const protoBtn = (t) => all((el) => el.tagName === 'BUTTON' && el.textContent === t)[0];
const frame = () => one((el) => el.tagName === 'IFRAME');
const pageSel = () => one(cls('proto-pages'));
const firstPanel = pp();
assert.ok(firstPanel, '评审页应有原型面板');
assert.match(firstPanel.textContent, /PRD v1/);
await protoBtn('生成原型').fire('click');
await tick();
assert.match(pp().textContent, /页面 2\/5/);
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/pm/reviews/8/prototypes' && c.body.versionN === 1));
P8[0].status = 'done';
P8[0].progress = { stage: 'pages', done: 5, total: 5 };
P8[0].pages = [{ slug: 'home', title: '首页', error: null }, { slug: 'detail', title: '详情', error: null }];
await ctx.window.proto._poll();
await tick();
assert.ok(frame(), 'done 后应出现 iframe');
assert.match(frame().attrs.src, /\/prototypes\/1\/html/);
assert.equal(frame().attrs.sandbox, 'allow-scripts');
assert.equal(pp(), firstPanel, '同一评审复用面板元素');
const firstFrame = frame();
await ctx.openReview(8);
await tick();
assert.equal(pp(), firstPanel);
assert.equal(frame(), firstFrame, 'iframe 不重建');
await dispatchMessage({ type: 'proto:page', slug: 'detail' }, frame().contentWindow);
assert.equal(pageSel().value, 'detail');
await dispatchMessage({ type: 'proto:page', slug: 'nope' }, frame().contentWindow);
assert.equal(pageSel().value, 'detail');
await dispatchMessage({ type: 'proto:page', slug: 'home' }, { postMessage() {} });
assert.equal(pageSel().value, 'detail');
pageSel().value = 'home';
await pageSel().fire('change');
assert.deepEqual(JSON.parse(JSON.stringify(iframeMessages.at(-1).msg)), { type: 'proto:goto', slug: 'home' });
await protoBtn('标注').fire('click');
assert.deepEqual(JSON.parse(JSON.stringify(iframeMessages.at(-1).msg)), { type: 'proto:notes', on: true });
const beforeReload = iframeMessages.length;
await frame().fire('load');
assert.ok(iframeMessages.slice(beforeReload).some((x) => x.msg.type === 'proto:notes' && x.msg.on === true), '重载后应重发标注状态');
await protoBtn('桌面').fire('click');
await tick();
assert.match(frame().attrs.src, /device=desktop/);
const input = one(cls('proto-revise-input'));
input.value = '草稿不能被轮询清掉';
await input.fire('input');
await ctx.window.proto._poll();
await tick();
assert.equal(one(cls('proto-revise-input')).value, '草稿不能被轮询清掉', '重绘后保留修改草稿');
one(cls('proto-revise-input')).value = '加微信登录';
await one(cls('proto-revise-input')).fire('input');
await one(cls('proto-revise')).fire('submit');
await tick();
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/pm/reviews/8/prototypes/1/revise' && c.body.text === '加微信登录'));
P8.push({ n: 3, status: 'error', error: '生成失败', progress: { stage: 'pages', done: 0, total: 3 }, request: '失败修改', note: '', base_version_n: 1, from_n: 1, pages: [], error: '生成失败' });
await ctx.window.proto._poll();
await tick();
await all((el) => el.tagName === 'BUTTON' && cls('proto-ver')(el) && el.textContent === 'v3')[0].fire('click');
await tick();
assert.ok(protoBtn('重试'), '失败版本应有重试按钮');
await protoBtn('重试').fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/pm/reviews/8/prototypes/3/retry'));
R8.latest = 2;
P8[2].status = 'done';
await ctx.openReview(8);
await tick();
await ctx.window.proto._poll();
await tick();
assert.match(pp().textContent, /原型基于 PRD v1，PRD 已更新到 v2/);
await protoBtn('按新 PRD 重新生成').fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/pm/reviews/8/prototypes' && c.body.versionN === 2));
const links = all((el) => el.tagName === 'A');
assert.ok(links.some((a) => /\/prototypes\/\d+\/html\?download=1/.test(a.attrs.href || '')), '应有下载链接');
assert.ok(links.some((a) => /^\/proto\/8\/\d+$/.test(a.attrs.href || '')), '应有全屏链接');
console.log('✓ 原型面板：生成、进度、预览、消息、修改、重试与 PRD 更新');

// 6.2 追问：发送时按钮立即禁用；进行中显示思考中；完成后显示回答
replyInput().value = '草稿';
await replyInput().fire('input');
await ctx.openReview(8);
await tick();
assert.equal(replyInput().value, '草稿', '刷新后保留追问草稿');
replyInput().value = '为什么';
await replyInput().fire('input');
await reply().fire('submit');
await tick();
assert.equal(disabledAtPost, true, '发送请求时按钮应已禁用');
assert.deepEqual(calls.filter((c) => c.url === '/api/pm/reviews/8/messages').at(-1).body, { text: '为什么', mode: 'auto' });
assert.match(threadText(), /思考中/);
assert.equal(replyInput().disabled, true, '进行中输入框应禁用');
assert.equal(replyInput().value, '', '发送后清空输入');
Object.assign(R8.messages.at(-1), { status: 'done', content: '这是解释' });
await ctx.openReview(8);
await tick();
assert.match(threadText(), /为什么[\s\S]*这是解释/);
assert.equal(replyInput().disabled, false);
console.log('✓ 追问与回答');

// 6.3 改写：出现 v2 并自动切换，对话中出现版本事件
replyInput().value = '改定价';
await replyInput().fire('input');
const revise = walk(reply()).find((el) => el.tagName === 'INPUT' && el.attrs.type === 'checkbox');
revise.checked = true;
await reply().fire('submit');
await tick();
assert.equal(calls.filter((c) => c.url === '/api/pm/reviews/8/messages').at(-1).body.mode, 'revise');
Object.assign(R8.messages.at(-1), { status: 'done', kind: 'revise', content: '改了定价', version_n: 2 });
R8.latest = 2;
R8.versions.push({ n: 2, source: 'ai_revise', created_at: now, note: '改了定价' });
R8.content = '# V2 内容';
await ctx.openReview(8);
await tick();
assert.equal(verOpts().length, 2);
assert.equal(verSel().value, '2', 'v2 应自动选中');
assert.match(one(cls('ver-note'))?.textContent ?? '', /改了定价/, '显示本版说明');
assert.match(docText(), /V2 内容/);
assert.match(threadText(), /已生成 v2：改了定价/);
await tabBtn('对话').fire('click');
const goDoc = one((el) => el.tagName === 'BUTTON' && el.textContent === '查看文档');
assert.ok(goDoc, '版本事件应有「查看文档」');
await goDoc.fire('click');
await tick();
assert.equal(pane('doc').hidden, false, '点「查看文档」切到文档页');
assert.equal(verSel().value, '2');
console.log('✓ 改写生成 v2 并自动切换');

// 6.4 切换到 v1：只请求一次，之后走缓存
let v1Calls = 0;
routes['GET /api/pm/reviews/8/versions/1'] = () => (v1Calls++, { version: { n: 1, source: 'ai_initial', created_at: now, note: null, content: '# V1 内容' } });
await pickVer(1);
assert.match(docText(), /V1 内容/);
await pickVer(2);
assert.match(docText(), /V2 内容/);
await pickVer(1);
assert.equal(v1Calls, 1, '第二次切换应命中缓存');
console.log('✓ 版本切换与缓存');

// 6.5 编辑：以 v1 为底稿；409 显示冲突提示；201 后出现 v3
await btnText('编辑').fire('click');
assert.match(confirms.at(-1) ?? '', /将以 v1 为底稿生成 v3/);
const editor = () => walk(one(cls('pm-doc'))).find((el) => el.tagName === 'TEXTAREA');
assert.equal(editor().value, '# V1 内容');
editor().value = '# 手改';
let saveStatus = 409;
routes['POST /api/pm/reviews/8/versions'] = (body) => {
  if (saveStatus === 409) return { __status: 409, data: { error: '已有更新的 v3' } };
  assert.deepEqual(body, { content: '# 手改', baseN: 2 });
  R8.latest = 3;
  R8.versions.push({ n: 3, source: 'manual', created_at: now, note: null });
  R8.content = '# 手改';
  return { __status: 201, data: { n: 3 } };
};
await btnText('保存为新版本').fire('click');
await tick();
assert.match(docText(), /已有更新的/);
assert.ok(btnText('查看最新'), '应提供「查看最新」');
assert.equal(editor().value, '# 手改', '冲突后保留编辑内容');
saveStatus = 201;
await btnText('保存为新版本').fire('click');
await tick();
assert.equal(verOpts().length, 3);
assert.equal(verSel().value, '3');
assert.match(docText(), /手改/);
assert.ok(!editor(), '保存后退出编辑');
console.log('✓ 手动编辑：冲突提示与保存为 v3');

// 6.5b 版本对比：保存后提示、对比上一版、折叠、字符级高亮、任选两版、缓存、对话入口、退出
{
  const same = (n, tag) => Array.from({ length: n }, (_, i) => ({ t: ' ', s: `${tag}${i + 1}` }));
  const D32 = { n: 3, base: 2, diff: { clipped: false, lines: [...same(10, '前文'), { t: '-', s: '定价：月费 99 元' }, { t: '+', s: '定价：年费 999 元' }, ...same(5, '后文')] }, stats: { add: 1, del: 1 } };
  const D31 = { n: 3, base: 1, diff: { clipped: false, lines: [{ t: '-', s: '# V1 内容' }, { t: '+', s: '# 手改' }] }, stats: { add: 1, del: 1 } };
  const D21 = { n: 2, base: 1, diff: { clipped: false, lines: [{ t: '-', s: '# V1 内容' }, { t: '+', s: '# V2 内容' }] }, stats: { add: 1, del: 1 } };
  let d3 = 0;
  routes['GET /api/pm/reviews/8/versions/3/diff'] = () => (d3++, calls.at(-1).url.endsWith('base=1') ? D31 : D32);
  routes['GET /api/pm/reviews/8/versions/2/diff'] = () => D21;
  const diffUrls = () => calls.filter((c) => /\/diff\?/.test(c.url)).map((c) => c.url);
  const saved = one(cls('pm-saved'));
  assert.match(saved?.textContent ?? '', /已保存为 v3/, '保存后有提示');
  assert.ok(walk(saved).some((el) => el.tagName === 'BUTTON' && el.textContent === '查看改动'), '保存提示带「查看改动」');
  await btnText('对比上一版').fire('click');
  await tick();
  assert.equal(diffUrls().at(-1), '/api/pm/reviews/8/versions/3/diff?base=2');
  assert.ok(!verSel(), '对比时不显示版本下拉');
  assert.ok(!btnText('编辑'), '对比时不能编辑');
  const box = () => one(cls('pm-diff'));
  assert.match(box().textContent, /新增 1 行 · 删除 1 行/);
  const rows = (c) => walk(box()).filter((el) => el.tagName === 'DIV' && cls(c)(el));
  assert.equal(rows('add').length, 1);
  assert.equal(rows('del').length, 1);
  assert.ok(walk(rows('add')[0]).some((el) => el.tagName === 'MARK'), '新增行有字符级高亮');
  assert.ok(walk(rows('del')[0]).some((el) => el.tagName === 'MARK'), '删除行有字符级高亮');
  assert.equal(rows('same').length, 4, '只看改动：改动前后各留 2 行');
  const folds = () => walk(box()).filter((el) => el.tagName === 'BUTTON' && /行未改动/.test(el.textContent));
  assert.deepEqual(folds().map((b) => b.textContent.match(/(\d+) 行未改动/)[1]), ['8', '3']);
  await folds()[0].fire('click');
  assert.equal(rows('same').length, 12, '展开一段后多出 8 行');
  assert.equal(folds().length, 1);
  await btnText('显示全文').fire('click');
  assert.equal(rows('same').length, 15);
  assert.equal(folds().length, 0);
  await btnText('只看改动').fire('click');
  assert.equal(folds().length >= 1, true);
  const sel = (label) => walk(box()).find((el) => el.tagName === 'SELECT' && el.attrs['aria-label'] === label);
  assert.deepEqual(sel('对比的旧版本').children.map((o) => o.attrs.value), ['2', '1']);
  sel('对比的旧版本').value = '1';
  await sel('对比的旧版本').fire('change');
  await tick();
  assert.equal(diffUrls().at(-1), '/api/pm/reviews/8/versions/3/diff?base=1');
  assert.match(box().textContent, /# 手改/);
  sel('对比的旧版本').value = '2';
  await sel('对比的旧版本').fire('change');
  await tick();
  assert.equal(d3, 2, '同一组对比命中缓存');
  await btnText('退出对比').fire('click');
  assert.ok(!box(), '退出后不显示对比');
  assert.equal(verSel().value, '3');
  assert.match(docText(), /手改/);
  await tabBtn('对话').fire('click');
  const see = one((el) => el.tagName === 'BUTTON' && el.textContent === '查看改动' && cls('pm-event')(el.parentNode));
  assert.ok(see, '对话里的版本事件有「查看改动」');
  await see.fire('click');
  await tick();
  assert.equal(pane('doc').hidden, false, '切到文档页');
  assert.equal(diffUrls().at(-1), '/api/pm/reviews/8/versions/2/diff?base=1');
  assert.match(box().textContent, /V2 内容/);
  await btnText('退出对比').fire('click');
  await pickVer(1);
  assert.ok(!btnText('对比上一版'), 'v1 没有「对比上一版」');
  await pickVer(3);
}
console.log('✓ 版本对比：保存提示、上一版、折叠、字符高亮、任选两版、缓存、对话入口');




// 6.6 下载与打印链接
const link = (t) => one((el) => el.tagName === 'A' && el.textContent === t);
assert.equal(link('下载 .md').attrs.href, '/api/pm/reviews/8/versions/3/download');
assert.equal(link('打印 / PDF').attrs.href, '/print/pm/8/3');
assert.equal(link('打印 / PDF').attrs.target, '_blank');
assert.match(link('打印 / PDF').attrs.rel, /noopener/);
console.log('✓ 下载与打印链接');

// 6.7 失败的会话：没有版本栏和输入区
routes['GET /api/pm/reviews/9'] = { review: { ...structuredClone(R8), id: 9, status: 'error', error: '模型超时', latest: 0, versions: [], messages: [], content: null } };
await ctx.openReview(9);
await tick();
assert.ok(!verSel(), '失败会话没有版本下拉');
assert.ok(!reply(), '失败会话不显示输入区');
assert.match($('pm-result').textContent, /模型超时/);
console.log('✓ 失败会话不显示版本栏与输入区');

// 6.8 竞态：A 的响应晚于 B 返回时被丢弃
let releaseA;
routes['GET /api/pm/reviews/10'] = () => new Promise((r) => (releaseA = () => r({ review: { ...structuredClone(R8), id: 10, input: 'R10 的需求', content: '# R10 文档' } })));
const pA = ctx.openReview(10);
await tick();
await ctx.openReview(8);
await tick();
releaseA();
await pA;
await tick();
assert.ok(!/R10/.test($('pm-result').textContent), '迟到的 A 响应不应覆盖 B');
assert.match(docText(), /手改/);
console.log('✓ 切换会话时丢弃迟到响应');

// ---------------- 记忆与上下文 ----------------
const find = (root, pred) => walk(root).filter(pred);
const byText = (root, tag, t) => find(root, (el) => el.tagName === tag && el.textContent === t);

// 7.1 雷达条目「与你相关」标签与筛选
const ITEM = (id, rel, zh) => ({ id, url: `https://a.com/${id}`, title: `T${id}`, title_zh: `标题${id}`, summary_zh: '摘要', analysis: [], topics: ['llm'], importance: 4, relevance: rel, relevance_zh: zh, lang: 'en', published_at: now, source_name: 'S', starred: false, analyzed: true, analysis_error: null });
routes['GET /api/items'] = () => ({ items: [ITEM(1, 3, '和你的合同审查工具直接相关'), ITEM(2, 1, '有点关系'), ITEM(3, null, null)] });
await goIntel('动态');
await ctx.loadItems();
await tick();
const rels = find($('list'), cls('rel'));
assert.equal(rels.length, 1, '只有 relevance ≥2 的条目有 .rel 标签');
assert.equal(rels[0].attrs.title, '和你的合同审查工具直接相关');
assert.equal(rels[0].textContent, '与你相关');
assert.ok($('rel'), '筛选栏应有「与我相关」复选框');
$('rel').checked = true;
await $('rel').fire('change');
await tick();
assert.match(calls.filter((c) => c.url.startsWith('/api/items?')).at(-1).url, /rel=1/);
$('rel').checked = false;
console.log('✓ 与你相关标签与筛选');

// 7.1b 同一事件并成一条：「另有 N 个来源」折叠 / 展开，来源与标题按文本显示
routes['GET /api/items'] = () => ({ items: [{ ...ITEM(1, null, null), also: [{ id: 5, url: 'https://b.com/5', title: '<img src=x onerror=alert(1)>', source_name: 'TechCrunch AI', published_at: now }, { id: 6, url: 'javascript:alert(1)', title: '坏链接', source_name: 'X', published_at: now }] }, ITEM(2, null, null)] });
await ctx.loadItems();
await tick();
const alsoToggle = () => find($('list'), cls('also-toggle'));
for (const li of find($('list'), cls('item'))) assert.ok(li.children.every((c) => c != null), '条目里不能混进 null（真实 DOM 会把它显示成文字 null）');
assert.equal(alsoToggle().length, 1, '只有带其他来源的条目显示「另有」');
assert.match(alsoToggle()[0].textContent, /另有 2 个来源/);
assert.equal(find($('list'), cls('also-list')).length, 0, '默认折叠');
await alsoToggle()[0].fire('click');
const alsoLinks = find($('list'), cls('also-list'));
assert.equal(alsoLinks.length, 1, '点击后展开');
assert.ok(find(alsoLinks[0], (el) => el.tagName === 'A' && el.attrs.href === 'https://b.com/5' && el.textContent === '<img src=x onerror=alert(1)>'), '标题按文本，链接可点');
assert.ok(!find(alsoLinks[0], (el) => el.attrs?.href?.startsWith('javascript')).length, '不生成 javascript: 链接');
assert.ok(!find($('list'), (el) => el.tagName === 'IMG').length);
await alsoToggle()[0].fire('click');
assert.equal(find($('list'), cls('also-list')).length, 0, '再点收起');
console.log('✓ 同一事件的其他来源折叠展示');

// 7.1c 清理情报：全部 / 日期区间，先预览再确认，保留收藏的
routes['GET /api/items'] = () => ({ items: [ITEM(1, null, null)] });
routes['GET /api/status'] = { state: { running: false }, stats: { today: 5, pending: 0 } };
let purgeReply = (b) => (b.dryRun ? { matched: 4, deleted: 3, keptStarred: 1, keptInKb: 0 } : { matched: 4, deleted: 3, keptStarred: 1, keptInKb: 0 });
routes['POST /api/items/purge'] = (b) => purgeReply(b);
const purgeCalls = () => calls.filter((c) => c.url === '/api/items/purge');
assert.ok($('purge-box').hidden, '默认不显示清理面板');
await $('purge-open').fire('click');
assert.ok(!$('purge-box').hidden, '点「清理…」展开面板');
const pEls = () => walk($('purge-box'));
const dates = () => pEls().filter((el) => el.tagName === 'INPUT' && el.attrs.type === 'date');
const radios = () => pEls().filter((el) => el.tagName === 'INPUT' && el.attrs.type === 'radio');
assert.equal(dates().length, 2);
assert.match($('purge-box').textContent, /已收藏的、已存入知识库的条目会保留/);
const pBtn = (t) => pEls().find((el) => el.tagName === 'BUTTON' && el.textContent === t);
// 日期区间：先 dryRun，再确认，再真正删除
dates()[0].value = '2026-11-01';
dates()[1].value = '2026-11-03';
const nConf0 = confirms.length;
await pBtn('删除').fire('click');
await tick();
const pc = purgeCalls();
assert.equal(pc.length, 2, '先预览再删除');
assert.deepEqual(pc[0].body, { from: new Date('2026-11-01T00:00:00').getTime(), to: new Date('2026-11-03T23:59:59.999').getTime(), dryRun: true });
assert.deepEqual(pc[1].body, { from: pc[0].body.from, to: pc[0].body.to });
assert.match(confirms[nConf0], /2026-11-01 至 2026-11-03.*共 3 条.*无法恢复.*1 条已收藏的会保留.*不会再被重新采集/s, '确认文案带数量与保留说明');
assert.match($('toast').textContent, /已删除 3 条，保留 1 条已收藏/);
assert.ok($('purge-box').hidden, '完成后收起面板');
// 取消确认：不发出真正的删除
await $('purge-open').fire('click');
const pcBefore = purgeCalls().length;
ctx.confirm = (m) => (confirms.push(m), false);
await pBtn('删除').fire('click');
await tick();
ctx.confirm = (m) => (confirms.push(m), true);
assert.equal(purgeCalls().length, pcBefore + 1, '取消后只有预览请求');
assert.equal(purgeCalls().at(-1).body.dryRun, true);
// 全部：不带日期
radios()[0].checked = true;
radios()[1].checked = false;
await radios()[0].fire('change');
assert.ok(dates().every((d) => d.disabled), '选「全部」时日期框禁用');
const n1 = purgeCalls().length;
await pBtn('删除').fire('click');
await tick();
assert.deepEqual(purgeCalls()[n1].body, { all: true, dryRun: true });
assert.deepEqual(purgeCalls()[n1 + 1].body, { all: true });
// 范围内没有可删的
await $('purge-open').fire('click');
purgeReply = () => ({ matched: 2, deleted: 0, keptStarred: 2, keptInKb: 0 });
const n2 = purgeCalls().length;
await pBtn('删除').fire('click');
await tick();
assert.equal(purgeCalls().length, n2 + 1, '没有可删的只预览');
assert.match($('toast').textContent, /都是已收藏或已在知识库里的/);
// 日期不完整
radios()[1].checked = true;
radios()[0].checked = false;
await radios()[1].fire('change');
dates()[0].value = '';
const n3 = purgeCalls().length;
await pBtn('删除').fire('click');
assert.equal(purgeCalls().length, n3, '日期没填完不发请求');
dates()[0].value = '2026-11-05';
dates()[1].value = '2026-11-01';
await pBtn('删除').fire('click');
assert.equal(purgeCalls().length, n3, '开始晚于结束不发请求');
assert.match($('toast').textContent, /开始日期不能晚于结束日期/);
$('purge-box').hidden = true;
console.log('✓ 清理情报：区间 / 全部、预览、确认、保留说明');

// 7.1d 重新生成今日：先预览，确认后才真正开始
let regenReply = (b) => (b.dryRun ? { matched: 5, deleted: 4, keptStarred: 1, keptInKb: 0, sources: 30 } : { message: '已开始重新生成，请稍候' });
routes['POST /api/regenerate'] = (b) => regenReply(b);
const regenCalls = () => calls.filter((c) => c.url === '/api/regenerate');
const nr0 = regenCalls().length;
const nConfR = confirms.length;
await $('regen-open').fire('click');
await tick();
const rc = regenCalls().slice(nr0);
assert.equal(rc.length, 2, '先预览再开始');
const todayD = new Date();
assert.equal(rc[0].body.dryRun, true);
assert.equal(rc[0].body.from, new Date(todayD.getFullYear(), todayD.getMonth(), todayD.getDate()).getTime(), '范围是本地今天 0 点');
assert.equal(rc[0].body.to, new Date(todayD.getFullYear(), todayD.getMonth(), todayD.getDate(), 23, 59, 59, 999).getTime());
assert.deepEqual(rc[1].body, { from: rc[0].body.from, to: rc[0].body.to });
assert.match(confirms[nConfR], /删除今天发布的 4 条.*1 条已收藏的保留.*全部 30 个信息源.*忽略缓存.*更新今日简报.*无法恢复/s);
// 取消：只有预览
ctx.confirm = (m) => (confirms.push(m), false);
const nr1 = regenCalls().length;
await $('regen-open').fire('click');
await tick();
ctx.confirm = (m) => (confirms.push(m), true);
assert.equal(regenCalls().length, nr1 + 1, '取消后不开始');
// 今天没有可删的：仍可重新获取
regenReply = (b) => (b.dryRun ? { matched: 0, deleted: 0, keptStarred: 0, keptInKb: 0, sources: 30 } : { message: 'ok' });
const nConfR2 = confirms.length;
await $('regen-open').fire('click');
await tick();
assert.match(confirms[nConfR2], /今天暂无可删除的条目/);
// 服务端拒绝（已有任务）：给出提示、不抛错
regenReply = (b) => {
  if (b.dryRun) return { matched: 0, deleted: 0, keptStarred: 0, keptInKb: 0, sources: 30 };
  throw new Error('已有任务在运行，请稍后再试');
};
await $('regen-open').fire('click');
await tick();
assert.match($('toast').textContent, /已有任务在运行/);
console.log('✓ 重新生成今日：预览、确认、取消、无可删、被拒绝');

// 7.2 产品顾问：参考了 N 条记忆、M 次历史讨论
routes['GET /api/pm/reviews/12'] = () => ({
  review: {
    ...structuredClone(R8), id: 12,
    context: { memories: [{ id: 1, kind: 'fact', content: '在做律所合同审查工具' }], reviews: [{ id: 8, input: '一个足够长的点子描述' }], skills: [{ id: 5, name: '周报起草与整理流程' }] },
    messages: [
      { id: 90, role: 'user', kind: 'ask', content: '定价？', status: 'done', version_n: null, error: null, created_at: now, context: null },
      { id: 91, role: 'assistant', kind: 'ask', content: '按席位', status: 'done', version_n: null, error: null, created_at: now, context: { memories: [], reviews: [{ id: 8, input: 'x' }] } },
    ],
  },
});
await ctx.openReview(12);
await tick();
const ctxEls = all(cls('pm-ctx'));
assert.equal(ctxEls.length, 2, '版本栏上方与 assistant 消息各一处');
assert.equal(ctxEls[0].tagName, 'DETAILS');
assert.match(ctxEls[0].textContent, /参考了 1 条记忆、1 次历史讨论/);
assert.match(ctxEls[0].textContent, /在做律所合同审查工具/);
assert.match(ctxEls[0].textContent, /、1 个技能/);
assert.match(ctxEls[0].textContent, /技能：周报起草与整理流程/);
assert.doesNotMatch(ctxEls[1].textContent, /技能/, '没有技能时不显示技能');
assert.match(ctxEls[1].textContent, /参考了 0 条记忆、1 次历史讨论/);
const top = pane('doc').children;
assert.ok(top.indexOf(ctxEls[0]) >= 0 && top.indexOf(ctxEls[0]) < top.findIndex(cls('pm-versions')), '摘要在版本栏上方');
const jump = find(ctxEls[0], (el) => el.tagName === 'BUTTON' && /一个足够长的点子描述/.test(el.textContent))[0];
assert.ok(jump, '历史会话可点击');
await jump.fire('click');
await tick();
assert.equal(calls.at(-1).url.startsWith('/api/pm/reviews'), true);
console.log('✓ 产品顾问显示参考记忆与历史讨论');

// 7.3 我的记忆
const MEM = {
  profile: { content: '## 背景\n独立开发者', updated_at: now, manual: false },
  memories: [
    { id: 1, kind: 'fact', content: '在做律所合同审查工具', manual: true, created_at: now, updated_at: now, hits: 2, last_used_at: now },
    { id: 2, kind: 'decision', content: '先做律所市场', manual: false, created_at: now, updated_at: now, hits: 0, last_used_at: null },
  ],
  changes: [
    { id: 11, at: now, op: 'add', memory_id: 2, kind: 'decision', before: null, after: { kind: 'decision', content: '先做律所市场', manual: false }, reason: '用户多次提到', source: 'auto', events: ['评审：律所合同审查'], undone_at: null, undoable: true },
    { id: 10, at: now, op: 'update', memory_id: 1, kind: 'fact', before: { kind: 'fact', content: '旧内容', manual: false }, after: { kind: 'fact', content: '在做律所合同审查工具', manual: true }, reason: null, source: 'manual', events: [], undone_at: null, undoable: false },
  ],
  pending: 3, running: false, llm: true,
};
routes['GET /api/memory'] = () => structuredClone(MEM);
for (const k of ['PUT /api/memory/profile', 'DELETE /api/memory/items/1', 'POST /api/memory/changes/11/undo', 'DELETE /api/memory']) routes[k] = { ok: true };
routes['POST /api/memory/items'] = { __status: 201, data: { id: 3 } };
routes['POST /api/memory/consolidate'] = { __status: 202, data: { started: true } };
const memTab = tabs.find((t) => t.dataset.view === 'memory');
assert.ok(memTab, '应有「我的记忆」标签');
await memTab.fire('click');
await tick();
assert.equal($('view-memory').hidden, false);
assert.equal($('view-feed').hidden, true);
assert.match($('mem-pending').textContent, /还有 3 条交互待整理/);
assert.match($('mem-profile').textContent, /独立开发者/);
const groups = () => find($('mem-items'), cls('mem-group'));
assert.deepEqual(groups().map((g) => g.attrs['data-kind']), ['fact', 'preference', 'decision', 'interest']);
assert.match(groups()[0].textContent, /事实[\s\S]*在做律所合同审查工具[\s\S]*手动/);
assert.match(groups()[2].textContent, /决定[\s\S]*先做律所市场/);
assert.match($('mem-changes').textContent, /用户多次提到/);
assert.match($('mem-changes').textContent, /评审：律所合同审查/);
assert.match($('mem-changes').textContent, /旧内容[\s\S]*在做律所合同审查工具/);
assert.equal(byText($('mem-changes'), 'BUTTON', '撤销').length, 1, 'undoable:false 的变化没有撤销按钮');
console.log('✓ 我的记忆：画像、四类分组、最近变化、待整理数');

// 编辑画像
await byText($('mem-profile'), 'BUTTON', '编辑')[0].fire('click');
const pta = find($('mem-profile'), (el) => el.tagName === 'TEXTAREA')[0];
assert.equal(pta.value, '## 背景\n独立开发者');
pta.value = '新画像';
await byText($('mem-profile'), 'BUTTON', '保存')[0].fire('click');
await tick();
assert.deepEqual(calls.filter((c) => c.method === 'PUT' && c.url === '/api/memory/profile').at(-1).body, { content: '新画像' });
// 添加
await byText(groups()[1], 'BUTTON', '添加')[0].fire('click');
const addIn = find(groups()[1], (el) => el.tagName === 'INPUT')[0];
addIn.value = '喜欢简洁的回答';
await byText(groups()[1], 'BUTTON', '保存')[0].fire('click');
await tick();
assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/memory/items').at(-1).body, { kind: 'preference', content: '喜欢简洁的回答' });
// 删除
await byText(groups()[0], 'BUTTON', '删除')[0].fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/api/memory/items/1'));
// 撤销
await byText($('mem-changes'), 'BUTTON', '撤销')[0].fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/memory/changes/11/undo'));
console.log('✓ 编辑画像、添加、删除、撤销');

// 清空：prompt 不是「清空」不发请求
promptAnswer = '算了';
await $('mem-clear').fire('click');
await tick();
assert.ok(!calls.some((c) => c.method === 'DELETE' && c.url === '/api/memory'));
promptAnswer = '清空';
await $('mem-clear').fire('click');
await tick();
assert.deepEqual(calls.filter((c) => c.method === 'DELETE' && c.url === '/api/memory').at(-1).body, { confirm: '清空' });
await $('mem-run').fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/memory/consolidate'));
assert.equal($('mem-export').attrs.href, '/api/memory/export');
console.log('✓ 清空需输入「清空」、立即整理、导出');

// 整理进行中轮询时，不重建正在编辑的画像和条目输入框
MEM.running = true;
await ctx.loadMemory();
await byText($('mem-profile'), 'BUTTON', '编辑')[0].fire('click');
{ const t = find($('mem-profile'), (el) => el.tagName === 'TEXTAREA')[0]; t.value = '编辑到一半'; await t.fire('input'); }
await byText(groups()[3], 'BUTTON', '添加')[0].fire('click');
{ const t = find(groups()[3], (el) => el.tagName === 'INPUT')[0]; t.value = '半句话'; await t.fire('input'); }
MEM.pending = 7;
await ctx.loadMemory(true);
assert.equal(find($('mem-profile'), (el) => el.tagName === 'TEXTAREA')[0].value, '编辑到一半');
assert.equal(find(groups()[3], (el) => el.tagName === 'INPUT')[0].value, '半句话');
assert.match($('mem-pending').textContent, /正在整理/);
console.log('✓ 轮询不打断正在编辑的内容');

// 7.4 我的记忆 · 技能
MEM.running = false;
MEM.skills = { total: 3, active: 1, candidate: 1, retired: 1, pending: 1 };
MEM.profileVersions = 2;
const SKD = (id, status, extra = {}) => ({
  id, name: `周报起草流程第${id}号`, scene: '每周五需要把本周进展整理成周报发给团队和投资人时', steps: ['先列本周完成的三件事', '再写下周计划'], cautions: ['数字要和看板一致'],
  example: '', source: 'auto', status, manual: false, pending: null, uses: 0, hits: 0, last_used_at: null, created_at: now, updated_at: now, rev: 2, revisions: 2, ...extra,
});
const SKL = {
  skills: [SKD(1, 'active', { uses: 3, example: '本周：上线导出' }), SKD(2, 'candidate', { manual: true, source: 'auto', pending: { name: 'x', scene: 'y', steps: ['a', 'b'], cautions: [], example: '' } }), SKD(3, 'retired', { source: 'manual', manual: true })],
  runs: [], enabled: true, blocker: null, running: false, last: null,
};
const DIFF = { diff: { lines: [{ t: ' ', s: '名称：周报' }, { t: '-', s: '1. 旧步骤' }, { t: '+', s: '1. 新步骤' }], clipped: false } };
routes['GET /api/memory/skills'] = () => structuredClone(SKL);
for (const id of [1, 2, 3]) routes[`POST /api/memory/skills/${id}/status`] = { skill: {} };
routes['GET /api/memory/skills/2/pending/diff'] = DIFF;
routes['POST /api/memory/skills/2/accept'] = { skill: {} };
routes['DELETE /api/memory/skills/2/pending'] = { ok: true };
routes['PUT /api/memory/skills/1'] = { skill: {} };
routes['POST /api/memory/skills'] = { __status: 201, data: { id: 9 } };
routes['DELETE /api/memory/skills/3'] = { ok: true };
routes['GET /api/memory/skills/1/revisions'] = { revisions: [{ rev: 2, origin: 'manual', reason: '手动编辑', created_at: now, skill: {} }, { rev: 1, origin: 'auto', reason: '沉淀', created_at: now, skill: {} }] };
routes['GET /api/memory/skills/1/revisions/1/diff'] = DIFF;
routes['POST /api/memory/skills/1/restore'] = { skill: {} };
let crystalResp = { __status: 202, data: { started: true } };
routes['POST /api/memory/skills/crystallize'] = () => crystalResp;
const skBody = () => $('mem-skills');
const memTabBtns = () => find($('mem-tabs'), (el) => el.tagName === 'BUTTON');
const skCard = (id) => find(skBody(), (el) => cls('sk-card')(el) && el.attrs['data-id'] === String(id))[0];
const skBtn = (id, t) => byText(skCard(id), 'BUTTON', t)[0];
const lastCall = (method, url) => calls.filter((c) => c.method === method && c.url === url).at(-1);
await ctx.loadMemory();
assert.deepEqual(memTabBtns().map((b) => b.textContent), ['记忆', '技能2'], '技能标签带待处理数（候选 + 新版）');
assert.equal($('mem-main').hidden, false);
assert.equal($('mem-skills').hidden, true);
await memTabBtns()[1].fire('click');
await tick();
assert.equal($('mem-main').hidden, true);
assert.equal($('mem-skills').hidden, false);
assert.ok(lastCall('GET', '/api/memory/skills'), '切到技能标签时加载技能');
assert.deepEqual(find(skBody(), cls('sk-group')).map((g) => g.attrs['data-status']), ['active', 'candidate', 'retired'], '按启用 / 候选 / 停用分组');
assert.match(skCard(1).textContent, /何时用：每周五/);
assert.match(skCard(1).textContent, /参考 3 次/);
assert.deepEqual(find(skCard(1), (el) => el.tagName === 'OL' && cls('sk-steps')(el))[0].children.map((c) => c.textContent), ['先列本周完成的三件事', '再写下周计划']);
assert.match(skCard(1).textContent, /示例/);
assert.match(skCard(2).textContent, /手改过/);
assert.match(skCard(3).textContent, /手写/);
assert.ok(skBtn(2, '采纳') && !skBtn(1, '采纳') && skBtn(1, '停用') && skBtn(3, '重新启用'), '按状态给出采纳 / 停用 / 重新启用');
await skBtn(2, '采纳').fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/skills/2/status').body, { status: 'active' });
await skBtn(1, '停用').fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/skills/1/status').body, { status: 'retired' });
await skBtn(3, '重新启用').fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/skills/3/status').body, { status: 'active' });
console.log('✓ 技能标签：分组、卡片、采纳 / 停用 / 重新启用');

// 有新版可参考：对比、采用、忽略
assert.match(skCard(2).textContent, /有新版可参考/);
assert.ok(!find(skCard(1), cls('sk-pending')).length, '没有新版的不显示');
await skBtn(2, '对比').fire('click');
await tick();
assert.ok(lastCall('GET', '/api/memory/skills/2/pending/diff'));
assert.ok(find(skCard(2), cls('wiki-diff')).length, '展开后显示差异');
assert.match(skCard(2).textContent, /新步骤/);
await skBtn(2, '采用新版').fire('click');
await tick();
assert.ok(lastCall('POST', '/api/memory/skills/2/accept'));
await skBtn(2, '忽略').fire('click');
await tick();
assert.ok(lastCall('DELETE', '/api/memory/skills/2/pending'));
console.log('✓ 有新版可参考：对比、采用、忽略');

// 编辑：前端先拦下明显不合规的输入；步骤可增删；保存为 PUT
await skBtn(1, '编辑').fire('click');
const skForm = () => find(skBody(), cls('sk-form'))[0];
const formInputs = () => find(skForm(), (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
assert.equal(formInputs()[0].value, '周报起草流程第1号');
const typeIn = async (el, v) => { el.value = v; await el.fire('input'); };
await typeIn(formInputs()[0], '短');
const putsBefore = calls.filter((c) => c.method === 'PUT' && c.url === '/api/memory/skills/1').length;
await byText(skForm(), 'BUTTON', '保存')[0].fire('click');
await tick();
assert.match($('toast').textContent, /名称需在 8–40 字之间/);
assert.equal(calls.filter((c) => c.method === 'PUT' && c.url === '/api/memory/skills/1').length, putsBefore, '不合规不发请求');
await typeIn(formInputs()[0], '周报起草与整理流程');
await byText(skForm(), 'BUTTON', '添加步骤')[0].fire('click');
await typeIn(find(skForm(), (el) => el.tagName === 'INPUT' && el.attrs['aria-label'] === '步骤 3')[0], '最后核对数字再发送');
await byText(skForm(), 'BUTTON', '添加注意事项')[0].fire('click');
await byText(skForm(), 'BUTTON', '删除').find((b) => b.attrs['aria-label'] === '删除注意事项 1').fire('click');
assert.equal(find(skForm(), (el) => el.tagName === 'INPUT' && el.attrs['aria-label'] === '步骤 3')[0].value, '最后核对数字再发送', '增删后草稿保留');
await byText(skForm(), 'BUTTON', '保存')[0].fire('click');
await tick();
assert.deepEqual(lastCall('PUT', '/api/memory/skills/1').body, {
  name: '周报起草与整理流程', scene: '每周五需要把本周进展整理成周报发给团队和投资人时', steps: ['先列本周完成的三件事', '再写下周计划', '最后核对数字再发送'], cautions: [], example: '本周：上线导出',
});
assert.ok(!find(skBody(), cls('sk-form')).length, '保存后收起表单');
// 有未保存修改时切到别的技能、新建或看历史先确认；没改过的不问
await skBtn(1, '编辑').fire('click');
let cBefore = confirms.length;
await skBtn(3, '编辑').fire('click');
assert.equal(confirms.length, cBefore, '没改过的草稿直接切换');
await typeIn(formInputs()[0], '改了一半的技能名称');
await byText(skBody(), 'BUTTON', '新建技能')[0].fire('click');
assert.equal(confirms.length, cBefore + 1);
assert.match(confirms.at(-1), /还没保存/);
await byText(skForm(), 'BUTTON', '取消')[0].fire('click');
// 新建
await byText(skBody(), 'BUTTON', '新建技能')[0].fire('click');
assert.match(skForm().textContent, /新建技能/);
const nf = formInputs();
await typeIn(nf[0], '投资人月报撰写流程');
await typeIn(nf[1], '每月初需要给投资人发月度经营更新邮件的时候');
await typeIn(nf[2], '先列关键数字');
await typeIn(nf[3], '再写进展与求助');
await byText(skForm(), 'BUTTON', '保存')[0].fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/skills').body, { name: '投资人月报撰写流程', scene: '每月初需要给投资人发月度经营更新邮件的时候', steps: ['先列关键数字', '再写进展与求助'], cautions: [], example: '' });
assert.match($('toast').textContent, /已新建/);
console.log('✓ 技能编辑与新建：前端校验、步骤增删、保存');

// 历史：版本列表、差异、回退
await skBtn(1, '历史（2）').fire('click');
await tick();
assert.ok(lastCall('GET', '/api/memory/skills/1/revisions'));
assert.match(skCard(1).textContent, /v2 · 手动 · .* · 当前/);
await find(skCard(1), (el) => el.tagName === 'BUTTON' && /^v1 · 自动沉淀/.test(el.textContent))[0].fire('click');
await tick();
assert.ok(lastCall('GET', '/api/memory/skills/1/revisions/1/diff'));
assert.match(skCard(1).textContent, /v1 → 当前 v2/);
await byText(skCard(1), 'BUTTON', '回退到此版本')[0].fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/skills/1/restore').body, { rev: 1 });
// 删除需确认
const confirmsBefore = confirms.length;
await skBtn(3, '删除').fire('click');
await tick();
assert.equal(confirms.length, confirmsBefore + 1);
assert.ok(lastCall('DELETE', '/api/memory/skills/3'));
console.log('✓ 技能历史：差异、回退；删除先确认');

// 立即沉淀：运行中 / 结束提示 / 409 / 未配置模型
await byText(skBody(), 'BUTTON', '立即沉淀')[0].fire('click');
await tick();
assert.ok(lastCall('POST', '/api/memory/skills/crystallize'));
assert.match($('toast').textContent, /已开始沉淀/);
SKL.running = true;
await memTabBtns()[1].fire('click');
await tick();
assert.ok(byText(skBody(), 'BUTTON', '正在沉淀…')[0].attrs.disabled != null, '运行中禁用');
SKL.running = false;
SKL.last = { at: now, run: { ran: true, added: 2, updated: 1, blocked: 0, dropped: 0 } };
await memTabBtns()[1].fire('click');
await tick();
assert.match($('toast').textContent, /沉淀完成：新增 2 个候选，更新 1 个/);
crystalResp = { __status: 409, data: { error: '没有新事件' } };
await byText(skBody(), 'BUTTON', '立即沉淀')[0].fire('click');
await tick();
assert.match($('toast').textContent, /没有新事件/);
SKL.enabled = false;
SKL.blocker = '未配置模型';
await memTabBtns()[1].fire('click');
await tick();
assert.ok(byText(skBody(), 'BUTTON', '立即沉淀')[0].attrs.disabled != null, '未配置模型时禁用');
assert.match(skBody().textContent, /暂不能沉淀：未配置模型/);
SKL.skills = [];
await memTabBtns()[1].fire('click');
await tick();
assert.match(skBody().textContent, /还没有技能/);
console.log('✓ 立即沉淀：运行中禁用、结束提示、409 提示、未配置模型禁用；空状态');

// 画像历史：展开才加载、差异、回退后重新加载记忆
routes['GET /api/memory/profile/versions'] = { versions: [{ rev: 2, content: MEM.profile.content, origin: 'manual', reason: '手动编辑', event_ids: [], created_at: now }, { rev: 1, content: 'a', origin: 'auto', reason: '整理 3 条操作', event_ids: [1], created_at: now }] };
routes['GET /api/memory/profile/versions/1/diff'] = DIFF;
routes['POST /api/memory/profile/restore'] = { ok: true };
await memTabBtns()[0].fire('click');
await tick();
assert.equal($('mem-main').hidden, false);
assert.equal($('mem-skills').hidden, true);
const phBtn = () => find($('mem-profile-hist'), (el) => el.tagName === 'BUTTON');
assert.equal(phBtn()[0].textContent, '画像历史（2 版）');
assert.ok(!calls.some((c) => c.url === '/api/memory/profile/versions'), '收起时不加载');
await phBtn()[0].fire('click');
await tick();
assert.ok(lastCall('GET', '/api/memory/profile/versions'));
assert.match($('mem-profile-hist').textContent, /v2 · 手动 · .* · 当前/);
assert.match($('mem-profile-hist').textContent, /整理 3 条操作/);
await phBtn().find((b) => /^v1 · 自动整理/.test(b.textContent)).fire('click');
await tick();
assert.ok(lastCall('GET', '/api/memory/profile/versions/1/diff'));
assert.match($('mem-profile-hist').textContent, /新步骤/);
const memLoads = calls.filter((c) => c.url === '/api/memory').length;
await byText($('mem-profile-hist'), 'BUTTON', '回退到此版本')[0].fire('click');
await tick();
assert.deepEqual(lastCall('POST', '/api/memory/profile/restore').body, { rev: 1 });
assert.ok(calls.filter((c) => c.url === '/api/memory').length > memLoads, '回退后重新加载记忆');
assert.equal($('mem-export-zip').attrs.href, '/api/memory/export?format=zip');
const savedProfile = MEM.profile.content;
MEM.profile.content = '';
routes['GET /api/memory/profile/versions/2/diff'] = DIFF;
await ctx.loadMemory();
await tick();
assert.doesNotMatch($('mem-profile-hist').textContent, /· 当前/, '画像被清空后，最新一版不再标为当前');
await phBtn().find((b) => /^v2 · /.test(b.textContent)).fire('click');
await tick();
assert.ok(byText($('mem-profile-hist'), 'BUTTON', '回退到此版本').length, '可以回退到清空前的版本');
MEM.profile.content = savedProfile;
console.log('✓ 画像历史：展开加载、差异、回退；打包导出');
$('toast').hidden = true;

// ---------------- 附件 ----------------
let pollN = 0;
let lastName = '';
const ATT = (id, name, status, extra = {}) => ({ id, name, status, kind: 'doc', mime: 'text/plain', size: 10, error: null, truncated: false, chars: 5, ...extra });
routes['POST /api/pm/uploads'] = (_, o) => ((lastName = decodeURIComponent(o.headers['x-file-name'])), { __status: 202, data: { attachment: ATT(31, lastName, 'processing') } });
routes['GET /api/pm/uploads/31'] = () => ({ attachment: ATT(31, lastName, pollN++ === 0 ? 'processing' : 'ready') });
routes['DELETE /api/pm/uploads/31'] = { ok: true };
const uploads = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/pm/uploads');
const reviewPosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/pm/reviews');
const attBar = () => $('pm-att').children;
const fileIn = $('pm-att-file');
assert.ok(fileIn && $('pm-att-add') && $('pm-att'), '表单应有附件行');
const pick = async (input, files) => { input.files = files; await input.fire('change'); await tick(); };
$('toast').hidden = true;

// 8.1 上传：文件名编码进头；标签转义显示
await pick(fileIn, [new ctx.File(['x'], '<b>x</b>.txt')]);
assert.equal(uploads().at(-1).headers['x-file-name'], encodeURIComponent('<b>x</b>.txt'));
assert.equal(uploads().at(-1).headers['content-type'], 'application/octet-stream');
assert.equal(attBar().length, 1);
assert.match(attBar()[0].textContent, /<b>x<\/b>\.txt · 10 B · 处理中/);
assert.ok(!walk($('pm-att')).some((el) => el.tagName === 'B'), '文件名不能生成元素');
console.log('✓ 附件上传与转义显示');

// 8.2 处理中不能提交
$('pm-input').value = '一个足够长的点子描述';
let nPost = reviewPosts().length;
await $('pm-form').fire('submit');
await tick();
assert.equal(errs(), '附件处理中');
assert.equal(reviewPosts().length, nPost, '处理中不应提交');
$('toast').hidden = true;

// 8.3 轮询到就绪后提交，带 attachmentIds，成功后清空
await new Promise((r) => setTimeout(r, 1600));
assert.match(attBar()[0].textContent, /就绪/);
await $('pm-form').fire('submit');
await tick();
assert.deepEqual(reviewPosts().at(-1).body.attachmentIds, [31]);
assert.equal(attBar().length, 0, '提交成功后清空附件栏');
console.log('✓ 处理中拦截、就绪后提交并清空');

// 8.4 超过 10MB 不上传
let nUp = uploads().length;
await pick(fileIn, [new ctx.File([], 'big.pdf', { size: 11 * 1024 * 1024 })]);
assert.match(errs(), /big\.pdf 超过 10MB/);
assert.equal(uploads().length, nUp);
$('toast').hidden = true;
// 一次超过 8 个
await pick(fileIn, Array.from({ length: 9 }, (_, i) => new ctx.File(['x'], `f${i}.txt`)));
assert.equal(errs(), '一次最多 8 个附件');
assert.equal(uploads().length, nUp);
$('toast').hidden = true;

// 8.5 × 删除
await pick(fileIn, [new ctx.File(['x'], 'c.txt')]);
assert.match(attBar()[0].textContent, /就绪/);
const xBtn = walk($('pm-att')).find((el) => el.tagName === 'BUTTON' && el.attrs['aria-label'] === '移除 c.txt');
assert.ok(xBtn, '应有移除按钮');
await xBtn.fire('click');
await tick();
assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/api/pm/uploads/31'));
assert.equal(attBar().length, 0);
console.log('✓ 超限拦截与删除');

// 8.6 粘贴图片
const pev = await $('pm-input').fire('paste', { clipboardData: { files: [new ctx.File([], 'image.png', { type: 'image/png' })] } });
await tick();
assert.ok(pev.defaultPrevented);
assert.match(decodeURIComponent(uploads().at(-1).headers['x-file-name']), /^粘贴的图片-\d{6}\.png$/);
await walk($('pm-att')).find((el) => el.tagName === 'BUTTON' && /^移除 粘贴的图片/.test(el.attrs['aria-label'] ?? '')).fire('click');
await tick();
console.log('✓ 粘贴图片改名上传');

// 8.7 对话中的附件
const IMG = { id: 5, kind: 'image', name: 'a.png', size: 2048 };
routes['GET /api/pm/reviews/13'] = () => ({ review: { ...structuredClone(R8), id: 13, messages: [], attachments: [IMG, { id: 6, kind: 'doc', name: 'b.pdf', size: 3000000 }] } });
await ctx.openReview(13);
await tick();
const thumb = one((el) => el.tagName === 'IMG' && cls('att-thumb')(el));
assert.ok(thumb, '应渲染缩略图');
assert.equal(thumb.attrs.src, '/api/pm/uploads/5/file');
assert.equal(thumb.attrs.loading, 'lazy');
assert.equal(thumb.attrs.alt, 'a.png');
const thumbA = one((el) => el.tagName === 'A' && el.children.includes(thumb));
assert.equal(thumbA.attrs.target, '_blank');
assert.match(thumbA.attrs.rel, /noopener/);
const docA = one((el) => el.tagName === 'A' && cls('att-file')(el));
assert.equal(docA.textContent, 'b.pdf · 2.9 MB');
assert.equal(docA.attrs.href, '/api/pm/uploads/6/file');
assert.ok('download' in docA.attrs);
console.log('✓ 首版附件：缩略图与下载链接');

// 8.8 带附件的失败轮次不显示重试
routes['GET /api/pm/reviews/14'] = () => ({ review: { ...structuredClone(R8), id: 14, attachments: [], messages: [
  { id: 95, role: 'user', kind: 'ask', content: '看图', status: 'done', version_n: null, error: null, created_at: now, attachments: [IMG] },
  { id: 96, role: 'assistant', kind: 'ask', content: '', status: 'error', version_n: null, error: '模型拒收图片', created_at: now, attachments: [] },
] } });
await ctx.openReview(14);
await tick();
assert.ok(!btnText('重试'), '带附件的失败轮次不应显示重试');
assert.match(threadText(), /请重新上传附件后再发送/);
assert.ok(walk(one(cls('pm-thread'))).some((el) => el.tagName === 'IMG' && el.attrs.src === '/api/pm/uploads/5/file'), 'user 消息下方显示附件');
console.log('✓ 带附件的失败轮次提示重新上传');

// 8.9 追问区附件
await ctx.openReview(8);
await tick();
replyInput().value = '好';
await reply().fire('submit');
await tick();
assert.equal(errs(), '请至少输入 2 个字');
$('toast').hidden = true;
const rFile = walk(reply()).find((el) => el.tagName === 'INPUT' && el.attrs.type === 'file');
assert.ok(rFile, '追问区应有附件输入');
await pick(rFile, [new ctx.File(['x'], 'r.txt')]);
assert.match(reply().textContent, /r\.txt · 10 B · 就绪/);
assert.equal(replyBtn().disabled, false);
replyInput().value = '';
await reply().fire('submit');
await tick();
assert.deepEqual(calls.filter((c) => c.url === '/api/pm/reviews/8/messages').at(-1).body, { text: '', mode: 'auto', attachmentIds: [31] });
assert.ok(!/r\.txt/.test(reply().textContent), '发送成功后清空追问附件');
console.log('✓ 追问区附件：空文本可发送并清空');

// ---------------- 知识库 ----------------
const KB_DOC = (id, extra = {}) => ({ id, kind: 'note', title: `条目${id}`, status: 'ready', error: null, folder_id: null, path: '未归类', review_id: null, item_id: null, file_name: null, file_size: null, truncated: false, created_at: now, updated_at: now, ...extra });
routes['GET /api/kb/tree'] = { folders: [{ id: 5, parent_id: null, name: '产品', sort: 0, count: 2 }, { id: 6, parent_id: 5, name: '竞品', sort: 0, count: 1 }], unfiled: 3, total: 6 };
routes['GET /api/kb/docs'] = { docs: [KB_DOC(1), KB_DOC(2, { folder_id: 5, path: '产品' })] };
const kbDlg = () => $('kb-dialog');
routes['GET /api/wiki/status'] = { queued: 1, running: { opId: 9, kind: 'ingest', docId: 2, title: '条目2' }, usedToday: 12, limit: 200, enabled: true, lastLint: { opId: 30, at: now, issues: 2 }, docs: { 1: 'done', 2: 'running' } };
const dlgBtn = (t) => walk(kbDlg()).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
const kbTab = () => tabs.find((t) => t.dataset.view === 'kb');
$('toast').hidden = true;

// 9.1 知识库页：目录树与列表
assert.ok(kbTab(), '导航栏应有知识库');
assert.ok(tabs.indexOf(kbTab()) === tabs.findIndex((t) => t.dataset.view === 'intel') + 1, '知识库紧跟在情报之后');
await kbTab().fire('click');
await tick();
assert.equal($('view-kb').hidden, false, '知识库视图应显示');
assert.ok(calls.some((c) => c.url === '/api/kb/tree'), '请求目录树');
assert.ok(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/kb/docs')), '请求条目列表');
assert.match($('kb-tree').textContent, /未归类3/);
assert.match($('kb-tree').textContent, /产品2/);
assert.match($('kb-tree').textContent, /竞品1/);
assert.match($('kb-body').textContent, /条目1/);
assert.match($('kb-body').textContent, /已编入/, '条目显示 Wiki 状态');
assert.match($('kb-body').textContent, /编入中/);
assert.equal(errs(), '');
console.log('✓ 知识库页：目录树与条目列表');

// 9.2 雷达条目「存入知识库」：建议目录 → 确认 → POST；409 打开已有条目
routes['POST /api/kb/suggest'] = { path: '产品/竞品', folderId: 6, create: false, reason: '竞品资料' };
routes['POST /api/kb/docs'] = (b) => ({ __status: 201, data: { doc: KB_DOC(40, { kind: 'item', item_id: b.itemId, folder_id: b.folderId, path: '产品/竞品' }) } });
const detBtn = (it, t) => ctx.detailChildren(it, new El('div'), new El('li')).flatMap((e) => [e, ...walk(e)]).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
const save1 = detBtn({ ...ITEM(1, 3, 'x'), content: 'c' }, '存入知识库');
assert.ok(save1, '雷达条目详情应有「存入知识库」');
await tick();
assert.ok(calls.some((c) => c.url === '/api/kb/source?itemId=1'), '查询是否已入库');
save1.fire('click');
await tick();
assert.equal(kbDlg().hidden, false, '弹出入库弹窗');
assert.match(kbDlg().textContent, /产品\/竞品/);
assert.match(kbDlg().textContent, /竞品资料/);
await dlgBtn('确认').fire('click');
await tick();
const sug1 = calls.filter((c) => c.url === '/api/kb/suggest').at(-1);
const post1 = calls.filter((c) => c.method === 'POST' && c.url === '/api/kb/docs').at(-1);
assert.deepEqual(sug1.body, { itemId: 1 });
assert.deepEqual(post1.body, { kind: 'item', itemId: 1, folderId: 6 });
assert.ok(calls.indexOf(sug1) < calls.indexOf(post1), '先建议后入库');
assert.equal(kbDlg().hidden, true, '确认后关闭弹窗');
assert.equal(save1.textContent, '已在知识库');

routes['GET /api/kb/source'] = { docId: 40 };
const inKb = detBtn(ITEM(3, 1, 'x'), '存入知识库');
await tick();
assert.equal(inKb.textContent, '已在知识库', '已入库的来源显示「已在知识库」');
routes['GET /api/kb/source'] = { docId: null };

routes['POST /api/kb/docs'] = { __status: 409, data: { error: '已在知识库中', docId: 40 } };
routes['GET /api/kb/docs/40'] = { doc: KB_DOC(40, { kind: 'item', item_id: 2, title: '定价新闻' }), body: null, chunks: [{ ord: 0, heading: '摘要', body: '摘要内容' }, { ord: 1, heading: '正文', body: '正文内容' }] };
await goIntel('动态');
const save2 = detBtn(ITEM(2, 1, 'x'), '存入知识库');
save2.fire('click');
await tick();
await dlgBtn('确认').fire('click');
await tick();
assert.ok(calls.some((c) => c.url === '/api/kb/docs/40'), '409 时打开已有条目');
assert.equal($('view-kb').hidden, false);
assert.match($('kb-body').textContent, /摘要内容/);
assert.match($('kb-body').textContent, /定价新闻/);
console.log('✓ 存入知识库：建议目录、确认入库、409 打开已有条目');

// 9.3 「参考了」：知识库分组
const cn = ctx.contextNote({ memories: [{ id: 1, kind: 'fact', content: 'x' }], reviews: [], kb: [{ doc: 40, ord: 1, title: '竞品', heading: '定价', exists: true }, { doc: 41, ord: 2, title: '旧', heading: '', exists: false }] });
assert.equal(cn.children[0].textContent, '参考了 1 条记忆、0 次历史讨论、2 段知识库');
assert.match(cn.textContent, /知识库：竞品 › 定价/);
assert.match(cn.textContent, /知识库：旧（已删除）/);
assert.equal(ctx.contextNote({ memories: [{ id: 1, kind: 'fact', content: 'x' }], reviews: [], kb: [] }).children[0].textContent, '参考了 1 条记忆、0 次历史讨论');
assert.equal(ctx.contextNote({ memories: [{ id: 1, kind: 'fact', content: 'x' }], reviews: [] }).children[0].textContent, '参考了 1 条记忆、0 次历史讨论');
assert.ok(ctx.contextNote({ memories: [], reviews: [], kb: [{ doc: 40, ord: 0, title: 't', heading: '', exists: true }] }), '只有知识库引用时也显示');
await tabs.find((t) => t.dataset.view === 'pm').fire('click');
const n40 = calls.filter((c) => c.url === '/api/kb/docs/40').length;
await walk(cn).find((el) => el.tagName === 'BUTTON' && el.textContent === '知识库：竞品 › 定价').fire('click');
await tick();
assert.equal(calls.filter((c) => c.url === '/api/kb/docs/40').length, n40 + 1, '点击引用打开条目');
assert.equal($('view-kb').hidden, false);
assert.ok(!walk(cn).some((el) => el.tagName === 'BUTTON' && /旧/.test(el.textContent)), '已删除的引用不可点击');
console.log('✓ 参考了：知识库分组与跳转');

// 9.4 评审页「存入知识库」
await ctx.openReview(8);
await tick();
assert.ok(all((el) => el.tagName === 'BUTTON' && el.textContent === '存入知识库').length >= 1, '评审页应有「存入知识库」');
assert.ok(calls.some((c) => c.url === '/api/kb/source?reviewId=8'));
console.log('✓ 评审页存入知识库按钮');

// 9.5 上传：轮询到 ready 后弹出归类；放进未归类时不发 PATCH
let kbPoll = 0;
routes['POST /api/kb/uploads'] = (_, o) => ({ __status: 202, data: { doc: KB_DOC(50, { kind: 'upload', status: 'processing', title: decodeURIComponent(o.headers['x-file-name']) }) } });
routes['GET /api/kb/docs/50'] = () => ({ doc: KB_DOC(50, { kind: 'upload', status: kbPoll++ === 0 ? 'processing' : 'ready', title: '访谈' }), body: 'x', chunks: [] });
routes['POST /api/kb/suggest'] = { path: null, folderId: null, create: false, reason: '' };
routes['PATCH /api/kb/docs/50'] = { doc: KB_DOC(50) };
await kbTab().fire('click');
await tick();
await pick($('kb-file'), [new ctx.File(['x'], '访谈.txt')]);
const up = calls.filter((c) => c.url.startsWith('/api/kb/uploads')).at(-1);
assert.equal(up.headers['x-file-name'], encodeURIComponent('访谈.txt'));
assert.equal(up.headers['content-type'], 'application/octet-stream');
assert.equal(kbDlg().hidden, true, '处理中不弹窗');
await new Promise((r) => setTimeout(r, 4400));
assert.ok(kbPoll >= 2, `应轮询到 ready（${kbPoll}）`);
assert.equal(kbDlg().hidden, false, '就绪后弹出归类弹窗');
assert.deepEqual(calls.filter((c) => c.url === '/api/kb/suggest').at(-1).body, { docId: 50 });
await dlgBtn('放进未归类').fire('click');
await tick();
assert.equal(kbDlg().hidden, true);
assert.ok(!calls.some((c) => c.method === 'PATCH' && c.url === '/api/kb/docs/50'), '放进未归类不发 PATCH');
console.log('✓ 上传后轮询到 ready 弹出归类，放进未归类不发 PATCH');

// 9.6 搜索与「移动到…」
routes['GET /api/kb/docs'] = { hits: [{ doc: KB_DOC(1), ord: 2, heading: '定价', snippet: '按【席位】收费' }] };
$('kb-q').value = '席位';
await $('kb-q').fire('input');
await new Promise((r) => setTimeout(r, 400));
assert.match(calls.filter((c) => c.url.startsWith('/api/kb/docs?')).at(-1).url, /q=%E5%B8%AD%E4%BD%8D/);
assert.match($('kb-body').textContent, /按席位收费/);
assert.ok(walk($('kb-body')).some((el) => el.tagName === 'MARK' && el.textContent === '席位'), '命中词高亮');
// 智能搜索：结果下方按钮；点击后带 smart=1，显示检索词；skip 时提示原因、保留原结果
const smartBtn = () => byText($('kb-body'), 'BUTTON', '没找到想要的？智能搜索')[0];
assert.ok(smartBtn(), '搜索结果下方有智能搜索按钮');
routes['GET /api/kb/docs'] = (_b, o) =>
  /smart=1/.test(o.url)
    ? { hits: [{ doc: KB_DOC(1), ord: 2, heading: '定价', snippet: '按【席位】收费' }, { doc: KB_DOC(3, { title: '价格策略' }), ord: 0, heading: '', snippet: '【定价策略】年付八折' }], terms: ['价格', '定价策略'], source: 'llm' }
    : { hits: [{ doc: KB_DOC(1), ord: 2, heading: '定价', snippet: '按【席位】收费' }] };
await smartBtn().fire('click');
await tick();
assert.match(calls.filter((c) => c.url.startsWith('/api/kb/docs?')).at(-1).url, /smart=1/);
assert.match($('kb-body').textContent, /已按这些说法搜索：价格、定价策略/);
assert.match($('kb-body').textContent, /价格策略/);
assert.match($('kb-body').textContent, /2 条结果/);
assert.ok(!smartBtn(), '智能搜索后不再显示按钮');
routes['GET /api/kb/docs'] = (_b, o) =>
  /smart=1/.test(o.url) ? { hits: [{ doc: KB_DOC(1), ord: 2, heading: '定价', snippet: '按【席位】收费' }], terms: [], source: 'skip', reason: '今天的智能搜索次数已用完' } : { hits: [{ doc: KB_DOC(1), ord: 2, heading: '定价', snippet: '按【席位】收费' }] };
$('kb-q').value = '席位收费';
await $('kb-q').fire('input');
await new Promise((r) => setTimeout(r, 400));
await smartBtn().fire('click');
await tick();
assert.match($('kb-body').textContent, /今天的智能搜索次数已用完/);
assert.match($('kb-body').textContent, /按席位收费/, 'skip 时保留普通结果');
routes['GET /api/kb/docs'] = { hits: [] };
$('kb-q').value = '完全没有';
await $('kb-q').fire('input');
await new Promise((r) => setTimeout(r, 400));
assert.ok(smartBtn(), '没有结果时也能智能搜索');
console.log('✓ 知识库智能搜索：按钮、检索词、跳过原因');
$('kb-q').value = '';
routes['GET /api/kb/docs'] = { docs: [KB_DOC(1), KB_DOC(2, { folder_id: 5, path: '产品' })] };
await $('kb-q').fire('input');
await new Promise((r) => setTimeout(r, 400));
routes['GET /api/kb/docs/1'] = { doc: KB_DOC(1), body: '正文', chunks: [{ ord: 0, heading: '', body: '正文' }] };
routes['PATCH /api/kb/docs/1'] = { doc: KB_DOC(1, { folder_id: 6, path: '产品/竞品' }) };
await walk($('kb-body')).find((el) => el.tagName === 'A' && el.textContent === '条目1').fire('click');
await tick();
const moveBtn = walk($('kb-body')).find((el) => el.tagName === 'BUTTON' && el.textContent === '移动到…');
assert.ok(moveBtn, '条目详情应有「移动到…」');
moveBtn.fire('click');
await tick();
const sel = walk(kbDlg()).find((el) => el.tagName === 'SELECT');
assert.ok(sel.children.some((o) => o.textContent === '产品/竞品'), '目录选择器列出完整路径');
sel.value = '6';
await dlgBtn('确认').fire('click');
await tick();
assert.deepEqual(calls.filter((c) => c.method === 'PATCH' && c.url === '/api/kb/docs/1').at(-1).body, { folderId: 6 });
console.log('✓ 知识库搜索与「移动到…」');

// 9.65 批量导入：预检摘要、并发 3、不弹归类、失败重试、停止、根部文件放进当前目录、取消不建目录
{
  const F = (path, o = {}) => new ctx.File(['x'], path.split('/').at(-1), { path, size: 10, ...o });
  const kbImp = () => $('kb-import');
  const impBtn = (t) => walk(kbImp()).find((el) => el.tagName === 'BUTTON' && el.textContent.startsWith(t));
  const ups = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/kb/uploads'));
  const ensures = () => calls.filter((c) => c.url === '/api/kb/folders/ensure');
  // 进入「产品」目录（id 5）
  await walk($('kb-tree')).find((el) => el.tagName === 'A' && el.textContent === '产品').fire('click');
  await tick();
  routes['GET /api/kb/tree'] = { folders: [{ id: 5, parent_id: null, name: '产品', sort: 0, count: 2 }, { id: 6, parent_id: 5, name: '竞品', sort: 0, count: 1 }, { id: 7, parent_id: 5, name: '资料', sort: 0, count: 1 }], unfiled: 3, total: 6 };
  routes['GET /api/kb/docs'] = (_b, o) => (/folder=7/.test(o.url) ? { docs: [KB_DOC(70, { kind: 'upload', folder_id: 7, file_name: 'a.md', file_size: 10 })] } : { docs: [] });
  const seven = [F('资料/.DS_Store'), F('资料/__MACOSX/a.md'), F('资料/x.exe'), F('资料/big.pdf', { size: 11 * 1024 * 1024 }), F('资料/empty.txt', { size: 0 }), F('资料/a.md'), F('资料/b/c.png')];
  const nEnsure = ensures().length;
  const u0 = ups().length;
  await pick($('kb-dir'), seven);
  await tick();
  assert.equal(kbDlg().hidden, false, '弹出导入摘要');
  assert.match(kbDlg().textContent, /将导入 1 个到〔产品〕，跳过 6 个（隐藏文件 2、不支持 1、超过 10MB 1、空文件 1、重复 1），其中 1 张图片需要模型识别/);
  assert.ok(calls.some((c) => /\/api\/kb\/docs\?folder=7&limit=2000$/.test(c.url)), '查重取目录里全部条目（limit=2000），不只默认的前 500');
  const dupBox = walk(kbDlg()).find((el) => el.tagName === 'INPUT' && el.attrs.type === 'checkbox');
  assert.ok(dupBox, '有重复时显示「仍然导入重复文件」');
  dupBox.checked = true;
  await dupBox.fire('change');
  assert.match(kbDlg().textContent, /将导入 2 个到〔产品〕，跳过 5 个/);
  assert.match(kbDlg().textContent, /会按原来的文件夹结构建目录/, '选文件夹时说明会建目录');
  await dlgBtn('取消').fire('click');
  await tick();
  assert.equal(ensures().length, nEnsure, '取消时不建目录');
  assert.equal(ups().length, u0, '取消时不上传');

  // 501 个文件只取 500
  routes['GET /api/kb/docs'] = { docs: [] };
  await pick($('kb-file'), Array.from({ length: 501 }, (_, i) => new ctx.File(['x'], `f${i}.md`, { size: 10 })));
  await tick();
  assert.match(kbDlg().textContent, /将导入 500 个到〔产品〕，跳过 1 个（超出数量上限 1）/);
  assert.match(kbDlg().textContent, /一次最多导入 500 个/);
  assert.doesNotMatch(kbDlg().textContent, /建目录/, '多选文件没有子目录时不提建目录');
  assert.match(kbDlg().textContent, /导入时不逐个弹出归类/);
  await dlgBtn('取消').fire('click');
  await tick();

  // 开始导入：并发不超过 3，不弹归类，根部文件带当前目录
  let active = 0;
  let peak = 0;
  let nextId = 900;
  const gate = [];
  routes['POST /api/kb/folders/ensure'] = (b) => ({ map: Object.fromEntries(b.paths.map((x) => [x, x === '' ? b.parentId : x === '资料' ? 7 : 8])), capped: false });
  routes['POST /api/kb/uploads'] = (_b, o) =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      const name = decodeURIComponent(o.headers['x-file-name']);
      gate.push(() => {
        active--;
        resolve(name === 'bad.md' ? { __status: 415, data: { error: '不支持的文件类型' } } : { __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'ready', title: name, folder_id: 5 }) } });
      });
    });
  const release = async () => {
    while (gate.length) {
      gate.shift()();
      await tick();
    }
  };
  const before = ups().length;
  const batch = [F('根部.md'), F('资料/一.md'), F('资料/二.md'), F('资料/b/三.md'), F('资料/bad.md')];
  await pick($('kb-dir'), batch);
  await tick();
  assert.match(kbDlg().textContent, /将导入 5 个/);
  await dlgBtn('开始导入').fire('click');
  await tick();
  assert.deepEqual(ensures().at(-1).body, { parentId: 5, paths: ['', '资料', '资料/b'] });
  assert.equal(kbImp().hidden, false, '显示进度面板');
  assert.ok(peak <= 3 && active === 3, `同时最多 3 个（${peak}）`);
  await release();
  await release();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(peak, 3);
  const mine = ups().slice(before);
  assert.equal(mine.length, 5);
  assert.match(mine.find((c) => decodeURIComponent(c.headers['x-file-name']) === '根部.md').url, /folder=5$/, '根部文件放进当前目录');
  assert.match(mine.find((c) => decodeURIComponent(c.headers['x-file-name']) === '三.md').url, /folder=8$/);
  assert.equal(kbDlg().hidden, true, '批量导入不弹归类');
  assert.match(kbImp().textContent, /成功 4/);
  assert.match(kbImp().textContent, /失败 1/);
  assert.match(kbImp().textContent, /bad\.md：不支持的文件类型/);

  // 重试失败的
  routes['POST /api/kb/uploads'] = (_b, o) => ({ __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'ready', title: decodeURIComponent(o.headers['x-file-name']) }) } });
  assert.equal(impBtn('重试失败的').textContent, '重试失败的（1）', '重试按钮显示可重传的个数');
  await impBtn('重试失败的').fire('click');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(decodeURIComponent(ups().at(-1).headers['x-file-name']), 'bad.md');
  assert.match(kbImp().textContent, /成功 5/);
  assert.match(kbImp().textContent, /失败 0/);
  await impBtn('关闭').fire('click');
  assert.equal(kbImp().hidden, true);

  // 处理失败（提取正文出错）计入失败；轮询用 ids
  routes['POST /api/kb/uploads'] = (_b, o) => ({ __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'processing', title: decodeURIComponent(o.headers['x-file-name']) }) } });
  routes['GET /api/kb/docs'] = (_b, o) => {
    if (!/ids=/.test(o.url)) return { docs: [] };
    const ids = decodeURIComponent(o.url.split('ids=')[1]).split(',').map(Number);
    return { docs: ids.map((id) => KB_DOC(id, { kind: 'upload', status: 'error', error: '正文超过 20 万字' })) };
  };
  await pick($('kb-file'), [new ctx.File(['x'], '长.md', { size: 10 }), new ctx.File(['x'], '长2.md', { size: 10 })]);
  await tick();
  await dlgBtn('开始导入').fire('click');
  await new Promise((r) => setTimeout(r, 2300));
  assert.ok(calls.some((c) => /\/api\/kb\/docs\?ids=/.test(c.url)), '按 ids 批量轮询');
  assert.match(kbImp().textContent, /失败 2/);
  assert.match(kbImp().textContent, /长\.md：正文超过 20 万字（已入库，需要重做请先删除该条目）/);
  assert.ok(!impBtn('重试失败的'), '已入库但处理失败的不提供重试（重传会多出同名条目）');
  await impBtn('关闭').fire('click');

  // 停止：不再发起新的上传
  const hold = [];
  routes['POST /api/kb/uploads'] = () => new Promise((r) => hold.push(() => r({ __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'ready' }) } })));
  const b2 = ups().length;
  await pick($('kb-file'), Array.from({ length: 6 }, (_, i) => new ctx.File(['x'], `s${i}.md`, { size: 10 })));
  await tick();
  await dlgBtn('开始导入').fire('click');
  await tick();
  assert.equal(ups().length - b2, 3);
  const unload = winListeners.beforeunload?.map((fn) => { const e = { preventDefault() { this.prevented = true; } }; fn(e); return e.prevented; }) ?? [];
  assert.ok(unload.includes(true), '导入进行中离开页面先提示');
  await impBtn('停止').fire('click');
  while (hold.length) (hold.shift()(), await tick());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ups().length - b2, 3, '停止后不再发起新的上传');
  assert.match(kbImp().textContent, /已停止，未上传/);
  assert.ok(impBtn('重试失败的'), '停止后可以继续（重试未上传的）');
  await impBtn('关闭').fire('click');

  // 目录名正好是原型属性（constructor）时，仍按 ensure 返回的 id 归类
  routes['GET /api/kb/docs'] = { docs: [] };
  routes['POST /api/kb/folders/ensure'] = (b) => ({ map: Object.fromEntries(b.paths.map((x) => [x, x === '' ? b.parentId : 11])), capped: false });
  routes['POST /api/kb/uploads'] = (_b, o) => ({ __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'ready', title: decodeURIComponent(o.headers['x-file-name']) }) } });
  await pick($('kb-dir'), [F('constructor/甲.md'), F('constructor/乙.md')]);
  await tick();
  await dlgBtn('开始导入').fire('click');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(ups().at(-1).url, /folder=11$/, 'constructor 目录按 ensure 返回的 id 归类');
  await impBtn('关闭').fire('click');

  // 拖入文件夹：读取 webkitGetAsEntry 递归
  const fileEntry = (path, size = 10) => ({ isFile: true, isDirectory: false, name: path.split('/').at(-1), fullPath: `/${path}`, file: (cb) => cb(new ctx.File(['x'], path.split('/').at(-1), { size })) });
  const dirEntry = (path, kids) => {
    let done = false;
    return { isFile: false, isDirectory: true, name: path.split('/').at(-1), fullPath: `/${path}`, createReader: () => ({ readEntries: (cb) => (cb(done ? [] : kids), (done = true)) }) };
  };
  routes['GET /api/kb/docs'] = { docs: [] };
  routes['POST /api/kb/uploads'] = (_b, o) => ({ __status: 202, data: { doc: KB_DOC(nextId++, { kind: 'upload', status: 'ready', title: decodeURIComponent(o.headers['x-file-name']) }) } });
  const tree = dirEntry('拖入', [fileEntry('拖入/甲.md'), dirEntry('拖入/子', [fileEntry('拖入/子/乙.md')])]);
  await $('kb-pane-docs').fire('dragover', { dataTransfer: { types: ['Files'] } });
  await $('kb-pane-docs').fire('drop', { dataTransfer: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => tree }], getData: () => '' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(kbDlg().textContent, /将导入 2 个到〔产品〕/);
  await dlgBtn('开始导入').fire('click');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ensures().at(-1).body.paths, ['拖入', '拖入/子']);
  assert.match(kbImp().textContent, /导入结束：共 2 个/);
  await impBtn('关闭').fire('click');
  routes['GET /api/kb/tree'] = { folders: [{ id: 5, parent_id: null, name: '产品', sort: 0, count: 2 }, { id: 6, parent_id: 5, name: '竞品', sort: 0, count: 1 }], unfiled: 3, total: 6 };
  routes['GET /api/kb/docs'] = { docs: [KB_DOC(1), KB_DOC(2, { folder_id: 5, path: '产品' })] };
  await walk($('kb-tree')).find((el) => el.tagName === 'A' && el.textContent === '全部').fire('click');
  await tick();
  console.log('✓ 知识库批量导入：预检摘要、并发 3、不弹归类、重试、停止、拖入文件夹');
}

// 9.66 导出全部：工具栏直链下载，title 说明内容范围
{
  const a = $('kb-export');
  assert.equal(a.tagName, 'A');
  assert.equal(a.attrs.href, '/api/kb/export');
  assert.ok('download' in a.attrs);
  assert.match(html, /id="kb-export"[^>]*>导出全部<\/a>/);
  assert.match(a.attrs.title, /原文件.*Markdown.*不含 Wiki/);

  // 点击：拦截默认跳转，用隐藏 iframe 下载；出错时（413 / 401 的 JSON）弹出服务端的提示
  const frames = () => ctx.document.body.children.filter((c) => c.tagName === 'IFRAME');
  $('toast').hidden = true;
  const ev = await a.fire('click');
  assert.ok(ev.defaultPrevented, '拦截默认的直链跳转');
  assert.equal(frames().length, 1);
  assert.equal(frames()[0].src, '/api/kb/export');
  assert.equal($('toast').hidden, true, '下载成功时没有提示');
  const f1 = frames()[0];
  f1.contentDocument = { URL: 'about:blank', body: { textContent: '' } };
  await f1.fire('load');
  assert.equal($('toast').hidden, true, '初始空白页的 load 不算失败');
  assert.equal(frames().length, 1);
  f1.contentDocument = { URL: 'https://x/api/kb/export', body: { textContent: '{"error":"导出内容超过 1.5GB，请先删除不需要的大文件后再导出"}' } };
  await f1.fire('load');
  assert.match($('toast').textContent, /导出内容超过 1\.5GB/);
  assert.equal(frames().length, 0, '提示后移除 iframe');
  await a.fire('click');
  frames()[0].contentDocument = { URL: 'https://x/api/kb/export', body: { textContent: '<html>502</html>' } };
  await frames()[0].fire('load');
  assert.equal($('toast').textContent, '导出失败', '读不出 error 时给通用提示');
  assert.equal(frames().length, 0);
  console.log('✓ 知识库导出全部链接');
}

// 9.7 网页条目：「网页预览 / 提取的文字」标签，沙箱 iframe，懒创建；普通条目没有标签
routes['GET /api/kb/docs'] = { docs: [KB_DOC(1), KB_DOC(3, { preview: true })] };
await $('kb-q').fire('input');
await new Promise((r) => setTimeout(r, 400));
routes['GET /api/kb/docs/3'] = { doc: KB_DOC(3, { preview: true }), body: '# 图谱\n\n记忆', chunks: [{ ord: 0, heading: '图谱', body: '记忆' }] };
await walk($('kb-body')).find((el) => el.tagName === 'A' && el.textContent === '条目3').fire('click');
await tick();
const kbDocTab = (t) => walk($('kb-body')).find((el) => el.tagName === 'BUTTON' && el.attrs.role === 'tab' && el.textContent === t);
const kbDocFrames = () => walk($('kb-body')).filter((el) => el.tagName === 'IFRAME');
const kbDocPane = (c) => walk($('kb-body')).find(cls(c));
assert.ok(kbDocTab('网页预览') && kbDocTab('提取的文字'), '网页条目应有预览和文字两个标签');
assert.ok(cls('on')(kbDocTab('网页预览')), '默认显示网页预览');
assert.equal(kbDocFrames().length, 1);
assert.equal(kbDocFrames()[0].attrs.sandbox, 'allow-scripts', 'iframe 只允许脚本，不同源');
assert.equal(kbDocFrames()[0].attrs.src, '/api/kb/docs/3/preview');
assert.equal(kbDocFrames()[0].attrs.referrerpolicy, 'no-referrer');
const kbNewWin = walk($('kb-body')).find((el) => el.tagName === 'A' && el.textContent === '新窗口打开');
assert.ok(kbNewWin && kbNewWin.attrs.href === '/api/kb/docs/3/preview' && /noopener/.test(kbNewWin.attrs.rel), '应有新窗口打开链接');
assert.equal(kbDocPane('kb-pane').hidden, true);
await kbDocTab('提取的文字').fire('click');
assert.ok(cls('on')(kbDocTab('提取的文字')) && !cls('on')(kbDocTab('网页预览')));
assert.equal(kbDocPane('kb-pane').hidden, false);
assert.equal(kbDocPane('kb-preview').hidden, true);
assert.match(kbDocPane('kb-pane').textContent, /记忆/);
await kbDocTab('网页预览').fire('click');
assert.equal(kbDocFrames().length, 1, '来回切换不重建 iframe');
routes['GET /api/kb/docs/1'] = { doc: KB_DOC(1), body: '正文', chunks: [{ ord: 0, heading: '', body: '正文' }] };
await walk($('kb-body')).find((el) => el.tagName === 'BUTTON' && el.textContent === '← 返回列表').fire('click');
await tick();
await walk($('kb-body')).find((el) => el.tagName === 'A' && el.textContent === '条目1').fire('click');
await tick();
assert.ok(!kbDocTab('网页预览') && !kbDocFrames().length, '普通条目没有预览标签');
assert.match($('kb-body').textContent, /正文/);
console.log('✓ 知识库网页条目：预览/文字标签与沙箱 iframe');

// 9.8 Wiki：四个标签、图谱、页面、问 Wiki、体检与日志
{
  const WPAGE = (slug, title, extra = {}) => ({ id: 1, slug, kind: 'concept', title, summary: '摘要', body: '', rev: 3, updated_at: now, created_at: now, backlinks: [], cites: [], links: [], deleted: 0, edited_by_user: 0, source_doc: null, ...extra });
  routes['GET /api/wiki/pages'] = { pages: [{ id: 1, slug: 'a', kind: 'concept', title: '概念A', summary: 's', updated_at: now }, { id: 2, slug: 'b', kind: 'entity', title: '实体B', summary: 's', updated_at: now }] };
  routes['GET /api/wiki/graph'] = { nodes: [{ slug: 'a', title: '概念A', kind: 'concept', backlinks: 1 }, { slug: 'b', title: '实体B', kind: 'entity', backlinks: 0 }], edges: [{ from: 'b', to: 'a' }] };
  routes['GET /api/wiki/pages/a'] = {
    page: WPAGE('a', '概念A', {
      body: '## 定义\n概念A 的正文，见 [[b]] 与 [[ghost|幽灵页]]。[^40:1]\n\n![](asset:5)\n\n[外链](javascript:alert(1))',
      backlinks: [{ slug: 'b', title: '实体B' }],
      cites: [{ doc: 40, ord: 1, title: '竞品', heading: '定价', valid: true }],
      links: [{ slug: 'b', title: '实体B' }, { slug: 'ghost', title: null }],
    }),
  };
  routes['GET /api/wiki/ops'] = {
    ops: [
      { id: 31, kind: 'ingest', doc_id: 1, doc_title: '条目1', status: 'done', pages: [{ page_id: 1, slug: 'a', from_rev: 2, to_rev: 3 }], note: '', error: null, llm_calls: 4, created_at: now, finished_at: now, target_op: null },
      { id: 30, kind: 'lint', doc_id: null, doc_title: null, status: 'error', pages: [], note: '', error: 'x', llm_calls: 1, created_at: now, finished_at: now, target_op: null },
    ],
  };
  routes['GET /api/wiki/ops/30'] = {
    op: { id: 30, kind: 'lint', status: 'done', pages: [], note: JSON.stringify({ issues: [{ type: 'missing', target: 'ghost', refs: 2, detail: '缺页 ghost' }, { type: 'orphan', slug: 'a', detail: '没有其他页面链接到这里' }], fixOp: null }), created_at: now, finished_at: now },
    diffs: [],
  };
  const kbTabBtn = (t) => $('kb-tabs').children.find((b) => b.tagName === 'BUTTON' && b.textContent === t);
  assert.deepEqual($('kb-tabs').children.filter((b) => b.tagName === 'BUTTON').map((b) => b.textContent), ['资料', 'Wiki', '问 Wiki', '体检与日志'], '知识库顶部四个标签');
  await kbTabBtn('Wiki').fire('click');
  await tick();
  assert.equal(store.get('kb.tab'), 'wiki', '记住选中的标签');
  assert.equal($('kb-pane-wiki').hidden, false);
  assert.equal($('kb-pane-docs').hidden, true);
  const wikiEls = () => walk($('kb-pane-wiki'));
  assert.ok(wikiEls().some((el) => el.tagName === 'SVG'), 'Wiki 首页是 SVG 图谱');
  assert.equal(wikiEls().filter((el) => el.tagName === 'CIRCLE').length, 2, '图谱有两个节点');
  assert.match($('kb-pane-wiki').textContent, /排队 1/);
  assert.match($('kb-pane-wiki').textContent, /12\/200/);
  assert.match($('kb-pane-wiki').textContent, /概念A/);
  await wikiEls().find((el) => el.tagName === 'A' && el.textContent === '概念A').fire('click');
  await tick();
  assert.ok(calls.some((c) => c.url === '/api/wiki/pages/a'), '打开页面');
  assert.match($('kb-pane-wiki').textContent, /概念A 的正文/);
  assert.match($('kb-pane-wiki').textContent, /反向链接/);
  assert.ok(wikiEls().some((el) => cls('wiki-missing')(el) && el.textContent === '幽灵页'), '缺页链接标红');
  assert.ok(wikiEls().some((el) => cls('wiki-link')(el) && el.textContent === '实体B'), '已有页面的链接显示标题');
  assert.ok(wikiEls().some((el) => el.tagName === 'IMG' && el.attrs.src === '/api/wiki/assets/5'), '图片指向 assets 接口');
  assert.ok(!wikiEls().some((el) => /^(javascript|https?):/i.test(el.attrs?.href ?? '')), '不生成外部或脚本链接');
  routes['POST /api/wiki/pages/ghost/generate'] = { __status: 202, data: { opId: 50 } };
  await wikiEls().find((el) => cls('wiki-missing')(el)).fire('click');
  await tick();
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/wiki/pages/ghost/generate'), '确认后生成缺页');
  routes['GET /api/kb/docs/40'] = { doc: KB_DOC(40), body: 'x', chunks: [{ ord: 1, heading: '定价', body: 'x' }] };
  const nKb40 = calls.filter((c) => c.url === '/api/kb/docs/40').length;
  await wikiEls().find((el) => cls('wiki-cite')(el)).fire('click');
  await tick();
  assert.equal(calls.filter((c) => c.url === '/api/kb/docs/40').length, nKb40 + 1, '引用跳到资料');
  assert.equal($('kb-pane-docs').hidden, false);
  assert.equal(store.get('kb.tab'), 'docs');

  await kbTabBtn('问 Wiki').fire('click');
  await tick();
  const askBox = walk($('kb-pane-ask')).find((el) => el.tagName === 'TEXTAREA');
  assert.ok(askBox && askBox.attrs.maxlength === '500', '问 Wiki 输入框');
  routes['POST /api/wiki/ask'] = { answer: '答案见 [[a]]。', pages: [{ slug: 'a', title: '概念A' }], cites: [], opId: 60 };
  askBox.value = '什么是 A？';
  await walk($('kb-pane-ask')).find((el) => el.tagName === 'BUTTON' && el.textContent === '提问').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/wiki/ask').at(-1).body, { question: '什么是 A？' });
  assert.match($('kb-pane-ask').textContent, /答案见/);
  routes['POST /api/wiki/answers'] = { __status: 201, data: { slug: 'q-a', opId: 61 } };
  await walk($('kb-pane-ask')).find((el) => el.tagName === 'BUTTON' && el.textContent === '存为问答页').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/wiki/answers').at(-1).body, { question: '什么是 A？', answer: '答案见 [[a]]。' });

  await kbTabBtn('体检与日志').fire('click');
  await tick();
  assert.ok(calls.some((c) => c.url.startsWith('/api/wiki/ops?') || c.url === '/api/wiki/ops'), '请求操作日志');
  const lintText = () => $('kb-pane-lint').textContent;
  assert.match(lintText(), /摄入/);
  assert.match(lintText(), /条目1/);
  assert.match(lintText(), /缺页/);
  assert.match(lintText(), /孤立页/);
  const lintBtn = (t) => walk($('kb-pane-lint')).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
  assert.ok(lintBtn('重试'), '失败的操作有重试');
  assert.ok(lintBtn('撤销'), '完成的摄入有撤销');
  assert.ok(lintBtn('生成此页'), '缺页可以生成');
  routes['POST /api/wiki/ops/31/revert'] = (b) => (b.force ? { revertOp: 70 } : { __status: 409, data: { error: '部分页面已被后来的操作修改', conflicts: [{ slug: 'a', rev: 4, expected: 3 }] } });
  await lintBtn('撤销').fire('click');
  await tick();
  assert.match(lintText(), /仍然覆盖/);
  await lintBtn('仍然覆盖').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/wiki/ops/31/revert').at(-1).body, { force: true });

  // 「参考了」里的 Wiki 页：切到 Wiki 标签并打开
  await kbTabBtn('资料').fire('click');
  const cnw = ctx.contextNote({ memories: [], reviews: [], kb: [{ wiki: 'a', doc: 0, ord: 0, title: '概念A', heading: '', exists: true }] });
  const nA = calls.filter((c) => c.url === '/api/wiki/pages/a').length;
  await walk(cnw).find((el) => el.tagName === 'BUTTON' && el.textContent === 'Wiki：概念A').fire('click');
  await tick();
  assert.equal(calls.filter((c) => c.url === '/api/wiki/pages/a').length, nA + 1);
  assert.equal($('kb-pane-wiki').hidden, false);
  await kbTabBtn('资料').fire('click');
  $('toast').hidden = true;
  console.log('✓ Wiki：四个标签、图谱、页面、问 Wiki、体检与日志、参考了跳转');
}

// 9.9 Wiki 分类树：树渲染、折叠记忆、搜索平铺、移到…、节点增删改、整理目录
{
  const NODES = [
    { id: 1, parent_id: null, title: 'Agent 开发', sort: 1, manual: false, own: 0, total: 3 },
    { id: 2, parent_id: 1, title: '检索', sort: 1, manual: false, own: 2, total: 2 },
    { id: 3, parent_id: 1, title: '记忆', sort: 2, manual: false, own: 1, total: 1 },
    { id: 4, parent_id: null, title: '空领域', sort: 2, manual: true, own: 0, total: 0 },
  ];
  const PG = (id, slug, kind, title, node_id) => ({ id, slug, kind, title, summary: 's', updated_at: now, node_id });
  const PAGES = [PG(1, 'a', 'concept', '概念A', 2), PG(2, 'b', 'entity', '实体B', 3), PG(3, 'c', 'concept', '概念C', 2), PG(4, 'd', 'concept', '概念D', null)];
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: NODES, topics: [] };
  routes['GET /api/wiki/status'] = { queued: 0, running: null, usedToday: 1, limit: 200, enabled: true, lastLint: null, unplaced: 1, docs: {} };
  const PAGE = (slug, title, node_id) => ({ page: { id: 1, slug, kind: 'concept', title, summary: '摘要', body: '正文', rev: 3, updated_at: now, created_at: now, backlinks: [], cites: [], links: [], deleted: 0, edited_by_user: 0, source_doc: null, node_id } });
  routes['GET /api/wiki/pages/a'] = PAGE('a', '概念A', 2);
  routes['GET /api/wiki/pages/d'] = PAGE('d', '概念D', null);
  const kbTab = (t) => $('kb-tabs').children.find((b) => b.tagName === 'BUTTON' && b.textContent === t);
  const pane = () => $('kb-pane-wiki');
  const els = () => walk(pane());
  const rowOf = (title) => els().find((el) => cls('wiki-node-row')(el) && el.children.some((c) => cls('wiki-node-name')(c) && c.textContent === title));
  const twisty = (title) => walk(rowOf(title)).find(cls('wiki-twisty'));
  const itemOf = (title) => els().find((el) => el.tagName === 'A' && cls('wiki-item')(el) && el.textContent.includes(title));
  const reopen = async () => {
    await kbTab('资料').fire('click');
    await kbTab('Wiki').fire('click');
    await tick();
  };
  store.delete('opc.wikiTree');
  await reopen();
  assert.match(rowOf('Agent 开发').textContent, /0\/3/, '顶层节点显示直属数 / 总数');
  assert.ok(rowOf('检索') && rowOf('记忆') && rowOf('空领域'), '顶层默认展开，第二层节点可见');
  assert.ok(!itemOf('概念A') && !itemOf('实体B'), '第二层默认折叠，页面不显示');
  assert.ok(itemOf('概念D'), '未分类页面显示');
  const lastGroup = els().find(cls('wiki-list')).children.at(-1);
  assert.ok(cls('wiki-unplaced')(lastGroup) && /未分类/.test(lastGroup.textContent) && /概念D/.test(lastGroup.textContent), '未分类分组在末尾');
  await twisty('检索').fire('click');
  assert.ok(itemOf('概念A') && itemOf('概念C') && !itemOf('实体B'), '展开检索');
  assert.deepEqual(JSON.parse(store.get('opc.wikiTree')), { 2: true }, '展开状态写入 localStorage');
  const nameOf = (title) => walk(rowOf(title)).find(cls('wiki-node-name'));
  await nameOf('Agent 开发').fire('click');
  assert.ok(!rowOf('检索'), '点节点名称也能折叠');
  await nameOf('Agent 开发').fire('click');
  assert.ok(rowOf('检索'), '再点名称展开');
  await walk(rowOf('Agent 开发')).find(cls('kb-count')).fire('click');
  assert.ok(!rowOf('检索'), '点数字也能折叠');
  await twisty('Agent 开发').fire('click');
  assert.ok(rowOf('检索'));
  await twisty('Agent 开发').fire('click');
  assert.ok(!rowOf('检索') && !itemOf('概念A'), '折叠顶层后子孙都不显示');
  assert.equal(JSON.parse(store.get('opc.wikiTree'))[1], false);
  await reopen();
  assert.ok(!rowOf('检索'), '重新进入后保持折叠');
  await twisty('Agent 开发').fire('click');
  assert.ok(rowOf('检索'));

  // 没有未分类页面时不显示该分组
  routes['GET /api/wiki/pages'] = { pages: PAGES.slice(0, 3), nodes: NODES, topics: [] };
  await reopen();
  assert.ok(!els().some(cls('wiki-unplaced')), '没有未分类页面时不显示');
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: NODES, topics: [] };
  await reopen();

  // 搜索：平铺，带路径；清空后回到树
  store.set('opc.wikiTree', '{}');
  await reopen();
  assert.ok(!itemOf('概念A'), '检索折叠');
  const qBox = els().find((el) => el.tagName === 'INPUT' && cls('wiki-q')(el));
  qBox.value = '概念';
  await qBox.fire('input');
  await new Promise((r) => setTimeout(r, 380));
  assert.ok(calls.some((c) => c.url === '/api/wiki/pages?q=%E6%A6%82%E5%BF%B5'), '搜索请求');
  assert.ok(!els().some(cls('wiki-twisty')), '搜索时没有树');
  assert.match(itemOf('概念A').textContent, /Agent 开发 \/ 检索/, '平铺结果带所属路径');
  assert.ok(!/ \/ /.test(itemOf('概念D').textContent), '未分类的结果没有路径');
  await itemOf('概念A').fire('click');
  await tick();
  qBox.value = '';
  await qBox.fire('input');
  await new Promise((r) => setTimeout(r, 380));
  assert.ok(els().some(cls('wiki-twisty')), '清空搜索后回到树');
  assert.ok(itemOf('概念A'), '从搜索结果打开页面后，所在节点在树里自动展开');

  // 页面详情：面包屑与「移到…」
  await itemOf('概念D').fire('click');
  await tick();
  assert.ok(!els().some(cls('wiki-crumb')), '未分类页面没有面包屑');
  await itemOf('概念A').fire('click');
  await tick();
  assert.match(els().find(cls('wiki-crumb')).textContent, /Agent 开发.*检索/, '面包屑');
  const moveSel = () => els().find((el) => el.tagName === 'SELECT' && cls('wiki-move')(el));
  assert.deepEqual(moveSel().children.map((o) => o.textContent), ['未分类', 'Agent 开发', 'Agent 开发 / 检索', 'Agent 开发 / 记忆', '空领域'], '按路径列出全部节点，再加未分类');
  routes['PUT /api/wiki/pages/a/node'] = { ok: true };
  moveSel().value = '3';
  await moveSel().fire('change');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'PUT' && c.url === '/api/wiki/pages/a/node').at(-1).body, { nodeId: 3 });
  moveSel().value = '';
  await moveSel().fire('change');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'PUT' && c.url === '/api/wiki/pages/a/node').at(-1).body, { nodeId: null }, '选「未分类」发 null');

  // 节点菜单：新建 / 改名 / 删除
  const act = (title, label) => walk(rowOf(title)).find((el) => el.tagName === 'BUTTON' && el.attrs['aria-label'] === label);
  assert.ok(act('Agent 开发', '新建子节点') && act('检索', '新建子节点'), '第 1、2 层可新建子节点');
  routes['POST /api/wiki/nodes'] = { __status: 201, data: { id: 9 } };
  promptAnswer = '新主题';
  await act('Agent 开发', '新建子节点').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/wiki/nodes').at(-1).body, { title: '新主题', parentId: 1 });
  promptAnswer = '顶层新领域';
  await els().find((el) => el.tagName === 'BUTTON' && el.textContent === '新建分类').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/wiki/nodes').at(-1).body, { title: '顶层新领域', parentId: null });
  promptAnswer = null;
  const nPost = calls.filter((c) => c.url === '/api/wiki/nodes').length;
  await act('Agent 开发', '新建子节点').fire('click');
  await tick();
  assert.equal(calls.filter((c) => c.url === '/api/wiki/nodes').length, nPost, '取消输入不发请求');
  routes['PATCH /api/wiki/nodes/4'] = { ok: true };
  promptAnswer = '改名后';
  await act('空领域', '改名').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'PATCH' && c.url === '/api/wiki/nodes/4').at(-1).body, { title: '改名后' });
  routes['DELETE /api/wiki/nodes/1'] = { __status: 409, data: { error: '节点下还有内容' } };
  await act('Agent 开发', '删除').fire('click');
  await tick();
  assert.match($('toast').textContent, /节点下还有内容/, '409 时提示服务端文案');
  routes['DELETE /api/wiki/nodes/4'] = { ok: true };
  await act('空领域', '删除').fire('click');
  await tick();
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/api/wiki/nodes/4'));
  const L3 = [...NODES, { id: 5, parent_id: 2, title: '第三层', sort: 1, manual: true, own: 0, total: 0 }];
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: L3, topics: [] };
  store.set('opc.wikiTree', JSON.stringify({ 2: true }));
  await reopen();
  assert.ok(rowOf('第三层') && !act('第三层', '新建子节点'), '第 3 层不显示「新建子节点」');
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: NODES, topics: [] };

  // 整理目录
  await reopen();
  assert.match(pane().textContent, /有 1 个页面还没有分类/);
  routes['POST /api/wiki/organize'] = { __status: 202, data: { opId: 80 } };
  await els().find((el) => el.tagName === 'BUTTON' && el.textContent === '整理目录').fire('click');
  await tick();
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/wiki/organize'));
  assert.match($('toast').textContent, /已开始整理/);
  routes['GET /api/wiki/status'] = { queued: 0, running: null, usedToday: 1, limit: 200, enabled: false, lastLint: null, unplaced: 1, docs: {} };
  await reopen();
  assert.equal(els().find((el) => el.tagName === 'BUTTON' && el.textContent === '整理目录').attrs.disabled, '', '未配置模型时整理按钮不可点');
  routes['GET /api/wiki/status'] = { queued: 0, running: null, usedToday: 1, limit: 200, enabled: true, lastLint: null, unplaced: 0, docs: {} };
  await reopen();
  assert.ok(!/还没有分类/.test(pane().textContent) && !els().some((el) => el.tagName === 'BUTTON' && el.textContent === '整理目录'), '没有未分类页面时不提示未分类');
  const reorg = els().find((el) => el.tagName === 'BUTTON' && el.textContent === '重新整理目录');
  assert.ok(reorg, '没有未分类页面时仍可重新整理');
  const nOrg = calls.filter((c) => c.url === '/api/wiki/organize').length;
  const nConfirm = confirms.length;
  await reorg.fire('click');
  await tick();
  assert.match(confirms[nConfirm], /重新整理/, '重新整理前确认');
  assert.equal(calls.filter((c) => c.url === '/api/wiki/organize').length, nOrg + 1);

  // 操作日志：整理目录可撤销，撤销前确认
  routes['GET /api/wiki/ops'] = { ops: [{ id: 90, kind: 'organize', doc_id: null, doc_title: null, status: 'done', pages: [], note: '整理 2 个页面，新建 3 个节点', error: null, llm_calls: 1, created_at: now, finished_at: now, target_op: null }] };
  await kbTab('体检与日志').fire('click');
  await tick();
  assert.match($('kb-pane-lint').textContent, /整理目录/);
  const lintBtn = (t) => walk($('kb-pane-lint')).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
  routes['GET /api/wiki/ops'] = { ops: [{ id: 92, kind: 'organize', doc_id: null, doc_title: null, status: 'done', pages: [], note: '没有需要整理的页面', error: null, llm_calls: 0, created_at: now, finished_at: now, target_op: null }] };
  await kbTab('资料').fire('click');
  await kbTab('体检与日志').fire('click');
  await tick();
  assert.ok(!lintBtn('撤销'), '没有快照的整理操作不显示撤销');
  routes['GET /api/wiki/ops'] = { ops: [{ id: 90, kind: 'organize', doc_id: null, doc_title: null, status: 'done', pages: [], note: '整理 2 个页面，新建 3 个节点', error: null, llm_calls: 1, created_at: now, finished_at: now, target_op: null }] };
  await kbTab('资料').fire('click');
  await kbTab('体检与日志').fire('click');
  await tick();
  routes['POST /api/wiki/ops/90/revert'] = { revertOp: 91 };
  const nConf = confirms.length;
  await lintBtn('撤销').fire('click');
  await tick();
  assert.match(confirms[nConf], /整棵分类树恢复到整理之前/, '撤销整理的确认文案');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/wiki/ops/90/revert'));

  // 趋势预测：确认后才入队；趋势页「依据」里的网址变成外链，其余协议不链接
  const nTr = () => calls.filter((c) => c.url === '/api/wiki/trends').length;
  const trendBtn = () => els().find((el) => el.tagName === 'BUTTON' && el.textContent === '更新趋势预测');
  routes['POST /api/wiki/trends'] = { __status: 202, data: { opId: 95 } };
  await reopen();
  const t0 = nTr();
  ctx.confirm = (m) => (confirms.push(m), false);
  await trendBtn().fire('click');
  await tick();
  ctx.confirm = (m) => (confirms.push(m), true);
  assert.equal(nTr(), t0, '取消确认不发请求');
  await trendBtn().fire('click');
  await tick();
  assert.match(confirms.at(-1), /近 30 天.*最多 12 次.*撤销/s, '确认文案说明范围、调用上限、可撤销');
  assert.equal(nTr(), t0 + 1);
  assert.match($('toast').textContent, /已开始生成趋势预测/);
  routes['GET /api/wiki/pages'] = { pages: [...PAGES, PG(5, 'trend-a', 'trend', '趋势：A', 1)], nodes: NODES, topics: [] };
  routes['GET /api/wiki/pages/trend-a'] = { page: { ...PAGE('trend-a', '趋势：A', 1).page, id: 5, kind: 'trend', body: '## 依据\n1. 标题 · 源 · 2026-11-20 · https://news.test/1\n2. javascript:alert(1) 与 http://ok.test/x（括号）\n3. ftp://bad.test/z' } };
  store.delete('opc.wikiTree');
  await reopen();
  await itemOf('趋势：A').fire('click');
  await tick();
  const ext = els().filter((el) => el.tagName === 'A' && /^https?:/i.test(el.attrs?.href ?? ''));
  assert.deepEqual(ext.map((a) => a.attrs.href), ['https://news.test/1', 'http://ok.test/x'], '只有 http(s) 网址成为链接，括号不算在网址里');
  assert.ok(ext.every((a) => a.attrs.rel === 'noopener noreferrer' && a.attrs.target === '_blank'));
  assert.ok(!els().some((el) => el.tagName === 'A' && /^(javascript|ftp):/i.test(el.attrs?.href ?? '')), '不生成脚本或 ftp 链接');
  assert.match(pane().textContent, /javascript:alert\(1\)/, '其余内容仍按文字显示');
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: NODES, topics: [] };

  // 只有节点没有页面时仍显示树
  routes['GET /api/wiki/pages'] = { pages: [], nodes: NODES, topics: [] };
  await reopen();
  assert.ok(rowOf('空领域'), '没有页面时仍显示已建的节点');

  // 所有名称经 textContent 写入
  const EVIL = '<img src=x onerror=alert(1)>';
  routes['GET /api/wiki/pages'] = { pages: [PG(1, 'a', 'concept', EVIL, 7)], nodes: [{ id: 7, parent_id: null, title: EVIL, sort: 1, manual: true, own: 1, total: 1 }], topics: [] };
  await reopen();
  assert.ok(rowOf(EVIL), '节点名按文本显示');
  assert.ok(!els().some((el) => el.tagName === 'IMG'), '没有被解析成元素');
  assert.ok(itemOf(EVIL));
  routes['GET /api/wiki/pages'] = { pages: PAGES, nodes: NODES, topics: [] };
  await kbTab('资料').fire('click');
  $('toast').hidden = true;
  console.log('✓ Wiki：分类树、折叠记忆、搜索平铺、移到…、节点增删改、整理目录');
}


// 10. 全屏页：路径解析、工具栏、消息来源与 iframe 常驻
{
  const fById = new Map();
  for (const id of ['proto-toolbar', 'proto-stage']) fById.set(id, new El('div', { id }));
  const fWinListeners = {};
  const fMessages = [];
  const fFrame = () => walk(fById.get('proto-stage')).find((el) => el.tagName === 'IFRAME');
  const fCtx = {
    document: {
      getElementById: (id) => fById.get(id) || null,
      createElement: (t) => new El(t),
      createTextNode: (t) => ({ textContent: t }),
      body: new El('body'),
    },
    Node: El,
    location: { pathname: '/proto/8/1' },
    window: { addEventListener: (t, fn) => { (fWinListeners[t] ??= []).push(fn); } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ prototypes: [{ n: 1, status: 'done', pages: [{ slug: 'home', title: '首页' }, { slug: 'detail', title: '详情' }] }] }) }),
    setTimeout, clearTimeout, URL, URLSearchParams, console, Date, Promise, Map, Set, Number, String, JSON, Math, Object, Array, Error,
  };
  vm.createContext(fCtx);
  vm.runInContext(fs.readFileSync(`${PUB}/proto-full.js`, 'utf8'), fCtx, { filename: 'proto-full.js' });
  await new Promise((r) => setTimeout(r, 30));
  const fBar = fById.get('proto-toolbar');
  const fBtn = (t) => walk(fBar).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
  assert.ok(fBtn('手机') && fBtn('桌面') && fBtn('标注'), '全屏工具栏应有终端与标注按钮');
  assert.ok(walk(fBar).some((el) => el.tagName === 'A' && el.textContent === '返回评审'));
  assert.match(fFrame().attrs.src, /\/prototypes\/1\/html\?device=phone/);
  assert.equal(fFrame().attrs.sandbox, 'allow-scripts');
  const fSel = walk(fBar).find((el) => el.tagName === 'SELECT');
  const sameFrame = fFrame();
  for (const fn of fWinListeners.message ?? []) await fn({ data: { type: 'proto:page', slug: 'detail' }, source: { postMessage() {} } });
  assert.notEqual(fSel.value, 'detail');
  for (const fn of fWinListeners.message ?? []) await fn({ data: { type: 'proto:page', slug: 'detail' }, source: sameFrame.contentWindow });
  assert.equal(fSel.value, 'detail');
  await fBtn('桌面').fire('click');
  assert.match(fFrame().attrs.src, /device=desktop/);
  assert.equal(fFrame(), sameFrame, '全屏 iframe 不重建');
  sameFrame.contentWindow.postMessage = (m, t) => fMessages.push({ m, t });
  await fBtn('标注').fire('click');
  assert.equal(fMessages.at(-1).m.on, true);
  const beforeReload = fMessages.length;
  await sameFrame.fire('load');
  assert.ok(fMessages.slice(beforeReload).some((x) => x.m.type === 'proto:notes' && x.m.on === true), '全屏重载后应重发标注状态');
}
console.log('✓ 全屏页：工具栏、消息过滤与 iframe 常驻');


// 11. 顶部菜单拖动排序：拖动、持久化、键盘排序，且不影响点击
const order = () => tabList.children.filter((c) => c.tagName === 'BUTTON').map((c) => c.dataset.view);
const tab = (v) => order().includes(v) && tabList.children.find((c) => c.dataset.view === v);
const dragData = { data: {}, setData(k, v) { this.data[k] = v; } };
const kbTabDrag = tab('kb');
const intelTab = tab('intel');
await kbTabDrag.fire('dragstart', { dataTransfer: dragData });
const over = await intelTab.fire('dragover', { dataTransfer: dragData });
assert.equal(over.defaultPrevented, true, '拖到标签上应允许放置');
await intelTab.fire('drop', { dataTransfer: dragData });
await kbTabDrag.fire('dragend', { dataTransfer: dragData });
assert.deepEqual(order(), ['pm', 'kb', 'intel', 'memory', 'growth', 'compliance'], '拖动后菜单顺序应改变');
assert.equal(store.get('opc.tabOrder.v2'), JSON.stringify(order()), '拖动后应保存顺序');
await new Promise((r) => setTimeout(r, 260));
await tab('memory').fire('click');
await tick();
assert.equal($('view-memory').hidden, false, '拖动后点击仍应切换视图');
const keyEv = await intelTab.fire('keydown', { key: 'ArrowRight', altKey: true });
assert.equal(keyEv.defaultPrevented, true, 'Alt+方向键应被处理');
assert.deepEqual(order(), ['pm', 'kb', 'memory', 'intel', 'growth', 'compliance'], 'Alt+→ 应把标签后移一位');
assert.equal(store.get('opc.tabOrder.v2'), JSON.stringify(order()), '键盘排序也应保存');
assert.equal(store.get('opc.tabOrder'), '["memory","growth","kb"]', '旧键不再读写');
console.log('✓ 顶部菜单：拖动排序、本地保存、键盘排序与点击兼容');

// 追加框架：历史评审在追问时追加新框架
const R20 = { ...structuredClone(R8), id: 20, skills: ['pre-mortem'], messages: [], latest: 1, versions: [{ n: 1, source: 'ai_initial', created_at: now, note: null }], content: '# V1' };
routes['GET /api/pm/reviews/20'] = () => ({ review: structuredClone(R20) });
routes['POST /api/pm/reviews/20/messages'] = (body) => {
  R20.messages.push({ id: 900 + R20.messages.length, role: 'user', kind: body.mode === 'revise' ? 'revise' : 'ask', content: body.text || '用新追加的框架补充评审：SWOT 分析', status: 'done', version_n: null, error: null, created_at: now, skills: body.skills ?? [] });
  R20.messages.push({ id: 900 + R20.messages.length, role: 'assistant', kind: 'ask', content: '', status: 'running', version_n: null, error: null, created_at: now, skills: [] });
  return { __status: 202, data: { messageId: 1 } };
};
await ctx.openReview(20);
await tick();
await tabBtn('对话').fire('click');
const addBtn = () => walk(reply()).find((el) => el.tagName === 'BUTTON' && /^追加框架/.test(el.textContent));
assert.ok(addBtn(), '追问区应有「追加框架」按钮');
assert.ok(!one(cls('pm-add')), '默认收起');
await addBtn().fire('click');
const addChip = (n) => walk(one(cls('pm-add'))).find((el) => el.tagName === 'BUTTON' && String(el.attrs.title ?? '').split('\n')[0] === n);
assert.ok(addChip('pre-mortem').className.includes('via'), '已有框架标为已使用');
assert.match(addChip('pre-mortem').attrs.title, /已在本评审中/);
await addChip('pre-mortem').fire('click');
assert.ok(!addChip('pre-mortem').className.includes(' on'), '已有框架不能再选');
await addChip('swot-analysis').fire('click');
assert.ok(addChip('swot-analysis').className.includes(' on'));
assert.match(one(cls('pm-add-sel')).textContent, /本轮追加：SWOT 分析/);
await reply().fire('submit');
await tick();
assert.deepEqual(calls.filter((c) => c.url === '/api/pm/reviews/20/messages').at(-1).body, { text: '', mode: 'auto', skills: ['swot-analysis'] }, '只追加框架时可以不写文字');
assert.match(threadText(), /追加框架：SWOT 分析/);
Object.assign(R20.messages.at(-1), { status: 'error', error: '模型超时' });
await ctx.openReview(20);
await tick();
assert.ok(!one(cls('pm-add-sel')), '发送后清空已选框架');
await btnText('重试').fire('click');
await tick();
assert.deepEqual(calls.filter((c) => c.url === '/api/pm/reviews/20/messages').at(-1).body.skills, ['swot-analysis'], '重试时带上追加的框架');
Object.assign(R20.messages.at(-1), { status: 'done', content: '补充了 SWOT' });
R20.skills = ['pre-mortem', 'swot-analysis'];
await ctx.openReview(20);
await tick();
assert.match(one(cls('pm-head')).textContent, /SWOT 分析/, '头部框架标签同步更新');
await addBtn().fire('click');
assert.ok(addChip('swot-analysis').className.includes('via'), '追加成功后标为已使用');
console.log('✓ 历史评审追加框架：选择、发送、重试、标签同步');

// 情报：动态 / 简报 / 信息源合并为一个顶部菜单，内部用子标签切换
routes['GET /api/brief'] = { brief: null };
routes['GET /api/sources'] = { sources: [] };
await new Promise((r) => setTimeout(r, 260)); // 等键盘排序后的点击屏蔽结束
assert.equal(tabs.length, 6, '顶部 6 个菜单');
assert.match(html, /data-view="intel"[^>]*>情报</, '合并后的菜单名为「情报」');
await tabs.find((t) => t.dataset.view === 'pm').fire('click');
await tick();
assert.equal($('intel-tabs').hidden, true, '其他菜单下不显示情报子标签');
const css = fs.readFileSync(`${PUB}/style.css`, 'utf8');
assert.match(css, /\.pm-tabs\[hidden\][^{]*\{\s*display:\s*none/, '.pm-tabs 设了 display:flex，必须有 [hidden] 规则才能真正隐藏');
await tabs.find((t) => t.dataset.view === 'intel').fire('click');
await tick();
assert.equal($('intel-tabs').hidden, false);
assert.deepEqual($('intel-tabs').children.map((b) => b.textContent), ['动态', '简报', '信息源']);
assert.ok(tabs.find((t) => t.dataset.view === 'intel').className.includes('on'), '情报菜单高亮');
await intelSub('简报').fire('click');
await tick();
assert.equal($('view-brief').hidden, false);
assert.equal($('view-feed').hidden, true);
assert.ok(intelSub('简报').className.includes('on'));
assert.equal(intelSub('简报').attrs['aria-selected'], 'true');
assert.equal($('q').hidden, true, '搜索框只在动态下显示');
assert.ok(calls.some((c) => c.url === '/api/brief'), '切到简报时加载简报');
await intelSub('信息源').fire('click');
await tick();
assert.equal($('view-sources').hidden, false);
assert.ok(calls.some((c) => c.url === '/api/sources'), '切到信息源时加载信息源');
await tabs.find((t) => t.dataset.view === 'kb').fire('click');
await tick();
await tabs.find((t) => t.dataset.view === 'intel').fire('click');
await tick();
assert.equal($('view-sources').hidden, false, '回到情报时停在上次的子标签');
await goIntel('动态');
assert.equal($('view-feed').hidden, false);
assert.equal($('q').hidden, false);
console.log('✓ 情报菜单：动态 / 简报 / 信息源子标签切换');

// 信息源：职业身份切换、搜索、编辑自定义源
{
  const walk = (root, out = []) => { out.push(root); for (const c of root.children ?? []) if (c instanceof El) walk(c, out); return out; };
  const P = [
    { id: 'tech', name: '技术从业者', who: 'AI 工程师、程序员', focus: ['大模型与 Agent', '工程效率'], why: '官方博客和版本发布是第一手信息', count: 96, topicCount: 12 },
    { id: 'product', name: '产品 / 设计', who: '产品经理、设计师', focus: ['产品方法', '竞品与新品'], why: '方法论源给可迁移的做法', count: 19, topicCount: 5 },
    { id: 'finance', name: '金融从业者', who: '银行、证券、基金', focus: ['货币政策', '市场行情'], why: '央行与监管公告是政策一手来源', count: 15, topicCount: 5 },
  ];
  let active = 'tech';
  routes['GET /api/profiles'] = () => ({ profiles: P, active });
  routes['POST /api/profiles/activate'] = (b) => {
    const p = P.find((x) => x.id === b.id);
    if (!p) throw new Error('职业档案不存在');
    active = p.id;
    return { id: p.id, name: p.name, enabled: p.count, disabled: 40 };
  };
  const S = (id, name, o = {}) => ({ id, name, url: `https://${id}.example/feed`, kind: 'feed', grp: 'blog', lang: 'en', filter: 0, enabled: 1, custom: 0, last_fetch_at: null, last_ok_at: null, last_error: null, item_count: 0, ...o });
  const list = [S('a', 'Alpha Blog'), S('b', 'Beta News', { grp: 'media' }), S('c', '我的源', { grp: 'custom', custom: 1, lang: 'zh' }), S('d', 'Delta Other', { enabled: 0, in_profile: false }), S('e', 'Echo Manual', { enabled: 1, in_profile: false })];
  routes['GET /api/sources'] = () => ({ sources: list });
  const n = (u) => calls.filter((c) => c.url === u).length;
  const btns = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
  const names = () => walk($('sources')).filter((e) => e.className === 'name').map((e) => e.textContent);

  await goIntel('信息源');
  const chips = () => btns($('profile-bar'));
  assert.deepEqual(chips().map((b) => b.textContent), ['技术从业者（96）', '产品 / 设计（19）', '金融从业者（15）']);
  assert.ok(chips()[0].className.includes('on') && chips()[0].attrs['aria-pressed'] === 'true');
  assert.ok(!chips()[1].className.includes('on'));
  assert.match($('profile-bar').textContent, /适用：AI 工程师、程序员/);
  assert.match($('profile-bar').textContent, /关注点：大模型与 Agent、工程效率/);
  assert.match($('profile-bar').textContent, /为什么是这些源：官方博客和版本发布是第一手信息/);
  // 默认只显示当前身份的源（含自定义源与手动启用的其它源）；其它身份的折叠，可展开 / 收起
  assert.equal(names().length, 4);
  assert.ok(!names().includes('Delta Other'), '其它身份且未启用的源默认不显示');
  assert.ok(names().includes('Echo Manual') && names().includes('我的源'), '手动启用的与自定义源保留');
  assert.match($('sources').textContent, /「技术从业者」的 4 个信息源，已启用 4 个/);
  const toggleOthers = () => btns($('sources')).find((b) => /其它身份的信息源/.test(b.textContent));
  assert.equal(toggleOthers().textContent, '显示其它身份的信息源（1）');
  await toggleOthers().fire('click');
  assert.ok(names().includes('Delta Other'));
  assert.match($('sources').textContent, /另含其它身份的 1 个/);
  assert.equal(toggleOthers().textContent, '收起其它身份的信息源');
  await toggleOthers().fire('click');
  assert.ok(!names().includes('Delta Other'));

  // 取消确认：不切换；点当前身份：不请求
  const a0 = n('/api/profiles/activate');
  ctx.confirm = (m) => (confirms.push(m), false);
  await chips()[1].fire('click');
  await tick();
  ctx.confirm = (m) => (confirms.push(m), true);
  await chips()[0].fire('click');
  await tick();
  assert.equal(n('/api/profiles/activate'), a0);
  // 确认后切换：请求、提示、高亮与列表刷新
  const s0 = n('/api/sources');
  const c0 = confirms.length;
  await chips()[1].fire('click');
  await tick();
  assert.match(confirms[c0], /切换为「产品 \/ 设计」.*19 个内置信息源.*重置.*自己添加的源不受影响/s);
  assert.deepEqual(calls.filter((c) => c.url === '/api/profiles/activate').at(-1).body, { id: 'product' });
  assert.match($('toast').textContent, /已切换为「产品 \/ 设计」，启用 19 个信息源/);
  assert.ok(chips()[1].className.includes('on') && !chips()[0].className.includes('on'));
  assert.ok(n('/api/sources') > s0, '切换后重新加载信息源');

  // 搜索：名称 / 网址 / 分组，多个词需同时命中
  const q = $('src-search');
  q.value = 'beta';
  await q.fire('input');
  assert.deepEqual(names(), ['Beta News']);
  assert.match($('sources').textContent, /在全部 5 个信息源中匹配 1 个/, '搜索在全部信息源里找');
  q.value = 'a.example';
  await q.fire('input');
  assert.deepEqual(names(), ['Alpha Blog']);
  q.value = 'alpha media';
  await q.fire('input');
  assert.deepEqual(names(), [], '多个词要同时命中');
  assert.match($('sources').textContent, /没有匹配的信息源/);
  q.value = '';
  await q.fire('input');
  assert.deepEqual(names(), ['Alpha Blog', 'Echo Manual', 'Beta News', '我的源']);
  q.value = 'delta';
  await q.fire('input');
  assert.deepEqual(names(), ['Delta Other'], '搜索能找到其它身份的源');
  q.value = '';
  await q.fire('input');

  // 编辑：只有自定义源有「编辑」；保存提交全部字段；失败时留在编辑状态；取消不请求
  assert.equal(btns($('sources')).filter((b) => b.textContent === '编辑').length, 1);
  const editRow = () => walk($('sources')).find((e) => e.className === 'src src-edit');
  await btns($('sources')).find((b) => b.textContent === '编辑').fire('click');
  assert.ok(editRow(), '进入编辑状态');
  const inputs = () => walk(editRow()).filter((e) => e.tagName === 'INPUT');
  const [nameIn, urlIn, zhIn, filterIn] = inputs();
  nameIn.value = '改名';
  urlIn.value = 'https://new.example/feed';
  zhIn.checked = true;
  filterIn.checked = true;
  let upd = () => ({ ok: true, newItems: 3, error: null });
  routes['POST /api/sources/c/update'] = (b) => upd(b);
  upd = () => { throw new Error('只支持 https 订阅地址'); };
  await btns(editRow()).find((b) => b.textContent === '保存').fire('click');
  await tick();
  assert.match($('toast').textContent, /只支持 https/);
  assert.ok(editRow(), '失败后仍在编辑');
  upd = () => ({ ok: true, newItems: 3, error: null });
  await btns(editRow()).find((b) => b.textContent === '保存').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/sources/c/update').at(-1).body, { name: '改名', url: 'https://new.example/feed', lang: 'zh', filter: true });
  assert.match($('toast').textContent, /已保存，新增 3 条/);
  assert.ok(!editRow(), '保存后退出编辑');
  await btns($('sources')).find((b) => b.textContent === '编辑').fire('click');
  const u0 = n('/api/sources/c/update');
  await btns(editRow()).find((b) => b.textContent === '取消').fire('click');
  assert.ok(!editRow());
  assert.equal(n('/api/sources/c/update'), u0);
  console.log('✓ 信息源：职业身份切换、搜索、编辑自定义源');
}

// 合规：新建、问卷、判定、台账、角标
{
  const L = (url) => [{ label: '官方', url }];
  const CP_META = { version: 1, notice: '结果为自查参考，以属地主管部门口径为准。', questions: [
    { id: 'forms', title: '产品形态', multi: true, options: [{ value: 'web', label: '网站' }, { value: 'app', label: 'App' }] },
    { id: 'ai_use', title: '怎么用 AI', multi: false, options: [{ value: 'none', label: '不用' }, { value: 'cn_api', label: '调用已备案模型 API' }] },
    { id: 'ai_output', title: '对模型输出做了什么', multi: false, options: [{ value: 'raw', label: '原样展示' }, { value: 'processed', label: '二次加工' }], dependsOn: { q: 'ai_use', in: ['cn_api'] } },
    { id: 'pi', title: '收集哪些个人信息', multi: true, exclusive: 'none', options: [{ value: 'none', label: '不收集' }, { value: 'general', label: '一般个人信息' }] },
  ], catalog: [
    { id: 'icp_filing', name: 'ICP 备案', authority: '通信管理局', basis: '《互联网信息服务管理办法》第四条', timing: '上线前', timingOrder: 0, links: L('https://beian.miit.gov.cn/') },
    { id: 'genai_filing', name: '大模型备案', authority: '网信办', basis: '《生成式人工智能服务管理暂行办法》第十七条', timing: '上线前', timingOrder: 0, links: L('https://www.gov.cn/x') },
    { id: 'pia', name: '个人信息保护影响评估', authority: '网信部门', basis: '《个人信息保护法》第五十五条', timing: '处理前', timingOrder: 0, links: L('https://www.cac.gov.cn/x') },
  ] };
  const P = (id, name, x = {}) => ({ id, name, description: '', review_id: null, created_at: now, updated_at: now, required: 0, open: 0, alerts: 0, ...x });
  const item = (id, key, x = {}) => ({ id, item: key, level: 'required', status: 'todo', stale: false, ref_no: null, done_at: null, due_at: null, remind_at: null, note: null, na_reason: null, explain: null, updated_at: now, ...x });
  const RESULT = { version: 1, social: { value: false, reason: '无公开传播功能' }, notes: ['有境外用户：另行评估'], items: [
    { id: 'icp_filing', level: 'required', reasons: ['问卷：产品形态包含「App」'], order: 0 },
    { id: 'genai_filing', level: 'maybe', reasons: ['二次加工'], order: 0 },
    { id: 'pia', level: 'na', reasons: [], order: 0 },
  ] };
  const D3 = { product: P(3, '写作助手'), assessment: null, items: [] };
  const D3done = { product: P(3, '写作助手'), assessment: { id: 1, created_at: now, rules_version: 1, answers: { forms: ['app'], ai_use: 'none', pi: ['general'] }, prefilled: [], result: RESULT },
    items: [item(31, 'icp_filing'), item(32, 'genai_filing', { level: 'maybe' }), item(33, 'pia', { stale: true })] };
  routes['GET /api/compliance/meta'] = CP_META;
  routes['GET /api/compliance/products'] = { products: [P(1, '写作 App', { required: 3, alerts: 1 }), P(2, '工具站')] };
  routes['GET /api/compliance/products/1'] = { product: P(1, '写作 App'), assessment: null, items: [] };
  routes['GET /api/compliance/products/3'] = () => D3;
  routes['POST /api/compliance/products'] = () => D3;
  routes['POST /api/compliance/products/3/assess'] = () => (Object.assign(D3, D3done), D3);
  routes['PATCH /api/compliance/items/31'] = (b) => ({ item: { ...D3.items[0], ...b } });
  routes['PATCH /api/compliance/items/33'] = () => ({ item: { ...D3.items[2], stale: false } });
  routes['GET /api/compliance/reminders'] = { reminders: [{ itemId: 31 }, { itemId: 32 }] };
  assert.deepEqual(tabs.map((t) => t.dataset.view), ['intel', 'kb', 'pm', 'growth', 'compliance', 'memory'], 'HTML 默认顺序：情报、知识库、产品顾问、运营、合规、我的记忆');
  const cpTab = tabs.find((t) => t.dataset.view === 'compliance');
  await new Promise((r) => setTimeout(r, 260));
  await cpTab.fire('click');
  await tick();
  assert.equal($('view-compliance').hidden, false, '合规页可见');
  assert.equal(walk($('cp-side')).filter(cls('cp-prod')).length, 2, '左栏 2 个产品');
  assert.match(walk($('cp-side')).filter(cls('cp-prod'))[0].textContent, /必须办 3/);
  assert.match(cpTab.textContent, /2/, '有提醒时菜单显示角标');
  const inMain = (pred) => walk($('cp-main')).find(pred);
  const btnIn = (t) => inMain((el) => el.tagName === 'BUTTON' && el.textContent === t);
  await walk($('cp-side')).find((el) => el.tagName === 'BUTTON' && el.textContent === '新建产品').fire('click');
  const form = inMain((el) => el.tagName === 'FORM');
  inMain((el) => el.attrs.name === 'name').value = '写作助手';
  inMain((el) => el.attrs.name === 'description').value = '帮人写稿';
  await form.fire('submit');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/compliance/products').at(-1).body, { name: '写作助手', description: '帮人写稿' });
  const assessBtn = () => inMain(cls('cp-assess'));
  assert.equal(assessBtn().disabled, true, '未答完时判定按钮禁用');
  assert.match(assessBtn().textContent, /未答/);
  routes['POST /api/compliance/products/3/prefill'] = { answers: { ai_use: 'cn_api' }, basis: { ai_use: '调用 DeepSeek 接口' } };
  await btnIn('AI 预填').fire('click');
  await tick();
  assert.match(inMain(cls('cp-ai')).textContent, /AI 预填[\s\S]*调用 DeepSeek 接口/, '预填的题显示标记与依据');
  assert.ok(btnIn('调用已备案模型 API').className.includes('on'));
  assert.ok(btnIn('原样展示'), '预填 cn_api 后显示条件题');
  assert.match(assessBtn().textContent, /待确认/);
  await btnIn('App').fire('click');
  await btnIn('不用').fire('click');
  assert.ok(!inMain(cls('cp-ai')), '点选后视为确认，标记消失');
  assert.ok(!btnIn('原样展示'), '不用 AI 时不显示「对模型输出做了什么」');
  await btnIn('调用已备案模型 API').fire('click');
  assert.ok(btnIn('原样展示'), '调用 API 时显示条件题');
  await btnIn('不用').fire('click');
  await btnIn('一般个人信息').fire('click');
  await btnIn('不收集').fire('click');
  assert.ok(!btnIn('一般个人信息').className.includes('on'), '互斥选项自动取消其他');
  await btnIn('一般个人信息').fire('click');
  assert.ok(!btnIn('不收集').className.includes('on'));
  assert.equal(assessBtn().disabled, false);
  const okAssess = routes['POST /api/compliance/products/3/assess'];
  routes['POST /api/compliance/products/3/assess'] = { __status: 409, data: { error: '问卷已更新，请刷新' } };
  const metaCalls = () => calls.filter((c) => c.url === '/api/compliance/meta').length;
  const m0 = metaCalls();
  await assessBtn().fire('click');
  await tick();
  assert.equal(metaCalls(), m0 + 1, '409 后重新拉取问卷');
  await btnIn('不收集').fire('click');
  await btnIn('一般个人信息').fire('click');
  assert.ok(btnIn('一般个人信息').className.includes('on'), '409 后仍可继续作答');
  routes['POST /api/compliance/products/3/assess'] = okAssess;
  await assessBtn().fire('click');
  await tick();
  const ab = calls.filter((c) => c.url === '/api/compliance/products/3/assess').at(-1).body;
  assert.deepEqual(ab, { answers: { forms: ['app'], ai_use: 'none', pi: ['general'] }, version: 1, prefilled: ['ai_use'] });
  const groups = walk($('cp-main')).filter(cls('cp-group'));
  assert.match(groups[0].textContent, /必须办/);
  assert.match(groups[0].textContent, /ICP 备案/);
  assert.match(groups[0].textContent, /第四条/);
  assert.match(groups[1].textContent, /可能需要[\s\S]*大模型备案/);
  const links = walk($('cp-main')).filter((el) => el.tagName === 'A');
  assert.ok(links.length && links.every((a) => a.attrs.href.startsWith('https://') && a.attrs.rel === 'noopener noreferrer'));
  assert.match($('cp-main').textContent, /以属地主管部门口径为准/);
  assert.match($('cp-main').textContent, /无公开传播功能/);
  routes['POST /api/compliance/items/32/explain'] = () => ({ item: { ...D3.items[1], explain: '因为做了二次加工，建议咨询属地网信办' } });
  assert.ok(!walk(groups[0]).some((el) => el.textContent === '请顾问解释'), '必须办不显示解释按钮');
  await btnIn('请顾问解释').fire('click');
  await tick();
  assert.match($('cp-main').textContent, /建议咨询属地网信办/);
  await walk($('cp-tabs')).find((el) => el.textContent === '台账').fire('click');
  const row = (id) => inMain((el) => el.tagName === 'TR' && el.attrs['data-id'] === String(id));
  const sel = (id) => walk(row(id)).find((el) => el.tagName === 'SELECT');
  sel(31).value = 'done';
  await sel(31).fire('change');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'PATCH' && c.url === '/api/compliance/items/31').at(-1).body, { status: 'done' });
  const before = calls.length;
  promptAnswer = null;
  sel(32).value = 'na';
  await sel(32).fire('change');
  await tick();
  assert.ok(!calls.slice(before).some((c) => c.method === 'PATCH'), 'prompt 取消时不发请求');
  assert.equal(sel(32).value, 'todo', '下拉恢复原值');
  assert.match(row(33).textContent, /最新判定已不再适用/);
  await walk(row(33)).find((el) => el.tagName === 'BUTTON' && el.textContent === '保留').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/compliance/items/33').at(-1).body, { keep: true });
  routes['GET /api/compliance/reminders'] = { reminders: [] };
  await cpTab.fire('click');
  await tick();
  assert.ok(!walk(cpTab).some(cls('tab-badge')), '无提醒时去掉角标');
  ctx.show('pm');
  await ctx.openReview(8);
  await tick();
  const cpBtn = walk($('pm-result')).find((el) => el.tagName === 'BUTTON' && el.textContent === '做合规自查');
  assert.ok(cpBtn, '评审头部有「做合规自查」');
  await cpBtn.fire('click');
  await tick();
  assert.equal($('view-compliance').hidden, false, '跳到合规页');
  assert.equal(inMain((el) => el.attrs.name === 'review').value, '8', '新建表单选中评审 #8');
  assert.equal(inMain((el) => el.attrs.name === 'name').value, '一个足够长的点子描述', '产品名取评审原文');
  await walk($('cp-side')).find((el) => el.tagName === 'BUTTON' && el.textContent === '监管动态').fire('click');
  await tick();
  assert.equal($('view-feed').hidden, false, '监管动态跳到情报流');
  assert.equal($('grp').value, 'reg');
  assert.match(calls.filter((c) => c.url.startsWith('/api/items?')).at(-1).url, /grp=reg/);
  console.log('✓ 合规：新建、问卷、判定、台账、角标、评审入口、监管动态');

  // ---------- 合规材料 ----------
  Object.assign(CP_META, {
    entityFields: [{ key: 'company_name', label: '公司全称', type: 'text', max: 100 }, { key: 'contact_email', label: '联系邮箱', type: 'text', max: 100 }],
    factFields: [
      { key: 'site', label: '网址或 App 名称', group: '对外信息', type: 'text', max: 200 },
      { key: 'effective_date', label: '材料生效日期', group: '对外信息', type: 'date' },
      { key: 'sdks', label: '第三方 SDK', group: '数据', type: 'sdks' },
      { key: 'minor_mode', label: '是否有未成年人模式', group: '未成年人', type: 'select', options: [['', '未填'], ['yes', '有'], ['no', '没有']] },
    ],
    docKinds: [
      { kind: 'privacy_policy', name: '隐私政策', usage: 'public', items: [], chapters: [
        { key: 'intro', title: '引言与适用范围', mode: 'fixed', uses: ['entity.company_name', 'facts.effective_date'] },
        { key: 'collect', title: '我们收集和使用的个人信息', mode: 'model', uses: [] },
        { key: 'cookies', title: 'Cookie', mode: 'model', uses: [] },
        { key: 'contact', title: '联系我们', mode: 'fixed', uses: ['entity.contact_email'] },
      ] },
      { kind: 'app_statement', name: '应用说明（登记/备案用）', usage: 'filing', items: ['genai_register', 'genai_filing'], chapters: [{ key: 'basic', title: '基本情况', mode: 'model', uses: ['entity.company_name'] }] },
      { kind: 'security_report', name: '双新安全评估报告', usage: 'filing', items: ['security_assess'], chapters: [] },
    ],
  });
  const sec = (key, title, mode, x = {}) => ({ key, title, mode, ord: 0, body: '', rev: 0, origin: null, stale: false, removed: false, placeholders: [], updated_at: now, ...x });
  const DOC5 = { id: 5, product_id: 3, kind: 'privacy_policy', name: '隐私政策', usage: 'public', status: 'draft', template_version: 1, finalized_at: null, created_at: now, updated_at: now, sections: [
    sec('intro', '引言与适用范围', 'fixed', { body: '本政策适用于写作助手。', rev: 1, origin: 'fixed' }),
    sec('collect', '我们收集和使用的个人信息', 'model'),
    sec('cookies', 'Cookie', 'model'),
    sec('contact', '联系我们', 'fixed', { body: '- 联系邮箱：【待填：联系邮箱】\n\n| 名称 | 用途 |\n| --- | --- |\n| A\\|B | 统计 |', rev: 1, origin: 'fixed', placeholders: ['联系邮箱'] }),
  ] };
  const DOC6 = { ...DOC5, id: 6, kind: 'app_statement', name: '应用说明（登记/备案用）', usage: 'filing', sections: [sec('basic', '基本情况', 'model', { body: '基本情况正文', rev: 1, origin: 'generate' })] };
  let cards = () => [
    { kind: 'privacy_policy', name: '隐私政策', usage: 'public', items: [], available: true, reason: null, doc: null },
    { kind: 'app_statement', name: '应用说明（登记/备案用）', usage: 'filing', items: ['genai_register', 'genai_filing'], available: true, reason: null, doc: { id: 6, status: 'draft', placeholders: 0, stale: 0, pending: 0 } },
    { kind: 'security_report', name: '双新安全评估报告', usage: 'filing', items: ['security_assess'], available: false, reason: '当前判定不需要这份材料', doc: null },
  ];
  D3.facts = { site: 'a.com' };
  routes['GET /api/compliance/products'] = { products: [P(1, '写作 App'), P(3, '写作助手')] };
  routes['GET /api/compliance/entity'] = { entity: { company_name: '旧公司' } };
  routes['PUT /api/compliance/entity'] = (b) => ({ entity: b });
  routes['PUT /api/compliance/products/3/facts'] = (b) => ({ facts: b });
  routes['GET /api/compliance/products/3/docs'] = () => ({ docs: cards() });
  routes['POST /api/compliance/products/3/docs'] = () => ({ docs: null, doc: structuredClone(DOC5) });
  routes['GET /api/compliance/docs/6'] = () => ({ doc: structuredClone(DOC6) });
  routes['POST /api/compliance/docs/5/sections/collect/generate'] = { __status: 502, data: { error: '模型调用失败，请稍后重试' } };
  routes['POST /api/compliance/docs/5/sections/cookies/generate'] = () => ({ section: sec('cookies', 'Cookie', 'model', { body: 'Cookie 正文', rev: 1, origin: 'generate' }) });
  routes['PUT /api/compliance/docs/5/sections/contact'] = (b) => ({ section: sec('contact', '联系我们', 'fixed', { body: b.body, rev: 2, origin: 'edit' }) });
  routes['GET /api/compliance/docs/5/sections/contact/revisions'] = () => ({
    revisions: [{ n: 2, origin: 'edit', created_at: now, chars: 4 }, { n: 1, origin: 'fixed', created_at: now, chars: 20 }],
    revision: { n: 1, body: '旧', origin: 'fixed', created_at: now, diff: { lines: [{ t: '-', s: '旧' }, { t: '+', s: '新的联系方式' }], clipped: false } },
  });
  routes['POST /api/compliance/docs/5/finalize'] = { __status: 400, data: { error: '还有待填内容', placeholders: [{ key: 'contact', title: '联系我们', fields: ['联系邮箱'] }] } };

  const side = (t) => walk($('cp-side')).find((el) => el.tagName === 'BUTTON' && el.textContent.startsWith(t));
  const inMainAll = (pred) => walk($('cp-main')).filter(pred);
  await cpTab.fire('click');
  await tick();
  assert.ok(side('主体信息'), '侧栏有「主体信息」');
  await side('主体信息').fire('click');
  await tick();
  assert.equal($('cp-tabs').hidden, true, '主体信息不显示产品标签');
  const company = inMain((el) => el.attrs.name === 'company_name');
  assert.equal(company.value, '旧公司');
  company.value = '某某科技有限公司';
  await inMain((el) => el.tagName === 'FORM').fire('submit');
  await tick();
  assert.equal(calls.filter((c) => c.method === 'PUT' && c.url === '/api/compliance/entity').at(-1).body.company_name, '某某科技有限公司');

  await side('写作助手').fire('click');
  await tick();
  assert.deepEqual(walk($('cp-tabs')).filter((el) => el.tagName === 'BUTTON').map((b) => b.textContent), ['问卷', '判定结果', '台账', '资料', '材料']);
  const cpTabBtn = (t) => walk($('cp-tabs')).find((el) => el.tagName === 'BUTTON' && el.textContent === t);
  await cpTabBtn('资料').fire('click');
  await tick();
  assert.equal(inMain((el) => el.attrs.name === 'site').value, 'a.com');
  const missing = inMain(cls('cp-facts-missing'));
  assert.ok(missing, '页顶列出未填字段');
  assert.match(missing.textContent, /材料生效日期（影响：隐私政策）/);
  assert.match(missing.textContent, /联系邮箱（影响：隐私政策）/, '主体字段也列入');
  assert.ok(!/公司全称/.test(missing.textContent), '已填字段不列');
  assert.ok(!/双新安全评估报告/.test(missing.textContent), '不可起草的材料不列入影响');
  await btnIn('添加一行').fire('click');
  const sdkName = inMain((el) => el.attrs.name === 'sdk-name');
  assert.ok(sdkName, 'SDK 表出现一行');
  sdkName.value = '友盟';
  await sdkName.fire('input');
  await inMain((el) => el.tagName === 'FORM').fire('submit');
  await tick();
  const fb = calls.filter((c) => c.method === 'PUT' && c.url === '/api/compliance/products/3/facts').at(-1).body;
  assert.equal(fb.sdks.length, 1);
  assert.equal(fb.sdks[0].name, '友盟');
  assert.equal(fb.site, 'a.com');

  await cpTabBtn('材料').fire('click');
  await tick();
  const pp = inMain((el) => el.tagName === 'ARTICLE' && el.attrs['data-kind'] === 'privacy_policy');
  assert.ok(pp, '隐私政策卡片');
  assert.match(inMain((el) => el.tagName === 'DETAILS').textContent, /双新安全评估报告 — 当前判定不需要这份材料/);
  await walk(pp).find((el) => el.tagName === 'BUTTON' && el.textContent === '起草').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/compliance/products/3/docs').at(-1).body, { kind: 'privacy_policy' });
  const tocText = () => inMain(cls('cp-doc-toc')).textContent;
  assert.match(tocText(), /未生成/);
  await btnIn('生成剩余章节').fire('click');
  await tick();
  const gens = calls.filter((c) => c.url.startsWith('/api/compliance/docs/5/') && c.url.endsWith('/generate')).map((c) => c.url.split('/').at(-2));
  assert.deepEqual(gens, ['collect', 'cookies'], '按目录顺序，失败后继续下一章');
  assert.ok(btnIn('失败，重试'), '失败章显示「失败，重试」');
  assert.equal($('toast').textContent, '已生成 1 章，失败 1 章');

  const tocBtn = (t) => inMain((el) => el.tagName === 'BUTTON' && cls('cp-doc-sec')(el) && el.textContent.startsWith(t));
  await tocBtn('联系我们').fire('click');
  const marks = inMainAll((el) => el.tagName === 'MARK');
  assert.ok(marks.length && marks[0].textContent === '【待填：联系邮箱】' && cls('cp-ph')(marks[0]), '占位为 MARK 节点');
  assert.ok(inMainAll((el) => el.tagName === 'TD').some((td) => td.textContent.includes('A｜B')), '表格里的 \\| 不打断单元格');
  await btnIn('编辑').fire('click');
  const ta = inMain((el) => el.tagName === 'TEXTAREA');
  ta.value = '新的联系方式';
  await btnIn('保存').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'PUT' && c.url === '/api/compliance/docs/5/sections/contact').at(-1).body, { body: '新的联系方式', baseRev: 1 });
  assert.match(tocText(), /已编辑/);
  await btnIn('历史').fire('click');
  await tick();
  await inMain((el) => el.tagName === 'BUTTON' && el.textContent.startsWith('第 1 版')).fire('click');
  await tick();
  assert.match(calls.at(-1).url, /revisions\?rev=1$/);
  assert.ok(inMainAll(cls('wiki-diff')).some((d) => walk(d).some(cls('add'))), '差异有新增行');

  await btnIn('定稿').fire('click');
  await tick();
  assert.match(inMain(cls('cp-doc-err')).textContent, /联系我们：联系邮箱/);
  routes['POST /api/compliance/docs/5/finalize'] = () => {
    const d = structuredClone(DOC5);
    d.status = 'final';
    d.finalized_at = now;
    return { doc: d };
  };
  await btnIn('定稿').fire('click');
  await tick();
  assert.ok(!btnIn('编辑'), '定稿后无「编辑」');
  assert.ok(btnIn('取消定稿'), '定稿后有「取消定稿」');
  assert.ok(!inMain(cls('cp-doc-err')), '定稿成功后清除错误提示');
  const word = inMain((el) => el.tagName === 'A' && el.textContent === '导出 Word');
  assert.ok(word.attrs.href.startsWith('/api/compliance/docs/') && word.attrs.href.includes('format=docx'));

  await cpTabBtn('台账').fire('click');
  const r32 = inMain((el) => el.tagName === 'TR' && el.attrs['data-id'] === '32');
  const link = walk(r32).find((el) => el.tagName === 'BUTTON' && el.textContent === '应用说明（登记/备案用）');
  assert.ok(link, '台账事项行有对应材料链接');
  await link.fire('click');
  await tick();
  assert.equal(cpTabBtn('材料').attrs['aria-selected'], 'true', '切到材料标签');
  assert.ok(calls.some((c) => c.url === '/api/compliance/docs/6'), '打开对应材料');
  assert.match(inMain(cls('cp-doc-toc')).textContent, /基本情况/);

  // 生成期间：编辑中的草稿不丢；遇 400 停止；返回列表后不再画回材料页；材料对象被替换后不卡在「生成中」
  {
    const DOC7 = { ...DOC5, id: 7, sections: [
      sec('a', '甲章', 'model'), sec('b', '乙章', 'model'), sec('d', '丁章', 'model'),
      sec('c', '丙章', 'fixed', { body: '丙章正文', rev: 1, origin: 'fixed' }),
    ] };
    cards = () => [{ kind: 'privacy_policy', name: '隐私政策', usage: 'public', items: [], available: true, reason: null, doc: { id: 7, status: 'draft', placeholders: 0, stale: 0, pending: 3 } }];
    routes['GET /api/compliance/docs/7'] = () => ({ doc: structuredClone(DOC7) });
    const G = (k) => `POST /api/compliance/docs/7/sections/${k}/generate`;
    const gen7 = () => calls.filter((c) => c.url.startsWith('/api/compliance/docs/7/') && c.url.endsWith('/generate')).map((c) => c.url.split('/').at(-2));
    const defer = () => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; };
    const done = (k, title) => ({ section: sec(k, title, 'model', { body: `${title}正文`, rev: 1, origin: 'generate' }) });
    const back = async () => { await btnIn('← 全部材料').fire('click'); await tick(); };
    const open7 = async () => { await inMain((el) => el.tagName === 'BUTTON' && el.textContent === '打开').fire('click'); await tick(); };

    await back();
    await open7();
    const da = defer();
    routes[G('a')] = () => da.p;
    routes[G('b')] = { __status: 400, data: { error: '未配置 DEEPSEEK_API_KEY，无法调用模型' } };
    const run = btnIn('生成剩余章节').fire('click');
    await tick();
    await tocBtn('丙章').fire('click');
    await btnIn('编辑').fire('click');
    const ta = inMain((el) => el.tagName === 'TEXTAREA');
    ta.value = '写到一半的草稿';
    await ta.fire('input');
    da.resolve(done('a', '甲章'));
    await run;
    await tick();
    const ta2 = inMain((el) => el.tagName === 'TEXTAREA');
    assert.ok(ta2, '生成完成后仍在编辑');
    assert.equal(ta2.value, '写到一半的草稿', '生成过程中的重绘不丢编辑内容');
    assert.deepEqual(gen7(), ['a', 'b'], '遇 400（未配置模型）停止，不再请求后续章节');
    assert.equal($('toast').textContent, '未配置 DEEPSEEK_API_KEY，无法调用模型');
    await btnIn('取消').fire('click');

    const db7 = defer();
    routes[G('b')] = () => db7.p;
    routes[G('d')] = () => done('d', '丁章');
    const run2 = btnIn('生成剩余章节').fire('click');
    await tick();
    await back();
    db7.resolve(done('b', '乙章'));
    await run2;
    await tick();
    assert.ok(inMain((el) => el.tagName === 'ARTICLE'), '返回列表后，迟到的结果不把材料页画回来');
    assert.ok(!inMain(cls('cp-doc-toc')), '仍是列表页');
    assert.ok(!gen7().includes('d'), '返回列表后停止后续章节');

    await open7();
    const dd = defer();
    routes[G('d')] = () => dd.p;
    await tocBtn('丁章').fire('click');
    const one = btnIn('生成本章').fire('click');
    await tick();
    assert.match(inMain(cls('cp-doc-toc')).textContent, /生成中…/);
    routes['POST /api/compliance/docs/7/unfinalize'] = () => ({ doc: structuredClone(DOC7) });
    routes['POST /api/compliance/docs/7/finalize'] = () => ({ doc: structuredClone(DOC7) });
    await btnIn('定稿').fire('click');
    await tick();
    dd.resolve(done('d', '丁章'));
    await one;
    await tick();
    const tocNow = inMain(cls('cp-doc-toc')).textContent;
    assert.ok(!/生成中…/.test(tocNow), '材料对象被替换后，生成结束不卡在「生成中…」');
    assert.match(tocBtn('丁章').textContent, /已生成/);
  }
  console.log('✓ 合规材料：主体、资料、起草、逐章生成、编辑、历史、定稿、导出、台账链接');
}

// 13. 运营：新建投放、逐平台生成、失败重试、高亮、替换、保留、定稿拦截、复制、导出、历史
{
  const F = (key, label, kind, x = {}) => ({ key, label, kind, ...x });
  const GR_META = {
    platforms: [
      { id: 'xhs', name: '小红书', fields: [F('title', '标题', 'text', { max: 20 }), F('body', '正文', 'text', { min: 300, max: 800 }), F('tags', '话题标签', 'tags', { minItems: 3, maxItems: 8, max: 15, unit: '个' })], total: null },
      { id: 'wechat', name: '微信公众号', fields: [F('title', '标题', 'text', { max: 64 }), F('digest', '摘要', 'text', { max: 120 }), F('body', '正文', 'md', { min: 1500, max: 3000 })], total: null },
      { id: 'video', name: '抖音 / 视频号口播', fields: [F('hook', '开头 3 秒', 'text', { max: 40 }), F('shots', '分镜', 'items', { minItems: 4, maxItems: 8, unit: '段', item: [{ key: 'scene', label: '画面', max: 60 }, { key: 'line', label: '口播', max: 80 }] }), F('cta', '结尾引导', 'text', { max: 40 })], total: { label: '口播合计', min: 240, max: 300 } },
      { id: 'landing', name: '发布页 / 应用商店', fields: [F('slogan', '标语', 'text', { max: 20 }), F('subtitle', '副标题', 'text', { max: 30 }), F('points', '卖点', 'items', { minItems: 3, maxItems: 5, unit: '条', item: [{ key: 'title', label: '标题', max: 12 }, { key: 'desc', label: '说明', max: 40 }] }), F('store_desc', '商店简介', 'text', { max: 170 })], total: null },
    ],
    tones: [{ id: 'pro', label: '专业' }, { id: 'warm', label: '亲切' }, { id: 'lively', label: '活泼' }],
    products: [{ id: 3, name: '写作助手', description: '帮人写稿', assessed: true }, { id: 1, name: '写作 App', description: '', assessed: false }],
    rules: [{ id: 'superlative', label: '极限用语', basis: '《广告法》第九条第三项' }],
    llm: true,
    aiNotice: '文案由 AI 起草，发布时请用平台的「AI 生成」声明功能标注（《人工智能生成合成内容标识办法》第十条第一款）。',
  };
  const empty = (id, platform) => ({ id, platform, rev: 0, status: 'draft', origin: null, updated_at: now, fields: {}, check: { hits: [], lengths: [], mustOpen: 0, warnOpen: 0 }, missing: [], stale: false, review: null, review_base: null, reviewed_at: null });
  const hit = (x) => ({ reason: '原因', basis: '《广告法》第九条第三项', suggest: [], kept: null, ...x });
  const SUP = hit({ key: 'superlative:title:最好:0', rule: 'superlative', level: 'must', label: '极限用语', path: 'title', start: 0, end: 2, text: '最好', reason: '广告不得使用「最佳」「最高级」等用语', suggest: ['很好用', '出色'] });
  const PRICE = hit({ key: 'price:body:限时免费:0', rule: 'price', level: 'warn', label: '价格与优惠条件', path: 'body', start: 0, end: 4, text: '限时免费', reason: '优惠需写明条件和期限', basis: '《广告法》第八条' });
  const KEPT = { ...PRICE, kept: { reason: '活动确有期限，详见活动页', at: now } };
  const REVIEW = [{ quote: '每周写周报太痛苦了', issue: '可能制造焦虑', suggestion: '改成中性描述' }];
  const xhs = (x = {}) => ({
    ...empty(51, 'xhs'), rev: 1, origin: 'generate',
    fields: { title: '最好用的周报工具', body: '限时免费，每周写周报太痛苦了。', tags: ['效率', '周报', 'AI'] },
    check: { hits: [SUP, PRICE], lengths: [{ path: 'body', text: '正文 15 字，少于 300 字' }], mustOpen: 1, warnOpen: 1 },
    ...x,
  });
  const xhs2 = (x = {}) => xhs({
    rev: 2, origin: 'replace', fields: { ...xhs().fields, title: '很好用的周报工具' },
    check: { hits: [PRICE], lengths: [], mustOpen: 0, warnOpen: 1 }, review: REVIEW, review_base: 1, reviewed_at: now, ...x,
  });
  const C5 = { id: 5, name: 'v1.2 上线', product_id: 3, product_name: '写作助手', product_desc: '帮人写稿', points: ['自动写周报', '一键导出'], audience: '', offer: '', tone: 'warm', created_at: now, updated_at: now, ctx: { minors: false, ai: true, paid: false }, copies: [empty(51, 'xhs'), empty(52, 'landing')] };
  routes['GET /api/growth/meta'] = GR_META;
  routes['GET /api/growth/campaigns'] = { campaigns: [] };
  routes['POST /api/growth/campaigns'] = () => {
    routes['GET /api/growth/campaigns'] = { campaigns: [{ id: 5, name: 'v1.2 上线', product_name: '写作助手', updated_at: now, copies: [{ platform: 'xhs', state: 'must' }, { platform: 'landing', state: 'empty' }] }] };
    return { campaign: structuredClone(C5) };
  };
  routes['GET /api/growth/campaigns/5'] = () => ({ campaign: structuredClone(C5) });
  routes['POST /api/growth/copies/51/generate'] = () => ({ copy: xhs() });
  routes['POST /api/growth/copies/51/review'] = () => ({ copy: xhs({ review: REVIEW, review_base: 1, reviewed_at: now }) });
  routes['POST /api/growth/copies/52/generate'] = { __status: 502, data: { error: '模型调用失败，请稍后重试' } };

  const grTab = tabs.find((t) => t.dataset.view === 'growth');
  assert.ok(grTab, '菜单有运营');
  assert.match(html, /data-view="growth"[^>]*>运营</, '菜单文字为「运营」');
  await grTab.fire('click');
  await tick();
  assert.equal($('view-growth').hidden, false, '运营页可见');
  assert.match($('gr-side').textContent, /还没有投放/);
  const grIn = (pred) => walk($('gr-main')).find(pred);
  const grAll = (pred) => walk($('gr-main')).filter(pred);
  const grBtn = (t) => grIn((el) => el.tagName === 'BUTTON' && el.textContent === t);
  const field = (n) => grIn((el) => el.attrs.name === n);
  const form = grIn((el) => el.tagName === 'FORM');
  assert.ok(form, '没有投放时直接显示新建表单');
  const prodSel = field('product');
  assert.deepEqual(prodSel.children.map((o) => o.textContent), ['不关联，手填', '写作助手', '写作 App']);
  prodSel.value = '3';
  await prodSel.fire('change');
  assert.equal(field('product_name').value, '写作助手', '带入产品名');
  assert.equal(field('product_desc').value, '帮人写稿', '带入产品描述');
  field('name').value = 'v1.2 上线';
  const pts = grAll((el) => el.attrs.name === 'point');
  assert.equal(pts.length, 3, '默认 3 条卖点输入');
  pts[0].value = ' 自动写周报 ';
  pts[2].value = '一键导出';
  const plats = grAll((el) => el.attrs.name === 'platform');
  assert.deepEqual(plats.map((p) => p.attrs.value), ['xhs', 'wechat', 'video', 'landing']);
  assert.ok(plats.every((p) => p.checked), '默认全选平台');
  plats[1].checked = false;
  plats[2].checked = false;
  await form.fire('submit');
  await tick();
  assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/api/growth/campaigns').at(-1).body, {
    name: 'v1.2 上线', product_id: 3, product_name: '写作助手', product_desc: '帮人写稿', points: ['自动写周报', '一键导出'], audience: '', offer: '', tone: 'warm', platforms: ['xhs', 'landing'],
  });
  const grPosts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/growth/')).map((c) => c.url.replace('/api/growth/', ''));
  assert.deepEqual(grPosts(), ['campaigns', 'copies/51/generate', 'copies/51/review', 'copies/52/generate'], '按平台顺序生成，成功后立即复核，失败继续');
  assert.equal($('toast').textContent, '已生成 1 个平台，失败 1 个');
  const grTabs = () => grAll(cls('gr-tab')).map((b) => b.textContent);
  assert.deepEqual(grTabs(), ['小红书 · 必须改 1', '发布页 / 应用商店 · 失败，重试']);
  assert.match($('gr-side').textContent, /v1\.2 上线/, '侧栏出现新投放');

  const marks = grAll((el) => el.tagName === 'MARK' && cls('gr-hit')(el));
  assert.ok(marks.some((m) => cls('must')(m) && m.textContent === '最好'), '必须改的命中高亮');
  assert.ok(marks.some((m) => cls('warn')(m) && m.textContent === '限时免费'), '注意的命中高亮');
  assert.match($('gr-main').textContent, /第十条第一款/, 'AI 声明提醒');
  assert.match($('gr-main').textContent, /可能制造焦虑[\s\S]*改成中性描述/, '显示复核建议');
  assert.match($('gr-main').textContent, /正文 15 字，少于 300 字/, '显示字数提示');

  routes['POST /api/growth/copies/51/finalize'] = { __status: 400, data: { error: '还有必须修改的问题', issues: [{ path: 'title', text: '最好', label: '极限用语' }] } };
  await grBtn('定稿').fire('click');
  await tick();
  assert.equal($('toast').textContent, '还有必须修改的问题');
  assert.match(grIn(cls('gr-issues')).textContent, /极限用语：最好/, '定稿被拦时列出问题');

  routes['POST /api/growth/copies/51/replace'] = () => ({ copy: xhs2() });
  await grBtn('替换为：很好用').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/growth/copies/51/replace').at(-1).body, { baseRev: 1, items: [{ key: 'superlative:title:最好:0', with: '很好用' }] });
  assert.ok(!grIn(cls('gr-issues')), '替换后清除定稿拦截提示');
  assert.equal(grTabs()[0], '小红书 · 注意 1');
  assert.match($('gr-main').textContent, /AI 复核基于 v1/, '复核结果来自旧版本时提示');

  promptAnswer = null;
  const n0 = calls.length;
  await grBtn('保留').fire('click');
  assert.equal(prompts.at(-1), '保留理由（1–200 字）');
  assert.equal(calls.length, n0, '取消输入时不发请求');
  promptAnswer = '活动确有期限，详见活动页';
  routes['POST /api/growth/copies/51/keep'] = () => ({ copy: xhs2({ check: { hits: [KEPT], lengths: [], mustOpen: 0, warnOpen: 0 } }) });
  await grBtn('保留').fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c.url === '/api/growth/copies/51/keep').at(-1).body, { key: 'price:body:限时免费:0', reason: '活动确有期限，详见活动页' });
  assert.match($('gr-main').textContent, /保留理由：活动确有期限，详见活动页/);
  assert.ok(grBtn('取消保留'));
  assert.equal(grTabs()[0], '小红书 · 通过');

  const clips = [];
  ctx.navigator.clipboard.writeText = async (s) => { clips.push(s); };
  const copyBtn = grAll((el) => el.tagName === 'BUTTON' && el.textContent === '复制').find((b) => b.parentNode?.parentNode?.attrs?.['data-path'] === 'tags');
  assert.ok(copyBtn, '标签字段有「复制」');
  await copyBtn.fire('click');
  assert.deepEqual(clips, ['#效率 #周报 #AI'], '标签复制为 #a #b');

  routes['POST /api/growth/copies/51/finalize'] = () => ({ copy: xhs2({ status: 'final', check: { hits: [KEPT], lengths: [], mustOpen: 0, warnOpen: 0 } }) });
  await grBtn('定稿').fire('click');
  await tick();
  assert.ok(!grBtn('编辑') && !grBtn('重新生成') && !grBtn('取消保留'), '定稿后不能编辑、重新生成、取消保留');
  assert.ok(grBtn('取消定稿'), '定稿后有「取消定稿」');
  assert.equal(grTabs()[0], '小红书 · 已定稿');
  const exp = grIn((el) => el.tagName === 'A' && el.textContent === '导出 Markdown');
  assert.equal(exp?.attrs.href, '/api/growth/campaigns/5/export?format=md');

  routes['GET /api/growth/copies/51/revisions'] = { revisions: [{ n: 2, origin: 'replace', created_at: now, reviewed: true }, { n: 1, origin: 'generate', created_at: now, reviewed: true }] };
  routes['GET /api/growth/copies/51/revisions/1'] = {
    revision: { n: 1, origin: 'generate', created_at: now, fields: {}, text: '' },
    diff: { lines: [{ t: '-', s: '### 最好用的周报工具' }, { t: '+', s: '### 很好用的周报工具' }, { t: ' ', s: '' }], clipped: false },
  };
  await grBtn('历史').fire('click');
  await tick();
  const v1 = grIn((el) => el.tagName === 'BUTTON' && el.textContent.startsWith('v1 · 生成'));
  assert.ok(v1, '历史列出版本');
  await v1.fire('click');
  await tick();
  assert.match(calls.at(-1).url, /\/copies\/51\/revisions\/1\?diff=1$/);
  assert.ok(grIn(cls('wiki-diff')) && grIn((el) => el.tagName === 'MARK' && cls('chg')(el)), '差异含字符级高亮');
  assert.ok(!grBtn('回退到此版本'), '已定稿时不能回退');

  const land = { ...empty(52, 'landing'), rev: 1, origin: 'generate', fields: { slogan: '周报一键写好', subtitle: '给忙碌的打工人', points: [{ title: '自动写', desc: '读取日程生成' }, { title: '导出', desc: '一键导出' }, { title: '模板', desc: '多种模板' }], store_desc: '写周报的助手' } };
  routes['POST /api/growth/copies/52/generate'] = () => ({ copy: structuredClone(land) });
  routes['POST /api/growth/copies/52/review'] = () => ({ copy: { ...structuredClone(land), review: [], review_base: 1, reviewed_at: now } });
  await grAll(cls('gr-tab'))[1].fire('click');
  await grBtn('重试生成').fire('click');
  await tick();
  assert.deepEqual(grPosts().slice(-2), ['copies/52/generate', 'copies/52/review'], '重试：生成后复核');
  assert.equal(grTabs()[1], '发布页 / 应用商店 · 通过');
  assert.match($('gr-main').textContent, /没有发现语境问题/);
  console.log('✓ 运营：新建投放、逐平台生成、失败重试、高亮、替换、保留、定稿拦截、复制、导出、历史');
}

console.log('ALL PASS');
