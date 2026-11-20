// 合规材料页：主体信息、产品资料、材料列表与逐章编辑。全部用 textContent / DOM 构建；占位以 <mark> 节点高亮
export function initComplianceDocs({ h, api, toast, safeHref, renderMarkdown }) {
  const PH_RE = /【待填：([^】\n]{1,40})】/g;
  const USAGE = { public: '对外公示', filing: '备案提交' };
  const ORIGIN = { fixed: '模板', generate: '模型生成', edit: '手工编辑', restore: '回退' };
  const SDK_MAX = 30;
  const SDK_COLS = [['name', '名称', 60], ['purpose', '用途', 100], ['data', '收集的信息', 200], ['policy_url', '隐私政策链接（https）', 300]];
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const enc = encodeURIComponent;
  /** 每个产品最近打开的材料 id，切回「材料」标签时恢复 */
  const opened = new Map();

  const loading = () => h('p', { class: 'muted cp-empty', text: '加载中…' });
  const failed = (e) => h('p', { class: 'muted cp-empty', text: e.message });
  const btn = (text, onclick, cls = '', disabled = false) => h('button', { type: 'button', class: cls || null, text, onclick, disabled });

  /** Markdown 预览：占位切成 mark 节点（借 renderMarkdown 的 [[链接]] 钩子）；表格里的 \| 显示为全角竖线，避免打断单元格 */
  function markPlaceholders(body) {
    const src = String(body ?? '')
      .replace(/\\\|/g, '｜')
      .replace(PH_RE, (m, label) => (/[[\]|]/.test(label) ? m : `[[\u0001${label}]]`));
    return renderMarkdown(src, [], {
      wikiLink: (slug, label) => (slug.startsWith('\u0001') ? h('mark', { class: 'cp-ph', text: `【待填：${slug.slice(1)}】` }) : `[[${slug}${label ? `|${label}` : ''}]]`),
    });
  }

  function fieldInput(f, value) {
    if (f.type === 'select') {
      const sel = h('select', { name: f.key, class: 'kb-select' }, ...f.options.map(([v, l]) => h('option', { value: v, text: l })));
      sel.value = typeof value === 'string' ? value : '';
      return sel;
    }
    const inp = h('input', { name: f.key, class: 'kb-input', type: f.type === 'date' ? 'date' : 'text', maxlength: f.max ?? null, autocomplete: 'off' });
    inp.value = typeof value === 'string' ? value : '';
    return inp;
  }

  // ---------- 主体信息 ----------
  function entityView(meta) {
    const root = h('div', { class: 'cp-facts' }, loading());
    api('/api/compliance/entity').then(({ entity }) => {
      const inputs = meta.entityFields.map((f) => [f, fieldInput(f, entity[f.key])]);
      const save = h('button', { type: 'submit', text: '保存' });
      const form = h('form', { class: 'cp-form cp-facts-form', onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          const r = await api('/api/compliance/entity', { method: 'PUT', body: Object.fromEntries(inputs.map(([f, el]) => [f.key, el.value])) });
          for (const [f, el] of inputs) el.value = r.entity[f.key] ?? '';
          toast('已保存');
        } catch (err) {
          toast(err.message);
        } finally {
          save.disabled = false;
        }
      } },
        h('h2', { class: 'cp-title', text: '主体信息' }),
        h('p', { class: 'muted cp-desc', text: '运营主体的公司信息，所有产品的材料共用。未填的项会在材料里以【待填：…】标出。' }),
        h('div', { class: 'cp-facts-grid' }, ...inputs.map(([f, el]) => h('label', { class: 'kb-field' }, f.label, el))),
        h('div', { class: 'cp-actions' }, save),
      );
      root.replaceChildren(form);
    }, (e) => root.replaceChildren(failed(e)));
    return root;
  }

  // ---------- 产品资料 ----------
  function factsView(meta, detail, onSaved) {
    const pid = detail.product.id;
    const root = h('div', { class: 'cp-facts' }, loading());
    Promise.all([api('/api/compliance/entity'), api(`/api/compliance/products/${pid}/docs`)]).then(
      ([{ entity }, { docs }]) => root.replaceChildren(...factsForm(meta, pid, detail, entity, docs, onSaved)),
      (e) => root.replaceChildren(failed(e)),
    );
    return root;
  }

  function missingList(meta, entity, facts, docs) {
    const usable = new Set(docs.filter((c) => c.available || c.doc).map((c) => c.kind));
    const filled = (scope, f) => {
      const v = (scope === 'entity' ? entity : facts)[f.key];
      return f.type === 'sdks' ? Array.isArray(v) : typeof v === 'string' && v.trim() !== '';
    };
    const rows = [];
    for (const [scope, fields] of [['entity', meta.entityFields], ['facts', meta.factFields]]) {
      for (const f of fields) {
        if (filled(scope, f)) continue;
        const path = `${scope}.${f.key}`;
        const names = meta.docKinds.filter((k) => usable.has(k.kind) && k.chapters.some((c) => c.uses.includes(path))).map((k) => k.name);
        if (names.length) rows.push(`${f.label}（影响：${names.join('、')}）`);
      }
    }
    return rows;
  }

  function factsForm(meta, pid, detail, entity, docs, onSaved) {
    const facts = detail.facts ?? {};
    const sdks = Array.isArray(facts.sdks) ? facts.sdks.map((s) => ({ ...s })) : [];
    const none = h('input', { type: 'checkbox', name: 'sdk-none' });
    none.checked = Array.isArray(facts.sdks) && facts.sdks.length === 0;
    const sdkBox = h('div', { class: 'cp-facts-sdks' });
    const drawSdks = () => {
      const add = btn('添加一行', () => {
        sdks.push({ name: '', purpose: '', data: '', policy_url: '' });
        none.checked = false;
        drawSdks();
      }, 'ghost', sdks.length >= SDK_MAX);
      sdkBox.replaceChildren(
        sdks.length
          ? h('div', { class: 'cp-table-wrap' },
              h('table', { class: 'cp-table cp-facts-table' },
                h('thead', {}, h('tr', {}, ...SDK_COLS.map(([, label]) => h('th', { text: label })), h('th', {}))),
                h('tbody', {}, ...sdks.map((row, i) => h('tr', {},
                  ...SDK_COLS.map(([k, label, max]) => {
                    const inp = h('input', { class: 'kb-input cp-in', name: `sdk-${k}`, maxlength: max, 'aria-label': `第 ${i + 1} 行 ${label}`, autocomplete: 'off' });
                    inp.value = row[k] ?? '';
                    inp.addEventListener('input', () => (row[k] = inp.value));
                    return h('td', {}, inp);
                  }),
                  h('td', {}, btn('删除', () => {
                    sdks.splice(i, 1);
                    drawSdks();
                  }, 'link')),
                ))),
              ),
            )
          : null,
        h('div', { class: 'cp-facts-sdk-bar' }, add, sdks.length ? null : h('label', { class: 'cp-facts-none' }, none, '本产品未接入第三方 SDK')),
      );
    };
    drawSdks();

    const inputs = [];
    const groups = new Map();
    for (const f of meta.factFields) {
      const g = f.group ?? '其他';
      if (!groups.has(g)) groups.set(g, []);
      let el;
      if (f.type === 'sdks') el = h('div', { class: 'kb-field' }, f.label, sdkBox);
      else {
        const inp = fieldInput(f, facts[f.key]);
        inputs.push([f, inp]);
        el = h('label', { class: 'kb-field' }, f.label, inp);
      }
      groups.get(g).push(el);
    }

    const save = h('button', { type: 'submit', text: '保存资料' });
    const form = h('form', { class: 'cp-facts-form', onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(inputs.map(([f, el]) => [f.key, el.value]));
      const rows = sdks.map((r) => Object.fromEntries(SDK_COLS.map(([k]) => [k, String(r[k] ?? '').trim()]))).filter((r) => Object.values(r).some(Boolean));
      if (rows.length) body.sdks = rows;
      else if (none.checked) body.sdks = [];
      save.disabled = true;
      try {
        const r = await api(`/api/compliance/products/${pid}/facts`, { method: 'PUT', body });
        detail.facts = r.facts;
        toast('已保存');
        onSaved?.(r.facts);
      } catch (err) {
        toast(err.message);
      } finally {
        save.disabled = false;
      }
    } },
      ...[...groups].map(([g, els]) => h('fieldset', { class: 'cp-q cp-facts-group' }, h('legend', { text: g }), ...els)),
      h('div', { class: 'cp-actions' }, save, h('span', { class: 'muted cp-notice', text: '资料变更后，用到这些资料的章节会标为「资料已更新」，可重新生成。' })),
    );
    const miss = missingList(meta, entity, facts, docs);
    return [
      miss.length
        ? h('div', { class: 'cp-facts-missing' }, h('strong', { text: '未填' }), h('ul', {}, ...miss.map((t) => h('li', { text: t }))),
            h('p', { class: 'muted', text: '主体信息在左侧「主体信息」中填写。' }))
        : null,
      form,
    ];
  }

  // ---------- 材料 ----------
  function docsView(meta, pid, openKind) {
    const root = h('div', { class: 'cp-docs' }, loading());
    /** doc 为当前打开的材料（列表页时为 null）；gen 为各章生成状态；editNode 为编辑中的面板，重绘时原样复用以免丢掉未保存的输入 */
    const ctx = { meta, pid, root, doc: null, cur: null, gen: new Map(), mode: 'view', hist: null, err: null, running: false, editNode: null };
    (async () => {
      try {
        const { docs } = await api(`/api/compliance/products/${pid}/docs`);
        let target = null;
        if (openKind) target = docs.find((c) => c.kind === openKind)?.doc?.id ?? null;
        else if (opened.has(pid) && docs.some((c) => c.doc?.id === opened.get(pid))) target = opened.get(pid);
        if (target) await openDoc(ctx, target);
        else listView(ctx, docs);
      } catch (e) {
        root.replaceChildren(failed(e));
      }
    })();
    return root;
  }

  function listView(ctx, docs) {
    opened.delete(ctx.pid);
    ctx.doc = null;
    ctx.gen.clear();
    ctx.editNode = null;
    ctx.err = null;
    const itemName = (id) => ctx.meta.catalog.find((c) => c.id === id)?.name ?? id;
    const card = (c) => {
      const d = c.doc;
      const stat = d
        ? [d.status === 'final' ? '已定稿' : '草稿', d.pending ? `未生成 ${d.pending}` : null, d.placeholders ? `待填 ${d.placeholders}` : null, d.stale ? `需更新 ${d.stale}` : null].filter(Boolean).join(' · ')
        : '未起草';
      return h('article', { class: `cp-card cp-doc-card${d ? ` has ${d.status}` : ''}`, 'data-kind': c.kind },
        h('div', { class: 'cp-card-head' }, h('strong', { text: c.name }), h('span', { class: 'cp-tag', text: USAGE[c.usage] ?? c.usage })),
        c.items.length ? h('p', { class: 'muted cp-doc-items', text: `对应事项：${c.items.map(itemName).join('、')}` }) : null,
        !c.available && d ? h('p', { class: 'cp-doc-note', text: c.reason }) : null,
        h('div', { class: 'cp-doc-card-foot' },
          h('span', { class: 'cp-doc-stat', text: stat }),
          d ? btn('打开', () => openDoc(ctx, d.id), 'ghost') : btn('起草', (e) => createDoc(ctx, c.kind, e.currentTarget)),
        ),
      );
    };
    const ok = docs.filter((c) => c.available || c.doc);
    const no = docs.filter((c) => !c.available && !c.doc);
    ctx.root.replaceChildren(
      h('p', { class: 'muted cp-notice cp-doc-intro', text: '按判定结果与资料起草：固定章节按模板直接写好，其余章节由模型逐章起草，缺的信息以【待填：…】标出。' }),
      ok.length ? h('div', { class: 'cp-cards' }, ...ok.map(card)) : h('p', { class: 'muted cp-empty', text: '暂时没有可起草的材料。' }),
      no.length
        ? h('details', { class: 'cp-group na' },
            h('summary', { text: `暂不能起草（${no.length}）` }),
            h('ul', { class: 'cp-na-list' }, ...no.map((c) => h('li', { text: `${c.name} — ${c.reason}` }))))
        : null,
    );
  }

  async function reloadList(ctx) {
    try {
      listView(ctx, (await api(`/api/compliance/products/${ctx.pid}/docs`)).docs);
    } catch (e) {
      toast(e.message);
    }
  }

  async function createDoc(ctx, kind, b) {
    if (b) b.disabled = true;
    try {
      const { doc } = await api(`/api/compliance/products/${ctx.pid}/docs`, { method: 'POST', body: { kind } });
      showDoc(ctx, doc);
    } catch (e) {
      toast(e.message);
      if (b) b.disabled = false;
    }
  }

  async function openDoc(ctx, id) {
    try {
      showDoc(ctx, (await api(`/api/compliance/docs/${id}`)).doc);
    } catch (e) {
      toast(e.message);
      if (e.status === 404) await reloadList(ctx);
    }
  }

  function showDoc(ctx, doc, keep = false) {
    const prev = ctx.doc?.id;
    ctx.doc = doc;
    opened.set(ctx.pid, doc.id);
    if (prev !== doc.id) ctx.gen.clear();
    if (!keep || !doc.sections.some((s) => s.key === ctx.cur)) ctx.cur = doc.sections[0]?.key ?? null;
    setMode(ctx, 'view');
    draw(ctx);
  }

  function setMode(ctx, mode) {
    ctx.mode = mode;
    ctx.hist = null;
    ctx.editNode = null;
  }
  /** 异步返回后确认仍在看同一份材料 */
  const same = (ctx, docId) => ctx.doc?.id === docId;

  const secUrl = (ctx, key) => `/api/compliance/docs/${ctx.doc.id}/sections/${enc(key)}`;
  function putSection(ctx, section) {
    const i = ctx.doc.sections.findIndex((s) => s.key === section.key);
    if (i >= 0) ctx.doc.sections[i] = section;
  }

  function stateOf(ctx, s) {
    const g = ctx.gen.get(s.key);
    if (g === 'running') return ['running', '生成中…'];
    if (g === 'failed') return ['failed', ''];
    if (s.removed) return ['removed', '模板已移除'];
    if (s.rev === 0) return ['pending', '未生成'];
    if (s.stale) return ['stale', '资料已更新'];
    if (s.origin === 'edit') return ['edited', '已编辑'];
    return ['done', '已生成'];
  }

  function draw(ctx) {
    const d = ctx.doc;
    const final = d.status === 'final';
    const remaining = d.sections.filter((s) => !s.removed && s.rev === 0).length;
    const exp = (fmt, label) => h('a', { class: 'cp-doc-export', href: `/api/compliance/docs/${d.id}/export?format=${fmt}`, text: label });
    const bar = h('div', { class: 'cp-doc-bar' },
      btn('← 全部材料', () => reloadList(ctx), 'link'),
      h('h3', { class: 'cp-doc-name', text: d.name }),
      h('span', { class: `cp-doc-status ${d.status}`, text: final ? '已定稿' : '草稿' }),
      h('span', { class: 'cp-doc-gap' }),
      !final && remaining ? h('button', { type: 'button', text: '生成剩余章节', title: `还有 ${remaining} 章未生成`, disabled: ctx.running, onclick: () => genRemaining(ctx) }) : null,
      final ? btn('取消定稿', () => unfinalize(ctx), 'ghost') : btn('定稿', () => finalize(ctx), '', ctx.running),
      h('span', { class: 'cp-doc-exports' }, exp('md', '导出 Markdown'), exp('html', '导出 HTML'), exp('docx', '导出 Word')),
      final ? null : btn('删除', () => removeDoc(ctx), 'ghost'),
    );
    const err = ctx.err
      ? h('div', { class: 'cp-doc-err', role: 'alert' }, h('strong', { text: ctx.err.title }), h('ul', {}, ...ctx.err.lines.map((t) => h('li', { text: t }))))
      : null;
    const toc = h('ol', { class: 'cp-doc-toc' }, ...d.sections.map((s) => {
      const [cls, text] = stateOf(ctx, s);
      return h('li', { class: s.key === ctx.cur ? 'on' : null },
        h('button', { type: 'button', class: `cp-doc-sec ${cls}${s.key === ctx.cur ? ' on' : ''}`, onclick: () => {
          if (ctx.editNode && s.key !== ctx.cur && !confirm('放弃未保存的修改？')) return;
          ctx.cur = s.key;
          setMode(ctx, 'view');
          draw(ctx);
        } },
          h('span', { class: 'cp-doc-sec-title', text: s.title }),
          h('span', { class: 'cp-doc-sec-meta' },
            text ? h('span', { class: 'cp-doc-sec-state', text }) : null,
            s.placeholders.length && !s.removed ? h('span', { class: 'cp-doc-ph-n', text: `待填 ${s.placeholders.length}` }) : null,
          ),
        ),
        cls === 'failed' ? btn('失败，重试', () => genOne(ctx, s, false, true), 'link cp-doc-retry', ctx.running) : null,
      );
    }));
    ctx.root.replaceChildren(
      h('div', { class: `cp-doc${final ? ' final' : ''}` },
        bar,
        final ? null : h('p', { class: 'muted cp-doc-draft', text: '草稿（未定稿），仅供参考，以属地主管部门口径为准。' }),
        err,
        h('div', { class: 'cp-doc-layout' },
          h('nav', { class: 'cp-doc-side', 'aria-label': '章节' }, toc),
          h('section', { class: 'cp-doc-main' }, panel(ctx)),
        ),
      ),
    );
  }

  function panel(ctx) {
    const d = ctx.doc;
    const s = d.sections.find((x) => x.key === ctx.cur);
    if (!s) return h('p', { class: 'muted cp-empty', text: '这份材料没有章节。' });
    const final = d.status === 'final';
    const busy = ctx.gen.get(s.key) === 'running';
    const head = h('div', { class: 'cp-doc-sec-head' },
      h('h4', { text: s.title }),
      h('span', { class: 'muted', text: s.rev ? `第 ${s.rev} 版 · ${ORIGIN[s.origin] ?? s.origin ?? ''} · ${when(s.updated_at)}` : '未生成' }),
    );
    const notes = [];
    if (s.removed) notes.push(h('p', { class: 'cp-doc-note', text: '按最新问卷答案，这一章已不在模板中：不会导出，也不参与定稿检查。' }));
    else if (s.stale) notes.push(h('p', { class: 'cp-doc-note', text: '资料或判定已更新，建议重新生成这一章。' }));
    if (s.placeholders.length && !s.removed) notes.push(h('p', { class: 'cp-doc-note ph', text: `待填：${s.placeholders.join('、')}` }));
    if (ctx.mode === 'edit' && !final) {
      if (ctx.editNode?.docId !== d.id || ctx.editNode.key !== s.key) ctx.editNode = { docId: d.id, key: s.key, node: editor(ctx, s) };
      return h('div', { class: 'cp-doc-panel' }, head, ...notes, ctx.editNode.node);
    }
    if (ctx.mode === 'history' && ctx.hist) return h('div', { class: 'cp-doc-panel' }, head, historyView(ctx, s));
    const actions = [];
    if (!final) {
      if (s.removed) actions.push(btn('删除本章', () => deleteSection(ctx, s), 'ghost'));
      else {
        actions.push(btn(s.rev ? '重新生成' : '生成本章', () => genOne(ctx, s, true, true), s.rev ? 'ghost' : '', busy || ctx.running));
        actions.push(btn('编辑', () => {
          setMode(ctx, 'edit');
          draw(ctx);
        }, 'ghost', busy));
      }
      if (s.rev) actions.push(btn('历史', () => showHistory(ctx, s), 'ghost'));
    }
    const body = busy
      ? h('p', { class: 'muted cp-empty', text: '生成中…' })
      : s.body.trim()
        ? h('div', { class: 'cp-doc-preview brief' }, ...markPlaceholders(s.body))
        : h('p', { class: 'muted cp-empty', text: s.mode === 'model' ? '这一章还没有内容，点「生成本章」由模型起草，或直接编辑。' : '这一章还没有内容。' });
    return h('div', { class: 'cp-doc-panel' }, head, ...notes, actions.length ? h('div', { class: 'cp-doc-actions' }, ...actions) : null, body);
  }

  function editor(ctx, s) {
    const ta = h('textarea', { class: 'kb-editor cp-doc-editor', rows: 18, maxlength: 20000, 'aria-label': `${s.title} 正文（Markdown）` });
    ta.value = s.body;
    const docId = ctx.doc.id;
    const save = btn('保存', async () => {
      save.disabled = true;
      try {
        const { section } = await api(secUrl(ctx, s.key), { method: 'PUT', body: { body: ta.value, baseRev: s.rev } });
        if (!same(ctx, docId)) return;
        putSection(ctx, section);
        setMode(ctx, 'view');
        ctx.err = null;
        draw(ctx);
        toast('已保存');
      } catch (e) {
        toast(e.message);
        save.disabled = false;
      }
    });
    return h('div', { class: 'cp-doc-edit' },
      ta,
      h('p', { class: 'muted cp-notice', text: '支持 Markdown：### 小标题、- 列表、| 表格 |。缺的信息可写成【待填：字段名】。' }),
      h('div', { class: 'cp-doc-actions' }, save, btn('取消', () => {
        setMode(ctx, 'view');
        draw(ctx);
      }, 'link')),
    );
  }

  const diffView = (diff) =>
    h('div', { class: 'wiki-diff' },
      diff.clipped ? h('p', { class: 'muted', text: '内容过长，只比较了开头和结尾部分。' }) : null,
      h('pre', {}, diff.lines.map((l) => h('div', { class: l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'same', text: `${l.t} ${l.s}` }))),
    );

  async function showHistory(ctx, s) {
    const docId = ctx.doc.id;
    try {
      const { revisions } = await api(`${secUrl(ctx, s.key)}/revisions`);
      if (!same(ctx, docId) || ctx.cur !== s.key) return;
      setMode(ctx, 'history');
      ctx.hist = { key: s.key, list: revisions, sel: null };
      draw(ctx);
    } catch (e) {
      toast(e.message);
    }
  }

  function historyView(ctx, s) {
    const { list, sel } = ctx.hist;
    const docId = ctx.doc.id;
    const final = ctx.doc.status === 'final';
    return h('div', { class: 'cp-doc-hist' },
      h('ol', { class: 'cp-doc-revs' }, ...list.map((r) => h('li', {},
        btn(`第 ${r.n} 版 · ${ORIGIN[r.origin] ?? r.origin} · ${when(r.created_at)} · ${r.chars} 字${r.n === s.rev ? '（当前）' : ''}`, async () => {
          try {
            const { revision } = await api(`${secUrl(ctx, s.key)}/revisions?rev=${r.n}`);
            if (!same(ctx, docId) || ctx.hist?.key !== s.key) return;
            ctx.hist.sel = revision;
            draw(ctx);
          } catch (e) {
            toast(e.message);
          }
        }, `link${sel?.n === r.n ? ' on' : ''}`),
      ))),
      sel
        ? h('div', { class: 'cp-doc-rev' },
            h('p', { class: 'muted', text: `第 ${sel.n} 版 → 当前内容（- 为该版本有而当前没有，+ 为当前新增）` }),
            diffView(sel.diff),
            sel.n !== s.rev && !final ? h('div', { class: 'cp-doc-actions' }, btn('回退到此版本', () => restore(ctx, s, sel.n))) : null,
          )
        : h('p', { class: 'muted cp-empty', text: '选一个版本，查看它与当前内容的差异。' }),
      h('div', { class: 'cp-doc-actions' }, btn('返回', () => {
        setMode(ctx, 'view');
        draw(ctx);
      }, 'link')),
    );
  }

  async function restore(ctx, s, n) {
    if (!confirm(`回退到第 ${n} 版？当前内容会保留在历史中。`)) return;
    const docId = ctx.doc.id;
    try {
      const { section } = await api(`${secUrl(ctx, s.key)}/restore`, { method: 'POST', body: { rev: n } });
      if (!same(ctx, docId)) return;
      putSection(ctx, section);
      setMode(ctx, 'view');
      draw(ctx);
      toast('已回退');
    } catch (e) {
      toast(e.message);
    }
  }

  /** 生成一章，成功返回 null，失败返回错误；ask 为真时覆盖手改前先确认；loud 为真时失败弹提示。
   *  按材料 id 判断是否仍在看同一份材料（打开、定稿等会换成新对象），切走后不再重绘 */
  async function genOne(ctx, s, ask, loud) {
    if (ask && s.origin === 'edit' && !confirm('将覆盖你的修改（可在历史中找回），继续？')) return new Error('已取消');
    const docId = ctx.doc.id;
    ctx.gen.set(s.key, 'running');
    draw(ctx);
    try {
      const { section } = await api(`/api/compliance/docs/${docId}/sections/${enc(s.key)}/generate`, { method: 'POST', body: {} });
      if (!same(ctx, docId)) return null;
      putSection(ctx, section);
      ctx.gen.delete(s.key);
      draw(ctx);
      return null;
    } catch (e) {
      if (!same(ctx, docId)) return e;
      ctx.gen.set(s.key, 'failed');
      if (loud) toast(e.message);
      draw(ctx);
      return e;
    }
  }

  async function genRemaining(ctx) {
    if (ctx.running) return;
    ctx.running = true;
    ctx.err = null;
    const docId = ctx.doc.id;
    const keys = ctx.doc.sections.filter((s) => !s.removed && s.rev === 0).map((s) => s.key);
    let ok = 0;
    let fail = 0;
    let stop = null;
    for (const key of keys) {
      if (!same(ctx, docId)) break;
      const s = ctx.doc.sections.find((x) => x.key === key);
      if (!s || s.removed || s.rev > 0) continue;
      const err = await genOne(ctx, s, false, false);
      if (!err) ok++;
      else {
        fail++;
        // 400（如未配置模型）、404、409 逐章重试也不会成功，停下并提示原因
        if ([400, 404, 409].includes(err.status)) {
          stop = err;
          break;
        }
      }
    }
    ctx.running = false;
    if (!same(ctx, docId)) return;
    draw(ctx);
    toast(stop ? stop.message : `已生成 ${ok} 章，失败 ${fail} 章`);
  }

  async function finalize(ctx) {
    const title = (k) => ctx.doc.sections.find((s) => s.key === k)?.title ?? k;
    try {
      const { doc } = await api(`/api/compliance/docs/${ctx.doc.id}/finalize`, { method: 'POST', body: {} });
      ctx.err = null;
      showDoc(ctx, doc, true);
      toast('已定稿');
    } catch (e) {
      if (Array.isArray(e.data?.placeholders)) ctx.err = { title: `${e.message}，补全后再定稿：`, lines: e.data.placeholders.map((p) => `${p.title}：${p.fields.join('、')}`) };
      else if (Array.isArray(e.data?.pending)) ctx.err = { title: `${e.message}：`, lines: [e.data.pending.map(title).join('、')] };
      else return toast(e.message);
      draw(ctx);
    }
  }

  async function unfinalize(ctx) {
    try {
      const { doc } = await api(`/api/compliance/docs/${ctx.doc.id}/unfinalize`, { method: 'POST', body: {} });
      showDoc(ctx, doc, true);
      toast('已取消定稿');
    } catch (e) {
      toast(e.message);
    }
  }

  async function removeDoc(ctx) {
    if (!confirm(`删除「${ctx.doc.name}」及其全部章节和历史版本？`)) return;
    try {
      await api(`/api/compliance/docs/${ctx.doc.id}`, { method: 'DELETE' });
      toast('已删除');
      await reloadList(ctx);
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteSection(ctx, s) {
    if (!confirm(`删除「${s.title}」？这一章已不在模板中，删除后历史版本也一并删除。`)) return;
    try {
      await api(secUrl(ctx, s.key), { method: 'DELETE' });
      await openDoc(ctx, ctx.doc.id);
    } catch (e) {
      toast(e.message);
    }
  }

  return { entityView, factsView, docsView };
}
