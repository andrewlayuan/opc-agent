import { initKb } from './kb.js';
import { initProto } from './proto-panel.js';
// 所有外部数据只通过 textContent 写入 DOM，链接只接受 http(s)
const $ = (id) => document.getElementById(id);
const TAB_VIEWS = ['feed', 'brief', 'pm', 'kb', 'memory', 'sources'];
const TAB_ORDER_KEY = 'opc.tabOrder';

function savedTabOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || '[]'); } catch { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const known = new Set(TAB_VIEWS);
  const clean = [...new Set(saved.filter((v) => known.has(v)))];
  return [...clean, ...TAB_VIEWS.filter((v) => !clean.includes(v))];
}

function tabButtons() {
  return Array.from(document.querySelectorAll('.tabs button'));
}

function applyTabOrder() {
  const buttons = tabButtons();
  const list = buttons[0]?.parentNode;
  if (!list) return;
  const byView = new Map(buttons.filter((b) => b?.dataset?.view).map((b) => [b.dataset.view, b]));
  for (const view of savedTabOrder()) {
    const b = byView.get(view);
    if (!b) continue;
    b.remove();
    list.append(b);
  }
}

let draggingTab = null;
let suppressTabClickUntil = 0;

function persistTabOrder() {
  try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(tabButtons().map((b) => b.dataset.view))); } catch {}
}

function moveTab(button, reference, before) {
  if (!button || !reference || button === reference) return;
  const list = reference.parentNode;
  const next = list.children[Array.from(list.children).indexOf(reference) + 1] ?? null;
  button.remove();
  list.insertBefore(button, before ? reference : next);
  persistTabOrder();
}

function bindTabDrag() {
  for (const b of tabButtons()) {
    b.setAttribute('draggable', 'true');
    b.setAttribute('title', '拖动排序，或用 Alt+方向键调整');
    b.addEventListener('dragstart', (e) => {
      draggingTab = b;
      b.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', b.dataset.view);
      }
    });
    b.addEventListener('dragover', (e) => {
      if (!draggingTab || draggingTab === b) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      b.classList.add('drop-target');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', (e) => {
      if (!draggingTab) return;
      e.preventDefault();
      moveTab(draggingTab, b, true);
      toast('菜单顺序已保存');
    });
    b.addEventListener('dragend', () => {
      draggingTab?.classList.remove('dragging');
      for (const x of tabButtons()) x.classList.remove('drop-target');
      draggingTab = null;
      suppressTabClickUntil = Date.now() + 250;
    });
    b.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const buttons = tabButtons();
      const i = buttons.indexOf(b);
      const j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
      if (j < 0 || j >= buttons.length) return;
      moveTab(b, buttons[j], e.key === 'ArrowLeft');
      b.focus();
      toast('菜单顺序已保存');
      suppressTabClickUntil = Date.now() + 250;
    });
  }
}

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

function safeHref(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
}

function extLink(url, text) {
  const href = safeHref(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text }) : h('span', { text });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

// ---------------- 状态 ----------------
const FOCUS = '*focus';
const state = { meta: null, topic: '', items: [], cursor: null, open: new Set(), loading: false, interests: { topics: [], minImportance: 3 } };
const topicLabel = (id) => state.meta?.topics.find((t) => t.id === id)?.label ?? id;

function filters() {
  const p = new URLSearchParams();
  let min = 0;
  if (state.topic === FOCUS) {
    p.set('topics', state.interests.topics.join(','));
    min = state.interests.minImportance;
  } else if (state.topic) p.set('topic', state.topic);
  if ($('grp').value) p.set('grp', $('grp').value);
  if ($('days').value) p.set('days', $('days').value);
  if ($('important').checked) min = 4;
  if (min) p.set('min', String(min));
  if ($('starred').checked) p.set('starred', '1');
  if ($('rel').checked) p.set('rel', '1');
  const q = $('q').value.trim();
  if (q) p.set('q', q);
  p.set('limit', '30');
  return p;
}

// ---------------- 动态 ----------------
function dots(n) {
  if (!n) return null;
  const el = h('span', { class: 'dots', title: `重要度 ${n}/5` });
  for (let i = 1; i <= 5; i++) el.append(h('span', { class: i <= n ? '' : 'off', text: '•' }));
  return el;
}

const relTag = (it) => (it.relevance >= 2 ? h('span', { class: 'rel', title: it.relevance_zh || '与你当前的项目或关注相关', text: '与你相关' }) : null);

function renderItem(it) {
  const zhTitle = it.title_zh || it.title;
  const showOrig = it.title_zh && it.title_zh !== it.title;
  const li = h('li', { class: 'item' });
  li.append(
    h('div', { class: 'meta' }, h('span', { text: it.source_name }), h('span', { text: '·' }), h('span', { text: ago(it.published_at) }), dots(it.importance), it.starred ? h('span', { text: '★' }) : null),
    h('div', { class: 'title-row' }, h('a', { class: 'title', href: '#', onclick: (e) => { e.preventDefault(); toggleOpen(it.id, li); }, text: zhTitle }), relTag(it)),
    showOrig ? h('p', { class: 'orig', text: it.title }) : null,
    it.summary_zh ? h('p', { class: 'summary', text: it.summary_zh }) : !it.analyzed ? h('p', { class: 'summary muted', text: it.analysis_error ? '分析失败，展开后可重试' : '待分析' }) : null,
    it.topics.length ? h('div', { class: 'tags' }, it.topics.map((t) => h('span', { class: 'tag', text: topicLabel(t) }))) : null,
  );
  if (state.open.has(it.id)) li.append(renderDetailShell(it, li));
  return li;
}

function renderDetailShell(it, li) {
  const box = h('div', { class: 'detail', text: '加载中…' });
  loadDetail(it.id, box, li);
  return box;
}

async function loadDetail(id, box, li) {
  try {
    const { item } = await api(`/api/items/${id}`);
    box.replaceChildren(...detailChildren(item, box, li));
  } catch (e) {
    box.replaceChildren(h('p', { class: 'err', text: e.message }));
  }
}

function detailChildren(item, box, li) {
  const out = [];
  if (item.relevance >= 2 && item.relevance_zh) out.push(h('div', { class: 'label', text: '与你相关' }), h('p', { class: 'rel-why', text: item.relevance_zh }));
  if (item.analysis.length) {
    out.push(h('div', { class: 'label', text: '分析' }), h('ul', {}, item.analysis.map((a) => h('li', { text: a }))));
  } else if (item.analysis_error) {
    out.push(h('p', { class: 'err', text: item.analysis_error }));
  }
  const trBox = h('div', { class: 'translation' });
  if (item.translation_zh) {
    out.push(h('div', { class: 'label', text: '中文翻译' }), h('div', { class: 'translation', text: item.translation_zh }));
  } else if (item.content) {
    out.push(h('div', { class: 'label', text: item.lang === 'zh' ? '原文摘录' : '原文摘录（英文）' }), h('div', { class: 'excerpt', text: item.content }));
  }
  out.push(trBox);
  const actions = h('div', { class: 'actions' });
  actions.append(extLink(item.url, '阅读原文 ↗'));
  if (item.lang !== 'zh' && !item.translation_zh && item.content) {
    actions.append(
      h('button', {
        class: 'link',
        text: '翻译成中文',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          b.textContent = '翻译中…';
          try {
            const { translation } = await api(`/api/items/${item.id}/translate`, { method: 'POST', body: {} });
            trBox.replaceChildren(h('div', { class: 'label', text: '中文翻译' }), h('div', { text: translation }));
            b.remove();
          } catch (err) {
            toast(err.message);
            b.disabled = false;
            b.textContent = '翻译成中文';
          }
        },
      }),
    );
  }
  actions.append(
    h('button', {
      class: 'link',
      text: item.analyzed ? '重新分析' : '分析',
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = '分析中…';
        try {
          const { item: fresh } = await api(`/api/items/${item.id}/analyze`, { method: 'POST', body: {} });
          replaceItem(fresh, li);
        } catch (err) {
          toast(err.message);
          b.disabled = false;
          b.textContent = '重试分析';
        }
      },
    }),
    h('button', {
      class: 'link',
      text: item.starred ? '取消收藏' : '收藏',
      onclick: async () => {
        try {
          await api(`/api/items/${item.id}/star`, { method: 'POST', body: { starred: !item.starred } });
          replaceItem({ ...item, starred: !item.starred }, li);
        } catch (err) {
          toast(err.message);
        }
      },
    }),
    kb.button({ itemId: item.id }),
  );
  out.push(actions);
  return out;
}

