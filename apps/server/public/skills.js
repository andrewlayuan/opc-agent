// 我的记忆 · 技能与画像历史：技能卡片（按状态分组）、编辑表单、版本历史与差异、待采用的新版本、立即沉淀；画像版本历史与回退。
// 用户与模型文本只通过 textContent 写入。全部逻辑放在 initSkills 内（页面模拟器会把本文件内联进 app.js）
export function initSkills({ h, api, toast, diffNodes, onProfileChange }) {
  const $ = (id) => document.getElementById(id);
  const S = '/api/memory/skills';
  const STATUS = { active: '启用', candidate: '候选', retired: '停用' };
  const ORDER = ['active', 'candidate', 'retired'];
  const SK_ORIGIN = { auto: '自动沉淀', manual: '手改', restore: '回退' };
  const PF_ORIGIN = { auto: '自动整理', manual: '手动', restore: '回退' };
  const LIM = { nameMin: 8, nameMax: 40, sceneMin: 20, sceneMax: 200, stepsMin: 2, stepsMax: 8, stepMax: 200, cautionsMax: 5, cautionMax: 120, exampleMax: 600 };
  const cps = (s) => Array.from(String(s ?? '').trim()).length;
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const post = (path, body = {}) => api(path, { method: 'POST', body });
  const blank = () => ({ name: '', scene: '', steps: ['', ''], cautions: [], example: '' });
  const copy = (s) => ({ name: s.name, scene: s.scene, steps: [...s.steps], cautions: [...s.cautions], example: s.example ?? '' });

  /** edit：{ id|null, draft }；hist：{ id, list, rev, data, opened, full, err }；pend：{ id, data, opened, err } */
  const st = { data: null, bar: null, edit: null, hist: null, pend: null, poll: null, wasRunning: false, err: null };
  /** 画像历史：open 时才拉列表；count 变化说明有新版本，列表作废 */
  const ph = { open: false, count: null, list: null, loading: false, rev: null, data: null, opened: new Set(), full: false, err: null };

  // ---------------- 技能 ----------------
  async function load(poll = false) {
    clearTimeout(st.poll);
    try {
      st.data = await api(S);
      st.err = null;
    } catch (e) {
      st.err = e.message;
    }
    const d = st.data;
    if (d && st.wasRunning && !d.running) toast(lastText(d.last) ?? '沉淀已结束');
    st.wasRunning = Boolean(d?.running);
    if (!(poll && st.edit)) paint();
    else paintBar();
    if (d?.running && !$('mem-skills').hidden) st.poll = setTimeout(() => load(true), 3000);
  }

  function lastText(last) {
    if (!last) return null;
    if (last.error) return `沉淀出错：${last.error}`;
    const r = last.run;
    if (!r) return null;
    if (r.skip) return `本次没有沉淀：${r.skip}`;
    if (r.error) return `沉淀出错：${r.error}`;
    return `沉淀完成：新增 ${r.added} 个候选，更新 ${r.updated} 个`;
  }

  /** 写操作：成功后提示并重新加载；失败提示并恢复按钮 */
  async function act(btn, fn, msg, after) {
    if (btn) btn.disabled = true;
    try {
      await fn();
      after?.();
      if (msg) toast(msg);
    } catch (e) {
      toast(e.message);
      if (btn) btn.disabled = false;
      return false;
    }
    await load();
    return true;
  }

  function paintBar() {
    if (st.bar && st.data) st.bar.replaceChildren(...barNodes(st.data));
  }

  function barNodes(d) {
    const status = d.running ? '正在沉淀…' : d.blocker ? `暂不能沉淀：${d.blocker}` : lastText(d.last) ?? '会在积累足够多的新交互后自动沉淀，也可以立即沉淀。';
    return [
      h('span', { class: `muted sk-status${d.blocker && !d.running ? ' warn' : ''}`, text: status }),
      h('button', {
        type: 'button',
        text: d.running ? '正在沉淀…' : '立即沉淀',
        disabled: !d.enabled || d.running,
        title: d.blocker ?? null,
        onclick: (e) => crystallize(e.currentTarget),
      }),
      h('button', {
        type: 'button',
        class: 'ghost',
        text: '新建技能',
        disabled: st.edit?.id === null,
        onclick: () => {
          st.edit = { id: null, draft: blank() };
          st.hist = null;
          paint();
        },
      }),
    ];
  }

  async function crystallize(btn) {
    btn.disabled = true;
    try {
      await post(`${S}/crystallize`);
      toast('已开始沉淀，完成后会提示');
    } catch (e) {
      toast(e.message);
    }
    await load();
  }

  function paint() {
    const root = $('mem-skills');
    if (!root) return;
    if (!st.data) {
      root.replaceChildren(h('p', { class: st.err ? 'err' : 'muted', text: st.err ?? '加载中…' }));
      return;
    }
    const d = st.data;
    const groups = ORDER.map((k) => [k, d.skills.filter((s) => s.status === k)]).filter(([, list]) => list.length);
    st.bar = h('div', { class: 'sk-bar' }, ...barNodes(d));
    const nodes = [
      h('p', { class: 'mem-intro muted', text: '从你反复使用的工作方式里沉淀出的做法。启用的技能会在产品顾问评审和追问时按需参考；候选需要你采纳后才会使用。' }),
      st.bar,
      st.edit?.id === null ? form() : null,
      ...groups.map(([k, list]) => h('div', { class: 'sk-group', 'data-status': k }, h('div', { class: 'grp-title', text: `${STATUS[k]}（${list.length}）` }), ...list.map(card))),
      groups.length || st.edit?.id === null ? null : h('p', { class: 'muted sk-empty', text: '还没有技能。多用几次产品顾问后可以立即沉淀，也可以自己新建。' }),
    ];
    root.replaceChildren(...nodes.filter(Boolean));
    if (!st.edit) return;
    const first = root.querySelector?.('.sk-form input');
    if (st.edit.focus && first) first.focus();
    st.edit.focus = false;
  }

  function card(s) {
    if (st.edit?.id === s.id) return h('div', { class: 'sk-card editing', 'data-id': s.id }, form(s));
    const btn = (text, onclick, cls = 'link') => h('button', { type: 'button', class: cls, text, onclick });
    const status = (to, label, msg) => btn(label, (e) => act(e.currentTarget, () => post(`${S}/${s.id}/status`, { status: to }), msg));
    return h(
      'div',
      { class: `sk-card${s.status === 'retired' ? ' off' : ''}`, 'data-id': s.id },
      h(
        'div',
        { class: 'sk-head' },
        h('span', { class: 'sk-name', text: s.name }),
        h('span', { class: 'tag', text: s.source === 'manual' ? '手写' : '自动沉淀' }),
        s.manual && s.source !== 'manual' ? h('span', { class: 'tag', text: '手改过' }) : null,
        h('span', { class: 'tag', text: `v${s.rev}` }),
        h('span', { class: 'info', text: s.uses ? `参考 ${s.uses} 次` : '尚未参考' }),
      ),
      h('div', { class: 'sk-scene' }, h('span', { class: 'muted', text: '何时用：' }), s.scene),
      h('ol', { class: 'sk-steps' }, ...s.steps.map((x) => h('li', { text: x }))),
      s.cautions.length ? h('div', { class: 'sk-cautions' }, h('span', { class: 'muted', text: '注意：' }), h('ul', {}, ...s.cautions.map((x) => h('li', { text: x })))) : null,
      s.example ? h('details', { class: 'sk-example' }, h('summary', { text: '示例' }), h('div', { class: 'sk-example-body', text: s.example })) : null,
      s.pending ? pendingBox(s) : null,
      h(
        'div',
        { class: 'sk-actions' },
        s.status === 'candidate' ? status('active', '采纳', '已采纳，之后会按需参考') : null,
        s.status === 'active' ? status('retired', '停用', '已停用') : null,
        s.status === 'retired' ? status('active', '重新启用', '已重新启用') : null,
        s.status === 'candidate' ? status('retired', '不采纳', '已停用') : null,
        btn('编辑', () => {
          st.edit = { id: s.id, draft: copy(s), focus: true };
          st.hist = null;
          paint();
        }),
        btn(st.hist?.id === s.id ? '收起历史' : `历史（${s.revisions}）`, () => (st.hist?.id === s.id ? ((st.hist = null), paint()) : openHist(s))),
        btn('删除', (e) => {
          if (!confirm(`删除技能「${s.name}」？版本历史也会一起删除，无法恢复。`)) return;
          act(e.currentTarget, () => api(`${S}/${s.id}`, { method: 'DELETE' }), '已删除');
        }),
      ),
      st.hist?.id === s.id ? histView(s) : null,
    );
  }

  function pendingBox(s) {
    const open = st.pend?.id === s.id;
    const p = st.pend;
    return h(
      'div',
      { class: 'sk-pending' },
      h(
        'div',
        { class: 'sk-pending-bar' },
        h('span', { class: 'sk-badge', text: '有新版可参考' }),
        h('span', { class: 'muted', text: '你手改过这个技能，新沉淀出的版本没有直接覆盖。' }),
        h('button', { type: 'button', class: 'link', text: open ? '收起对比' : '对比', onclick: () => (open ? ((st.pend = null), paint()) : openPending(s)) }),
        h('button', { type: 'button', class: 'link', text: '采用新版', onclick: (e) => act(e.currentTarget, () => post(`${S}/${s.id}/accept`), '已采用新版', () => (st.pend = null)) }),
        h('button', { type: 'button', class: 'link', text: '忽略', onclick: (e) => act(e.currentTarget, () => api(`${S}/${s.id}/pending`, { method: 'DELETE' }), '已忽略新版', () => (st.pend = null)) }),
      ),
      open
        ? p.data
          ? h('div', { class: 'sk-diff' }, h('p', { class: 'muted', text: '- 为当前有而新版没有，+ 为新版新增。' }), ...diffNodes(h, p.data.diff, { full: false, opened: p.opened, repaint: paint }))
          : h('p', { class: p.err ? 'err' : 'muted', text: p.err ?? '加载中…' })
        : null,
    );
  }

  async function openPending(s) {
    const p = { id: s.id, data: null, opened: new Set(), err: null };
    st.pend = p;
    paint();
    try {
      p.data = await api(`${S}/${s.id}/pending/diff`);
    } catch (e) {
      p.err = e.message;
    }
    if (st.pend === p) paint();
  }

  // ---------------- 编辑表单 ----------------
  function form(s) {
    const e = st.edit;
    const d = e.draft;
    const field = (label, hint, el) => h('label', { class: 'sk-field' }, h('span', { class: 'sk-label' }, label, h('small', { class: 'muted', text: hint })), el);
    const input = (key, max, ph) => {
      const el = h('input', { class: 'kb-input', maxlength: String(max), placeholder: ph, autocomplete: 'off' });
      el.value = d[key];
      el.addEventListener('input', () => (d[key] = el.value));
      return el;
    };
    const area = (key, max, rows, ph) => {
      const el = h('textarea', { class: 'kb-input', maxlength: String(max), rows: String(rows), placeholder: ph });
      el.value = d[key];
      el.addEventListener('input', () => (d[key] = el.value));
      return el;
    };
    const list = (key, max, each, label) =>
      h(
        'div',
        { class: 'sk-list', 'data-key': key },
        ...d[key].map((v, i) => {
          const el = h('input', { class: 'kb-input', maxlength: String(each), 'aria-label': `${label} ${i + 1}`, autocomplete: 'off' });
          el.value = v;
          el.addEventListener('input', () => (d[key][i] = el.value));
          return h(
            'div',
            { class: 'sk-list-row' },
            h('span', { class: 'muted sk-n', text: key === 'steps' ? `${i + 1}.` : '-' }),
            el,
            h('button', {
              type: 'button',
              class: 'link',
              text: '删除',
              'aria-label': `删除${label} ${i + 1}`,
              onclick: () => {
                d[key].splice(i, 1);
                paint();
              },
            }),
          );
        }),
        d[key].length < max
          ? h('button', {
              type: 'button',
              class: 'link sk-add',
              text: `添加${label}`,
              onclick: () => {
                d[key].push('');
                paint();
              },
            })
          : null,
      );
    const cancel = () => {
      st.edit = null;
      paint();
    };
    return h(
      'div',
      { class: 'sk-form' },
      h('div', { class: 'sk-form-title', text: s ? `编辑「${s.name}」` : '新建技能' }),
      field('名称', `${LIM.nameMin}–${LIM.nameMax} 字`, input('name', LIM.nameMax, '例如：周报起草与整理流程')),
      field('何时用', `${LIM.sceneMin}–${LIM.sceneMax} 字`, area('scene', LIM.sceneMax, 2, '在什么情况下用这套做法')),
      h('div', { class: 'sk-field' }, h('span', { class: 'sk-label' }, '步骤', h('small', { class: 'muted', text: `${LIM.stepsMin}–${LIM.stepsMax} 条，每条不超过 ${LIM.stepMax} 字` })), list('steps', LIM.stepsMax, LIM.stepMax, '步骤')),
      h('div', { class: 'sk-field' }, h('span', { class: 'sk-label' }, '注意', h('small', { class: 'muted', text: `可选，最多 ${LIM.cautionsMax} 条` })), list('cautions', LIM.cautionsMax, LIM.cautionMax, '注意事项')),
      field('示例', `可选，不超过 ${LIM.exampleMax} 字`, area('example', LIM.exampleMax, 3, '')),
      h(
        'div',
        { class: 'sk-actions' },
        h('button', { type: 'button', text: '保存', onclick: (ev) => save(ev.currentTarget, s) }),
        h('button', { type: 'button', class: 'link', text: '取消', onclick: cancel }),
      ),
    );
  }

  /** 先在页面上拦下明显不合规的输入，最终以服务端校验为准 */
  function problem(d) {
    if (cps(d.name) < LIM.nameMin || cps(d.name) > LIM.nameMax) return `名称需在 ${LIM.nameMin}–${LIM.nameMax} 字之间`;
    if (cps(d.scene) < LIM.sceneMin || cps(d.scene) > LIM.sceneMax) return `何时用需在 ${LIM.sceneMin}–${LIM.sceneMax} 字之间`;
    const steps = d.steps.filter((x) => cps(x));
    if (steps.length < LIM.stepsMin || steps.length > LIM.stepsMax) return `步骤需在 ${LIM.stepsMin}–${LIM.stepsMax} 条之间`;
    return null;
  }

  async function save(btn, s) {
    const d = st.edit.draft;
    const why = problem(d);
    if (why) return toast(why);
    const body = {
      name: d.name.trim(),
      scene: d.scene.trim(),
      steps: d.steps.map((x) => x.trim()).filter(Boolean),
      cautions: d.cautions.map((x) => x.trim()).filter(Boolean),
      example: d.example.trim(),
    };
    await act(
      btn,
      () => (s ? api(`${S}/${s.id}`, { method: 'PUT', body }) : post(S, body)),
      s ? '已保存为新版本' : '已新建，采纳后才会参考',
      () => (st.edit = null),
    );
  }

  // ---------------- 技能历史 ----------------
  async function openHist(s) {
    const hs = { id: s.id, list: null, rev: null, data: null, opened: new Set(), full: false, err: null };
    st.hist = hs;
    st.edit = null;
    paint();
    try {
      hs.list = (await api(`${S}/${s.id}/revisions`)).revisions;
    } catch (e) {
      hs.err = e.message;
    }
    if (st.hist === hs) paint();
  }

  async function pickRev(rev) {
    const hs = st.hist;
    Object.assign(hs, { rev, data: null, err: null, opened: new Set() });
    paint();
    try {
      const d = await api(`${S}/${hs.id}/revisions/${rev}/diff`);
      if (hs.rev === rev) hs.data = d;
    } catch (e) {
      if (hs.rev === rev) hs.err = e.message;
    }
    if (st.hist === hs) paint();
  }

  function histView(s) {
    const hs = st.hist;
    return revPanel({
      hs,
      cur: s.rev,
      label: (r) => `v${r.rev} · ${SK_ORIGIN[r.origin] ?? r.origin} · ${when(r.created_at)}${r.rev === s.rev ? ' · 当前' : ''}`,
      pick: pickRev,
      restore: (btn, rev) => {
        if (!confirm(`把「${s.name}」回退到 v${rev}？会另存为一个新版本，可以再回退。`)) return;
        act(btn, () => post(`${S}/${s.id}/restore`, { rev }), `已回退到 v${rev}`, () => (st.hist = null));
      },
      repaint: paint,
    });
  }

  /** 技能历史与画像历史共用：版本列表 + 选中版本与当前的差异 + 回退 */
  function revPanel({ hs, cur, label, pick, restore, repaint }) {
    const list =
      hs.list == null
        ? h('p', { class: hs.err ? 'err' : 'muted', text: hs.err ?? '加载中…' })
        : hs.list.length
          ? h(
              'ol',
              { class: 'sk-revs' },
              ...hs.list.map((r) =>
                h(
                  'li',
                  {},
                  h('button', { type: 'button', class: `link${r.rev === hs.rev ? ' on' : ''}`, text: label(r), onclick: () => pick(r.rev) }),
                  r.reason ? h('span', { class: 'muted sk-reason', text: r.reason }) : null,
                ),
              ),
            )
          : h('p', { class: 'muted', text: '还没有历史版本。' });
    let detail = null;
    if (hs.rev != null && hs.list != null) {
      detail = !hs.data
        ? h('p', { class: hs.err ? 'err' : 'muted', text: hs.err ?? '加载中…' })
        : h(
            'div',
            { class: 'sk-diff' },
            h(
              'div',
              { class: 'sk-diff-bar' },
              h('span', { class: 'muted', text: hs.rev === cur ? `v${hs.rev} 是当前版本` : `v${hs.rev} → 当前 v${cur}` }),
              h('button', {
                type: 'button',
                class: 'link',
                text: hs.full ? '只看改动' : '显示全文',
                onclick: () => {
                  hs.full = !hs.full;
                  repaint();
                },
              }),
              hs.rev !== cur ? h('button', { type: 'button', class: 'link', text: '回退到此版本', onclick: (e) => restore(e.currentTarget, hs.rev) }) : null,
            ),
            ...diffNodes(h, hs.data.diff, { full: hs.full, opened: hs.opened, repaint }),
          );
    }
    return h('div', { class: 'sk-hist' }, h('p', { class: 'muted sk-hint', text: '选一个版本，查看它与当前版本的差异：- 为该版本有而当前没有，+ 为当前新增。' }), list, detail);
  }

  // ---------------- 画像历史 ----------------
  function renderProfileHistory(count) {
    if (count !== ph.count) {
      ph.count = count;
      ph.list = null;
      ph.rev = null;
      ph.data = null;
    }
    paintProfile();
  }

  async function loadProfileVersions() {
    ph.loading = true;
    ph.err = null;
    try {
      ph.list = (await api('/api/memory/profile/versions')).versions;
    } catch (e) {
      ph.err = e.message;
    }
    ph.loading = false;
    paintProfile();
  }

  async function pickProfileRev(rev) {
    Object.assign(ph, { rev, data: null, err: null, opened: new Set() });
    paintProfile();
    try {
      const d = await api(`/api/memory/profile/versions/${rev}/diff`);
      if (ph.rev === rev) ph.data = d;
    } catch (e) {
      if (ph.rev === rev) ph.err = e.message;
    }
    paintProfile();
  }

  function paintProfile() {
    const root = $('mem-profile-hist');
    if (!root) return;
    const n = ph.count ?? 0;
    const toggle = h('button', {
      type: 'button',
      class: 'link sk-ph-toggle',
      text: ph.open ? '收起画像历史' : `画像历史（${n} 版）`,
      disabled: !n && !ph.open,
      onclick: () => {
        ph.open = !ph.open;
        paintProfile();
      },
    });
    if (!ph.open) return root.replaceChildren(toggle);
    if (ph.list == null && !ph.loading && !ph.err) loadProfileVersions();
    const cur = ph.list?.[0]?.rev ?? null;
    root.replaceChildren(
      toggle,
      revPanel({
        hs: ph,
        cur,
        label: (r) => `v${r.rev} · ${PF_ORIGIN[r.origin] ?? r.origin} · ${when(r.created_at)}${r.rev === cur ? ' · 当前' : ''}`,
        pick: pickProfileRev,
        restore: async (btn, rev) => {
          if (!confirm(`把画像回退到 v${rev}？会另存为一个新版本，可以再回退。`)) return;
          btn.disabled = true;
          try {
            await post('/api/memory/profile/restore', { rev });
            toast(`画像已回退到 v${rev}`);
          } catch (e) {
            toast(e.message);
            btn.disabled = false;
            return;
          }
          ph.list = null;
          ph.rev = null;
          ph.data = null;
          await onProfileChange?.();
        },
        repaint: paintProfile,
      }),
    );
  }

  /** 离开技能标签时停止轮询（编辑草稿保留） */
  function hide() {
    clearTimeout(st.poll);
  }

  return { load, hide, renderProfileHistory };
}
