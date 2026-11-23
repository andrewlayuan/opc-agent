// 运营页：投放列表、新建表单、逐平台生成与 AI 复核、命中高亮、自查清单、字段编辑、历史差异、定稿与导出。
// 用户与模型文本只通过 textContent 写入；命中按码点偏移切分文本节点。差异渲染由 app.js 传入（pm-diff.js 的 diffNodes）
export function initGrowth({ h, api, toast, diffNodes }) {
  const $ = (id) => document.getElementById(id);
  const ORIGIN = { generate: '生成', edit: '手改', replace: '替换', restore: '回退' };
  const STATE = { empty: '未生成', must: '必须改', warn: '注意', ok: '通过', final: '已定稿' };
  const STOP = new Set([400, 404, 409]);
  const POINTS_MAX = 10;
  /** mode：detail 为查看投放，new 为新建表单；busy / failed 按文案 id 记录生成或复核状态；edit、hist、info 为当前打开的编辑、历史、投放信息表单 */
  const st = {
    meta: null, list: [], camp: null, mode: 'none', seq: 0,
    tab: new Map(), busy: new Map(), failed: new Map(), issues: new Map(),
    edit: null, hist: null, info: null, marks: new Map(),
  };
  const cps = (s) => Array.from(String(s ?? '').trim()).length;
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const kids = (...xs) => xs.flat().filter((x) => x != null && x !== false);
  const plat = (id) => st.meta?.platforms.find((p) => p.id === id) ?? { id, name: id, fields: [], total: null };
  const post = (path, body = {}) => api(path, { method: 'POST', body });
  const isDraft = (c) => c.status !== 'final';
  const input = (attrs, value = '') => {
    const el = h('input', { class: 'kb-input', autocomplete: 'off', ...attrs });
    el.value = value;
    return el;
  };
  const area = (attrs, value = '') => {
    const el = h('textarea', { class: 'kb-input', ...attrs });
    el.value = value;
    return el;
  };
  const limitText = (n, min, max, unit) => (min != null && max != null ? `${n} ${unit}（${min}–${max}）` : max != null ? `${n} / ${max} ${unit}` : `${n} ${unit}`);
  const isOver = (n, min, max) => (max != null && n > max) || (min != null && n > 0 && n < min);

  /** 字段路径的中文名，与服务端 pathLabel 一致：`points.0.desc` → 「卖点 1 说明」 */
  function pathLabel(p, path) {
    if (!path) return p.total?.label ?? '整体';
    const [k, i, sub] = path.split('.');
    const d = p.fields.find((x) => x.key === k);
    if (!d) return path;
    if (i === undefined) return d.label;
    const head = `${d.label} ${Number(i) + 1}`;
    return sub === undefined ? head : `${head} ${d.item?.find((x) => x.key === sub)?.label ?? sub}`;
  }

  /** 单个字段复制出去的纯文本：标签为 `#a #b`，分段为编号列表 */
  function fieldText(d, v) {
    if (d.kind === 'tags') return (v ?? []).map((t) => `#${t}`).join(' ');
    if (d.kind === 'items') return (v ?? []).map((x, i) => `${i + 1}. ${d.item.map((it) => `${it.label}：${x[it.key] ?? ''}`).join('／')}`).join('\n');
    return v ?? '';
  }

  /** 与服务端 renderCopy 相同的格式，用于「复制全部」 */
  function renderText(pid, f) {
    const s = (k) => (typeof f[k] === 'string' ? f[k] : '');
    const a = (k) => (Array.isArray(f[k]) ? f[k] : []);
    switch (pid) {
      case 'xhs':
        return `### ${s('title')}\n\n${s('body')}\n\n${a('tags').map((t) => `#${t}`).join(' ')}`;
      case 'wechat':
        return `### ${s('title')}\n\n> ${s('digest')}\n\n${s('body')}`;
      case 'video':
        return [`**开头 3 秒**：${s('hook')}`, a('shots').map((x, i) => `${i + 1}. 画面：${x.scene ?? ''}／口播：${x.line ?? ''}`).join('\n'), `**结尾**：${s('cta')}`].join('\n\n');
      case 'landing':
        return [`### ${s('slogan')}`, s('subtitle'), a('points').map((x) => `- **${x.title ?? ''}**：${x.desc ?? ''}`).join('\n'), `**商店简介**：${s('store_desc')}`].join('\n\n');
    }
    return '';
  }

  async function copyOut(text) {
    if (!navigator.clipboard?.writeText) return toast('当前环境不支持复制，请手动选择文字');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择文字');
    }
  }

  /** 按码点偏移把文本切成普通文本与命中高亮；重叠或越界的命中跳过 */
  function highlight(text, hits) {
    const cs = Array.from(String(text ?? ''));
    const out = [];
    let pos = 0;
    for (const x of [...hits].sort((a, b) => a.start - b.start)) {
      if (x.start < pos || x.end > cs.length || x.end <= x.start) continue;
      if (x.start > pos) out.push(cs.slice(pos, x.start).join(''));
      const m = h('mark', { class: `gr-hit ${x.level}${x.kept ? ' kept' : ''}`, 'data-key': x.key, title: `${x.label}：${x.reason}`, text: cs.slice(x.start, x.end).join('') });
      st.marks.set(x.key, m);
      out.push(m);
      pos = x.end;
    }
    if (pos < cs.length) out.push(cs.slice(pos).join(''));
    return out;
  }

  function stateOf(c) {
    if (st.busy.get(c.id) === 'gen') return ['run', '生成中…'];
    if (st.failed.get(c.id) === 'gen') return ['fail', '失败，重试'];
    if (c.rev === 0) return ['empty', '未生成'];
    if (!isDraft(c)) return ['final', '已定稿'];
    if (c.check.mustOpen) return ['must', `必须改 ${c.check.mustOpen}`];
    if (c.check.warnOpen) return ['warn', `注意 ${c.check.warnOpen}`];
    return ['ok', '通过'];
  }

  async function reloadList() {
    try {
      st.list = (await api('/api/growth/campaigns')).campaigns;
    } catch (e) {
      toast(e.message);
    }
    renderSide();
  }

  async function load() {
    try {
      st.meta = await api('/api/growth/meta');
      await reloadList();
      if (st.mode === 'new') return;
      if (st.camp && st.list.some((c) => c.id === st.camp.id)) {
        if (st.busy.size) return paint();
        return await open(st.camp.id);
      }
      if (st.list.length) await open(st.list[0].id);
      else openNew();
    } catch (e) {
      toast(e.message);
    }
  }

  function renderSide() {
    const cur = st.mode === 'detail' ? st.camp?.id : null;
    const items = st.list.map((c) =>
      h('li', {},
        h('button', { type: 'button', class: `cp-prod gr-camp${c.id === cur ? ' on' : ''}`, onclick: () => open(c.id) },
          h('span', { class: 'cp-prod-name', text: c.name }),
          h('span', { class: 'cp-prod-meta' },
            h('span', { class: 'gr-camp-prod', text: c.product_name }),
            h('span', { class: 'gr-dots' },
              ...c.copies.map((x) => {
                const t = `${plat(x.platform).name}：${STATE[x.state] ?? x.state}`;
                return h('span', { class: `gr-dot s-${x.state}`, title: t, role: 'img', 'aria-label': t });
              }),
            ),
          ),
        ),
      ),
    );
    $('gr-side').replaceChildren(
      h('div', { class: 'cp-side-head' },
        h('span', { class: 'cp-side-title', text: '投放' }),
        h('button', { type: 'button', class: 'link', text: '新建投放', onclick: () => openNew() }),
      ),
      items.length ? h('ol', { class: 'cp-list' }, ...items) : h('p', { class: 'muted cp-empty', text: '还没有投放，先新建一个。' }),
    );
  }

  /** 投放信息表单：新建（含平台勾选）与编辑共用 */
  function campaignForm(init, o) {
    const m = st.meta;
    const name = input({ name: 'name', maxlength: 60, required: true, placeholder: '例如：v1.2 上线' }, init?.name ?? '');
    const prod = h('select', { name: 'product', class: 'kb-select' },
      h('option', { value: '', text: '不关联，手填' }),
      ...m.products.map((p) => h('option', { value: String(p.id), text: p.name })),
    );
    if (init?.product_id != null && m.products.some((p) => p.id === init.product_id)) prod.value = String(init.product_id);
    const pname = input({ name: 'product_name', maxlength: 60, required: true, placeholder: '产品叫什么' }, init?.product_name ?? '');
    const pdesc = area({ name: 'product_desc', rows: 4, maxlength: 2000, placeholder: '做什么、给谁用、怎么收费' }, init?.product_desc ?? '');
    const hint = h('p', { class: 'muted gr-hint' });
    const pick = () => m.products.find((x) => String(x.id) === prod.value);
    const syncHint = () => {
      const p = pick();
      hint.textContent = !p
        ? '不关联时只跑通用规则；关联做过合规判定的产品后，会按判定结果（未成年人、AI、收费）收紧部分规则。'
        : p.assessed
          ? '自查会参考该产品最新的合规判定。'
          : '该产品还没做合规判定，自查只跑通用规则。';
    };
    prod.addEventListener('change', () => {
      const p = pick();
      if (p) {
        pname.value = p.name;
        pdesc.value = p.description;
      }
      syncHint();
    });
    syncHint();

    const rows = [];
    const pointsBox = h('div', { class: 'gr-points' });
    const addBtn = h('button', { type: 'button', class: 'link', text: '添加卖点', onclick: () => addPoint() });
    const syncAdd = () => (addBtn.hidden = rows.length >= POINTS_MAX);
    function addPoint(v = '') {
      if (rows.length >= POINTS_MAX) return;
      const el = input({ name: 'point', maxlength: 100, placeholder: `卖点 ${rows.length + 1}，如「自动汇总本周日程」` }, v);
      const r = { el, row: null };
      r.row = h('div', { class: 'gr-point' }, el,
        h('button', { type: 'button', class: 'link', text: '×', title: '删除这条卖点', 'aria-label': '删除这条卖点', onclick: () => {
          if (rows.length <= 1) return void (el.value = '');
          rows.splice(rows.indexOf(r), 1);
          r.row.remove();
          syncAdd();
        } }),
      );
      rows.push(r);
      pointsBox.append(r.row);
      syncAdd();
    }
    const initPoints = init?.points?.length ? init.points : ['', '', ''];
    for (const v of initPoints) addPoint(v);

    const audience = input({ name: 'audience', maxlength: 200, placeholder: '例如：每周要写周报的职场人' }, init?.audience ?? '');
    const offer = input({ name: 'offer', maxlength: 200, placeholder: '例如：首月 5 折，截至 12 月 31 日' }, init?.offer ?? '');
    const tone = h('select', { name: 'tone', class: 'kb-select' }, ...m.tones.map((t) => h('option', { value: t.id, text: t.label })));
    tone.value = init?.tone ?? 'warm';
    const plats = o.platforms
      ? m.platforms.map((p) => {
          const cb = h('input', { type: 'checkbox', name: 'platform', value: p.id });
          cb.checked = true;
          return { id: p.id, cb, el: h('label', { class: 'gr-check' }, cb, p.name) };
        })
      : [];
    const submit = h('button', { type: 'submit', text: o.submitText });
    return h('form', { class: `cp-form gr-form${o.platforms ? '' : ' gr-info'}`, onsubmit: async (e) => {
      e.preventDefault();
      const body = {
        name: name.value,
        product_id: prod.value ? Number(prod.value) : null,
        product_name: pname.value,
        product_desc: pdesc.value,
        points: rows.map((r) => r.el.value.trim()).filter(Boolean),
        audience: audience.value,
        offer: offer.value,
        tone: tone.value,
      };
      if (!body.points.length) return toast('请至少填写一条卖点');
      if (o.platforms) {
        body.platforms = plats.filter((x) => x.cb.checked).map((x) => x.id);
        if (!body.platforms.length) return toast('至少选择一个平台');
      }
      submit.disabled = true;
      try {
        await o.onSubmit(body);
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    } },
      o.heading,
      h('label', { class: 'kb-field' }, '投放名称', name),
      h('label', { class: 'kb-field' }, '关联合规产品', prod, hint),
      h('label', { class: 'kb-field' }, '产品名', pname),
      h('label', { class: 'kb-field' }, '产品描述（可选）', pdesc),
      h('div', { class: 'kb-field' }, `卖点（1–${POINTS_MAX} 条）`, pointsBox, h('div', {}, addBtn)),
      h('div', { class: 'gr-form-row' },
        h('label', { class: 'kb-field' }, '目标用户（可选）', audience),
        h('label', { class: 'kb-field' }, '活动信息（可选）', offer),
        h('label', { class: 'kb-field gr-tone' }, '语气', tone),
      ),
      o.platforms ? h('fieldset', { class: 'gr-plats' }, h('legend', { text: '平台' }), ...plats.map((x) => x.el)) : null,
      o.platforms && !m.llm ? h('p', { class: 'muted', text: '未配置模型：创建后只能手动填写文案。' }) : null,
      h('div', { class: 'cp-actions' }, submit, o.onCancel ? h('button', { type: 'button', class: 'ghost', text: '取消', onclick: o.onCancel }) : null),
    );
  }

  function openNew() {
    st.mode = 'new';
    ++st.seq;
    st.info = null;
    renderSide();
    const form = campaignForm(null, {
      heading: h('h2', { class: 'cp-title', text: '新建投放' }),
      submitText: st.meta.llm ? '创建并生成' : '创建',
      platforms: true,
      onSubmit: async (body) => {
        const { campaign } = await post('/api/growth/campaigns', body);
        st.mode = 'detail';
        st.camp = campaign;
        ++st.seq;
        await reloadList();
        paint();
        if (st.meta.llm) await runGen(campaign.copies.filter((c) => c.rev === 0));
        else toast('已创建；未配置模型，请在各平台手动填写');
      },
    });
    $('gr-main').replaceChildren(form);
  }

  async function open(id) {
    const seq = ++st.seq;
    if (st.camp?.id !== id) {
      st.edit = null;
      st.hist = null;
      st.info = null;
    }
    try {
      const { campaign } = await api(`/api/growth/campaigns/${id}`);
      if (seq !== st.seq) return;
      st.mode = 'detail';
      if (st.camp?.id === id) {
        const mine = new Map(st.camp.copies.map((x) => [x.id, x]));
        campaign.copies = campaign.copies.map((x) => (mine.get(x.id)?.rev > x.rev ? mine.get(x.id) : x));
      }
      st.camp = campaign;
      renderSide();
      paint();
    } catch (e) {
      if (seq === st.seq) toast(e.message);
    }
  }

  /** 只接受不比本地旧的版本，避免先发后到的响应覆盖新内容 */
  function putCopy(copy) {
    const list = st.camp?.copies;
    const i = list ? list.findIndex((x) => x.id === copy.id) : -1;
    if (i >= 0 && copy.rev >= list[i].rev) list[i] = copy;
    st.issues.delete(copy.id);
  }

  async function refresh(id) {
    try {
      putCopy((await api(`/api/growth/copies/${id}`)).copy);
    } catch (e) {
      toast(e.message);
    }
    paint();
  }

  /** 生成一个平台，成功后立即复核。返回 ok / fail / skip（404 已删除、409 已改动或定稿）/ stop（400 未配置模型） */
  async function genOne(id, quiet) {
    st.busy.set(id, 'gen');
    st.failed.delete(id);
    paint();
    try {
      putCopy((await post(`/api/growth/copies/${id}/generate`)).copy);
    } catch (e) {
      st.busy.delete(id);
      if (STOP.has(e.status)) {
        toast(e.message);
        if (e.status === 409) await refresh(id);
        else if (e.status === 404) await open(st.camp.id);
        else paint();
        return e.status === 400 ? 'stop' : 'skip';
      }
      st.failed.set(id, 'gen');
      if (!quiet) toast(e.message);
      paint();
      return 'fail';
    }
    await reviewOne(id);
    return 'ok';
  }

  async function reviewOne(id) {
    st.busy.set(id, 'review');
    st.failed.delete(id);
    paint();
    try {
      putCopy((await post(`/api/growth/copies/${id}/review`)).copy);
      return null;
    } catch (e) {
      st.failed.set(id, 'review');
      return e;
    } finally {
      st.busy.delete(id);
      paint();
    }
  }

  async function runGen(copies) {
    const cid = st.camp.id;
    let ok = 0;
    let fail = 0;
    for (const { id } of copies) {
      if (st.mode !== 'detail' || st.camp?.id !== cid) return;
      const c = st.camp.copies.find((x) => x.id === id);
      if (!c || c.rev > 0 || st.busy.has(id)) continue;
      const r = await genOne(id, true);
      if (r === 'stop') return;
      if (r === 'ok') ok++;
      else if (r === 'fail') fail++;
    }
    toast(`已生成 ${ok} 个平台，失败 ${fail} 个`);
    await reloadList();
  }

  async function single(id) {
    if ((await genOne(id, false)) === 'ok') toast('已生成');
    await reloadList();
  }

  async function regen(c) {
    if (c.origin === 'edit' && !confirm('将覆盖你的修改（可在历史中找回），继续？')) return;
    await single(c.id);
  }

  async function manualReview(id) {
    const e = await reviewOne(id);
    if (e) toast(e.message);
  }

  async function act(c, path, body, done) {
    try {
      putCopy((await post(`/api/growth/copies/${c.id}/${path}`, body)).copy);
      if (done) toast(done);
    } catch (e) {
      toast(e.message);
      if (e.status === 404) return open(st.camp.id);
      if (e.status === 409 && path !== 'finalize') return refresh(c.id);
      if (e.data?.issues) st.issues.set(c.id, e.data.issues);
    }
    paint();
    await reloadList();
  }

  const replace = (c, items) => act(c, 'replace', { baseRev: c.rev, items });

  async function keep(c, x) {
    if (x.kept) return act(c, 'keep', { key: x.key, reason: '' });
    const r = prompt('保留理由（1–200 字）');
    if (r == null || !r.trim()) return;
    await act(c, 'keep', { key: x.key, reason: r.trim() });
  }

  async function restore(c, n) {
    st.hist = null;
    await act(c, 'restore', { rev: n }, `已回退到 v${n} 的内容`);
  }

  async function delCopy(c) {
    if (!confirm(`删除「${plat(c.platform).name}」的文案及全部历史？`)) return;
    try {
      await api(`/api/growth/copies/${c.id}`, { method: 'DELETE' });
      st.camp.copies = st.camp.copies.filter((x) => x.id !== c.id);
      if (st.edit?.id === c.id) st.edit = null;
      paint();
      await reloadList();
    } catch (e) {
      toast(e.message);
    }
  }

  async function delCampaign(c) {
    if (!confirm(`删除投放「${c.name}」及其全部文案？`)) return;
    try {
      await api(`/api/growth/campaigns/${c.id}`, { method: 'DELETE' });
      st.camp = null;
      st.edit = null;
      st.hist = null;
      st.info = null;
      await reloadList();
      if (st.list.length) await open(st.list[0].id);
      else openNew();
    } catch (e) {
      toast(e.message);
    }
  }

  async function addPlatform(pid) {
    try {
      const { copy } = await post(`/api/growth/campaigns/${st.camp.id}/copies`, { platform: pid });
      st.camp.copies.push(copy);
      const order = st.meta.platforms.map((p) => p.id);
      st.camp.copies.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
      st.tab.set(st.camp.id, pid);
      st.hist = null;
      paint();
      await reloadList();
    } catch (e) {
      toast(e.message);
    }
  }

  function toggleInfo() {
    st.info = st.info
      ? null
      : campaignForm(st.camp, {
          heading: h('h3', { class: 'gr-sub', text: '投放信息' }),
          submitText: '保存',
          platforms: false,
          onCancel: () => {
            st.info = null;
            paint();
          },
          onSubmit: async (body) => {
            const { campaign } = await api(`/api/growth/campaigns/${st.camp.id}`, { method: 'PUT', body });
            st.camp = campaign;
            st.info = null;
            paint();
            await reloadList();
            toast('已保存；基于旧信息生成的文案会提示重新生成');
          },
        });
    paint();
  }

  function paint() {
    if (st.mode !== 'detail' || !st.camp) return;
    st.marks = new Map();
    const c = st.camp;
    let pid = st.tab.get(c.id);
    if (!c.copies.some((x) => x.platform === pid)) {
      pid = c.copies[0]?.platform;
      st.tab.set(c.id, pid);
    }
    const cur = c.copies.find((x) => x.platform === pid);
    $('gr-main').replaceChildren(...kids(
      head(c),
      st.info,
      tabsBar(c, pid),
      cur ? panel(cur) : h('p', { class: 'muted gr-none', text: '这个投放还没有平台，先补加一个。' }),
    ));
  }

  function head(c) {
    const tone = st.meta.tones.find((t) => t.id === c.tone)?.label ?? c.tone;
    const flags = [c.ctx.minors && '可能有未成年人用户', c.ctx.ai && '使用 AI', c.ctx.paid && '收费'].filter(Boolean);
    const ctxText = c.product_id == null ? '未关联合规产品：只跑通用规则' : flags.length ? `按合规判定收紧：${flags.join('、')}` : '已关联合规产品（判定中没有需要收紧规则的情形）';
    return h('div', { class: 'cp-head gr-head' },
      h('div', { class: 'cp-head-text' },
        h('h2', { class: 'cp-title', text: c.name }),
        h('p', { class: 'muted cp-desc', text: `${c.product_name} · 语气${tone} · 卖点 ${c.points.length} 条${c.offer ? ` · 活动：${c.offer}` : ''}` }),
        h('p', { class: 'muted cp-desc gr-ctx', text: ctxText }),
      ),
      h('div', { class: 'gr-head-actions' },
        h('button', { type: 'button', class: 'link', text: st.info ? '收起投放信息' : '编辑投放信息', onclick: toggleInfo }),
        h('a', { class: 'gr-export', href: `/api/growth/campaigns/${c.id}/export?format=md`, text: '导出 Markdown' }),
        h('button', { type: 'button', class: 'link gr-danger', text: '删除投放', onclick: () => delCampaign(c) }),
      ),
    );
  }

  function tabsBar(c, pid) {
    const bar = h('div', { class: 'pm-tabs kb-tabs gr-tabs', role: 'tablist', 'aria-label': '平台' },
      ...c.copies.map((x) => {
        const [k, label] = stateOf(x);
        const on = x.platform === pid;
        return h('button', {
          type: 'button',
          role: 'tab',
          class: `pm-tab gr-tab s-${k}${on ? ' on' : ''}`,
          'aria-selected': on ? 'true' : 'false',
          text: `${plat(x.platform).name} · ${label}`,
          onclick: () => {
            st.tab.set(c.id, x.platform);
            st.hist = null;
            paint();
          },
        });
      }),
    );
    const missing = st.meta.platforms.filter((p) => !c.copies.some((x) => x.platform === p.id));
    if (missing.length) {
      const sel = h('select', { class: 'kb-select gr-add-sel', 'aria-label': '补加平台' }, ...missing.map((p) => h('option', { value: p.id, text: p.name })));
      bar.append(h('span', { class: 'gr-add' }, sel, h('button', { type: 'button', class: 'link', text: '补加平台', onclick: () => addPlatform(sel.value) })));
    }
    return bar;
  }

  function panel(c) {
    const p = plat(c.platform);
    if (st.hist?.id === c.id) return histView(c);
    if (st.edit?.id === c.id) return h('div', { class: 'gr-panel' }, st.edit.el);
    const busy = st.busy.get(c.id);
    const failed = st.failed.get(c.id);
    if (c.rev === 0) {
      return h('div', { class: 'gr-panel gr-blank' },
        h('p', { class: failed === 'gen' ? 'err' : 'muted', text: busy === 'gen' ? '生成中…' : failed === 'gen' ? '生成失败。' : '还没有生成。' }),
        busy
          ? null
          : h('div', { class: 'cp-actions' },
              st.meta.llm ? h('button', { type: 'button', text: failed === 'gen' ? '重试生成' : '生成', onclick: () => single(c.id) }) : null,
              h('button', { type: 'button', class: 'ghost', text: '手动填写', onclick: () => startEdit(c) }),
              h('button', { type: 'button', class: 'link gr-danger', text: '删除此平台', onclick: () => delCopy(c) }),
            ),
        st.meta.llm ? null : h('p', { class: 'muted', text: '未配置模型，只能手动填写。' }),
      );
    }
    const draft = isDraft(c);
    const note = (cls, ...xs) => h('p', { class: `gr-note${cls ? ` ${cls}` : ''}` }, ...xs);
    const link = (text, onclick) => h('button', { type: 'button', class: 'link', text, onclick });
    return h('div', { class: 'gr-panel' },
      busy === 'gen' ? note('', '重新生成中…') : null,
      busy === 'review' ? note('', 'AI 复核中…') : null,
      failed === 'gen' ? note('warn', '重新生成失败，', link('重试', () => single(c.id))) : null,
      failed === 'review' ? note('warn', '复核失败，', link('重试', () => manualReview(c.id))) : null,
      c.stale ? note('', '投放信息已更新，', draft ? link('重新生成', () => regen(c)) : '取消定稿后可重新生成') : null,
      c.review_base != null && c.review_base !== c.rev ? note('', `AI 复核基于 v${c.review_base}（当前 v${c.rev}），可重新复核`) : null,
      st.issues.has(c.id)
        ? h('div', { class: 'cp-doc-err gr-issues' },
            h('strong', { text: '定稿前还需处理：' }),
            h('ul', {}, ...st.issues.get(c.id).map((x) => h('li', { text: `${x.label}：${x.text}` }))),
          )
        : null,
      h('div', { class: 'gr-grid' }, fieldsView(c, p), checksView(c, p)),
      actions(c),
    );
  }

  function countText(d, v) {
    if (d.kind === 'tags' || d.kind === 'items') return limitText((v ?? []).length, d.minItems, d.maxItems, d.unit);
    return limitText(cps(v), d.min, d.max, '字');
  }

  function fieldsView(c, p) {
    const hitsAt = (path) => c.check.hits.filter((x) => x.path === path);
    const lens = (key) => c.check.lengths.filter((l) => l.path === key || l.path.startsWith(`${key}.`));
    const out = p.fields.map((d) => {
      const v = c.fields[d.key];
      const list = Array.isArray(v) ? v : [];
      const empty = d.kind === 'tags' || d.kind === 'items' ? !list.length : !String(v ?? '').trim();
      let body;
      if (d.kind === 'tags') body = h('div', { class: 'gr-tags' }, ...list.map((t, i) => h('span', { class: 'gr-tag' }, '#', ...highlight(t, hitsAt(`${d.key}.${i}`)))));
      else if (d.kind === 'items')
        body = h('ol', { class: 'gr-items' },
          ...list.map((x, i) =>
            h('li', {},
              ...d.item.map((it) =>
                h('div', { class: 'gr-item-row' },
                  h('span', { class: 'muted gr-item-label', text: it.label }),
                  h('span', { class: 'gr-text' }, ...highlight(x[it.key] ?? '', hitsAt(`${d.key}.${i}.${it.key}`))),
                ),
              ),
            ),
          ),
        );
      else body = h('div', { class: `gr-text${d.kind === 'md' || (d.min ?? 0) >= 300 ? ' long' : ''}` }, ...highlight(v ?? '', hitsAt(d.key)));
      const notes = lens(d.key);
      return h('div', { class: 'gr-field', 'data-path': d.key },
        h('div', { class: 'gr-field-head' },
          h('span', { class: 'gr-field-label', text: d.label }),
          h('span', { class: `muted gr-count${notes.length ? ' over' : ''}`, text: countText(d, v) }),
          empty ? null : h('button', { type: 'button', class: 'link gr-copy', text: '复制', onclick: () => copyOut(fieldText(d, v)) }),
        ),
        empty ? h('p', { class: 'muted', text: '未填写' }) : body,
        ...notes.map((l) => h('p', { class: 'gr-len', text: l.text })),
      );
    });
    return h('div', { class: 'gr-fields' }, ...out, ...c.check.lengths.filter((l) => l.path === '').map((l) => h('p', { class: 'gr-len', text: l.text })));
  }

  function hitItem(c, p, x) {
    const draft = isDraft(c) && !st.busy.has(c.id);
    return h('div', { class: `gr-hit-item ${x.level}${x.kept ? ' kept' : ''}` },
      h('div', { class: 'gr-hit-top' },
        h('span', { class: 'gr-hit-label', text: x.label }),
        h('span', { class: 'gr-quote', text: `「${x.text}」` }),
        h('span', { class: 'muted gr-where', text: pathLabel(p, x.path) }),
      ),
      h('p', { class: 'gr-reason', text: x.reason }),
      h('p', { class: 'muted gr-basis', text: `依据：${x.basis}` }),
      x.kept ? h('p', { class: 'gr-kept', text: `保留理由：${x.kept.reason}` }) : null,
      h('div', { class: 'gr-hit-actions' },
        ...(draft && !x.kept ? x.suggest.map((s) => h('button', { type: 'button', class: 'link', text: `替换为：${s}`, onclick: () => replace(c, [{ key: x.key, with: s }]) })) : []),
        draft && !x.kept && !x.suggest.length && x.level === 'must' ? h('span', { class: 'muted', text: '需手改' }) : null,
        draft ? h('button', { type: 'button', class: 'link', text: x.kept ? '取消保留' : '保留', onclick: () => keep(c, x) }) : null,
        st.marks.has(x.key) ? h('button', { type: 'button', class: 'link', text: '定位', onclick: () => locate(x.key) }) : null,
      ),
    );
  }

  function locate(key) {
    const m = st.marks.get(key);
    if (!m) return;
    m.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    m.classList.add('flash');
    setTimeout(() => m.classList.remove('flash'), 1600);
  }

  function checksView(c, p) {
    const draft = isDraft(c);
    const open = c.check.hits.filter((x) => !x.kept);
    const must = open.filter((x) => x.level === 'must');
    const warn = open.filter((x) => x.level === 'warn');
    const kept = c.check.hits.filter((x) => x.kept);
    const fixable = must.filter((x) => x.suggest.length);
    const group = (title, cls, items) => (items.length ? h('section', { class: `gr-group ${cls}` }, h('h4', { text: `${title} ${items.length}` }), ...items) : null);
    const rv = c.review;
    return h('aside', { class: 'gr-checks', 'aria-label': '自查清单' },
      h('p', { class: 'gr-notice', text: st.meta.aiNotice }),
      draft
        ? h('div', { class: 'gr-check-bar' },
            fixable.length
              ? h('button', { type: 'button', class: 'ghost', text: `全部替换（${fixable.length}）`, disabled: st.busy.has(c.id), onclick: () => replace(c, fixable.map((x) => ({ key: x.key, with: x.suggest[0] }))) })
              : null,
            st.meta.llm ? h('button', { type: 'button', class: 'ghost', text: 'AI 复核', disabled: st.busy.has(c.id), onclick: () => manualReview(c.id) }) : null,
          )
        : null,
      open.length ? null : h('p', { class: 'gr-pass', text: kept.length ? '本地规则命中均已处理。' : '本地规则未发现问题。' }),
      group('必须改', 'must', must.map((x) => hitItem(c, p, x))),
      group('注意', 'warn', warn.map((x) => hitItem(c, p, x))),
      h('section', { class: 'gr-group review' },
        h('h4', { text: rv?.length ? `建议 ${rv.length}` : '建议' }),
        rv == null
          ? h('p', { class: 'muted', text: st.busy.get(c.id) === 'review' ? 'AI 复核中…' : '还没有 AI 复核。' })
          : !rv.length
            ? h('p', { class: 'muted', text: '没有发现语境问题。' })
            : null,
        ...(rv ?? []).map((r) =>
          h('div', { class: 'gr-hit-item review' },
            h('div', { class: 'gr-hit-top' }, h('span', { class: 'gr-quote', text: `「${r.quote}」` })),
            h('p', { class: 'gr-reason', text: r.issue }),
            r.suggestion ? h('p', { class: 'muted', text: `建议：${r.suggestion}` }) : null,
          ),
        ),
      ),
      group('已保留', 'kept', kept.map((x) => hitItem(c, p, x))),
    );
  }

  function actions(c) {
    const draft = isDraft(c);
    const busy = st.busy.has(c.id);
    return h('div', { class: 'cp-actions gr-actions' },
      draft ? h('button', { type: 'button', class: 'ghost', text: '编辑', disabled: busy, onclick: () => startEdit(c) }) : null,
      draft && st.meta.llm ? h('button', { type: 'button', class: 'ghost', text: '重新生成', disabled: busy, onclick: () => regen(c) }) : null,
      h('button', { type: 'button', class: 'ghost', text: '历史', onclick: () => openHist(c) }),
      h('button', { type: 'button', class: 'ghost', text: '复制全部', onclick: () => copyOut(renderText(c.platform, c.fields)) }),
      h('span', { class: 'gr-gap' }),
      draft
        ? h('button', { type: 'button', text: '定稿', disabled: busy, onclick: () => act(c, 'finalize', {}, '已定稿') })
        : h('button', { type: 'button', class: 'ghost', text: '取消定稿', onclick: () => act(c, 'unfinalize', {}) }),
      draft ? h('button', { type: 'button', class: 'link gr-danger', text: '删除此平台', disabled: busy, onclick: () => delCopy(c) }) : null,
    );
  }

  function startEdit(c) {
    const p = plat(c.platform);
    const f = clone(c.fields);
    for (const d of p.fields) {
      if (d.kind === 'tags') f[d.key] = Array.isArray(f[d.key]) ? f[d.key] : [];
      else if (d.kind === 'items') {
        const a = Array.isArray(f[d.key]) ? f[d.key] : [];
        while (a.length < (d.minItems ?? 1)) a.push(Object.fromEntries(d.item.map((it) => [it.key, ''])));
        f[d.key] = a;
      } else f[d.key] = typeof f[d.key] === 'string' ? f[d.key] : '';
    }
    st.hist = null;
    st.edit = { id: c.id, rev: c.rev, fields: f, el: null };
    st.edit.el = editForm(c, p, st.edit);
    paint();
  }

  function counter(get, min, max, unit) {
    const el = h('span', { class: 'muted gr-count' });
    const upd = () => {
      const n = get();
      el.textContent = limitText(n, min, max, unit);
      el.classList.toggle('over', isOver(n, min, max));
    };
    upd();
    return { el, upd };
  }

  function fieldEditor(d, f) {
    if (d.kind === 'tags') {
      const el = input({ 'aria-label': d.label, placeholder: '用逗号分隔，不用写 #' }, f[d.key].join('，'));
      const cnt = counter(() => f[d.key].length, d.minItems, d.maxItems, d.unit);
      el.addEventListener('input', () => {
        f[d.key] = el.value.split(/[,，、\n]+/).map((t) => t.trim().replace(/^#+/, '').trim()).filter(Boolean);
        cnt.upd();
      });
      return h('label', { class: 'kb-field gr-edit-field' }, h('span', { class: 'gr-field-head' }, d.label, cnt.el), el);
    }
    if (d.kind === 'items') {
      const box = h('div', { class: 'gr-edit-items' });
      const cnt = counter(() => f[d.key].length, d.minItems, d.maxItems, d.unit);
      const draw = () => {
        const arr = f[d.key];
        box.replaceChildren(
          ...arr.map((x, i) =>
            h('div', { class: 'gr-edit-item' },
              h('span', { class: 'muted gr-edit-n', text: String(i + 1) }),
              ...d.item.map((it) => {
                const el = input({ 'aria-label': `${d.label} ${i + 1} ${it.label}`, placeholder: `${it.label}（≤${it.max} 字）` }, x[it.key] ?? '');
                el.addEventListener('input', () => (x[it.key] = el.value));
                return el;
              }),
              arr.length > 1
                ? h('button', { type: 'button', class: 'link', text: '×', title: '删除这一项', 'aria-label': '删除这一项', onclick: () => {
                    arr.splice(i, 1);
                    draw();
                  } })
                : null,
            ),
          ),
          arr.length < (d.maxItems ?? 99)
            ? h('button', { type: 'button', class: 'link', text: `添加${d.label}`, onclick: () => {
                arr.push(Object.fromEntries(d.item.map((it) => [it.key, ''])));
                draw();
              } })
            : null,
        );
        cnt.upd();
      };
      draw();
      return h('div', { class: 'kb-field gr-edit-field' }, h('span', { class: 'gr-field-head' }, d.label, cnt.el), box);
    }
    const long = d.kind === 'md' || (d.max ?? 0) > 64;
    const el = long
      ? area({ 'aria-label': d.label, rows: d.kind === 'md' ? 18 : (d.min ?? 0) >= 300 ? 12 : 4, class: `kb-input gr-area${d.kind === 'md' ? ' mono' : ''}` }, f[d.key])
      : input({ 'aria-label': d.label }, f[d.key]);
    const cnt = counter(() => cps(el.value), d.min, d.max, '字');
    el.addEventListener('input', () => {
      f[d.key] = el.value;
      cnt.upd();
    });
    return h('label', { class: 'kb-field gr-edit-field' }, h('span', { class: 'gr-field-head' }, d.kind === 'md' ? `${d.label}（Markdown）` : d.label, cnt.el), el);
  }

  function editForm(c, p, ed) {
    const save = h('button', { type: 'submit', text: '保存' });
    return h('form', { class: 'gr-edit', onsubmit: async (e) => {
      e.preventDefault();
      const over = p.fields.find((d) => d.kind === 'tags' && ed.fields[d.key].length > d.maxItems);
      if (over) return toast(`${over.label}最多 ${over.maxItems} 个`);
      save.disabled = true;
      try {
        const { copy } = await api(`/api/growth/copies/${c.id}`, { method: 'PUT', body: { fields: ed.fields, baseRev: ed.rev } });
        if (st.edit === ed) st.edit = null;
        putCopy(copy);
        paint();
        await reloadList();
      } catch (err) {
        toast(err.message);
      } finally {
        save.disabled = false;
      }
    } },
      h('p', { class: 'muted gr-edit-hint', text: '字数限制为平台常见要求，超出只提示；保存后重新自查（编辑框内不高亮命中）。' }),
      ...p.fields.map((d) => fieldEditor(d, ed.fields)),
      h('div', { class: 'cp-actions' }, save, h('button', { type: 'button', class: 'ghost', text: '取消', onclick: () => {
        st.edit = null;
        paint();
      } })),
    );
  }

  async function openHist(c) {
    st.edit = null;
    const hs = { id: c.id, list: null, n: null, data: null, opened: new Set(), full: false, err: null };
    st.hist = hs;
    paint();
    try {
      hs.list = (await api(`/api/growth/copies/${c.id}/revisions`)).revisions;
    } catch (e) {
      hs.err = e.message;
    }
    if (st.hist === hs) paint();
  }

  async function pickRev(n) {
    const hs = st.hist;
    Object.assign(hs, { n, data: null, err: null, opened: new Set() });
    paint();
    try {
      const d = await api(`/api/growth/copies/${hs.id}/revisions/${n}?diff=1`);
      if (hs.n === n) hs.data = d;
    } catch (e) {
      if (hs.n === n) hs.err = e.message;
    }
    if (st.hist === hs) paint();
  }

  function histView(c) {
    const hs = st.hist;
    const list =
      hs.list == null
        ? h('p', { class: hs.err ? 'err' : 'muted', text: hs.err ?? '加载中…' })
        : h('ol', { class: 'cp-doc-revs gr-revs' },
            ...hs.list.map((r) =>
              h('li', {},
                h('button', {
                  type: 'button',
                  class: `link${r.n === hs.n ? ' on' : ''}`,
                  text: `v${r.n} · ${ORIGIN[r.origin] ?? r.origin} · ${when(r.created_at)}${r.n === c.rev ? ' · 当前' : ''}${r.reviewed ? ' · 已复核' : ''}`,
                  onclick: () => pickRev(r.n),
                }),
              ),
            ),
          );
    let detail = null;
    if (hs.n != null && hs.list != null) {
      detail = !hs.data
        ? h('p', { class: hs.err ? 'err' : 'muted', text: hs.err ?? '加载中…' })
        : h('div', { class: 'gr-rev' },
            h('div', { class: 'gr-rev-bar' },
              h('span', { class: 'muted', text: hs.n === c.rev ? `v${hs.n} 是当前版本` : `v${hs.n} → 当前 v${c.rev}` }),
              h('button', { type: 'button', class: 'link', text: hs.full ? '只看改动' : '显示全文', onclick: () => {
                hs.full = !hs.full;
                paint();
              } }),
              isDraft(c) && hs.n !== c.rev ? h('button', { type: 'button', class: 'link', text: '回退到此版本', onclick: () => restore(c, hs.n) }) : null,
            ),
            ...diffNodes(h, hs.data.diff, { full: hs.full, opened: hs.opened, repaint: paint }),
          );
    }
    return h('div', { class: 'gr-panel gr-hist' },
      h('div', { class: 'gr-hist-bar' },
        h('button', { type: 'button', class: 'link', text: '← 返回文案', onclick: () => {
          st.hist = null;
          paint();
        } }),
        h('span', { class: 'muted', text: '选一个版本，查看它与当前版本的差异：- 为该版本有而当前没有，+ 为当前新增。' }),
      ),
      list,
      detail,
    );
  }

  return { load };
}