function replaceItem(fresh, li) {
  const i = state.items.findIndex((x) => x.id === fresh.id);
  if (i >= 0) state.items[i] = { ...state.items[i], ...fresh };
  li.replaceWith(renderItem(state.items[i] ?? fresh));
}

/** 从知识库跳回动态：展开指定资讯（不在当前列表里时放到最前面） */
async function openItem(id) {
  show('feed');
  try {
    const { item } = await api(`/api/items/${id}`);
    if (!state.items.some((x) => x.id === id)) state.items.unshift(item);
    state.open.add(id);
    $('list').replaceChildren(...state.items.map(renderItem));
    $('empty').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    toast(e.message);
  }
}

function toggleOpen(id, li) {
  if (state.open.has(id)) state.open.delete(id);
  else state.open.add(id);
  const it = state.items.find((x) => x.id === id);
  if (it) li.replaceWith(renderItem(it));
}

async function loadItems(reset = true) {
  if (state.loading) return;
  state.loading = true;
  try {
    const p = filters();
    if (!reset && state.cursor) p.set('before', String(state.cursor));
    const { items } = await api(`/api/items?${p}`);
    if (reset) {
      state.items = [];
      $('list').replaceChildren();
    }
    state.items.push(...items);
    $('list').append(...items.map(renderItem));
    state.cursor = items.length ? items[items.length - 1].published_at : state.cursor;
    $('more').hidden = items.length < 30;
    $('empty').hidden = state.items.length > 0;
    $('empty').textContent = state.topic === FOCUS ? '关注方向下暂时没有符合条件的内容，可以放宽重点程度或时间范围。' : '暂无内容。点右上角「刷新」开始采集。';
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
  }
}

function selectTopic(id) {
  if (id === FOCUS && !state.interests.topics.length) {
    openFocusEditor();
    return;
  }
  state.topic = id;
  renderTopics();
  loadItems();
}

function renderTopics() {
  const all = [{ id: FOCUS, label: '★ 我的关注' }, { id: '', label: '全部' }, ...state.meta.topics];
  $('topics').replaceChildren(
    ...all.map((t) => h('button', { class: `chip${t.id === FOCUS ? ' focus' : ''}${state.topic === t.id ? ' on' : ''}`, text: t.label, onclick: () => selectTopic(t.id) })),
  );
  const bar = $('focus-bar');
  bar.hidden = state.topic !== FOCUS;
  if (!bar.hidden) {
    const minText = { 0: '全部内容', 3: '重要度 ≥3', 4: '只看重要（≥4）' }[state.interests.minImportance];
    bar.replaceChildren(
      h('span', { text: `关注：${state.interests.topics.map(topicLabel).join('、')} · ${minText}` }),
      h('button', { class: 'link', text: '调整', onclick: openFocusEditor }),
    );
  }
}

// ---------------- 我的关注 ----------------
let focusDraft = new Set();
function openFocusEditor() {
  focusDraft = new Set(state.interests.topics);
  const box = $('focus-topics');
  const draw = () =>
    box.replaceChildren(
      ...state.meta.topics.map((t) =>
        h('button', {
          type: 'button',
          class: `chip${focusDraft.has(t.id) ? ' on' : ''}`,
          'aria-pressed': focusDraft.has(t.id) ? 'true' : 'false',
          text: t.label,
          onclick: () => {
            if (focusDraft.has(t.id)) focusDraft.delete(t.id);
            else focusDraft.add(t.id);
            draw();
          },
        }),
      ),
    );
  draw();
  $('focus-min').value = String(state.interests.minImportance);
  $('focus-edit').hidden = false;
}

async function saveFocus(e) {
  e.preventDefault();
  if (!focusDraft.size) {
    toast('至少选择一个方向');
    return;
  }
  try {
    const { interests } = await api('/api/prefs/interests', { method: 'PUT', body: { topics: [...focusDraft], minImportance: Number($('focus-min').value) } });
    state.interests = interests;
    $('focus-edit').hidden = true;
    selectTopic(FOCUS);
    toast('已保存我的关注');
  } catch (err) {
    toast(err.message);
  }
}

// ---------------- 状态与刷新 ----------------
let pollTimer;
async function refreshStatus() {
  try {
    const { state: st, stats } = await api('/api/status');
    const text = st.running ? `${st.phase}…` : `今日 ${stats.today} 条 · 待分析 ${stats.pending}`;
    $('status').textContent = state.meta?.llm.enabled ? text : `${text} · 未配置模型`;
    $('refresh').disabled = st.running;
    clearTimeout(pollTimer);
    if (st.running) {
      pollTimer = setTimeout(async () => {
        await refreshStatus();
      }, 3000);
      state.wasRunning = true;
    } else if (state.wasRunning) {
      state.wasRunning = false;
      toast(st.lastResult || '完成');
      loadItems();
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------- 简报 ----------------
/** 把模型输出的简化 Markdown 转为 DOM（全部 textContent，不解析 HTML）；[n] 映射为服务端给出的来源链接 */
function renderMarkdown(content, refList = []) {
  const refs = new Map(refList.map((x) => [x.n, x]));
  const inline = (text) => {
    const line = text.replace(/\*\*/g, '').replace(/`/g, '');
    const parts = [];
    let last = 0;
    for (const m of line.matchAll(/\[(\d{1,3})\]/g)) {
      parts.push(line.slice(last, m.index));
      const r = refs.get(Number(m[1]));
      parts.push(r ? h('sup', {}, extLink(r.url, `${m[1]}`)) : m[0]);
      last = m.index + m[0].length;
    }
    parts.push(line.slice(last));
    return parts;
  };
  const cells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const nodes = [];
  let ul = null;
  let table = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) table = null;
    if (!line) {
      ul = null;
      continue;
    }
    if (line.startsWith('|')) {
      ul = null;
      if (/^\|?[\s:|-]+\|?$/.test(line)) continue; // 表头分隔行
      if (!table) {
        table = h('tbody');
        nodes.push(h('div', { class: 'table-wrap' }, h('table', {}, table)));
        table.append(h('tr', {}, cells(line).map((c) => h('th', {}, inline(c)))));
      } else table.append(h('tr', {}, cells(line).map((c) => h('td', {}, inline(c)))));
    } else if (/^#{1,2}\s/.test(line)) {
      ul = null;
      nodes.push(h('h3', { text: line.replace(/^#+\s*/, '').replace(/\*\*/g, '') }));
    } else if (/^#{3,6}\s/.test(line)) {
      ul = null;
      nodes.push(h('h4', { text: line.replace(/^#+\s*/, '').replace(/\*\*/g, '') }));
    } else if (/^[-*•]\s|^\d+[.、)]\s/.test(line)) {
      if (!ul) nodes.push((ul = h('ul')));
      ul.append(h('li', {}, inline(line.replace(/^([-*•]|\d+[.、)])\s*/, ''))));
    } else if (/^-{3,}$/.test(line)) {
      ul = null;
    } else {
      ul = null;
      nodes.push(h('p', {}, inline(line)));
    }
  }
  if (refList.length) {
    nodes.push(h('div', { class: 'refs' }, h('div', { text: '来源' }), h('ol', {}, refList.map((x) => h('li', {}, extLink(x.url, x.title), h('span', { text: ` · ${x.source}` }))))));
  }
  return nodes;
}

function renderBrief(b) {
  const box = $('brief');
  if (!b) {
    $('brief-time').textContent = '';
    box.replaceChildren(h('p', { class: 'empty', text: '还没有简报。' }));
    return;
  }
  $('brief-time').textContent = `生成于 ${new Date(b.created_at).toLocaleString('zh-CN')}`;
  box.replaceChildren(...renderMarkdown(b.content, b.items));
}

async function loadBrief() {
  try {
    const { brief } = await api('/api/brief');
    renderBrief(brief);
  } catch (e) {
    toast(e.message);
  }
}

// ---------------- 信息源 ----------------
async function loadSources() {
  try {
    const { sources } = await api('/api/sources');
    const byGrp = new Map();
    for (const s of sources) {
      if (!byGrp.has(s.grp)) byGrp.set(s.grp, []);
      byGrp.get(s.grp).push(s);
    }
    const nodes = [];
    for (const [grp, list] of byGrp) {
      nodes.push(h('div', { class: 'grp-title', text: state.meta.groups[grp] ?? grp }));
      for (const s of list) {
        const ok = s.last_ok_at && (!s.last_error || s.last_ok_at >= s.last_fetch_at);
        const info = s.last_error ? s.last_error : s.last_fetch_at ? `${ago(s.last_fetch_at)} · 共 ${s.item_count} 条` : '未抓取';
        nodes.push(
          h(
            'div',
            { class: 'src' },
            h('span', { class: `dot ${s.last_error ? 'bad' : ok ? 'ok' : ''}`, title: s.last_error || '' }),
            h('span', { class: 'name' }, extLink(s.url, s.name)),
            h('span', { class: 'info', text: info }),
            h('input', {
              type: 'checkbox',
              checked: s.enabled ? true : null,
              title: '启用',
              onchange: async (e) => {
                try {
                  await api(`/api/sources/${encodeURIComponent(s.id)}/toggle`, { method: 'POST', body: { enabled: e.target.checked } });
                } catch (err) {
                  toast(err.message);
                  e.target.checked = !e.target.checked;
                }
              },
            }),
            s.custom
              ? h('button', {
                  class: 'link',
                  text: '删除',
                  onclick: async () => {
                    if (!confirm(`删除「${s.name}」及其全部条目？`)) return;
                    try {
                      await api(`/api/sources/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                      loadSources();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                })
              : null,
          ),
        );
      }
    }
    $('sources').replaceChildren(...nodes);
  } catch (e) {
    toast(e.message);
  }
}

