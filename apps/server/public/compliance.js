// 合规页：产品列表、问卷、判定结果、台账与提醒角标。用户与模型文本只通过 textContent 写入，官方链接只来自事项目录并经 safeHref
export function initCompliance({ h, api, toast, safeHref, openFeed }) {
  const $ = (id) => document.getElementById(id);
  const TABS = [['quiz', '问卷'], ['result', '判定结果'], ['ledger', '台账']];
  const STATUS = [['todo', '待办'], ['preparing', '准备中'], ['submitted', '已提交'], ['done', '已办结'], ['na', '不适用']];
  const LEVEL = { required: '必须办', maybe: '可能需要', na: '不适用' };
  const FILTERS = [['all', '全部'], ['open', '未办结'], ['alert', '有提醒']];
  const DAY = 86_400_000;
  const REMIND_DAYS = 30;
  /** mode：product 为查看某个产品，new 为新建表单；tabs、drafts 按产品记在内存里 */
  const st = { meta: null, products: [], pid: null, detail: null, mode: 'product', tabs: new Map(), drafts: new Map(), ai: new Map(), filter: 'all', seq: 0, badge: null };
  const clip = (s, n) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ts) => { if (ts == null) return ''; const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
  const cat = (id) => st.meta.catalog.find((c) => c.id === id) ?? { id, name: id, authority: '', basis: '', timing: '', links: [] };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  /** 与服务端 reminders.ts 相同：remind_at、due_at 取较早的非空值；不适用的不提醒 */
  function alertOf(it, now) {
    if (it.status === 'na') return null;
    const dates = [it.remind_at, it.due_at].filter((d) => d != null);
    if (!dates.length) return null;
    const date = Math.min(...dates);
    if (date < now) return { kind: 'overdue', date };
    return date - now <= REMIND_DAYS * DAY ? { kind: 'soon', date } : null;
  }

  async function ensureMeta() {
    if (!st.meta) st.meta = await api('/api/compliance/meta');
  }

  async function refreshBadge() {
    let n = 0;
    try {
      n = (await api('/api/compliance/reminders')).reminders.length;
    } catch {
      return;
    }
    const btn = Array.from(document.querySelectorAll('.tabs button')).find((b) => b.dataset.view === 'compliance');
    st.badge?.remove();
    st.badge = null;
    if (btn && n > 0) {
      st.badge = h('span', { class: 'tab-badge', text: String(n), title: `${n} 项快到期或已逾期` });
      btn.append(st.badge);
    }
  }

  async function reloadList() {
    try {
      st.products = (await api('/api/compliance/products')).products;
      renderSide();
    } catch (e) {
      toast(e.message);
    }
  }

  async function load() {
    try {
      await ensureMeta();
      await reloadList();
      if (st.mode === 'new') return;
      if (!st.products.some((p) => p.id === st.pid)) st.pid = st.products[0]?.id ?? null;
      if (st.pid) await open(st.pid);
      else await openNew();
    } catch (e) {
      toast(e.message);
    }
    await refreshBadge();
  }

  function renderSide() {
    const list = st.products.map((p) =>
      h('li', {},
        h('button', { type: 'button', class: `cp-prod${st.mode === 'product' && p.id === st.pid ? ' on' : ''}`, onclick: () => open(p.id) },
          h('span', { class: 'cp-prod-name', text: p.name }),
          h('span', { class: 'cp-prod-meta' }, `必须办 ${p.required}`,
            p.alerts ? h('span', { class: 'cp-alert', text: String(p.alerts), title: `${p.alerts} 项快到期或已逾期` }) : null),
        ),
      ),
    );
    $('cp-side').replaceChildren(
      h('div', { class: 'cp-side-head' },
        h('span', { class: 'cp-side-title', text: '产品' }),
        h('button', { type: 'button', class: 'link', text: '新建产品', onclick: () => openNew() }),
      ),
      h('button', { type: 'button', class: 'link cp-feed', text: '监管动态', title: '查看网信办发布与政策法规', onclick: () => openFeed('reg') }),
      list.length ? h('ol', { class: 'cp-list' }, ...list) : h('p', { class: 'muted cp-empty', text: '还没有产品，先新建一个。' }),
    );
  }

  async function openNew(reviewId = null) {
    st.mode = 'new';
    const seq = ++st.seq;
    renderSide();
    $('cp-tabs').hidden = true;
    const reviews = await api('/api/pm/reviews').then((r) => r.reviews ?? [], () => []);
    if (seq !== st.seq) return;
    const name = h('input', { name: 'name', class: 'kb-input', maxlength: 60, required: true, placeholder: '例如：AI 写作助手', autocomplete: 'off' });
    const desc = h('textarea', { name: 'description', class: 'kb-editor', rows: 6, maxlength: 8000, placeholder: '做什么、给谁用、怎么收费、是否用 AI。选择评审时可留空，自动带入评审原文' });
    const sel = h('select', { name: 'review', class: 'kb-select' },
      h('option', { value: '', text: '不带入' }),
      ...reviews.map((r) => h('option', { value: String(r.id), text: `#${r.id} ${clip(r.input, 40)}` })),
    );
    const fillName = () => {
      const r = reviews.find((x) => String(x.id) === sel.value);
      if (r && !name.value.trim()) name.value = clip(r.input, 30).replace(/…$/, '');
    };
    sel.addEventListener('change', fillName);
    if (reviewId != null) {
      sel.value = String(reviewId);
      fillName();
    }
    const submit = h('button', { type: 'submit', text: '创建并开始问卷' });
    const form = h('form', { class: 'cp-form', onsubmit: async (e) => {
      e.preventDefault();
      const body = { name: name.value, description: desc.value };
      if (sel.value) body.reviewId = Number(sel.value);
      submit.disabled = true;
      try {
        const d = await api('/api/compliance/products', { method: 'POST', body });
        st.mode = 'product';
        st.pid = d.product.id;
        st.detail = d;
        st.tabs.set(st.pid, 'quiz');
        await reloadList();
        renderAll();
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    } },
      h('h2', { class: 'cp-title', text: '新建产品' }),
      h('label', { class: 'kb-field' }, '产品名称', name),
      h('label', { class: 'kb-field' }, '从产品顾问评审带入', sel),
      h('label', { class: 'kb-field' }, '产品描述（可选）', desc),
      h('div', { class: 'cp-actions' }, submit),
    );
    $('cp-main').replaceChildren(form);
  }

  async function open(pid) {
    st.mode = 'product';
    st.pid = pid;
    const seq = ++st.seq;
    renderSide();
    try {
      await ensureMeta();
      const d = await api(`/api/compliance/products/${pid}`);
      if (seq !== st.seq) return;
      st.detail = d;
      if (!st.tabs.has(pid)) st.tabs.set(pid, d.assessment ? 'result' : 'quiz');
      renderAll();
    } catch (e) {
      if (seq === st.seq) toast(e.message);
    }
  }

  function renderAll() {
    renderTabs();
    renderMain();
  }

  function renderTabs() {
    const cur = st.tabs.get(st.pid) ?? 'quiz';
    const el = $('cp-tabs');
    el.hidden = false;
    el.replaceChildren(
      ...TABS.map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', class: `pm-tab${k === cur ? ' on' : ''}`, 'aria-selected': k === cur ? 'true' : 'false', text: label, onclick: () => {
          st.tabs.set(st.pid, k);
          renderAll();
        } }),
      ),
    );
  }

  function renderMain() {
    const tab = st.tabs.get(st.pid) ?? 'quiz';
    const body = tab === 'quiz' ? quizView() : tab === 'result' ? resultView() : ledgerView();
    $('cp-main').replaceChildren(headView(), body);
  }

  function headView() {
    const p = st.detail.product;
    return h('div', { class: 'cp-head' },
      h('div', { class: 'cp-head-text' },
        h('h2', { class: 'cp-title', text: p.name }),
        p.description ? h('p', { class: 'muted cp-desc', text: clip(p.description, 160) }) : null,
      ),
      h('button', { type: 'button', class: 'ghost', text: '删除产品', onclick: () => removeProduct() }),
    );
  }

  async function removeProduct() {
    const p = st.detail.product;
    if (!confirm(`删除「${p.name}」及其判定和台账？`)) return;
    try {
      await api(`/api/compliance/products/${p.id}`, { method: 'DELETE' });
      st.tabs.delete(p.id);
      st.drafts.delete(p.id);
      st.pid = null;
      toast('已删除');
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- 问卷 ----------
  function draft() {
    if (!st.drafts.has(st.pid)) st.drafts.set(st.pid, clone(st.detail.assessment?.answers ?? {}));
    return st.drafts.get(st.pid);
  }
  const visibleQs = (a) => st.meta.questions.filter((q) => !q.dependsOn || (typeof a[q.dependsOn.q] === 'string' && q.dependsOn.in.includes(a[q.dependsOn.q])));
  /** AI 预填状态：filled 为 AI 填过的题（判定时上报），pending 为尚未确认的题 → 依据原文 */
  function aiState() {
    if (!st.ai.has(st.pid)) st.ai.set(st.pid, { filled: new Set(), pending: new Map() });
    return st.ai.get(st.pid);
  }
  const answered = (q, a) => (q.multi ? Array.isArray(a[q.id]) && a[q.id].length > 0 : typeof a[q.id] === 'string' && a[q.id] !== '');

  function pick(q, v) {
    const a = draft();
    aiState().pending.delete(q.id);
    if (q.multi) {
      let cur = Array.isArray(a[q.id]) ? a[q.id] : [];
      if (cur.includes(v)) cur = cur.filter((x) => x !== v);
      else if (v === q.exclusive) cur = [v];
      else cur = [...cur.filter((x) => x !== q.exclusive), v];
      a[q.id] = cur;
    } else a[q.id] = v;
    renderMain();
  }

  function quizView() {
    const a = draft();
    const qs = visibleQs(a);
    const ai = aiState();
    const left = qs.filter((q) => !answered(q, a)).length;
    const pending = qs.filter((q) => ai.pending.has(q.id) && answered(q, a)).length;
    const label = left ? `还有 ${left} 题未答${pending ? `，${pending} 题待确认` : ''}` : pending ? `还有 ${pending} 题待确认` : '判定';
    const btn = h('button', { type: 'button', class: 'cp-assess', text: label, onclick: () => submitAssess() });
    btn.disabled = left + pending > 0;
    const pre = h('button', { type: 'button', class: 'ghost', text: 'AI 预填', onclick: () => prefill(pre) });
    return h('div', { class: 'cp-quiz' },
      h('div', { class: 'cp-quiz-bar' }, pre, h('span', { class: 'muted', text: '按产品描述预填未答的题；预填结果需逐题确认，点选任一选项即视为确认' })),
      ...qs.map((q, i) => {
        const cur = a[q.id];
        const on = (v) => (q.multi ? Array.isArray(cur) && cur.includes(v) : cur === v);
        return h('fieldset', { class: `cp-q${answered(q, a) ? '' : ' todo'}` },
          h('legend', { text: `${i + 1}. ${q.title}${q.multi ? '（可多选）' : ''}` }),
          h('div', { class: 'cp-chips' },
            ...q.options.map((o) => h('button', { type: 'button', class: `chip${on(o.value) ? ' on' : ''}`, 'aria-pressed': on(o.value) ? 'true' : 'false', text: o.label, onclick: () => pick(q, o.value) })),
          ),
          ai.pending.has(q.id)
            ? h('div', { class: 'cp-ai' },
                h('span', { class: 'cp-ai-tag', text: 'AI 预填' }),
                h('span', { class: 'cp-ai-basis', text: `依据：${ai.pending.get(q.id)}` }),
                h('button', { type: 'button', class: 'link', text: '确认', onclick: () => {
                  ai.pending.delete(q.id);
                  renderMain();
                } }),
              )
            : null,
        );
      }),
      h('div', { class: 'cp-actions' }, btn, h('span', { class: 'muted cp-notice', text: st.meta.notice })),
    );
  }

  async function prefill(btn) {
    const pid = st.pid;
    btn.disabled = true;
    btn.textContent = '预填中…';
    try {
      const r = await api(`/api/compliance/products/${pid}/prefill`, { method: 'POST', body: {} });
      if (st.pid !== pid) return;
      const a = draft();
      const ai = aiState();
      let n = 0;
      for (const q of st.meta.questions) {
        if (!(q.id in (r.answers ?? {})) || answered(q, a)) continue;
        a[q.id] = clone(r.answers[q.id]);
        ai.filled.add(q.id);
        ai.pending.set(q.id, String(r.basis?.[q.id] ?? ''));
        n++;
      }
      toast(n ? `已预填 ${n} 题，请逐题确认` : '描述里没有可预填的信息，或相关题已作答');
      renderMain();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = 'AI 预填';
    }
  }

  async function submitAssess() {
    const a = draft();
    const answers = {};
    for (const q of visibleQs(a)) if (answered(q, a)) answers[q.id] = a[q.id];
    const pid = st.pid;
    const prefilled = [...aiState().filled].filter((id) => id in answers);
    try {
      const d = await api(`/api/compliance/products/${pid}/assess`, { method: 'POST', body: { answers, version: st.meta.version, prefilled } });
      st.drafts.delete(pid);
      st.ai.delete(pid);
      st.tabs.set(pid, 'result');
      if (st.pid !== pid) return;
      st.detail = d;
      renderAll();
      reloadList();
      refreshBadge();
    } catch (e) {
      if (e.status === 409) {
        toast('问卷已更新，已重新载入，请检查后再判定');
        try {
          st.meta = await api('/api/compliance/meta');
          if (st.pid === pid && st.mode === 'product') renderAll();
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      const miss = (e.data?.missing ?? []).concat(e.data?.invalid ?? []);
      const titles = miss.map((id) => st.meta?.questions.find((q) => q.id === id)?.title ?? id);
      toast(titles.length ? `${e.message}：${titles.join('、')}` : e.message);
    }
  }

  // ---------- 判定结果 ----------
  function links(c) {
    const xs = c.links
      .map((l) => ({ l, href: safeHref(l.url) }))
      .filter((x) => x.href && x.href.startsWith('https://'))
      .map(({ l, href }) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: l.label }));
    return xs.length ? h('div', { class: 'cp-links' }, ...xs) : null;
  }

  function card(it) {
    const c = cat(it.id);
    return h('article', { class: `cp-card ${it.level}` },
      h('div', { class: 'cp-card-head' }, h('strong', { text: c.name }), h('span', { class: 'cp-tag', text: c.timing })),
      h('dl', { class: 'cp-dl' },
        h('dt', { text: '主管部门' }), h('dd', { text: c.authority }),
        h('dt', { text: '依据' }), h('dd', { text: c.basis }),
      ),
      it.reasons.length ? h('ul', { class: 'cp-reasons' }, ...it.reasons.map((s) => h('li', { text: s }))) : null,
      links(c),
      it.level === 'maybe' ? explainBox(it.id) : null,
    );
  }

  function explainBox(key) {
    const li = st.detail.items.find((x) => x.item === key);
    if (!li) return null;
    const btn = h('button', { type: 'button', class: 'link', text: li.explain ? '重新解释' : '请顾问解释', onclick: async () => {
      btn.disabled = true;
      btn.textContent = '解释中…';
      try {
        const { item } = await api(`/api/compliance/items/${li.id}/explain`, { method: 'POST', body: {} });
        const i = st.detail.items.findIndex((x) => x.id === li.id);
        if (i >= 0) st.detail.items[i] = item;
        renderMain();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
        btn.textContent = li.explain ? '重新解释' : '请顾问解释';
      }
    } });
    return h('div', { class: 'cp-explain' },
      li.explain ? h('p', { class: 'cp-explain-text', text: li.explain }) : null,
      h('div', { class: 'cp-explain-bar' }, btn, li.explain ? h('span', { class: 'muted', text: '模型生成，仅供参考' }) : null),
    );
  }

  function resultView() {
    const as = st.detail.assessment;
    if (!as) return h('p', { class: 'muted cp-empty', text: '还没有判定。先在「问卷」里答完题，再点「判定」。' });
    const r = as.result;
    const by = (lv) => r.items.filter((x) => x.level === lv);
    const na = by('na');
    return h('div', { class: 'cp-result' },
      h('div', { class: 'cp-summary' },
        h('p', { text: `舆论属性或社会动员能力：${r.social.value ? '有' : '无'}（${r.social.reason}）` }),
        ...r.notes.map((n) => h('p', { class: 'cp-note', text: n })),
        h('p', { class: 'muted', text: `规则版本 ${as.rules_version} · 判定于 ${when(as.created_at)}` }),
        h('p', { class: 'cp-notice', text: st.meta.notice }),
      ),
      ...['required', 'maybe'].map((lv) => {
        const xs = by(lv);
        return h('section', { class: `cp-group ${lv}` },
          h('h3', { text: `${LEVEL[lv]}（${xs.length}）` }),
          xs.length ? h('div', { class: 'cp-cards' }, ...xs.map(card)) : h('p', { class: 'muted', text: '无' }),
        );
      }),
      h('details', { class: 'cp-group na' },
        h('summary', { text: `不适用（${na.length}）` }),
        h('ul', { class: 'cp-na-list' }, ...na.map((x) => h('li', { text: `${cat(x.id).name} — ${cat(x.id).basis}` }))),
      ),
    );
  }

  // ---------- 台账 ----------
  async function patchItem(it, body, revert) {
    try {
      const { item } = await api(`/api/compliance/items/${it.id}`, { method: 'PATCH', body });
      const i = st.detail.items.findIndex((x) => x.id === it.id);
      if (i >= 0) st.detail.items[i] = item;
      renderMain();
      reloadList();
      refreshBadge();
    } catch (e) {
      toast(e.message);
      revert();
    }
  }

  function askNa(it, c) {
    const reason = prompt(`「${c.name}」为什么不适用？（必填，200 字内）`, it.na_reason ?? '');
    return reason == null || !reason.trim() ? null : reason.trim();
  }

  function ledgerRow(it, now) {
    const c = cat(it.item);
    const al = alertOf(it, now);
    const sel = h('select', { class: 'kb-select cp-status', 'aria-label': `${c.name} 状态` }, ...STATUS.map(([v, l]) => h('option', { value: v, text: l })));
    sel.value = it.status;
    sel.addEventListener('change', async () => {
      const revert = () => (sel.value = it.status);
      if (sel.value !== 'na') return patchItem(it, { status: sel.value }, revert);
      const na_reason = askNa(it, c);
      if (!na_reason) return revert();
      return patchItem(it, { status: 'na', na_reason }, revert);
    });
    const text = (field, max, label) => {
      const inp = h('input', { class: 'kb-input cp-in', maxlength: max, 'aria-label': `${c.name} ${label}` });
      inp.value = it[field] ?? '';
      inp.addEventListener('change', () => {
        if (inp.value.trim() === (it[field] ?? '')) return;
        return patchItem(it, { [field]: inp.value }, () => (inp.value = it[field] ?? ''));
      });
      return inp;
    };
    const date = (field, label) => {
      const inp = h('input', { type: 'date', class: 'kb-input cp-date', 'aria-label': `${c.name} ${label}` });
      inp.value = ymd(it[field]);
      inp.addEventListener('change', () => {
        const revert = () => (inp.value = ymd(it[field]));
        const v = inp.value ? parseYmd(inp.value) : null;
        if (inp.value && v == null) return revert();
        return patchItem(it, { [field]: v }, revert);
      });
      return inp;
    };
    const stale = it.stale
      ? h('div', { class: 'cp-stale' },
          h('span', { text: '最新判定已不再适用' }),
          h('button', { type: 'button', class: 'link', text: '确认不适用', onclick: () => {
            const na_reason = askNa(it, c);
            return na_reason ? patchItem(it, { status: 'na', na_reason }, () => {}) : undefined;
          } }),
          h('button', { type: 'button', class: 'link', text: '保留', onclick: () => patchItem(it, { keep: true }, () => {}) }),
        )
      : null;
    return h('tr', { 'data-id': String(it.id), class: `${it.stale ? 'stale' : ''}${al ? ` ${al.kind}` : ''}`.trim() || null },
      h('td', { class: 'cp-name' },
        h('div', { text: c.name }),
        al ? h('span', { class: `cp-due ${al.kind}`, text: `${al.kind === 'overdue' ? '已逾期' : '快到期'} ${ymd(al.date)}` }) : null,
        it.status === 'na' && it.na_reason ? h('div', { class: 'muted cp-na-reason', text: `不适用：${it.na_reason}` }) : null,
        stale,
      ),
      h('td', { class: 'cp-level', text: LEVEL[it.level] ?? it.level }),
      h('td', {}, sel),
      h('td', {}, text('ref_no', 100, '编号')),
      h('td', {}, date('done_at', '办结日期')),
      h('td', {}, date('due_at', '到期日')),
      h('td', {}, date('remind_at', '提醒日')),
      h('td', {}, text('note', 2000, '备注')),
    );
  }

  function ledgerView() {
    const items = st.detail.items;
    if (!items.length) return h('p', { class: 'muted cp-empty', text: '还没有台账。完成判定后，必须办与可能需要的事项会自动加入。' });
    const now = Date.now();
    const shown = items.filter((it) => st.filter === 'all' || (st.filter === 'open' ? it.status !== 'done' && it.status !== 'na' : alertOf(it, now)));
    return h('div', { class: 'cp-ledger' },
      h('div', { class: 'cp-chips' },
        ...FILTERS.map(([k, label]) => h('button', { type: 'button', class: `chip${st.filter === k ? ' on' : ''}`, text: label, onclick: () => {
          st.filter = k;
          renderMain();
        } })),
      ),
      h('div', { class: 'cp-table-wrap' },
        h('table', { class: 'cp-table' },
          h('thead', {}, h('tr', {}, ...['事项', '档位', '状态', '编号', '办结日期', '到期日', '提醒日', '备注'].map((t) => h('th', { text: t })))),
          h('tbody', {}, ...shown.map((it) => ledgerRow(it, now))),
        ),
      ),
      shown.length ? null : h('p', { class: 'muted cp-empty', text: '没有符合筛选的事项。' }),
    );
  }

  async function newFromReview(reviewId) {
    st.mode = 'new';
    await ensureMeta().catch(() => {});
    await reloadList();
    await openNew(reviewId);
  }

  return { load, refreshBadge, newFromReview };
}
