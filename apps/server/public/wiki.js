// 知识库 Wiki 界面：页面与图谱、问 Wiki、体检与日志。外部数据只通过 textContent / setAttribute 写入 DOM，不使用 innerHTML
export function initWiki({ h, api, toast, renderMarkdown, openDoc, onStatus }) {
  const KINDS = [
    ['overview', '总览'],
    ['entity', '实体'],
    ['concept', '概念'],
    ['compare', '对比'],
    ['answer', '问答'],
    ['source', '资料摘要'],
  ];
  const KIND = Object.fromEntries(KINDS);
  const OP = { ingest: '摄入', lint: '体检', fix: '自动修复', generate: '生成缺页', query_save: '存为问答', edit: '编辑', restore: '恢复版本', revert: '撤销', ask: '提问' };
  const OP_STATUS = { queued: '排队中', running: '进行中', done: '完成', error: '失败', reverted: '已撤销' };
  const LINT = { orphan: '孤立页', missing: '缺页', broken_cite: '依据失效', stale: '页面过时', no_cite: '无依据', missing_link: '缺少链接', conflict: '矛盾', gap: '数据缺口' };
  const REVERTABLE = new Set(['ingest', 'fix', 'generate', 'query_save', 'edit', 'restore']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 10000;
  const GRAPH_MAX = 300;
  const GRAPH_ITERS = 300;
  const OPS_PAGE = 30;
  const ASSET_MAX = 5 * 1024 * 1024;
  const st = { panes: null, el: null, tab: null, status: null, q: '', view: 'home', slug: null, seq: 0, ops: [], opsMore: false, askBuilt: false };
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const enc = encodeURIComponent;
  /** replaceChildren 会把 null 渲染成文字，这里先滤掉空值 */
  const put = (el, ...xs) => el.replaceChildren(...xs.flat(Infinity).filter((x) => x != null && x !== false));
  const pageUrl = (slug) => `/api/wiki/pages/${enc(slug)}`;

  /** 与服务端 slugify 一致：NFKC → 小写 → 空白和标点换成 - → 去首尾 - → 最长 80 个码点 */
  const slugify = (raw) => {
    const s = String(raw).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '-').replace(/^-+|-+$/g, '');
    return [...s].slice(0, 80).join('').replace(/-+$/, '');
  };

  function svg(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    for (const c of kids) if (c != null) el.append(c);
    return el;
  }

  async function act(fn) {
    try {
      return await fn();
    } catch (e) {
      toast(e.message);
      return undefined;
    }
  }

  // ---------- Markdown 渲染选项：[[链接]]、[^doc:ord] 引用、asset 图片 ----------
  /** titles：slug → 标题（null 表示缺页）；cites：'doc:ord' → 引用信息 */
  function mdOpts(titles, cites) {
    const nums = new Map();
    return {
      wikiLink(target, label) {
        const slug = slugify(target);
        const known = titles.has(slug);
        const title = titles.get(slug);
        const missing = known && title == null;
        const text = label || title || target;
        return h('a', {
          href: '#',
          class: missing ? 'wiki-link wiki-missing' : 'wiki-link',
          text,
          title: missing ? '页面还不存在，点击生成' : undefined,
          onclick: (e) => {
            e.preventDefault();
            if (missing) generate(slug, text);
            else openPage(slug);
          },
        });
      },
      cite(doc, ord) {
        const key = `${doc}:${ord}`;
        if (!nums.has(key)) nums.set(key, nums.size + 1);
        const c = cites.get(key);
        const bad = c && c.valid === false;
        return h(
          'sup',
          {},
          h('a', {
            href: '#',
            class: bad ? 'wiki-cite wiki-cite-bad' : 'wiki-cite',
            text: `[${nums.get(key)}]`,
            title: c ? `${c.title}${c.heading ? ` › ${c.heading}` : ''}${bad ? '（依据已失效）' : ''}` : '查看原文',
            onclick: (e) => (e.preventDefault(), openDoc(doc, ord)),
          }),
        );
      },
      image: (id, alt) => h('img', { class: 'wiki-img', src: `/api/wiki/assets/${id}`, alt: alt || '', loading: 'lazy' }),
    };
  }

  async function generate(slug, text) {
    if (!confirm(`「${text}」还没有页面，现在让模型生成吗？`)) return;
    await act(async () => {
      await api(`${pageUrl(slug)}/generate`, { method: 'POST' });
      toast('已加入生成队列，完成后会出现在列表里');
      refreshStatus();
    });
  }

  // ---------- 状态 ----------
  function renderStatus() {
    const s = st.status;
    if (!st.el || !s) return;
    const parts = [`排队 ${s.queued}`];
    if (s.running) parts.push(`正在${OP[s.running.kind] ?? s.running.kind}${s.running.title ? `「${s.running.title}」` : ''}`);
    parts.push(`今日调用 ${s.usedToday}/${s.limit}`);
    if (!s.enabled) parts.push('未配置模型');
    st.el.status.textContent = parts.join(' · ');
  }

  /** 拉取队列状态；失败时静默返回 null（后台轮询不打扰用户） */
  async function refreshStatus() {
    try {
      st.status = await api('/api/wiki/status');
    } catch {
      return null;
    }
    renderStatus();
    onStatus?.(st.status);
    return st.status;
  }

  // ---------- Wiki 标签：左栏 ----------
  function buildWikiPane(el) {
    const status = h('div', { class: 'wiki-status muted' });
    const q = h('input', { type: 'search', class: 'wiki-q', placeholder: '搜索 Wiki', maxlength: '200', autocomplete: 'off' });
    const list = h('div', { class: 'wiki-list' });
    const scope = h('select', { class: 'kb-select wiki-scope', title: '导出范围' }, h('option', { value: 'all', text: '全部' }), ...KINDS.map(([k, label]) => h('option', { value: `kind:${k}`, text: label })));
    const exp = h('a', { class: 'wiki-export', href: '/api/wiki/export?scope=all', text: '导出' });
    scope.addEventListener('change', () => exp.setAttribute('href', `/api/wiki/export?scope=${enc(scope.value)}`));
    let qt;
    q.addEventListener('input', () => {
      clearTimeout(qt);
      qt = setTimeout(() => {
        st.q = q.value.trim();
        loadPages();
      }, 300);
    });
    const main = h('div', { class: 'wiki-main' });
    const right = h('aside', { class: 'wiki-right' });
    const side = h(
      'aside',
      { class: 'wiki-side' },
      status,
      h('div', { class: 'wiki-side-bar' }, h('button', { type: 'button', class: 'link', text: '知识图谱', onclick: goHome }), h('span', { class: 'wiki-export-box' }, scope, exp)),
      q,
      list,
    );
    put(el, h('div', { class: 'wiki-layout' }, side, main, right));
    st.el = { status, list, main, right };
  }

  async function loadPages() {
    const data = await act(() => api(`/api/wiki/pages${st.q ? `?q=${enc(st.q)}` : ''}`));
    if (!data || !st.el) return;
    const groups = KINDS.map(([k, label]) => [label, data.pages.filter((p) => p.kind === k)]).filter(([, ps]) => ps.length);
    if (!data.pages.length) {
      put(st.el.list, h('p', { class: 'muted wiki-empty-side', text: st.q ? '没有找到相关页面' : '还没有页面' }));
      return;
    }
    put(st.el.list, 
      ...groups.map(([label, ps]) =>
        h(
          'div',
          { class: 'wiki-group' },
          h('div', { class: 'wiki-group-title' }, h('span', { text: label }), h('span', { class: 'kb-count', text: String(ps.length) })),
          h(
            'ul',
            {},
            ps.map((p) => h('li', { class: p.slug === st.slug && st.view !== 'home' ? 'on' : '' }, h('a', { href: '#', text: p.title, title: p.summary || p.title, onclick: (e) => (e.preventDefault(), openPage(p.slug)) }))),
          ),
        ),
      ),
    );
  }

  // ---------- 图谱 ----------
  /** 力导向布局：斥力 + 弹簧 + 向心力，固定迭代次数后停止；节点过多时只保留反向链接最多的部分 */
  function layout(data, W, H) {
    let nodes = data.nodes;
    if (nodes.length > GRAPH_MAX) {
      const keep = new Set([...nodes].sort((a, b) => b.backlinks - a.backlinks).slice(0, GRAPH_MAX).map((n) => n.slug));
      nodes = nodes.filter((n) => keep.has(n.slug));
    }
    const idx = new Map(nodes.map((n, i) => [n.slug, i]));
    const edges = data.edges.filter((e) => idx.has(e.from) && idx.has(e.to)).map((e) => [idx.get(e.from), idx.get(e.to)]);
    const n = nodes.length;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = 18 * Math.sqrt(i + 1);
      x[i] = W / 2 + r * Math.cos(i * 2.399963);
      y[i] = H / 2 + r * Math.sin(i * 2.399963);
    }
    const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.5;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let it = 0; it < GRAPH_ITERS; it++) {
      dx.fill(0);
      dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ex = x[i] - x[j];
          const ey = y[i] - y[j];
          const d2 = ex * ex + ey * ey + 0.01;
          const f = (k * k) / d2;
          dx[i] += ex * f;
          dy[i] += ey * f;
          dx[j] -= ex * f;
          dy[j] -= ey * f;
        }
      }
      for (const [a, b] of edges) {
        const ex = x[a] - x[b];
        const ey = y[a] - y[b];
        const f = Math.sqrt(ex * ex + ey * ey) / k;
        dx[a] -= ex * f;
        dy[a] -= ey * f;
        dx[b] += ex * f;
        dy[b] += ey * f;
      }
      const temp = 1 + 24 * (1 - it / GRAPH_ITERS);
      for (let i = 0; i < n; i++) {
        dx[i] += (W / 2 - x[i]) * 0.05;
        dy[i] += (H / 2 - y[i]) * 0.05;
        const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
        const step = Math.min(len, temp);
        x[i] = Math.min(W - 20, Math.max(20, x[i] + (dx[i] / len) * step));
        y[i] = Math.min(H - 20, Math.max(20, y[i] + (dy[i] / len) * step));
      }
    }
    return { nodes, edges, x, y };
  }

  function drawGraph(data) {
    const W = 1000;
    const H = 640;
    const { nodes, edges, x, y } = layout(data, W, H);
    const view = { s: 1, tx: 0, ty: 0 };
    const g = svg('g');
    const apply = () => g.setAttribute('transform', `translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)}) scale(${view.s.toFixed(3)})`);
    for (const [a, b] of edges) g.append(svg('line', { class: 'wiki-edge', x1: x[a].toFixed(1), y1: y[a].toFixed(1), x2: x[b].toFixed(1), y2: y[b].toFixed(1) }));
    let dragged = false;
    nodes.forEach((nd, i) => {
      const r = 5 + Math.min(12, Math.sqrt(nd.backlinks) * 2.5);
      const title = svg('title');
      title.textContent = `${nd.title}（${KIND[nd.kind] ?? nd.kind}，${nd.backlinks} 个反向链接）`;
      const label = svg('text', { class: 'wiki-node-label', x: (x[i] + r + 3).toFixed(1), y: (y[i] + 4).toFixed(1) });
      label.textContent = nd.title;
      const node = svg('g', { class: `wiki-node k-${nd.kind}`, role: 'button', tabindex: '0' }, svg('circle', { cx: x[i].toFixed(1), cy: y[i].toFixed(1), r: r.toFixed(1) }), label, title);
      node.addEventListener('click', () => {
        if (!dragged) openPage(nd.slug);
      });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openPage(nd.slug);
      });
      g.append(node);
    });
    apply();
    const root = svg('svg', { class: 'wiki-graph', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '知识图谱' }, g);
    const scale = () => {
      const r = root.getBoundingClientRect?.();
      return r && r.width ? W / r.width : 1;
    };
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = root.getBoundingClientRect?.();
        const px = r ? (e.clientX - r.left) * scale() : W / 2;
        const py = r ? (e.clientY - r.top) * scale() : H / 2;
        const ns = Math.min(5, Math.max(0.2, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        view.tx = px - ((px - view.tx) * ns) / view.s;
        view.ty = py - ((py - view.ty) * ns) / view.s;
        view.s = ns;
        apply();
      },
      { passive: false },
    );
    let drag = null;
    root.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      dragged = false;
    });
    root.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const mx = e.clientX - drag.x;
      const my = e.clientY - drag.y;
      if (Math.abs(mx) + Math.abs(my) > 4) dragged = true;
      view.tx = drag.tx + mx * scale();
      view.ty = drag.ty + my * scale();
      apply();
    });
    const end = () => {
      drag = null;
      setTimeout(() => (dragged = false), 0);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointerleave', end);
    const legend = h('div', { class: 'wiki-legend muted' }, KINDS.map(([k, label]) => h('span', { class: `wiki-dot k-${k}`, text: label })));
    const note = data.nodes.length > GRAPH_MAX ? h('p', { class: 'muted wiki-note', text: `共 ${data.nodes.length} 页，只显示反向链接最多的 ${GRAPH_MAX} 页` }) : null;
    return [legend, note, root];
  }

  async function goHome() {
    st.view = 'home';
    st.slug = null;
    const seq = ++st.seq;
    put(st.el.right, );
    put(st.el.main, h('p', { class: 'muted', text: '正在加载图谱…' }));
    const data = await act(() => api('/api/wiki/graph'));
    if (!data || seq !== st.seq) return;
    if (!data.nodes.length) {
      put(st.el.main, h('p', { class: 'empty kb-empty', text: 'Wiki 还是空的。「资料」里的条目会在后台自动编入，也可以打开条目点「编入 Wiki」。' }));
      return;
    }
    put(st.el.main, h('div', { class: 'wiki-head' }, h('h2', { text: '知识图谱' }), h('span', { class: 'muted', text: `${data.nodes.length} 页 · ${data.edges.length} 条链接` })), ...drawGraph(data));
  }

  // ---------- 页面 ----------
  async function openPage(slug) {
    st.view = 'page';
    st.slug = slug;
    const seq = ++st.seq;
    try {
      const { page } = await api(pageUrl(slug));
      if (seq !== st.seq) return;
      renderPage(page);
    } catch (e) {
      if (seq !== st.seq) return;
      if (e.status === 404) renderMissing(slug);
      else toast(e.message);
    }
  }

  function renderMissing(slug) {
    put(st.el.right, );
    put(st.el.main, 
      h('button', { type: 'button', class: 'link kb-back', text: '← 知识图谱', onclick: goHome }),
      h('p', { class: 'empty kb-empty', text: `页面「${slug}」还不存在。` }),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '生成此页', onclick: () => generate(slug, slug) })),
    );
  }

  function renderPage(page) {
    const titles = new Map((page.links ?? []).map((l) => [l.slug, l.title]));
    const cites = new Map((page.cites ?? []).map((c) => [`${c.doc}:${c.ord}`, c]));
    put(st.el.main, 
      h('button', { type: 'button', class: 'link kb-back', text: '← 知识图谱', onclick: goHome }),
      h(
        'div',
        { class: 'wiki-page-head' },
        h('h2', { class: 'kb-doc-title', text: page.title }),
        h('div', { class: 'kb-meta muted' }, h('span', { class: `kb-kind wiki-kind k-${page.kind}`, text: KIND[page.kind] ?? page.kind }), page.summary ? h('span', { text: page.summary }) : null),
      ),
      h('div', { class: 'brief wiki-body' }, ...renderMarkdown(page.body || '（空页面）', [], mdOpts(titles, cites))),
    );
    const linkList = (items, empty) => (items.length ? h('ul', { class: 'wiki-refs' }, items) : h('p', { class: 'muted', text: empty }));
    const exportHref = `/api/wiki/export?scope=${enc(`page:${page.slug}`)}`;
    put(st.el.right, 
      h('h4', { text: '反向链接' }),
      linkList(
        (page.backlinks ?? []).map((b) => h('li', {}, h('a', { href: '#', text: b.title, onclick: (e) => (e.preventDefault(), openPage(b.slug)) }))),
        '没有页面链接到这里',
      ),
      h('h4', { text: '引用的资料' }),
      linkList(
        (page.cites ?? []).map((c) =>
          h(
            'li',
            { class: c.valid ? '' : 'wiki-cite-bad' },
            h('a', { href: '#', text: `${c.title || `资料 ${c.doc}`}${c.heading ? ` › ${c.heading}` : ''}`, onclick: (e) => (e.preventDefault(), openDoc(c.doc, c.ord)) }),
            c.valid ? null : h('span', { class: 'muted', text: '（已失效）' }),
          ),
        ),
        '没有引用',
      ),
      h('p', { class: 'muted wiki-rev', text: `第 ${page.rev} 版 · 更新于 ${when(page.updated_at)}${page.edited_by_user ? ' · 人工改过' : ''}` }),
      h(
        'div',
        { class: 'actions wiki-actions' },
        h('button', { type: 'button', class: 'ghost', text: '编辑', onclick: () => editPage(page) }),
        h('button', { type: 'button', class: 'ghost', text: '历史', onclick: () => showHistory(page) }),
        h('a', { class: 'wiki-export', href: exportHref, text: '导出本页' }),
      ),
    );
    loadPages();
  }

  function editPage(page) {
    st.view = 'edit';
    ++st.seq;
    const title = h('input', { class: 'kb-input', maxlength: '120' });
    title.value = page.title;
    const summary = h('input', { class: 'kb-input', maxlength: '200', placeholder: '一句话摘要' });
    summary.value = page.summary || '';
    const text = h('textarea', { class: 'kb-editor wiki-editor', rows: '22' });
    text.value = page.body || '';
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    const insert = (s) => {
      const at = Number.isInteger(text.selectionStart) ? text.selectionStart : text.value.length;
      text.value = `${text.value.slice(0, at)}${s}${text.value.slice(at)}`;
    };
    file.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > ASSET_MAX) return toast('图片最大 5MB');
      let res;
      try {
        res = await fetch(`/api/wiki/assets?page=${enc(page.slug)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: f });
      } catch {
        return toast('上传失败，请检查网络');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || `上传失败（${res.status}）`);
      insert(`![${f.name.replace(/[[\]\n]/g, '')}](asset:${data.id})`);
    });
    const save = h('button', {
      type: 'button',
      text: '保存',
      onclick: async () => {
        save.disabled = true;
        try {
          const r = await api(pageUrl(page.slug), { method: 'PUT', body: { title: title.value, summary: summary.value, body: text.value, baseRev: page.rev } });
          toast(r.dropped?.length ? `已保存，删除了 ${r.dropped.length} 处无效引用` : '已保存');
          await openPage(page.slug);
        } catch (e) {
          toast(e.status === 409 ? '页面已被更新，请刷新后再改' : e.message);
          save.disabled = false;
        }
      },
    });
    put(st.el.right, 
      h('h4', { text: '写法' }),
      h('ul', { class: 'wiki-help muted' }, h('li', { text: '[[页面名]] 或 [[页面名|显示文字]]：链接到其他页面' }), h('li', { text: '[^资料ID:段落序号]：引用原文' }), h('li', { text: '「插入图片」上传后会在光标处插入图片' })),
    );
    put(st.el.main, 
      h(
        'div',
        { class: 'kb-edit' },
        h('h3', { text: `编辑「${page.title}」` }),
        h('label', { class: 'kb-field' }, '标题', title),
        h('label', { class: 'kb-field' }, '摘要', summary),
        h('label', { class: 'kb-field' }, '正文（Markdown）', text),
        file,
        h(
          'div',
          { class: 'actions' },
          save,
          h('button', { type: 'button', class: 'ghost', text: '插入图片', onclick: () => file.click() }),
          h('button', { type: 'button', class: 'link', text: '取消', onclick: () => openPage(page.slug) }),
        ),
      ),
    );
  }

  const diffView = (diff) =>
    h(
      'div',
      { class: 'wiki-diff' },
      diff.clipped ? h('p', { class: 'muted', text: '内容过长，只比较了开头和结尾部分。' }) : null,
      h(
        'pre',
        {},
        diff.lines.map((l) => h('div', { class: l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'same', text: `${l.t} ${l.s}` })),
      ),
    );

  async function showHistory(page) {
    st.view = 'history';
    const seq = ++st.seq;
    const data = await act(() => api(`${pageUrl(page.slug)}/revisions`));
    if (!data || seq !== st.seq) return;
    const detail = h('div', { class: 'wiki-rev-detail' });
    const pick = async (rev) => {
      const r = await act(() => api(`${pageUrl(page.slug)}/revisions?rev=${rev}&diff=1`));
      if (!r) return;
      put(detail, 
        h('h4', { text: `第 ${rev} 版与当前版本的差异（- 为该版，+ 为当前）` }),
        diffView(r.diff),
        rev === data.rev
          ? null
          : h('div', { class: 'actions' }, h('button', { type: 'button', text: '恢复此版', onclick: () => restore(page.slug, rev) })),
      );
    };
    put(st.el.main, 
      h('button', { type: 'button', class: 'link kb-back', text: `← 返回「${page.title}」`, onclick: () => openPage(page.slug) }),
      h('h3', { text: '版本历史' }),
      h(
        'ol',
        { class: 'wiki-revs' },
        data.revisions.map((r) =>
          h(
            'li',
            {},
            h('button', { type: 'button', class: 'link', text: `第 ${r.rev} 版`, onclick: () => pick(r.rev) }),
            h('span', { class: 'muted', text: ` ${when(r.created_at)} · ${r.title}${r.deleted ? '（已删除）' : ''}${r.rev === data.rev ? ' · 当前' : ''}` }),
          ),
        ),
      ),
      detail,
    );
  }

  async function restore(slug, rev) {
    if (!confirm(`把页面恢复到第 ${rev} 版？当前内容会保留在历史里。`)) return;
    await act(async () => {
      await api(`${pageUrl(slug)}/restore`, { method: 'POST', body: { rev } });
      toast(`已恢复到第 ${rev} 版`);
      await openPage(slug);
    });
  }

  // ---------- 问 Wiki ----------
  function buildAsk(el) {
    const box = h('textarea', { class: 'kb-editor wiki-ask-input', maxlength: '500', rows: '3', placeholder: '向 Wiki 提问，例如：我们对竞品定价有哪些结论？（最多 500 字）' });
    const out = h('div', { class: 'wiki-answer' });
    const btn = h('button', { type: 'button', text: '提问' });
    btn.addEventListener('click', async () => {
      const q = box.value.trim();
      if (!q) return toast('请输入问题');
      btn.disabled = true;
      put(out, h('p', { class: 'muted', text: '正在查阅 Wiki…' }));
      try {
        renderAnswer(out, q, await api('/api/wiki/ask', { method: 'POST', body: { question: q } }));
      } catch (e) {
        put(out, );
        toast(e.message);
      } finally {
        btn.disabled = false;
      }
    });
    put(el, h('div', { class: 'wiki-ask' }, h('p', { class: 'muted', text: '根据 Wiki 页面和它们引用的原文回答；好的回答可以存成问答页。' }), box, h('div', { class: 'actions' }, btn), out));
  }

  function renderAnswer(out, q, r) {
    const titles = new Map((r.pages ?? []).map((p) => [p.slug, p.title]));
    const cites = new Map((r.cites ?? []).map((c) => [`${c.doc}:${c.ord}`, { ...c, valid: true }]));
    const save = r.opId
      ? h('button', {
          type: 'button',
          class: 'ghost',
          text: '存为问答页',
          onclick: async () => {
            save.disabled = true;
            try {
              const { slug } = await api('/api/wiki/answers', { method: 'POST', body: { question: q, answer: r.answer } });
              toast('已存为问答页');
              save.replaceWith(h('button', { type: 'button', class: 'link', text: '打开问答页', onclick: () => openWiki(slug) }));
            } catch (e) {
              toast(e.message);
              save.disabled = false;
            }
          },
        })
      : null;
    put(out, 
      h('div', { class: 'brief wiki-body' }, ...renderMarkdown(r.answer, [], mdOpts(titles, cites))),
      r.pages?.length
        ? h('p', { class: 'muted wiki-consulted' }, '查阅了：', ...r.pages.flatMap((p, i) => [i ? '、' : '', h('a', { href: '#', text: p.title, onclick: (e) => (e.preventDefault(), openWiki(p.slug)) })]))
        : null,
      save ? h('div', { class: 'actions' }, save) : null,
    );
  }

  // ---------- 体检与日志 ----------
  async function loadLint() {
    const el = st.panes.lint;
    const report = h('div', { class: 'wiki-report' }, h('p', { class: 'muted', text: '正在加载…' }));
    const ops = h('ol', { class: 'wiki-ops' });
    const more = h('div', { class: 'actions' });
    put(el, 
      h(
        'div',
        { class: 'wiki-lint' },
        h('div', { class: 'wiki-head' }, h('h3', { text: '最近一次体检' }), h('button', { type: 'button', class: 'ghost', text: '立即体检', onclick: runLint })),
        report,
        h('h3', { text: '操作日志' }),
        ops,
        more,
      ),
    );
    st.lintEl = { report, ops, more };
    st.ops = [];
    await Promise.all([loadReport(), loadOps()]);
  }

  async function runLint() {
    await act(async () => {
      await api('/api/wiki/lint', { method: 'POST' });
      toast('已加入体检队列，完成后刷新本页查看');
      refreshStatus();
    });
  }

  async function loadReport() {
    const box = st.lintEl.report;
    const s = (await refreshStatus()) ?? st.status;
    if (!s?.lastLint) return put(box, h('p', { class: 'muted', text: '还没有体检过。每周一凌晨会自动体检一次。' }));
    const data = await act(() => api(`/api/wiki/ops/${s.lastLint.opId}`));
    if (!data) return put(box, );
    let note = {};
    try {
      note = JSON.parse(data.op.note || '{}');
    } catch {
      note = {};
    }
    const issues = Array.isArray(note.issues) ? note.issues : [];
    const head = h('p', { class: 'muted', text: `${when(data.op.finished_at ?? data.op.created_at)} · ${issues.length} 个问题${note.fixOp ? ` · 已自动修复部分问题（操作 #${note.fixOp}）` : ''}` });
    const groups = Object.keys(LINT)
      .map((t) => [t, issues.filter((i) => i.type === t)])
      .filter(([, xs]) => xs.length);
    const jump = (slug) => h('a', { href: '#', text: slug, onclick: (e) => (e.preventDefault(), openWiki(slug)) });
    put(box, 
      head,
      note.modelError ? h('p', { class: 'kb-note warn', text: note.modelError }) : null,
      ...groups.map(([t, xs]) =>
        h(
          'div',
          { class: 'wiki-issue-group' },
          h('h4', { text: `${LINT[t]}（${xs.length}）` }),
          h(
            'ul',
            {},
            xs.map((i) =>
              h(
                'li',
                {},
                h('span', { text: i.detail || '' }),
                i.fixed ? h('span', { class: 'muted', text: '（已修复）' }) : null,
                ...[i.slug, ...(i.slugs ?? [])].filter(Boolean).map((s2) => [' ', jump(s2)]).flat(),
                t === 'missing' && i.target ? [' ', h('button', { type: 'button', class: 'link', text: '生成此页', onclick: () => generate(i.target, i.target) })] : null,
              ),
            ),
          ),
        ),
      ),
      issues.length ? null : h('p', { text: '没有发现问题。' }),
    );
  }

  async function loadOps(before) {
    const data = await act(() => api(`/api/wiki/ops?limit=${OPS_PAGE}${before ? `&before=${before}` : ''}`));
    if (!data) return;
    st.ops = before ? [...st.ops, ...data.ops] : data.ops;
    put(st.lintEl.ops, ...st.ops.map(opRow));
    put(st.lintEl.more, 
      data.ops.length === OPS_PAGE ? h('button', { type: 'button', class: 'ghost', text: '更多', onclick: () => loadOps(st.ops.at(-1).id) }) : null,
    );
    if (!st.ops.length) put(st.lintEl.ops, h('p', { class: 'muted', text: '还没有操作记录' }));
  }

  function opRow(op) {
    const detail = h('div', { class: 'wiki-op-detail' });
    detail.hidden = true;
    const meta = [
      op.doc_title ? `资料「${op.doc_title}」` : null,
      `${op.pages.length} 页`,
      `调用 ${op.llm_calls} 次`,
      when(op.created_at),
    ].filter(Boolean);
    const expand = async () => {
      if (!detail.hidden) return (detail.hidden = true);
      const r = await act(() => api(`/api/wiki/ops/${op.id}`));
      if (!r) return;
      put(detail, 
        op.error ? h('p', { class: 'kb-note err', text: op.error }) : null,
        ...(r.diffs.length
          ? r.diffs.map((d) =>
              h(
                'div',
                { class: 'wiki-op-page' },
                h('h4', {}, h('a', { href: '#', text: d.title, onclick: (e) => (e.preventDefault(), openWiki(d.slug)) }), h('span', { class: 'muted', text: ` 第 ${d.from_rev} → ${d.to_rev} 版${d.deleted ? '（删除）' : ''}` })),
                d.pruned ? h('p', { class: 'muted', text: '历史版本已清理，无法显示差异。' }) : diffView(d.diff),
              ),
            )
          : [h('p', { class: 'muted', text: '这次操作没有改动页面。' })]),
      );
      detail.hidden = false;
    };
    const revert = async (force) => {
      if (!force && !confirm(`撤销「${OP[op.kind] ?? op.kind} #${op.id}」？会生成一条新的撤销记录，历史不会删除。`)) return;
      try {
        await api(`/api/wiki/ops/${op.id}/revert`, { method: 'POST', body: force ? { force: true } : {} });
        toast('已撤销');
        loadOps();
      } catch (e) {
        if (e.status !== 409 || !e.data?.conflicts) return toast(e.message);
        put(detail, 
          h('p', { class: 'kb-note warn', text: '以下页面在这次操作之后又被改过，撤销会覆盖这些改动：' }),
          h(
            'ul',
            {},
            e.data.conflicts.map((c) => h('li', { text: `${c.slug}（当前第 ${c.rev} 版，这次操作写入的是第 ${c.expected} 版）` })),
          ),
          h('div', { class: 'actions' }, h('button', { type: 'button', text: '仍然覆盖', onclick: () => revert(true) })),
        );
        detail.hidden = false;
      }
    };
    const retry = async () => {
      await act(async () => {
        await api(`/api/wiki/ops/${op.id}/retry`, { method: 'POST' });
        toast('已重新排队');
        refreshStatus();
      });
    };
    return h(
      'li',
      { class: `wiki-op s-${op.status}` },
      h(
        'div',
        { class: 'wiki-op-line' },
        h('span', { class: 'wiki-op-kind', text: OP[op.kind] ?? op.kind }),
        h('span', { class: `kb-status wiki-op-status s-${op.status}`, text: OP_STATUS[op.status] ?? op.status }),
        h('span', { class: 'muted', text: meta.join(' · ') }),
        h(
          'span',
          { class: 'wiki-op-acts' },
          h('button', { type: 'button', class: 'link', text: '详情', onclick: expand }),
          REVERTABLE.has(op.kind) && op.status === 'done' ? h('button', { type: 'button', class: 'link', text: '撤销', onclick: () => revert(false) }) : null,
          op.status === 'error' ? h('button', { type: 'button', class: 'link', text: '重试', onclick: retry }) : null,
        ),
      ),
      detail,
    );
  }

  // ---------- 入口 ----------
  function mount(panes) {
    st.panes = panes;
    buildWikiPane(panes.wiki);
    setInterval(() => {
      if (st.tab === 'wiki' && !panes.wiki.hidden && !document.getElementById('view-kb')?.hidden) refreshStatus();
    }, POLL_MS);
  }

  /** 切到某个 Wiki 标签；slug 给出时直接打开该页 */
  function activate(tab, o = {}) {
    st.tab = tab;
    if (tab === 'wiki') {
      refreshStatus();
      loadPages();
      if (o.slug) openPage(o.slug);
      else if (st.view === 'home' || !st.slug) goHome();
    } else if (tab === 'ask') {
      if (!st.askBuilt) buildAsk(st.panes.ask);
      st.askBuilt = true;
    } else if (tab === 'lint') {
      loadLint();
    }
  }

  function deactivate() {
    st.tab = null;
  }

  /** 由 kb.js 注入：切到 Wiki 标签并打开页面 */
  let openWiki = (slug) => openPage(slug);
  const setOpenWiki = (fn) => (openWiki = fn);

  return { mount, activate, deactivate, refreshStatus, openPage, setOpenWiki, openWiki: (slug) => openWiki(slug) };
}