// ---------------- 产品顾问 ----------------
const pm = {
  meta: null,
  current: null,
  pollTimer: null,
  sel: { presets: [], skills: [] },
  openSeq: 0,
  review: null,
  view: { id: 0, n: 0 },
  verCache: new Map(),
  edit: null,
  att: { form: [], reply: [], replyFor: 0, replyEl: null, replySync: null },
  tabs: new Map(),
  draft: { id: 0, text: '', revise: false },
  dom: null,
  sig: {},
};

const PM_TABS = [['doc', '文档'], ['chat', '对话'], ['proto', '原型']];
const PM_SIDE_KEY = 'opc.pmSide';
const TRUNC_NOTE = '输出达到上限，内容可能不完整';
const isNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;

function setPmSide(collapsed, save = true) {
  $('pm-layout').classList.toggle('collapsed', collapsed);
  const t = $('pm-side-toggle');
  t.textContent = collapsed ? '展开列表' : '收起列表';
  t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  if (save) {
    try { localStorage.setItem(PM_SIDE_KEY, collapsed ? 'collapsed' : 'open'); } catch {}
  }
}

function initPmSide() {
  let saved = null;
  try { saved = localStorage.getItem(PM_SIDE_KEY); } catch {}
  setPmSide(saved ? saved === 'collapsed' : isNarrow(), false);
}

/** 未打开评审时显示新建表单，打开后显示详情 */
function pmShowMode(r) {
  const open = !!r;
  $('pm-form').hidden = open;
  $('pm-result').hidden = !open;
  $('pm-new').hidden = !open;
  $('pm-crumb').textContent = open ? `#${r.id} ${clipText(r.input.replace(/\s+/g, ' '), 40)}` : '新建评审';
}

function markPmHistory() {
  for (const li of $('pm-history').children) li.classList?.toggle('on', Number(li.getAttribute?.('data-id')) === pm.current);
}

function newPmReview() {
  if (pm.edit && !confirm('放弃未保存的编辑？')) return false;
  clearTimeout(pm.pollTimer);
  pm.openSeq++;
  pm.current = null;
  pm.review = null;
  pm.edit = null;
  proto.leave();
  pmShowMode(null);
  markPmHistory();
  $('pm-input').focus();
  return true;
}

// ---------- 附件 ----------
const ATT_MAX = 8;
const ATT_FILE_MAX = 10 * 1024 * 1024;
const ATT_POLL_MS = 1500;
const ATT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.docm,.rtf,.odt,.wps,.xls,.xlsx,.xlsm,.ods,.et,.ppt,.pptx,.pptm,.odp,.dps,.html,.htm,.xhtml,.txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml';
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
let attSeq = 0;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attGate(list) {
  if (list.some((a) => a.status === 'uploading' || a.status === 'processing')) return '附件处理中';
  if (list.some((a) => a.status === 'error')) return '请先移除失败的附件';
  return '';
}

const attIds = (list) => list.filter((a) => a.status === 'ready' && a.id).map((a) => a.id);

function attStatusText(a) {
  if (a.status === 'uploading') return '上传中';
  if (a.status === 'processing') return '处理中';
  if (a.status === 'error') return `失败：${a.error || '未知错误'}`;
  return a.truncated ? `已截取前 ${a.chars} 字` : '就绪';
}

function renderAttBar(list) {
  return list.map((a) =>
    h(
      'span',
      { class: `att-chip${a.status === 'error' ? ' err' : ''}` },
      h('span', { text: `${a.name} · ${fmtSize(a.size)} · ${attStatusText(a)}` }),
      h('button', { type: 'button', class: 'link', 'aria-label': `移除 ${a.name}`, title: '移除', text: '×', onclick: () => removeAtt(list, a.key) }),
    ),
  );
}

/** 附件状态变化后只重绘对应的附件栏与发送按钮 */
function refreshAtt(list) {
  if (list === pm.att.form) {
    $('pm-att').replaceChildren(...renderAttBar(list));
    syncPmSubmit();
  } else if (list === pm.att.reply) {
    pm.att.replySync?.();
  }
}

function syncPmSubmit() {
  const gate = attGate(pm.att.form);
  const btn = $('pm-submit');
  btn.disabled = !pm.meta?.enabled || !!gate;
  btn.title = gate;
}

function applyAtt(a, v) {
  Object.assign(a, { id: v.id, name: v.name, size: v.size, status: v.status, error: v.error || '', truncated: !!v.truncated, chars: v.chars || 0 });
}

async function uploadAtt(list, a, file) {
  let res;
  try {
    res = await fetch('/api/pm/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(a.name) },
      body: file,
    });
  } catch {
    Object.assign(a, { status: 'error', error: '上传失败，请检查网络' });
    return refreshAtt(list);
  }
  if (res.status === 401) {
    location.replace('/login');
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.attachment) {
    Object.assign(a, { status: 'error', error: data.error || `上传失败（${res.status}）` });
    return refreshAtt(list);
  }
  // 上传期间已被移除：服务端的记录也删掉
  if (!list.includes(a)) {
    api(`/api/pm/uploads/${data.attachment.id}`, { method: 'DELETE' }).catch(() => {});
    return;
  }
  applyAtt(a, data.attachment);
  refreshAtt(list);
  pollAtt(list, a);
}

async function pollAtt(list, a) {
  while (a.status === 'processing' && list.includes(a)) {
    try {
      const { attachment } = await api(`/api/pm/uploads/${a.id}`);
      if (!list.includes(a)) return;
      applyAtt(a, attachment);
      refreshAtt(list);
    } catch (e) {
      if (!list.includes(a)) return;
      if (e.status === 404) {
        Object.assign(a, { status: 'error', error: '附件不存在' });
        return refreshAtt(list);
      }
    }
    if (a.status !== 'processing') return;
    await new Promise((r) => setTimeout(r, ATT_POLL_MS));
  }
}

async function addFiles(list, files) {
  files = [...files];
  if (!files.length) return;
  if (list.length + files.length > ATT_MAX) return toast(`一次最多 ${ATT_MAX} 个附件`);
  const todo = [];
  for (const f of files) {
    if (f.size > ATT_FILE_MAX) {
      toast(`${f.name} 超过 10MB`);
      continue;
    }
    const a = { key: ++attSeq, name: f.name, size: f.size, status: 'uploading', id: 0, error: '', truncated: false, chars: 0 };
    list.push(a);
    todo.push([a, f]);
  }
  refreshAtt(list);
  for (const [a, f] of todo) if (list.includes(a)) await uploadAtt(list, a, f);
}

