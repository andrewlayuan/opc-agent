// 全屏原型页：精简工具栏 + 铺满屏幕的 iframe。外部数据只通过 textContent 写入 DOM
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const match = /^\/proto\/([1-9]\d*)\/([1-9]\d*)$/.exec(location.pathname);
const id = match ? Number(match[1]) : 0;
const n = match ? Number(match[2]) : 0;
const toolbar = document.getElementById('proto-toolbar');
const stage = document.getElementById('proto-stage');
let version = null;
let device = 'phone';
let slug = '';
let notes = false;
let frame = null;
let mounted = false;
let select = null;
let toastTimer = null;

function toast(msg) {
  let el = document.getElementById('proto-full-toast');
  if (!el) {
    el = h('div', { id: 'proto-full-toast', class: 'proto-full-toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function url() {
  return `/api/pm/reviews/${id}/prototypes/${n}/html?device=${device}${slug ? `#/${encodeURIComponent(slug)}` : ''}`;
}

function send(msg) {
  if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
}

function render() {
  toolbar.replaceChildren();
  toolbar.append(h('span', { class: 'proto-full-title', text: `原型 v${n}` }));
  select = h('select', {
    onchange: (e) => { slug = e.target.value; send({ type: 'proto:goto', slug }); },
  });
  for (const p of version?.pages || []) select.append(h('option', { value: p.slug, text: p.title || p.slug }));
  if (slug) select.value = slug;
  toolbar.append(select);
  toolbar.append(h('button', { class: device === 'phone' ? 'on' : '', text: '手机', onclick: () => { device = 'phone'; render(); } }));
  toolbar.append(h('button', { class: device === 'desktop' ? 'on' : '', text: '桌面', onclick: () => { device = 'desktop'; render(); } }));
  toolbar.append(h('button', {
    class: notes ? 'on' : '', text: '标注',
    onclick: () => { notes = !notes; render(); send({ type: 'proto:notes', on: notes }); },
  }));
  toolbar.append(h('a', { href: `/api/pm/reviews/${id}/prototypes/${n}/html?download=1`, text: '下载' }));
  toolbar.append(h('a', { href: `/#pm/${id}`, text: '返回评审' }));
  if (!frame) frame = h('iframe', {
    class: 'proto-full-frame', sandbox: 'allow-scripts', title: '原型预览',
    onload: () => {
      if (notes) send({ type: 'proto:notes', on: true });
      if (slug) send({ type: 'proto:goto', slug });
    },
  });
  const src = url();
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
  if (!mounted) { stage.append(frame); mounted = true; }
}

window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data || {};
  if (m.type !== 'proto:page') return;
  if (!(version?.pages || []).some((p) => p.slug === m.slug)) return;
  slug = m.slug;
  if (select) select.value = slug;
});

async function load() {
  try {
    const res = await fetch(`/api/pm/reviews/${id}/prototypes`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '原型列表读取失败');
    version = (data.prototypes || []).find((v) => v.n === n);
    if (!version) throw new Error('原型版本不存在');
    if (version.status !== 'done') throw new Error('原型还没生成完成');
    render();
  } catch (e) {
    toast(e.message);
  }
}

load();
