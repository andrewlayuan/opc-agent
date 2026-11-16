import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { assemble, SHELL } from './assemble.ts';
import { sanitizeHtml, tokenize } from './sanitize.ts';
import type { Outline, ProtoRow } from './types.ts';

type Listener = (e: any) => void;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

class El {
  tag: string;
  attrs = new Map<string, string>();
  children: any[] = [];
  parent: El | null = null;
  listeners = new Map<string, Listener[]>();
  constructor(tag: string) { this.tag = tag; }
  setAttribute(name: string, value: string) { this.attrs.set(name.toLowerCase(), String(value)); }
  getAttribute(name: string): string | null {
    const v = this.attrs.get(name.toLowerCase());
    return v === undefined ? null : v;
  }
  get classList() {
    const el = this;
    const names = () => new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    const save = (s: Set<string>) => el.setAttribute('class', [...s].join(' '));
    return {
      contains: (c: string) => names().has(c),
      add: (c: string) => { const s = names(); s.add(c); save(s); },
      remove: (c: string) => { const s = names(); s.delete(c); save(s); },
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !names().has(c) : !!force;
        const s = names();
        if (on) s.add(c); else s.delete(c);
        save(s);
        return on;
      },
    };
  }
  get dataset(): any {
    const el = this;
    return new Proxy({}, {
      get: (_t, k) => el.getAttribute('data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) ?? undefined,
      set: (_t, k, v) => { el.setAttribute('data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), String(v)); return true; },
    });
  }
  appendChild(child: any) { if (typeof child !== 'string') child.parent = this; this.children.push(child); return child; }
  get textContent(): string { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v: string) { this.children = [String(v)]; }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (el: El) => {
      for (const c of el.children) if (typeof c !== 'string') { if (matches(c, sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  closest(sel: string): El | null {
    let p: El | null = this;
    while (p) { if (matches(p, sel)) return p; p = p.parent; }
    return null;
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
}

function matches(el: El, sel: string): boolean {
  return sel.split(',').some((part) => {
    const s = part.trim();
    const m = /^([a-zA-Z][\w-]*)?(\.[\w-]+)?(\[[\w:-]+(?:="[^"]*")?\])?$/.exec(s);
    assert.ok(m, `unsupported selector: ${s}`);
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    if (m[2] && !el.classList.contains(m[2].slice(1))) return false;
    if (m[3]) {
      const a = /^\[([\w:-]+)(?:="([^"]*)")?\]$/.exec(m[3])!;
      if (!el.attrs.has(a[1])) return false;
      if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
    }
    return true;
  });
}

function buildTree(html: string): El {
  const root = new El('#root');
  const stack: El[] = [root];
  for (const t of tokenize(html)) {
    const top = stack[stack.length - 1];
    if (t.t === 'text') top.appendChild(t.v);
    else if (t.t === 'open') {
      const el = new El(t.tag);
      for (const [k, v] of t.attrs) el.setAttribute(k, v);
      top.appendChild(el);
      if (!t.self && !VOID.has(t.tag)) stack.push(el);
    } else {
      const idx = stack.map((e) => e.tag).lastIndexOf(t.tag);
      if (idx > 0) stack.length = idx;
    }
  }
  return root;
}

const outline: Outline = {
  product: '律审通',
  device: 'phone',
  theme: 'blue',
  nav: ['home', 'detail', 'me'],
  data: {},
  pages: [
    { slug: 'home', title: '首页', purpose: '展示入口', content: '常用操作都在这里', links: [] },
    { slug: 'detail', title: '订单详情', purpose: '查看订单', content: '展示订单状态', links: [] },
    { slug: 'me', title: '我的', purpose: '个人中心', content: '账号与设置', links: [] },
  ],
};

const homeHtml = sanitizeHtml(`
<div class="card">
  <button class="btn" data-goto="detail">去详情</button>
  <button class="btn" data-goto="订单详情">按标题去详情</button>
  <button class="btn" data-goto="nope">不存在的页</button>
  <div class="tabs">
    <button class="tab" data-tab="t:a">A</button><button class="tab" data-tab="t:b">B</button>
  </div>
  <div class="tab-panel" data-tab-panel="t:a">A 内容</div>
  <div class="tab-panel" data-tab-panel="t:b">B 内容</div>
  <button data-toggle>开关</button>
  <button data-toast="已收藏">收藏</button>
  <button data-open="filter">筛选</button>
  <div id="filter" class="sheet"><button data-close>关闭</button>筛选内容</div>
  <form data-goto="me" data-toast="已提交"><button type="submit">提交</button></form>
</div>`);

const protoRow: ProtoRow = {
  id: 1,
  review_id: 8,
  n: 1,
  created_at: 0,
  finished_at: 0,
  status: 'done',
  base_version_n: 1,
  from_n: null,
  request: '',
  note: '',
  progress: { stage: 'pages', done: 3, total: 3 },
  outline,
  pages: [
    { slug: 'home', title: '首页', html: homeHtml, error: null },
    { slug: 'detail', title: '订单详情', html: '<div class="card">详情</div>', error: null },
    { slug: 'me', title: '我的', html: '<div class="card">我的</div>', error: null },
  ],
  error: null,
};

function make() {
  const root = buildTree(assemble(protoRow));
  const all: El[] = [];
  const collect = (el: El) => {
    for (const c of el.children) if (typeof c !== 'string') { all.push(c); collect(c); }
  };
  collect(root);
  const document = {
    getElementById: (id: string) => all.find((e) => e.getAttribute('id') === id) || null,
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    createElement: (tag: string) => { const el = new El(tag); all.push(el); return el; },
  };
  const sent: any[] = [];
  const parent = { postMessage: (m: any) => { sent.push(m); } };
  const win: Record<string, Listener[]> = {};
  const window = {
    parent,
    addEventListener: (t: string, fn: Listener) => { if (!win[t]) win[t] = []; win[t].push(fn); },
  };
  const location = { hash: '' };
  const timers: Array<() => void> = [];
  vm.runInNewContext(SHELL.js, {
    document, window, location,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  const fire = (el: El, type: string) => {
    const e = { target: el, preventDefault() {} };
    let p: El | null = el;
    while (p) { for (const fn of p.listeners.get(type) || []) fn(e); p = p.parent; }
  };
  const message = (data: any, source: any) => { for (const fn of win.message || []) fn({ data, source }); };
  const q = (sel: string) => document.querySelectorAll(sel);
  return { document, sent, parent, location, fire, message, q, body: document.getElementById('proto-body') as El };
}

test('启动：只显示第一页，其余带 hidden，并发出 proto:ready', () => {
  const e = make();
  const ready = e.sent.filter((m) => m.type === 'proto:ready');
  assert.equal(ready.length, 1);
  assert.deepEqual(Array.from(ready[0].pages), ['home', 'detail', 'me']);
  const pages = e.q('section.pg');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].classList.contains('hidden'), false);
  assert.equal(pages[1].classList.contains('hidden'), true);
  assert.equal(pages[2].classList.contains('hidden'), true);
});

test('goto/back：按 slug 跳转、写 hash、发消息；data-back 返回上一页', () => {
  const e = make();
  const home = e.q('section.pg')[0];
  e.fire(home.querySelectorAll('[data-goto="detail"]')[0], 'click');
  assert.equal(e.q('section.pg')[0].classList.contains('hidden'), true);
  assert.equal(e.q('section.pg')[1].classList.contains('hidden'), false);
  assert.equal(e.location.hash, '#/detail');
  assert.equal(e.sent.filter((m) => m.type === 'proto:page').pop().slug, 'detail');
  e.fire(e.q('.back')[0], 'click');
  assert.equal(e.q('section.pg')[0].classList.contains('hidden'), false);
  assert.equal(e.location.hash, '#/home');
});

test('Review Focus 2：data-goto 写页面标题时跳到对应页面；未知 slug 显示占位', () => {
  const e = make();
  const home = e.q('section.pg')[0];
  e.fire(home.querySelectorAll('[data-goto="订单详情"]')[0], 'click');
  assert.equal(e.q('section.pg')[1].classList.contains('hidden'), false);
  const e2 = make();
  e2.fire(e2.q('section.pg')[0].querySelectorAll('[data-goto="nope"]')[0], 'click');
  const missing = e2.document.getElementById('proto-missing') as El;
  assert.ok(missing);
  assert.equal(missing.classList.contains('hidden'), false);
  assert.ok(missing.textContent.includes('这一页还没有设计'));
  assert.ok(missing.textContent.includes('可以在对话里让它补上'));
});

test('弹层、tab、toggle 与 toast', () => {
  const e = make();
  const home = e.q('section.pg')[0];
  e.fire(home.querySelectorAll('[data-open="filter"]')[0], 'click');
  const sheet = e.document.getElementById('filter') as El;
  assert.ok(sheet.classList.contains('open'));
  e.fire(sheet.querySelectorAll('[data-close]')[0], 'click');
  assert.equal(sheet.classList.contains('open'), false);
  e.fire(home.querySelectorAll('[data-tab="t:b"]')[0], 'click');
  const tabB = home.querySelectorAll('[data-tab="t:b"]')[0];
  const panelB = home.querySelectorAll('.tab-panel')[1];
  assert.ok(tabB.classList.contains('on'));
  assert.ok(panelB.classList.contains('on'));
  assert.equal(home.querySelectorAll('[data-tab="t:a"]')[0].classList.contains('on'), false);
  const toggle = home.querySelectorAll('[data-toggle]')[0];
  e.fire(toggle, 'click');
  assert.ok(toggle.classList.contains('on'));
  e.fire(home.querySelectorAll('[data-toast="已收藏"]')[0], 'click');
  const toast = e.document.getElementById('proto-toast') as El;
  assert.equal(toast.textContent, '已收藏');
  assert.ok(toast.classList.contains('on'));
});

test('表单提交：阻止默认提交，先提示再跳转', () => {
  const e = make();
  e.fire(e.q('section.pg')[0].querySelectorAll('form')[0], 'submit');
  assert.equal(e.q('section.pg')[2].classList.contains('hidden'), false);
  assert.equal((e.document.getElementById('proto-toast') as El).textContent, '已提交');
  assert.equal(e.location.hash, '#/me');
});

test('消息：标注开关只接受父窗口来源，goto 由父窗口控制', () => {
  const e = make();
  e.message({ type: 'proto:notes', on: true }, { postMessage() {} });
  assert.equal(e.body.classList.contains('notes'), false);
  e.message({ type: 'proto:notes', on: true }, e.parent);
  assert.ok(e.body.classList.contains('notes'));
  assert.ok(e.body.classList.contains('embedded'));
  const card = e.q('section.pg')[0].querySelectorAll('.note-card')[0];
  assert.ok(card.textContent.includes('展示入口'));
  assert.ok((e.document.getElementById('proto-map') as El).querySelectorAll('.map-item').length === 3);
  e.message({ type: 'proto:goto', slug: 'me' }, e.parent);
  assert.equal(e.q('section.pg')[2].classList.contains('hidden'), false);
});