async function removeAtt(list, key) {
  const i = list.findIndex((a) => a.key === key);
  if (i < 0) return;
  const a = list[i];
  if (a.id) await api(`/api/pm/uploads/${a.id}`, { method: 'DELETE' }).catch(() => {});
  const j = list.indexOf(a);
  if (j >= 0) list.splice(j, 1);
  refreshAtt(list);
}

/** 剪贴板里的图片：改名为「粘贴的图片-HHMMSS.ext」；没有图片时按普通粘贴处理 */
function onPasteFiles(e, list) {
  const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => IMG_EXT[f.type]);
  if (!imgs.length) return;
  e.preventDefault();
  const d = new Date();
  const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('');
  addFiles(list, imgs.map((f) => new File([f], `粘贴的图片-${hms}.${IMG_EXT[f.type]}`, { type: f.type })));
}

function bindDrop(el, list) {
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(list(), e.dataTransfer?.files ?? []);
  });
}

/** 已发送的附件：图片缩略图在新标签打开，文档点击下载 */
function attList(atts) {
  if (!atts?.length) return null;
  return h(
    'div',
    { class: 'att-list' },
    atts.map((a) => {
      const href = `/api/pm/uploads/${a.id}/file`;
      if (a.kind === 'image') return h('a', { href, target: '_blank', rel: 'noopener', title: a.name }, h('img', { class: 'att-thumb', loading: 'lazy', alt: a.name, src: href }));
      return h('a', { class: 'att-file', href, download: true, text: `${a.name} · ${fmtSize(a.size)}` });
    }),
  );
}

async function initPm() {
  if (pm.meta) return;
  try {
    pm.meta = await api('/api/pm/meta');
  } catch (e) {
    toast(e.message);
    return;
  }
  renderPmPicker();
  if (!pm.meta.enabled) {
    $('pm-submit').disabled = true;
    $('pm-hint').textContent = !pm.meta.skillsFound ? '未找到 pm-skills：请在服务器上运行 scripts/setup-pm-skills.sh 后重启服务。' : '未配置 DEEPSEEK_API_KEY，无法生成反馈。';
  }
}

/** 多选：方案（预设组合）+ 自选框架；都不选 = 智能匹配 */
function pmMerged(sel = pm.sel) {
  const fromPresets = sel.presets.flatMap((id) => pm.meta.presets.find((p) => p.id === id)?.skills ?? []);
  return [...new Set([...fromPresets, ...sel.skills])];
}

function pmTry(next) {
  const n = pmMerged(next).length;
  if (n > pm.meta.maxSelected) {
    toast(`一次最多组合 ${pm.meta.maxSelected} 个框架（这样选会有 ${n} 个）`);
    return;
  }
  pm.sel = next;
  renderPmPicker();
}

function togglePreset(id) {
  if (id === 'auto') return pmTry({ presets: [], skills: [] });
  const on = pm.sel.presets.includes(id);
  pmTry({ ...pm.sel, presets: on ? pm.sel.presets.filter((x) => x !== id) : [...pm.sel.presets, id] });
}

function toggleSkill(name) {
  if (pm.sel.skills.includes(name)) return pmTry({ ...pm.sel, skills: pm.sel.skills.filter((x) => x !== name) });
  if (pmMerged().includes(name)) return toast('这个框架已包含在所选方案中');
  pmTry({ ...pm.sel, skills: [...pm.sel.skills, name] });
}

function renderPmPicker() {
  const merged = new Set(pmMerged());
  const auto = merged.size === 0;
  $('pm-presets').replaceChildren(
    ...pm.meta.presets.map((p) => {
      const on = p.id === 'auto' ? auto : pm.sel.presets.includes(p.id);
      return h('button', {
        type: 'button',
        class: `chip${on ? ' on' : ''}`,
        'aria-pressed': on ? 'true' : 'false',
        title: p.id === 'auto' ? '不选任何方案时，按内容自动挑选 2-3 个框架' : `${p.label}\n框架：${p.skills.join(' · ')}`,
        text: p.short,
        onclick: () => togglePreset(p.id),
      });
    }),
  );
  const groups = new Map();
  for (const s of pm.meta.skills) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  $('pm-skills').replaceChildren(
    ...[...groups].map(([g, list]) =>
      h(
        'div',
        { class: 'pm-skill-group' },
        h('div', { class: 'pm-skill-title', text: g }),
        h(
          'div',
          { class: 'chips wrap-chips' },
          list.map((s) => {
            const own = pm.sel.skills.includes(s.name);
            const via = !own && merged.has(s.name);
            return h('button', {
              type: 'button',
              class: `chip${own ? ' on' : ''}${via ? ' via' : ''}`,
              'aria-pressed': own ? 'true' : 'false',
              title: via ? `已包含在所选方案中\n${s.description}` : s.description,
              text: s.name,
              onclick: () => toggleSkill(s.name),
            });
          }),
        ),
      ),
    ),
  );
  $('pm-custom-count').textContent = pm.sel.skills.length ? `已选 ${pm.sel.skills.length} 个` : '';
  if (!pm.meta.enabled) return;
  const list = [...merged];
  $('pm-hint').textContent = auto
    ? '未选择方案：将根据你的描述自动挑选 2-3 个最合适的框架。'
    : `将组合 ${list.length}/${pm.meta.maxSelected} 个框架：${list.join(' · ')}${list.length === 1 && list[0] === 'create-prd' ? '（输出 PRD 初稿）' : ''}`;
}

const SOURCE_LABEL = { ai_initial: '首版', ai_revise: 'AI 改写', manual: '手动' };
const hasRunningTurn = (r) => (r.messages || []).some((m) => m.status === 'running');

/** 当前查看版本的正文；最新版随详情返回，其余版本来自缓存 */
function viewedContent(r) {
  if (pm.view.n === r.latest) return r.content || '';
  return pm.verCache.get(`${r.id}:${pm.view.n}`) ?? null;
}

