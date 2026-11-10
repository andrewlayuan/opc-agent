// 所有外部数据只通过 textContent 写入 DOM，链接只接受 http(s)
const $ = (id) => document.getElementById(id);

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
  if (!res.ok) throw new Error(data.error || data.message || `请求失败（${res.status}）`);
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

function renderItem(it) {
  const zhTitle = it.title_zh || it.title;
  const showOrig = it.title_zh && it.title_zh !== it.title;
  const li = h('li', { class: 'item' });
  li.append(
    h('div', { class: 'meta' }, h('span', { text: it.source_name }), h('span', { text: '·' }), h('span', { text: ago(it.published_at) }), dots(it.importance), it.starred ? h('span', { text: '★' }) : null),
    h('a', { class: 'title', href: '#', onclick: (e) => { e.preventDefault(); toggleOpen(it.id, li); }, text: zhTitle }),
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
  );
  out.push(actions);
  return out;
}

function replaceItem(fresh, li) {
  const i = state.items.findIndex((x) => x.id === fresh.id);
  if (i >= 0) state.items[i] = { ...state.items[i], ...fresh };
  li.replaceWith(renderItem(state.items[i] ?? fresh));
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
const pm = { meta: null, current: null, pollTimer: null };

async function initPm() {
  if (pm.meta) return;
  try {
    pm.meta = await api('/api/pm/meta');
  } catch (e) {
    toast(e.message);
    return;
  }
  const mode = $('pm-mode');
  mode.replaceChildren(...pm.meta.presets.map((p) => h('option', { value: p.id, text: p.label })), h('option', { value: 'custom', text: '指定单个框架…' }));
  const groups = new Map();
  for (const s of pm.meta.skills) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  $('pm-skill').replaceChildren(...[...groups].map(([g, list]) => h('optgroup', { label: g }, list.map((s) => h('option', { value: s.name, title: s.description, text: s.name })))));
  updatePmHint();
  if (!pm.meta.enabled) {
    $('pm-submit').disabled = true;
    $('pm-hint').textContent = !pm.meta.skillsFound ? '未找到 pm-skills：请在服务器上运行 scripts/setup-pm-skills.sh 后重启服务。' : '未配置 DEEPSEEK_API_KEY，无法生成反馈。';
  }
}

function updatePmHint() {
  if (!pm.meta) return;
  const v = $('pm-mode').value;
  $('pm-skill').hidden = v !== 'custom';
  let text = '';
  if (v === 'auto') text = '根据你的描述自动挑选 2-3 个最合适的框架。';
  else if (v === 'custom') text = pm.meta.skills.find((s) => s.name === $('pm-skill').value)?.description ?? '';
  else text = `使用框架：${pm.meta.presets.find((p) => p.id === v)?.skills.join(' · ') ?? ''}`;
  if (pm.meta.enabled) $('pm-hint').textContent = text;
}

function renderReview(r) {
  const box = $('pm-result');
  box.hidden = false;
  const head = h(
    'div',
    { class: 'pm-head' },
    h('div', { class: 'meta' }, h('span', { text: r.mode_label }), h('span', { text: '·' }), h('span', { text: new Date(r.created_at).toLocaleString('zh-CN') })),
    h('details', { class: 'pm-input' }, h('summary', { text: r.input.length > 60 ? `${r.input.slice(0, 60)}…` : r.input }), h('div', { text: r.input })),
    r.skills.length ? h('div', { class: 'tags' }, r.skills.map((s) => h('span', { class: 'tag', text: s }))) : null,
  );
  const body = h('div', { class: 'brief' });
  if (r.status === 'running') {
    body.append(h('p', { class: 'muted', text: '正在评审…一般需要 1-3 分钟，可以先去看看别的，回来在「历史评审」里查看。' }));
  } else if (r.status === 'error') {
    body.append(h('p', { class: 'err', text: `评审失败：${r.error || '未知错误'}` }));
  } else {
    body.append(...renderMarkdown(r.content || '', r.refs));
  }
  const actions = h('div', { class: 'actions' });
  if (r.status === 'done') {
    actions.append(
      h('button', {
        class: 'link',
        text: '复制全文',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(r.content || '');
            toast('已复制');
          } catch {
            toast('复制失败，请手动选择文本');
          }
        },
      }),
      h('button', {
        class: 'link',
        text: '用相同内容再评一次',
        onclick: () => {
          $('pm-input').value = r.input;
          updatePmCount();
          $('pm-input').focus();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
      }),
    );
  }
  box.replaceChildren(head, body, actions);
}

async function openReview(id) {
  clearTimeout(pm.pollTimer);
  pm.current = id;
  try {
    const { review } = await api(`/api/pm/reviews/${id}`);
    if (pm.current !== id) return;
    renderReview(review);
    if (review.status === 'running') pm.pollTimer = setTimeout(() => openReview(id), 3000);
    else loadPmHistory();
  } catch (e) {
    toast(e.message);
  }
}

async function loadPmHistory() {
  try {
    const { reviews } = await api('/api/pm/reviews');
    $('pm-history-title').hidden = !reviews.length;
    $('pm-history').replaceChildren(
      ...reviews.map((r) =>
        h(
          'li',
          { class: `pm-row${r.id === pm.current ? ' on' : ''}` },
          h('a', {
            href: '#',
            text: r.input.replace(/\s+/g, ' ').slice(0, 80),
            onclick: (e) => {
              e.preventDefault();
              openReview(r.id);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          }),
          h('span', { class: 'info', text: `${r.status === 'running' ? '进行中' : r.status === 'error' ? '失败' : r.mode_label} · ${ago(r.created_at)}` }),
          r.status !== 'running'
            ? h('button', {
                class: 'link',
                text: '删除',
                onclick: async () => {
                  if (!confirm('删除这条评审？')) return;
                  try {
                    await api(`/api/pm/reviews/${r.id}`, { method: 'DELETE' });
                    if (pm.current === r.id) {
                      pm.current = null;
                      $('pm-result').hidden = true;
                    }
                    loadPmHistory();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              })
            : null,
        ),
      ),
    );
  } catch (e) {
    toast(e.message);
  }
}

function updatePmCount() {
  $('pm-count').textContent = `${[...$('pm-input').value].length}/4000`;
}

async function submitPm(e) {
  e.preventDefault();
  const btn = $('pm-submit');
  btn.disabled = true;
  try {
    const mode = $('pm-mode').value;
    const { id } = await api('/api/pm/reviews', {
      method: 'POST',
      body: { input: $('pm-input').value, mode, skill: mode === 'custom' ? $('pm-skill').value : undefined, useRadar: $('pm-radar').checked },
    });
    await openReview(id);
    loadPmHistory();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = !pm.meta?.enabled;
  }
}

// ---------------- 视图切换与事件 ----------------
function show(view) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of ['feed', 'brief', 'sources']) $(`view-${v}`).hidden = v !== view;
  $('q').hidden = view !== 'feed';
  if (view === 'brief') loadBrief();
  if (view === 'sources') loadSources();
}

async function init() {
  state.meta = await api('/api/meta');
  for (const [k, v] of Object.entries(state.meta.groups)) $('grp').append(h('option', { value: k, text: v }));
  renderTopics();
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => show(b.dataset.view));
  for (const id of ['grp', 'days', 'important', 'starred']) $(id).addEventListener('change', () => loadItems());
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

init().catch((e) => toast(e.message));