function renderHead(r) {
  return [
    h('div', { class: 'meta' }, h('span', { class: 'pm-mode', text: r.mode_label }), h('span', { text: '·' }), h('span', { text: new Date(r.created_at).toLocaleString('zh-CN') }), h('span', { text: '·' }), h('span', { text: `#${r.id}` })),
    h('details', { class: 'pm-input' }, h('summary', { text: r.input.length > 60 ? `${r.input.slice(0, 60)}…` : r.input }), h('div', { text: r.input })),
    attList(r.attachments),
    r.skills.length ? h('div', { class: 'tags' }, r.skills.map((s) => h('span', { class: 'tag', text: s }))) : null,
    r.status === 'done'
      ? h(
          'div',
          { class: 'actions' },
          h('button', {
            class: 'link',
            text: '用相同内容和框架再评一次',
            onclick: () => {
              if (!newPmReview()) return;
              $('pm-input').value = r.input;
              updatePmCount();
              const known = new Set(pm.meta?.skills.map((s) => s.name) ?? []);
              const skills = r.skills.filter((s) => known.has(s));
              if (pm.meta && skills.length && skills.length <= pm.meta.maxSelected) {
                pm.sel = { presets: [], skills };
                renderPmPicker();
              }
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }),
          kb.button({ reviewId: r.id }),
        )
      : null,
  ];
}

function pmSkeleton() {
  if (pm.dom) return pm.dom;
  const head = h('div', { class: 'pm-head' });
  const status = h('div', { class: 'pm-status' });
  const tabs = h('div', { class: 'pm-tabs', role: 'tablist', 'aria-label': '评审内容' });
  const panes = {};
  for (const [k] of PM_TABS) panes[k] = h('div', { class: 'pm-pane', 'data-pane': k, role: 'tabpanel' });
  $('pm-result').replaceChildren(head, status, tabs, panes.doc, panes.chat, panes.proto);
  pm.dom = { head, status, tabs, panes, thread: null, reply: null };
  return pm.dom;
}

function renderPmTabs(r) {
  const d = pm.dom;
  const tab = pm.tabs.get(r.id) || 'doc';
  const turns = (r.messages || []).filter((m) => m.role === 'user').length;
  const badge = { doc: `v${r.latest}`, chat: turns ? String(turns) : '', proto: '' };
  d.tabs.replaceChildren(
    ...PM_TABS.map(([k, label]) =>
      h(
        'button',
        { type: 'button', role: 'tab', class: `pm-tab${k === tab ? ' on' : ''}`, 'aria-selected': k === tab ? 'true' : 'false', onclick: () => setPmTab(r.id, k) },
        label,
        badge[k] ? h('span', { class: 'pm-tab-n', text: ` ${badge[k]}` }) : null,
      ),
    ),
  );
  for (const [k] of PM_TABS) d.panes[k].hidden = k !== tab;
}

function setPmTab(id, tab) {
  pm.tabs.set(id, tab);
  if (pm.review?.id === id && pm.dom) renderPmTabs(pm.review);
}

/** 从对话跳到文档页并定位到指定版本开头 */
async function gotoDoc(id, n) {
  pm.tabs.set(id, 'doc');
  if (pm.edit) {
    toast('请先保存或取消编辑');
    if (pm.review) renderPmTabs(pm.review);
  } else {
    await selectVersion(id, n);
  }
  pm.dom?.tabs.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

/** 局部刷新：各区块按内容签名判断是否重建，未变化的区块（滚动位置、焦点、草稿）保持原样 */
function renderReview(r) {
  pm.review = r;
  const d = pmSkeleton();
  pmShowMode(r);
  markPmHistory();
  const sigHead = JSON.stringify([r.id, r.status, r.input, r.skills, r.mode_label, (r.attachments || []).map((a) => a.id)]);
  if (pm.sig.head !== sigHead) {
    pm.sig.head = sigHead;
    d.head.replaceChildren(...renderHead(r).filter(Boolean));
  }
  if (r.status === 'running' || r.status === 'error' || !r.latest) {
    proto.leave();
    pm.sig.doc = pm.sig.thread = pm.sig.reply = null;
    d.tabs.hidden = true;
    for (const [k] of PM_TABS) d.panes[k].hidden = true;
    d.panes.doc.replaceChildren();
    d.panes.chat.replaceChildren();
    d.thread = d.reply = null;
    d.status.hidden = false;
    d.status.replaceChildren(
      r.status === 'running'
        ? h('div', { class: 'brief' }, h('p', { class: 'muted', text: '正在评审…一般需要 1-3 分钟，可以先去看看别的，回来在左侧「历史评审」里查看。' }))
        : h('div', { class: 'brief' }, h('p', { class: 'err', text: `评审失败：${r.error || '没有可用的文档'}` })),
    );
    return;
  }
  d.status.hidden = true;
  d.status.replaceChildren();
  d.tabs.hidden = false;
  renderPmTabs(r);

  const busy = hasRunningTurn(r);
  const content = viewedContent(r);
  const cur = r.versions.find((v) => v.n === pm.view.n);
  const sigDoc = JSON.stringify([r.id, r.latest, pm.view.n, busy, pm.edit ? pm.edit.base : null, content == null ? -1 : content.length, r.versions.length, cur?.note ?? null]);
  if (pm.sig.doc !== sigDoc) {
    pm.sig.doc = sigDoc;
    d.panes.doc.replaceChildren(...[contextNote(r.context), renderVersions(r), renderVerNote(cur), renderDoc(r)].filter(Boolean));
  }

  const sigThread = JSON.stringify([r.id, busy, (r.messages || []).map((m) => [m.id, m.status, m.kind, m.version_n, (m.content || '').length, m.error, (m.attachments || []).length])]);
  const sigReply = JSON.stringify([r.id, busy || pm.edit != null]);
  if (pm.sig.thread !== sigThread || !d.thread) {
    pm.sig.thread = sigThread;
    const t = renderThread(r);
    if (d.thread && d.thread.parentNode === d.panes.chat) {
      d.panes.chat.insertBefore(t, d.thread);
      d.thread.remove();
    } else {
      d.panes.chat.insertBefore(t, d.panes.chat.children[0] ?? null);
    }
    d.thread = t;
  }
  if (pm.sig.reply !== sigReply || !d.reply) {
    pm.sig.reply = sigReply;
    const f = renderReply(r);
    if (d.reply && d.reply.parentNode === d.panes.chat) d.reply.remove();
    d.panes.chat.append(f);
    d.reply = f;
  }

  const panel = proto.panel(r, pm.view.n);
  for (const c of [...d.panes.proto.children]) if (c !== panel) c.remove();
  if (panel.parentNode !== d.panes.proto) d.panes.proto.append(panel);
}

function renderVerNote(v) {
  if (!v?.note) return null;
  return h('p', { class: `ver-note${v.note === TRUNC_NOTE ? ' warn' : ''}`, text: `本版说明：${v.note}` });
}

/** 「参考了 N 条记忆、M 次历史讨论、K 段知识库」：展开后列出记忆内容、可跳转的历史会话与知识库段落 */
function contextNote(c, inline = false) {
  const ms = c?.memories ?? [];
  const rs = c?.reviews ?? [];
  const ks = c?.kb ?? [];
  if (!ms.length && !rs.length && !ks.length) return null;
  const kbLabel = (k) => (k.wiki ? `Wiki：${k.title}` : `知识库：${k.title}${k.heading ? ` › ${k.heading}` : ''}`);
  return h(
    'details',
    { class: `pm-ctx${inline ? ' inline' : ''}` },
    h('summary', { text: `参考了 ${ms.length} 条记忆、${rs.length} 次历史讨论${ks.length ? `、${ks.length} 段知识库` : ''}` }),
    ms.length ? h('ul', {}, ms.map((m) => h('li', { text: `${MEM_LABEL[m.kind] ? `[${MEM_LABEL[m.kind]}] ` : ''}${m.content}` }))) : null,
    rs.length
      ? h(
          'ul',
          {},
          rs.map((x) =>
            h(
              'li',
              {},
              h('button', {
                type: 'button',
                class: 'link',
                text: `#${x.id} ${x.input}`,
                onclick: () => {
                  openReview(x.id);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                },
              }),
            ),
          ),
        )
      : null,
    ks.length
      ? h(
          'ul',
          {},
          ks.map((k) =>
            h(
              'li',
              {},
              k.exists
                ? h('button', { type: 'button', class: 'link', text: kbLabel(k), onclick: () => (k.wiki ? kb.openWiki?.(k.wiki) : kb.open(k.doc, k.ord)) })
                : h('span', { text: `${kbLabel(k)}（已删除）` }),
            ),
          ),
        )
      : null,
  );
}

function verLabel(v, r) {
  const t = new Date(v.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `v${v.n} · ${SOURCE_LABEL[v.source] ?? v.source} · ${t}${v.n === r.latest ? ' · 最新' : ''}`;
}

function renderVersions(r) {
  const n = pm.view.n;
  const busy = hasRunningTurn(r);
  const edit = h('button', { type: 'button', class: 'link', text: '编辑', title: busy ? '上一轮还在进行中' : '在 Markdown 原文上修改，保存为新版本', onclick: () => startEdit(pm.review) });
  edit.disabled = busy || pm.edit != null;
  const sel = h('select', {
    class: 'ver-select',
    'aria-label': '文档版本',
    onchange: (e) => selectVersion(r.id, Number(e.target.value)),
  });
  for (const v of [...r.versions].reverse()) sel.append(h('option', { value: String(v.n), text: verLabel(v, r) }));
  sel.value = String(n);
  sel.disabled = pm.edit != null;
  return h(
    'div',
    { class: 'pm-versions' },
    h('label', { class: 'ver-pick' }, h('span', { class: 'muted', text: `共 ${r.versions.length} 版` }), sel),
    h(
      'div',
      { class: 'ver-actions' },
      h('button', {
        type: 'button',
        class: 'link',
        text: '复制全文',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(viewedContent(pm.review) ?? '');
            toast('已复制');
          } catch {
            toast('复制失败，请手动选择文本');
          }
        },
      }),
      h('a', { class: 'link', href: `/api/pm/reviews/${r.id}/versions/${n}/download`, download: '', text: '下载 .md' }),
      h('a', { class: 'link', href: `/print/pm/${r.id}/${n}`, target: '_blank', rel: 'noopener noreferrer', text: '打印 / PDF' }),
      edit,
    ),
  );
}

async function selectVersion(id, n) {
  if (pm.edit) return toast('请先保存或取消编辑');
  if (!pm.review || pm.review.id !== id) return;
  const key = `${id}:${n}`;
  if (n !== pm.review.latest && !pm.verCache.has(key)) {
    try {
      const { version } = await api(`/api/pm/reviews/${id}/versions/${n}`);
      pm.verCache.set(key, version.content);
    } catch (e) {
      return toast(e.message);
    }
    if (pm.review?.id !== id) return;
  }
  pm.view = { id, n };
  renderReview(pm.review);
}

function startEdit(r) {
  const n = pm.view.n;
  const content = viewedContent(r);
  if (content == null) return;
  if (n !== r.latest && !confirm(`将以 v${n} 为底稿生成 v${r.latest + 1}，确定吗？`)) return;
  pm.edit = { base: n, value: content };
  renderReview(r);
}

function renderDoc(r) {
  const box = h('div', { class: 'brief pm-doc' });
  if (!pm.edit) {
    const content = viewedContent(r);
    if (content == null) box.append(h('p', { class: 'muted', text: '加载中…' }));
    else box.append(...renderMarkdown(content, r.refs));
    return box;
  }
  const ta = h('textarea', { class: 'pm-edit', rows: '18', maxlength: '80000', 'aria-label': '编辑文档（Markdown）' });
  ta.value = pm.edit.value;
  ta.addEventListener('input', () => {
    if (pm.edit) pm.edit.value = ta.value;
  });
  const notice = h('div', { class: 'pm-conflict' });
  const save = h('button', {
    type: 'button',
    text: '保存为新版本',
    onclick: async () => {
      if (pm.edit) pm.edit.value = ta.value;
      save.disabled = true;
      try {
        const { n } = await api(`/api/pm/reviews/${r.id}/versions`, { method: 'POST', body: { content: ta.value, baseN: r.latest } });
        pm.edit = null;
        pm.view = { id: r.id, n };
        toast(`已保存为 v${n}`);
        await openReview(r.id);
      } catch (e) {
        if (e.status !== 409) return toast(e.message);
        notice.replaceChildren(
          h('span', { class: 'err', text: `${e.message}，你的修改还在编辑框里，可以先复制保存。` }),
          h('button', {
            type: 'button',
            class: 'link',
            text: '查看最新',
            onclick: () => {
              pm.edit = null;
              pm.view = { id: r.id, n: 0 };
              openReview(r.id);
            },
          }),
        );
      } finally {
        save.disabled = false;
      }
    },
  });
  const cancel = h('button', {
    type: 'button',
    class: 'link',
    text: '取消',
    onclick: () => {
      pm.edit = null;
      renderReview(pm.review);
    },
  });
  box.append(h('p', { class: 'muted', text: `以 v${pm.edit.base} 为底稿编辑 Markdown 原文，保存后生成 v${r.latest + 1}` }), ta, notice, h('div', { class: 'row' }, save, cancel));
  return box;
}

function renderThread(r) {
  const msgs = r.messages || [];
  if (!msgs.length) return h('div', { class: 'pm-thread' }, h('p', { class: 'muted', text: '对结论有疑问，或想调整文档？在下面继续对话。' }));
  const busy = hasRunningTurn(r);
  return h(
    'div',
    { class: 'pm-thread' },
    msgs.map((m, i) => {
      if (m.role === 'user') {
        return h('div', { class: 'pm-msg user' }, h('div', { class: 'bubble', text: m.content }), attList(m.attachments), m.kind === 'revise' ? h('small', { class: 'muted', text: '要求改写文档' }) : null);
      }
      if (m.status === 'running') return h('div', { class: 'pm-msg assistant' }, h('p', { class: 'muted', text: '思考中…改写文档一般需要 1-2 分钟' }));
      if (m.status === 'error') {
        const prev = msgs.slice(0, i).reverse().find((x) => x.role === 'user');
        const last = i === msgs.length - 1;
        return h(
          'div',
          { class: 'pm-msg assistant' },
          h('span', { class: 'err', text: `这一轮失败：${m.error || '未知错误'}` }),
          // 附件已随那一轮关联，不能重复使用，只能重新上传
          prev && last && !busy
            ? prev.attachments?.length
              ? h('small', { class: 'muted', text: '请重新上传附件后再发送' })
              : h('button', { type: 'button', class: 'link', text: '重试', onclick: () => sendTurn(r.id, prev.content, prev.kind === 'revise' ? 'revise' : 'auto') })
            : null,
        );
      }
      if (m.kind === 'revise' && m.version_n) {
        return h(
          'div',
          { class: 'pm-event' },
          h('span', { class: 'pm-event-text', text: `已生成 v${m.version_n}：${m.content}` }),
          h('button', { type: 'button', class: 'link', text: '查看文档', onclick: () => gotoDoc(r.id, m.version_n) }),
          contextNote(m.context, true),
        );
      }
      return h('div', { class: 'pm-msg assistant brief' }, ...renderMarkdown(m.content, r.refs), contextNote(m.context, true));
    }),
  );
}

function renderReply(r) {
  const busy = hasRunningTurn(r);
  const ta = h('textarea', { rows: '3', maxlength: '8000', 'aria-label': '继续对话', placeholder: '继续追问，或说明要怎么改（如：定价部分按 To B 年费重写）· Ctrl/⌘+Enter 发送' });
  const chk = h('input', { type: 'checkbox', 'aria-label': '改写文档', onchange: () => (pm.draft.revise = chk.checked) });
  if (pm.draft.id !== r.id) pm.draft = { id: r.id, text: '', revise: false };
  ta.value = pm.draft.text;
  chk.checked = pm.draft.revise;
  const count = h('span', { class: 'muted', text: `${[...pm.draft.text].length}/8000` });
  const btn = h('button', { type: 'submit', text: busy ? '进行中…' : '发送' });
  const blocked = busy || pm.edit != null;
  if (pm.att.replyFor !== r.id) {
    pm.att.reply = [];
    pm.att.replyFor = r.id;
  }
  let sending = false;
  const bar = h('div', { class: 'att-bar' });
  const sync = () => {
    const list = pm.att.reply;
    bar.replaceChildren(...renderAttBar(list));
    const gate = attGate(list);
    btn.disabled = blocked || sending || !!gate;
    btn.title = gate;
  };
  pm.att.replyEl = bar;
  pm.att.replySync = sync;
  ta.disabled = blocked;
  sync();
  ta.addEventListener('input', () => {
    pm.draft.text = ta.value;
    count.textContent = `${[...ta.value].length}/8000`;
  });
  ta.addEventListener('paste', (e) => onPasteFiles(e, pm.att.reply));
  const send = async () => {
    if (blocked || sending) return;
    const list = pm.att.reply;
    const text = ta.value.trim();
    if (!list.length && [...text].length < 2) return toast('请至少输入 2 个字');
    const gate = attGate(list);
    if (gate) return toast(gate);
    if (btn.disabled) return;
    sending = true;
    btn.disabled = true;
    const ok = await sendTurn(r.id, text, chk.checked ? 'revise' : 'auto', attIds(list));
    sending = false;
    if (!ok) sync();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  const file = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    accept: ATT_ACCEPT,
    onchange: (e) => {
      addFiles(pm.att.reply, e.target.files ?? []);
      e.target.value = '';
    },
  });
  const attRow = h('div', { class: 'att-row' }, h('button', { type: 'button', class: 'link', text: '添加附件', disabled: blocked, onclick: () => file.click() }), file, bar);
  const form = h('form', { class: 'pm-reply', autocomplete: 'off' }, ta, attRow, h('div', { class: 'row' }, h('label', { class: 'check', title: '不勾选时由顾问判断：提问就回答，提出修改就出新版' }, chk, ' 改写文档'), count, btn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  if (!blocked) bindDrop(form, () => pm.att.reply);
  return form;
}

async function sendTurn(id, text, mode, attachmentIds = []) {
  try {
    await api(`/api/pm/reviews/${id}/messages`, { method: 'POST', body: attachmentIds.length ? { text, mode, attachmentIds } : { text, mode } });
    if (attachmentIds.length) pm.att.reply = [];
    if (pm.draft.id === id) pm.draft = { id, text: '', revise: false };
    await openReview(id);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

async function openReview(id) {
  clearTimeout(pm.pollTimer);
  const seq = ++pm.openSeq;
  pm.current = id;
  try {
    const { review } = await api(`/api/pm/reviews/${id}`);
    if (seq !== pm.openSeq) return;
    const prev = pm.review?.id === id ? pm.review : null;
    if (!prev) {
      pm.edit = null;
      pm.sig = {};
      pm.view = { id, n: review.latest };
    } else if (review.latest > prev.latest || pm.view.n < 1 || pm.view.n > review.latest) {
      pm.view = { id, n: review.latest };
    }
    renderReview(review);
    if (review.status === 'running' || hasRunningTurn(review)) pm.pollTimer = setTimeout(() => openReview(id), 3000);
    else loadPmHistory();
  } catch (e) {
    if (seq === pm.openSeq) toast(e.message);
  }
}

async function loadPmHistory() {
  try {
    const { reviews } = await api('/api/pm/reviews');
    $('pm-history-empty').hidden = reviews.length > 0;
    $('pm-history-count').textContent = reviews.length ? String(reviews.length) : '';
    $('pm-history').replaceChildren(
      ...reviews.map((r) => {
        const info = r.status === 'running' ? '进行中' : r.status === 'error' ? '失败' : `${r.mode_label} · v${r.latest} · ${r.turns} 轮`;
        return h(
          'li',
          { class: `pm-row${r.id === pm.current ? ' on' : ''}${r.status === 'running' ? ' running' : r.status === 'error' ? ' failed' : ''}`, 'data-id': String(r.id) },
          h('a', {
            href: '#',
            title: r.input,
            text: clipText(r.input.replace(/\s+/g, ' '), 60),
            onclick: (e) => {
              e.preventDefault();
              if (pm.edit && pm.current !== r.id && !confirm('放弃未保存的编辑？')) return;
              if (isNarrow()) setPmSide(true, false);
              openReview(r.id);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }),
          h(
            'div',
            { class: 'pm-row-foot' },
            h('span', { class: 'info', text: `${info} · ${ago(r.updated_at || r.created_at)}` }),
            r.status !== 'running'
              ? h('button', {
                  class: 'link pm-del',
                  text: '删除',
                  'aria-label': `删除评审 #${r.id}`,
                  onclick: async () => {
                    if (!confirm('删除这条评审及其所有版本和对话？')) return;
                    try {
                      await api(`/api/pm/reviews/${r.id}`, { method: 'DELETE' });
                      if (pm.current === r.id) {
                        pm.edit = null;
                        newPmReview();
                      }
                      loadPmHistory();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                })
              : null,
          ),
        );
      }),
    );
  } catch (e) {
    toast(e.message);
  }
}

function updatePmCount() {
  $('pm-count').textContent = `${[...$('pm-input').value].length}/8000`;
}

async function submitPm(e) {
  e.preventDefault();
  const gate = attGate(pm.att.form);
  if (gate) return toast(gate);
  const btn = $('pm-submit');
  btn.disabled = true;
  try {
    const ids = attIds(pm.att.form);
    const body = { input: $('pm-input').value, presets: pm.sel.presets, skills: pm.sel.skills, useRadar: $('pm-radar').checked };
    const { id } = await api('/api/pm/reviews', { method: 'POST', body: ids.length ? { ...body, attachmentIds: ids } : body });
    // 原地清空，保持数组引用不变（refreshAtt 按引用区分表单与追问区）
    pm.att.form.length = 0;
    refreshAtt(pm.att.form);
    $('pm-input').value = '';
    updatePmCount();
    await openReview(id);
    loadPmHistory();
  } catch (err) {
    toast(err.message);
  } finally {
    syncPmSubmit();
  }
}

// ---------------- 我的记忆 ----------------
const MEM_KINDS = ['fact', 'preference', 'decision', 'interest'];
const MEM_LABEL = { fact: '事实', preference: '偏好', decision: '决定', interest: '关注' };
const OP_LABEL = { add: '新增', update: '修改', delete: '删除', profile: '画像' };
const SRC_LABEL = { auto: '自动整理', manual: '手动', undo: '撤销', evict: '超出上限淘汰' };
const mem = { data: null, editProfile: false, editItem: null, addKind: null, pollTimer: null, profileDraft: null, itemDraft: null };

const clipText = (s, n = 200) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);

/** poll=true 时是整理中的自动刷新：正在编辑时不重建画像和条目，避免打断输入 */
async function loadMemory(poll = false) {
  clearTimeout(mem.pollTimer);
  try {
    mem.data = await api('/api/memory');
    renderMemory(poll && (mem.editProfile || mem.editItem != null || mem.addKind != null));
    if (mem.data.running && !$('view-memory').hidden) mem.pollTimer = setTimeout(() => loadMemory(true), 3000);
  } catch (e) {
    toast(e.message);
  }
}

/** 写操作：成功后重新加载；失败提示并恢复按钮 */
async function memDo(btn, fn, after) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    after?.();
  } catch (e) {
    toast(e.message);
    if (btn) btn.disabled = false;
    return;
  }
  await loadMemory();
}

function renderMemory(keepEditors = false) {
  const d = mem.data;
  if (!d) return;
  const pend = d.running ? '正在整理…' : d.pending ? `还有 ${d.pending} 条交互待整理` : '交互都已整理';
  $('mem-pending').textContent = d.llm ? pend : `${pend} · 未配置模型，暂不自动整理`;
  $('mem-run').disabled = !d.llm || d.running;
  $('mem-clear').disabled = false;
  if (!keepEditors) {
    $('mem-profile').replaceChildren(...renderProfileBox(d.profile));
    $('mem-items').replaceChildren(...MEM_KINDS.map((k) => renderMemGroup(k, d.memories.filter((m) => m.kind === k))));
  }
  $('mem-changes').replaceChildren(...(d.changes.length ? d.changes.map(renderChange) : [h('li', { class: 'muted', text: '还没有变化。' })]));
}

function renderProfileBox(p) {
  if (mem.editProfile) {
    const ta = h('textarea', { rows: '8', maxlength: '1500', 'aria-label': '编辑画像', placeholder: '用几句话描述你自己：在做什么、目标用户、阶段、偏好的沟通方式…' });
    ta.value = mem.profileDraft ?? p.content;
    ta.addEventListener('input', () => (mem.profileDraft = ta.value));
    return [
      ta,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', text: '保存', onclick: (e) => memDo(e.currentTarget, () => api('/api/memory/profile', { method: 'PUT', body: { content: ta.value } }), () => ((mem.editProfile = false), (mem.profileDraft = null))) }),
        h('button', { type: 'button', class: 'link', text: '取消', onclick: () => ((mem.editProfile = false), (mem.profileDraft = null), renderMemory()) }),
      ),
    ];
  }
  const body = p.content ? h('div', { class: 'brief mem-md' }, ...renderMarkdown(p.content)) : h('p', { class: 'muted', text: '还没有画像。整理器会根据你的交互逐步生成，也可以自己写。' });
  return [
    body,
    h(
      'div',
      { class: 'row' },
      p.manual ? h('small', { class: 'muted', text: '手动编辑过' }) : null,
      h('button', { type: 'button', class: 'link', text: '编辑', onclick: () => ((mem.editProfile = true), renderMemory()) }),
    ),
  ];
}

function memEditor(value, save, done) {
  const input = h('input', { type: 'text', maxlength: '200', 'aria-label': '记忆内容', placeholder: '一句话，最多 200 字' });
  input.value = mem.itemDraft ?? value;
  input.addEventListener('input', () => (mem.itemDraft = input.value));
  const cancel = () => {
    mem.editItem = null;
    mem.addKind = null;
    mem.itemDraft = null;
    renderMemory();
  };
  const submit = (btn) => {
    const v = input.value.trim();
    if (!v) return toast('内容不能为空');
    memDo(btn, () => save(v), () => ((mem.itemDraft = null), done()));
  };
  const ok = h('button', { type: 'button', text: '保存', onclick: (e) => submit(e.currentTarget) });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(ok);
    } else if (e.key === 'Escape') cancel();
  });
  return h('li', { class: 'mem-row editing' }, input, ok, h('button', { type: 'button', class: 'link', text: '取消', onclick: cancel }));
}

function renderMemGroup(k, list) {
  const rows = list.map((m) =>
    mem.editItem === m.id
      ? memEditor(m.content, (v) => api(`/api/memory/items/${m.id}`, { method: 'PUT', body: { content: v } }), () => (mem.editItem = null))
      : h(
          'li',
          { class: 'mem-row' },
          h('span', { class: 'mem-text', text: m.content }),
          m.manual ? h('span', { class: 'tag', text: '手动' }) : null,
          h('span', { class: 'info', text: m.last_used_at ? `最近使用 ${ago(m.last_used_at)}` : '尚未使用' }),
          h('button', { type: 'button', class: 'link', text: '编辑', onclick: () => ((mem.editItem = m.id), (mem.addKind = null), (mem.itemDraft = null), renderMemory()) }),
          h('button', {
            type: 'button',
            class: 'link',
            text: '删除',
            onclick: (e) => {
              if (!confirm(`删除这条记忆？\n${m.content}`)) return;
              memDo(e.currentTarget, () => api(`/api/memory/items/${m.id}`, { method: 'DELETE' }));
            },
          }),
        ),
  );
  if (mem.addKind === k) rows.push(memEditor('', (v) => api('/api/memory/items', { method: 'POST', body: { kind: k, content: v } }), () => (mem.addKind = null)));
  return h(
    'div',
    { class: 'mem-group', 'data-kind': k },
    h('div', { class: 'mem-group-title', text: MEM_LABEL[k] }),
    h('ul', { class: 'mem-list' }, rows.length ? rows : h('li', { class: 'muted mem-empty', text: '暂无' })),
    mem.addKind === k ? null : h('button', { type: 'button', class: 'link', text: '添加', onclick: () => ((mem.addKind = k), (mem.editItem = null), (mem.itemDraft = null), renderMemory()) }),
  );
}

function renderChange(c) {
  const text = (o) => (o && o.content != null ? clipText(String(o.content)) : '');
  const before = text(c.before);
  const after = text(c.after);
  const label = c.op === 'profile' ? OP_LABEL.profile : `${OP_LABEL[c.op] ?? c.op}${MEM_LABEL[c.kind] ? ` · ${MEM_LABEL[c.kind]}` : ''}`;
  const diff = h('div', { class: 'mem-diff' });
  if (before) diff.append(h('del', { text: before }));
  if (before && after) diff.append(h('span', { class: 'muted', text: ' → ' }));
  if (after) diff.append(h('ins', { text: after }));
  return h(
    'li',
    { class: `mem-change${c.undone_at ? ' undone' : ''}` },
    h(
      'div',
      { class: 'meta' },
      h('span', { class: 'tag', text: label }),
      h('span', { text: SRC_LABEL[c.source] ?? c.source }),
      h('span', { text: ago(c.at) }),
      c.undone_at ? h('span', { text: '已撤销' }) : null,
      c.undoable ? h('button', { type: 'button', class: 'link', text: '撤销', onclick: (e) => memDo(e.currentTarget, () => api(`/api/memory/changes/${c.id}/undo`, { method: 'POST', body: {} })) }) : null,
    ),
    diff,
    c.reason ? h('div', { class: 'muted mem-note', text: `理由：${c.reason}` }) : null,
    c.events.length ? h('div', { class: 'muted mem-note', text: `来源：${c.events.join('；')}` }) : null,
  );
}

async function runMemory(e) {
  await memDo(e.currentTarget, async () => {
    const r = await api('/api/memory/consolidate', { method: 'POST', body: {} });
    toast(r.started ? '已开始整理' : '没有待整理的交互');
  });
}

async function clearAllMemory(e) {
  if (!confirm('将删除画像、全部记忆、变化记录和待整理的交互，无法恢复。继续吗？')) return;
  const ans = prompt('请输入「清空」确认');
  if (ans !== '清空') {
    if (ans != null) toast('输入不匹配，没有清空');
    return;
  }
  await memDo(e.currentTarget, () => api('/api/memory', { method: 'DELETE', body: { confirm: '清空' } }), () => {
    mem.editProfile = false;
    mem.editItem = null;
    mem.addKind = null;
    mem.profileDraft = null;
    mem.itemDraft = null;
    toast('已清空');
  });
}

// ---------------- 视图切换与事件 ----------------
function show(view, opts = {}) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of ['feed', 'brief', 'pm', 'kb', 'memory', 'sources']) $(`view-${v}`).hidden = v !== view;
  $('q').hidden = view !== 'feed';
  if (view === 'kb' && !opts.skipLoad) kb.load();
  if (view === 'brief') loadBrief();
  if (view === 'sources') loadSources();
  if (view === 'memory') loadMemory();
  if (view === 'pm') {
    initPm();
    loadPmHistory();
  }
}

async function init() {
  applyTabOrder();
  bindTabDrag();
  const [meta, prefs] = await Promise.all([api('/api/meta'), api('/api/prefs/interests')]);
  state.meta = meta;
  state.interests = prefs.interests;
  if (state.interests.topics.length) state.topic = FOCUS;
  $('brief-focus').checked = state.interests.topics.length > 0;
  for (const [k, v] of Object.entries(state.meta.groups)) $('grp').append(h('option', { value: k, text: v }));
  renderTopics();
  $('focus-edit').addEventListener('submit', saveFocus);
  $('focus-cancel').addEventListener('click', () => ($('focus-edit').hidden = true));
  $('pm-form').addEventListener('submit', submitPm);
  initPmSide();
  $('pm-side-toggle').addEventListener('click', () => setPmSide(!$('pm-layout').classList.contains('collapsed')));
  $('pm-new').addEventListener('click', () => newPmReview());
  $('pm-input').addEventListener('input', updatePmCount);
  $('pm-input').addEventListener('paste', (e) => onPasteFiles(e, pm.att.form));
  $('pm-att-add').addEventListener('click', () => $('pm-att-file').click());
  $('pm-att-file').addEventListener('change', (e) => {
    addFiles(pm.att.form, e.target.files ?? []);
    e.target.value = '';
  });
  bindDrop($('pm-form'), () => pm.att.form);
  for (const b of tabButtons()) b.addEventListener('click', () => {
    if (Date.now() < suppressTabClickUntil) return;
    show(b.dataset.view);
  });
  for (const id of ['grp', 'days', 'important', 'starred', 'rel']) $(id).addEventListener('change', () => loadItems());
  $('mem-run').addEventListener('click', runMemory);
  $('mem-clear').addEventListener('click', clearAllMemory);
  let qt;
  $('q').addEventListener('input', () => {
    clearTimeout(qt);
    qt = setTimeout(() => loadItems(), 300);
  });
  $('more').addEventListener('click', () => loadItems(false));
  $('refresh').addEventListener('click', async () => {
    try {
      const r = await api('/api/run', { method: 'POST', body: {} });
      toast(r.message);
      state.wasRunning = true;
      refreshStatus();
    } catch (e) {
      toast(e.message);
    }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    location.replace('/login');
  });
  $('brief-gen').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = '生成中…';
    try {
      const { brief } = await api('/api/brief', { method: 'POST', body: { focus: $('brief-focus').checked } });
      renderBrief(brief);
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
      b.textContent = '生成今日简报';
    }
  });
  $('add-source').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      const el = (n) => f.elements.namedItem(n);
      const r = await api('/api/sources', {
        method: 'POST',
        body: { name: el('name').value, url: el('url').value, lang: el('zh').checked ? 'zh' : 'en', filter: el('filter').checked },
      });
      toast(r.error ? `已添加，但抓取失败：${r.error}` : `已添加，新增 ${r.newItems} 条`);
      f.reset();
      loadSources();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  loadItems();
  refreshStatus();
  setInterval(refreshStatus, 30000);
}

const kb = initKb({ h, api, toast, show, openReview, openItem });
const proto = initProto({ h, api, toast });

init().catch((e) => toast(e.message));
