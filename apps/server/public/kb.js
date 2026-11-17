// 知识库页：顶部标签（资料 / Wiki / 问 Wiki / 体检与日志）、目录树、条目列表与搜索、条目详情、上传、笔记、入库与归类弹窗。外部数据只通过 textContent 写入 DOM
import { initWiki } from './wiki.js';

export function initKb({ h, api, toast, show, openReview, openItem, renderMarkdown }) {
  const $ = (id) => document.getElementById(id);
  const KIND = { upload: '上传', review: '评审', item: '资讯', note: '笔记' };
  const STATUS = { processing: '处理中', error: '失败', orphan: '来源已删除' };
  const POLL_MS = 2000;
  const FILE_MAX = 10 * 1024 * 1024;
  const SUGGEST_CHARS = 1500;
  /** folder：null 为全部，'none' 为未归类，数字为目录 id；view：list | doc | edit */
  const st = { tree: null, folder: null, q: '', view: 'list', docId: null, docTab: null, seq: 0, collapsed: new Set(), dialog: Promise.resolve(), cancel: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const day = (ts) => new Date(ts).toLocaleDateString('zh-CN');
  const visible = () => !$('view-kb').hidden;
  const TABS = [
    ['docs', '资料'],
    ['wiki', 'Wiki'],
    ['ask', '问 Wiki'],
    ['lint', '体检与日志'],
  ];
  const WIKI_STATE = { none: '未编入', queued: '排队中', running: '编入中', done: '已编入', error: '失败', reverted: '已撤销' };
  const savedTab = localStorage.getItem('kb.tab');
  st.tab = TABS.some(([k]) => k === savedTab) ? savedTab : 'docs';
  st.wikiDocs = {};
  const wiki = initWiki({
    h,
    api,
    toast,
    renderMarkdown,
    openDoc: (doc, ord) => open(doc, ord),
    onStatus: (s) => (st.wikiDocs = s.docs || {}),
  });

  // ---------- 顶部标签 ----------
  function renderTabs() {
    $('kb-tabs').replaceChildren(
      ...TABS.map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', class: `pm-tab${k === st.tab ? ' on' : ''}`, 'aria-selected': k === st.tab ? 'true' : 'false', text: label, onclick: () => setTab(k) }),
      ),
    );
  }

  /** 切换标签并记住；o.slug 给出时在 Wiki 标签里直接打开该页 */
  function setTab(k, o = {}) {
    st.tab = k;
    localStorage.setItem('kb.tab', k);
    renderTabs();
    for (const [key] of TABS) $(`kb-pane-${key}`).hidden = key !== k;
    if (k === 'docs') {
      wiki.deactivate();
      if (!st.tree && st.view === 'list') load().catch(() => {});
    } else wiki.activate(k, o);
  }

  function openWiki(slug) {
    if (!visible()) show('kb', { skipLoad: true });
    setTab('wiki', { slug });
  }
  wiki.setOpenWiki(openWiki);

  // ---------- 目录 ----------
  function paths() {
    const fs = st.tree?.folders ?? [];
    const by = new Map(fs.map((f) => [f.id, f]));
    const pathOf = (f) => {
      const parts = [];
      for (let c = f, i = 0; c && i < 10; c = by.get(c.parent_id), i++) parts.unshift(c.name);
      return parts.join('/');
    };
    return fs.map((f) => ({ id: f.id, path: pathOf(f) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  function descendants(id) {
    const fs = st.tree?.folders ?? [];
    const out = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of fs) {
        if (out.has(f.parent_id) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
    }
    return out;
  }

  function folderLabel() {
    if (st.folder == null) return '全部条目';
    if (st.folder === 'none') return '未归类';
    return paths().find((p) => p.id === st.folder)?.path ?? '目录';
  }

  async function loadTree() {
    st.tree = await api('/api/kb/tree');
    renderTree();
  }

  async function act(fn) {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  }

  async function refresh() {
    await loadTree();
    if (st.view === 'list') await loadList();
  }

  function dragSrc(el, key) {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation?.();
      e.dataTransfer?.setData('text/plain', key);
    });
  }

  /** kind：folder 可接收目录与条目；unfiled 只接收条目；all 只接收目录（移到顶层） */
  function dropTarget(el, folderId, kind) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.toggle('drop', true);
    });
    el.addEventListener('dragleave', () => el.classList.toggle('drop', false));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.toggle('drop', false);
      const m = /^kb-(doc|folder):(\d+)$/.exec(e.dataTransfer?.getData('text/plain') ?? '');
      if (!m) return;
      const id = Number(m[2]);
      if (m[1] === 'doc' && kind !== 'all') await moveDoc(id, folderId);
      if (m[1] === 'folder' && kind !== 'unfiled' && id !== folderId) await moveFolder(id, folderId);
    });
  }

  async function moveDoc(id, folderId) {
    await act(async () => {
      await api(`/api/kb/docs/${id}`, { method: 'PATCH', body: { folderId } });
      await refresh();
      if (st.view === 'doc' && st.docId === id) await open(id);
    });
  }

  async function moveFolder(id, parentId) {
    await act(async () => {
      await api(`/api/kb/folders/${id}`, { method: 'PATCH', body: { parentId } });
      await loadTree();
    });
  }

  async function newFolder(parentId) {
    const name = prompt(parentId ? '子目录名称（1–40 字）' : '目录名称（1–40 字）');
    if (!name || !name.trim()) return;
    await act(async () => {
      await api('/api/kb/folders', { method: 'POST', body: { name: name.trim(), parentId } });
      if (parentId) st.collapsed.delete(parentId);
      await loadTree();
    });
  }

  async function renameFolder(f) {
    const name = prompt('新的目录名称', f.name);
    if (!name || !name.trim() || name.trim() === f.name) return;
    await act(async () => {
      await api(`/api/kb/folders/${f.id}`, { method: 'PATCH', body: { name: name.trim() } });
      await refresh();
    });
  }

  async function moveFolderDialog(f) {
    const to = await folderDialog({ heading: `移动「${f.name}」到…`, rootLabel: '（顶层）', exclude: descendants(f.id), current: f.parent_id });
    if (to === undefined || to === f.parent_id) return;
    await moveFolder(f.id, to);
  }

  async function deleteFolder(f) {
    if (!confirm(`删除目录「${f.name}」？只能删除空目录。`)) return;
    await act(async () => {
      await api(`/api/kb/folders/${f.id}`, { method: 'DELETE' });
      if (st.folder === f.id) st.folder = null;
      await refresh();
    });
  }

  function selectFolder(key) {
    st.folder = key;
    st.q = '';
    $('kb-q').value = '';
    st.view = 'list';
    st.docId = null;
    renderTree();
    loadList().catch((e) => toast(e.message));
  }

  function renderTree() {
    const t = st.tree;
    if (!t) return;
    const kids = new Map();
    for (const f of t.folders) {
      const k = f.parent_id ?? 0;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(f);
    }
    const row = (key, name, count, toggle = null, ops = null) =>
      h(
        'div',
        { class: `kb-row${st.folder === key ? ' on' : ''}` },
        toggle ?? h('span', { class: 'kb-tog' }),
        h('a', { href: '#', class: 'kb-name', text: name, onclick: (e) => (e.preventDefault(), selectFolder(key)) }),
        h('span', { class: 'kb-count', text: String(count) }),
        ops,
      );
    const node = (f) => {
      const children = kids.get(f.id) ?? [];
      const closed = st.collapsed.has(f.id);
      const toggle =
        children.length > 0
          ? h('button', {
              type: 'button',
              class: 'link kb-tog',
              text: closed ? '▸' : '▾',
              title: closed ? '展开' : '折叠',
              onclick: () => {
                if (closed) st.collapsed.delete(f.id);
                else st.collapsed.add(f.id);
                renderTree();
              },
            })
          : null;
      const ops = h(
        'span',
        { class: 'kb-ops' },
        h('button', { type: 'button', class: 'link', text: '＋', title: '新建子目录', onclick: () => newFolder(f.id) }),
        h('button', { type: 'button', class: 'link', text: '改名', onclick: () => renameFolder(f) }),
        h('button', { type: 'button', class: 'link', text: '移动', onclick: () => moveFolderDialog(f) }),
        h('button', { type: 'button', class: 'link', text: '删除', onclick: () => deleteFolder(f) }),
      );
      const r = row(f.id, f.name, f.count, toggle, ops);
      dragSrc(r, `kb-folder:${f.id}`);
      dropTarget(r, f.id, 'folder');
      return h('li', {}, r, children.length > 0 && !closed ? h('ul', {}, children.map(node)) : null);
    };
    const all = row(null, '全部', t.total);
    dropTarget(all, null, 'all');
    const none = row('none', '未归类', t.unfiled);
    dropTarget(none, null, 'unfiled');
    $('kb-tree').replaceChildren(h('li', {}, all), h('li', { class: 'kb-sep' }, none), ...(kids.get(0) ?? []).map(node));
  }

  // ---------- 列表与搜索 ----------
  const kindTag = (d) => h('span', { class: `kb-kind k-${d.kind}`, text: KIND[d.kind] ?? d.kind });
  const statusTag = (d) => (STATUS[d.status] ? h('span', { class: `kb-status s-${d.status}`, text: STATUS[d.status] }) : null);
  const wikiTag = (d) => {
    if (d.status !== 'ready') return null;
    const s = st.wikiDocs[d.id] ?? 'none';
    return h('span', { class: `kb-wiki w-${s}`, text: WIKI_STATE[s] ?? s, title: 'Wiki 状态' });
  };
  const titleLink = (d, ord) => h('a', { href: '#', class: 'kb-title', text: d.title, onclick: (e) => (e.preventDefault(), open(d.id, ord)) });

  async function loadList() {
    const seq = ++st.seq;
    const p = new URLSearchParams();
    if (st.folder != null) p.set('folder', String(st.folder));
    if (st.q) p.set('q', st.q);
    const qs = p.toString();
    const data = await api(`/api/kb/docs${qs ? `?${qs}` : ''}`);
    if (seq !== st.seq || st.view !== 'list') return;
    renderList(data);
  }

  /** 搜索摘录里【】包住的是命中词，渲染成高亮 */
  const snip = (s) =>
    h(
      'p',
      { class: 'kb-snip' },
      String(s ?? '')
        .split(/【([^【】]*)】/)
        .map((part, i) => (i % 2 ? h('mark', { text: part }) : part)),
    );

  function renderList({ docs, hits }) {
    const body = $('kb-body');
    const n = hits ? hits.length : docs.length;
    const crumb = h(
      'div',
      { class: 'kb-crumb' },
      h('span', { class: 'kb-crumb-title', text: st.q ? `在「${folderLabel()}」中搜索「${st.q}」` : folderLabel() }),
      n ? h('span', { class: 'kb-crumb-count', text: hits ? `${n} 条结果` : `${n} 个条目` }) : null,
    );
    if (hits) {
      if (!hits.length) return body.replaceChildren(crumb, h('p', { class: 'empty kb-empty', text: '没有找到相关内容' }));
      return body.replaceChildren(
        crumb,
        h(
          'ol',
          { class: 'kb-list' },
          hits.map((x) =>
            h(
              'li',
              { class: 'kb-doc-row' },
              h('div', { class: 'kb-line' }, kindTag(x.doc), titleLink(x.doc, x.ord), statusTag(x.doc), wikiTag(x.doc)),
              h('div', { class: 'kb-meta muted', text: [x.doc.path, x.heading].filter(Boolean).join(' › ') }),
              snip(x.snippet),
            ),
          ),
        ),
      );
    }
    if (!docs.length) {
      const empty = st.folder == null ? '知识库还是空的。可以上传资料、新建笔记，或者在评审和资讯里点「存入知识库」。' : '这里还没有条目';
      return body.replaceChildren(crumb, h('p', { class: 'empty kb-empty', text: empty }));
    }
    body.replaceChildren(
      crumb,
      h(
        'ol',
        { class: 'kb-list' },
        docs.map((d) => {
          const li = h(
            'li',
            { class: 'kb-doc-row' },
            h('div', { class: 'kb-line' }, kindTag(d), titleLink(d), statusTag(d), wikiTag(d)),
            h('div', { class: 'kb-meta muted', text: `${d.path} · ${day(d.updated_at)}` }),
          );
          dragSrc(li, `kb-doc:${d.id}`);
          return li;
        }),
      ),
    );
  }

  function backToList() {
    st.view = 'list';
    st.docId = null;
    loadList().catch((e) => toast(e.message));
  }

  // ---------- 详情与编辑 ----------
  function sourceLink(doc) {
    if (doc.kind === 'review') {
      if (doc.status === 'orphan') return h('span', { text: '来源：评审（已删除）' });
      return h('button', { type: 'button', class: 'link', text: `打开评审 #${doc.review_id}`, onclick: () => (show('pm'), openReview(doc.review_id)) });
    }
    if (doc.kind === 'item') {
      if (doc.status === 'orphan') return h('span', { text: '来源：资讯（已删除）' });
      return h('button', { type: 'button', class: 'link', text: '查看资讯', onclick: () => openItem(doc.item_id) });
    }
    if (doc.kind === 'upload') return h('a', { href: `/api/kb/docs/${doc.id}/file`, target: '_blank', rel: 'noopener', text: `下载原文件（${doc.file_name ?? '文件'}）` });
    return null;
  }

  async function open(id, ord) {
    if (!visible()) show('kb', { skipLoad: true });
    if (st.tab !== 'docs') setTab('docs');
    st.view = 'doc';
    st.docId = id;
    const seq = ++st.seq;
    try {
      const data = await api(`/api/kb/docs/${id}`);
      if (seq !== st.seq) return;
      renderDoc(data, ord);
      if (!st.tree) loadTree().catch(() => {});
    } catch (e) {
      if (seq !== st.seq) return;
      toast(e.message);
      if (e.status === 404) backToList();
    }
  }

  /** 上传的网页：「网页预览」和「提取的文字」两个标签；从搜索结果跳到某一段时默认看文字。iframe 在第一次切到预览时才创建 */
  function docContent(doc, blocks, ord) {
    const text = blocks.length ? h('div', { class: 'kb-doc' }, blocks) : doc.status === 'ready' ? h('p', { class: 'muted', text: '（没有正文）' }) : null;
    if (!doc.preview) return text;
    const src = `/api/kb/docs/${doc.id}/preview`;
    const panes = { preview: h('div', { class: 'kb-preview' }), text: h('div', { class: 'kb-pane' }, text) };
    const tabs = h('div', { class: 'pm-tabs kb-tabs', role: 'tablist' });
    let built = false;
    const set = (k) => {
      st.docTab = k;
      if (k === 'preview' && !built) {
        built = true;
        panes.preview.append(
          h(
            'div',
            { class: 'kb-preview-bar muted' },
            h('span', { text: '原网页在隔离沙箱中运行：不能联网，也读不到你的登录信息。' }),
            h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', text: '新窗口打开' }),
          ),
          h('iframe', { class: 'kb-preview-frame', sandbox: 'allow-scripts', src, title: `网页预览：${doc.title}`, referrerpolicy: 'no-referrer' }),
        );
      }
      tabs.replaceChildren(
        ...[['preview', '网页预览'], ['text', '提取的文字']].map(([key, label]) =>
          h('button', { type: 'button', role: 'tab', class: `pm-tab${key === k ? ' on' : ''}`, 'aria-selected': key === k ? 'true' : 'false', text: label, onclick: () => set(key) }),
        ),
      );
      for (const key of Object.keys(panes)) panes[key].hidden = key !== k;
    };
    set(ord != null ? 'text' : st.docTab || 'preview');
    return h('div', { class: 'kb-content' }, tabs, panes.preview, panes.text);
  }

  function renderDoc({ doc, body, chunks }, ord) {
    const notes = [];
    if (doc.status === 'orphan') notes.push(h('p', { class: 'kb-note warn', text: '来源已删除，正文已清空。只能移动或删除这个条目。' }));
    if (doc.status === 'error') notes.push(h('p', { class: 'kb-note err', text: `处理失败：${doc.error || '未知错误'}` }));
    if (doc.status === 'processing') notes.push(h('p', { class: 'kb-note', text: '正在提取文字，稍后再打开查看。' }));
    if (doc.truncated) notes.push(h('p', { class: 'kb-note', text: '过长，只索引了前面部分。' }));
    const editable = doc.status !== 'orphan' && doc.status !== 'processing';
    const actions = h(
      'div',
      { class: 'actions' },
      editable ? h('button', { type: 'button', class: 'link', text: '编辑', onclick: () => editDoc(doc, body) }) : null,
      h('button', { type: 'button', class: 'link', text: '移动到…', onclick: () => moveDocDialog(doc) }),
      h('button', { type: 'button', class: 'link', text: '删除', onclick: () => deleteDoc(doc) }),
      ...wikiActions(doc),
    );
    let last = null;
    const blocks = chunks.map((c) => {
      const head = c.heading && c.heading !== last ? h('h4', { class: 'kb-h', text: c.heading }) : null;
      last = c.heading;
      return h('div', { class: `kb-chunk${c.ord === ord ? ' hit' : ''}`, id: `kb-c-${c.ord}` }, head, h('div', { class: 'kb-text', text: c.body }));
    });
    $('kb-body').replaceChildren(
      h('button', { type: 'button', class: 'link kb-back', text: '← 返回列表', onclick: backToList }),
      h(
        'div',
        { class: 'kb-doc-head' },
        h('h2', { class: 'kb-doc-title', text: doc.title }),
        h('div', { class: 'kb-meta muted' }, kindTag(doc), statusTag(doc), h('span', { text: doc.path }), h('span', { text: `更新于 ${when(doc.updated_at)}` }), sourceLink(doc)),
        ...notes,
        actions,
      ),
      docContent(doc, blocks, ord),
    );
    if (ord != null) document.getElementById(`kb-c-${ord}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  /** 条目详情里的「编入 Wiki / 重新编入」和「Wiki 摘要页」 */
  function wikiActions(doc) {
    if (doc.status !== 'ready') return [];
    const s = st.wikiDocs[doc.id] ?? 'none';
    const busy = s === 'queued' || s === 'running';
    const b = h('button', {
      type: 'button',
      class: 'link',
      text: busy ? WIKI_STATE[s] : s === 'none' ? '编入 Wiki' : '重新编入',
      onclick: async () => {
        b.disabled = true;
        try {
          await api(`/api/wiki/ingest/${doc.id}`, { method: 'POST' });
          st.wikiDocs[doc.id] = 'queued';
          b.textContent = WIKI_STATE.queued;
          toast('已加入编入队列');
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      },
    });
    b.disabled = busy;
    const link = s === 'done' ? h('button', { type: 'button', class: 'link', text: 'Wiki 摘要页', onclick: () => openWiki(`src-${doc.id}`) }) : null;
    return [b, link];
  }

  function editDoc(doc, body) {
    st.view = 'edit';
    ++st.seq;
    const title = h('input', { class: 'kb-input', maxlength: '120' });
    title.value = doc.title;
    const text = body != null ? h('textarea', { class: 'kb-editor', rows: '18' }) : null;
    if (text) text.value = body;
    const save = h('button', {
      type: 'button',
      text: '保存',
      onclick: async () => {
        save.disabled = true;
        try {
          const patch = { title: title.value };
          if (text && text.value !== body) patch.body = text.value;
          await api(`/api/kb/docs/${doc.id}`, { method: 'PATCH', body: patch });
          loadTree().catch(() => {});
          await open(doc.id);
        } catch (e) {
          toast(e.message);
          save.disabled = false;
        }
      },
    });
    $('kb-body').replaceChildren(
      h(
        'div',
        { class: 'kb-edit' },
        h('label', { class: 'kb-field' }, '标题', title),
        text ? h('label', { class: 'kb-field' }, '正文（Markdown）', text) : h('p', { class: 'muted', text: '评审和资讯的正文跟随来源更新，在知识库里只能改标题。' }),
        h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'ghost', text: '取消', onclick: () => open(doc.id) })),
      ),
    );
  }

  async function moveDocDialog(doc) {
    const to = await folderDialog({ heading: `移动「${doc.title}」到…`, rootLabel: '未归类', current: doc.folder_id });
    if (to === undefined || to === doc.folder_id) return;
    await moveDoc(doc.id, to);
  }

  async function deleteDoc(doc) {
    if (!confirm(`删除「${doc.title}」？${doc.kind === 'upload' ? '原文件也会一并删除。' : ''}`)) return;
    await act(async () => {
      await api(`/api/kb/docs/${doc.id}`, { method: 'DELETE' });
      toast('已删除');
      loadTree().catch(() => {});
      backToList();
    });
  }

  function newNote() {
    st.view = 'edit';
    st.docId = null;
    ++st.seq;
    const title = h('input', { class: 'kb-input', maxlength: '120', placeholder: '可留空，默认取正文第一行' });
    const text = h('textarea', { class: 'kb-editor', rows: '18', placeholder: '正文，支持 Markdown' });
    const save = h('button', {
      type: 'button',
      text: '保存',
      onclick: async () => {
        if (!text.value.trim()) return toast('笔记内容不能为空');
        save.disabled = true;
        try {
          const pick = await classify({
            heading: '保存笔记',
            suggest: { title: title.value, text: [...text.value].slice(0, SUGGEST_CHARS).join('') },
            current: typeof st.folder === 'number' ? st.folder : null,
          });
          if (!pick) return;
          const { doc } = await api('/api/kb/docs', { method: 'POST', body: { kind: 'note', title: title.value.trim() || undefined, body: text.value, folderId: pick.folderId } });
          toast(`已保存到：${doc.path}`);
          loadTree().catch(() => {});
          await open(doc.id);
        } catch (e) {
          toast(e.message);
        } finally {
          save.disabled = false;
        }
      },
    });
    $('kb-body').replaceChildren(
      h(
        'div',
        { class: 'kb-edit' },
        h('h3', { text: '新建笔记' }),
        h('label', { class: 'kb-field' }, '标题', title),
        h('label', { class: 'kb-field' }, '正文', text),
        h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'ghost', text: '取消', onclick: backToList })),
      ),
    );
    title.focus();
  }

  // ---------- 弹窗 ----------
  /** 弹窗依次排队显示；build(close) 返回内容节点数组，close(v) 关闭并以 v 作为结果；Esc 以 cancelValue 关闭 */
  function dialog(build, cancelValue) {
    const run = () =>
      new Promise((resolve) => {
        const box = $('kb-dialog');
        const close = (v) => {
          st.cancel = null;
          box.hidden = true;
          box.replaceChildren();
          resolve(v);
        };
        st.cancel = () => close(cancelValue);
        box.replaceChildren(h('div', { class: 'kb-dlg' }, ...build(close).filter(Boolean)));
        box.hidden = false;
      });
    const p = st.dialog.then(run, run);
    st.dialog = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  function folderSelect(rootLabel, exclude, current, extra = []) {
    const sel = h(
      'select',
      { class: 'kb-select' },
      h('option', { value: '', text: rootLabel }),
      ...extra,
      ...paths()
        .filter((p) => !exclude.has(p.id))
        .map((p) => h('option', { value: String(p.id), text: p.path })),
    );
    sel.value = current == null ? '' : String(current);
    return sel;
  }

  /** 选目录：返回目录 id，选根时返回 null，取消时返回 undefined */
  async function folderDialog({ heading, rootLabel, exclude = new Set(), current = null }) {
    await loadTree().catch(() => {});
    return dialog((close) => {
      const sel = folderSelect(rootLabel, exclude, current);
      return [
        h('h3', { text: heading }),
        h('label', { class: 'kb-field' }, '目录', sel),
        h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', text: '确认', onclick: () => close(sel.value === '' ? null : Number(sel.value)) }),
          h('button', { type: 'button', class: 'ghost', text: '取消', onclick: () => close(undefined) }),
        ),
      ];
    }, undefined);
  }

  /** 按路径新建一层目录（父目录必须已存在） */
  async function createPath(path) {
    const segs = path.split('/');
    const parentPath = segs.slice(0, -1).join('/');
    let parentId = null;
    if (parentPath) {
      parentId = paths().find((p) => p.path === parentPath)?.id ?? null;
      if (parentId == null) throw new Error('上级目录不存在');
    }
    const { id } = await api('/api/kb/folders', { method: 'POST', body: { name: segs.at(-1), parentId } });
    loadTree().catch(() => {});
    return id;
  }

  /** 归类弹窗：显示目录建议，可改选或放进未归类；返回 { folderId, title }，取消时返回 null */
  async function classify({ heading, suggest, current = null, titleField = null }) {
    await loadTree().catch(() => {});
    return dialog((close) => {
      const hint = h('p', { class: 'kb-sugg muted', text: '正在推荐目录…' });
      let sel = folderSelect('未归类', new Set(), current);
      let touched = false;
      let newPath = null;
      const watch = () => sel.addEventListener('change', () => (touched = true));
      watch();
      const field = h('label', { class: 'kb-field' }, '目录', sel);
      const titleIn = titleField ? h('input', { class: 'kb-input', maxlength: '120', placeholder: titleField.placeholder || '' }) : null;
      if (titleIn) titleIn.value = titleField.value || '';
      const titleOf = () => (titleIn ? titleIn.value.trim() : '');
      const none = () => (hint.textContent = '没有推荐的目录，可以手动选择或放进未归类。');
      api('/api/kb/suggest', { method: 'POST', body: suggest })
        .then((s) => {
          if (!s.path) return none();
          hint.textContent = `${s.create ? '建议新建' : '推荐'}：${s.path}${s.reason ? `（${s.reason}）` : ''}`;
          if (touched) return;
          if (s.create) {
            newPath = s.path;
            sel = folderSelect('未归类', new Set(), null, [h('option', { value: 'new', text: `新建：${s.path}` })]);
            sel.value = 'new';
            watch();
            field.replaceChildren('目录', sel);
          } else if (s.folderId != null) {
            sel.value = String(s.folderId);
          }
        })
        .catch(none);
      const ok = h('button', {
        type: 'button',
        text: '确认',
        onclick: async () => {
          ok.disabled = true;
          try {
            const folderId = sel.value === '' ? null : sel.value === 'new' ? await createPath(newPath) : Number(sel.value);
            close({ folderId, title: titleOf() });
          } catch (e) {
            toast(e.message);
            ok.disabled = false;
          }
        },
      });
      return [
        h('h3', { text: heading }),
        titleIn ? h('label', { class: 'kb-field' }, '标题', titleIn) : null,
        hint,
        field,
        h(
          'div',
          { class: 'actions' },
          ok,
          h('button', { type: 'button', class: 'ghost', text: '放进未归类', onclick: () => close({ folderId: null, title: titleOf() }) }),
          h('button', { type: 'button', class: 'link', text: '取消', onclick: () => close(null) }),
        ),
      ];
    }, null);
  }

  // ---------- 入库 ----------
  /** 存入评审或资讯；已在知识库时打开已有条目。返回条目 id，取消或失败时返回 null */
  async function saveDialog(src) {
    const isReview = src.reviewId != null;
    const pick = await classify({
      heading: '存入知识库',
      suggest: isReview ? { reviewId: src.reviewId } : { itemId: src.itemId },
      titleField: { value: '', placeholder: '可留空，默认使用来源标题' },
    });
    if (!pick) return null;
    const body = isReview ? { kind: 'review', reviewId: src.reviewId } : { kind: 'item', itemId: src.itemId };
    body.folderId = pick.folderId;
    if (pick.title) body.title = pick.title;
    try {
      const { doc } = await api('/api/kb/docs', { method: 'POST', body });
      toast(`已存入知识库：${doc.path}`);
      if (visible() && st.view === 'list') refresh().catch(() => {});
      return doc.id;
    } catch (e) {
      if (e.status === 409 && e.data?.docId) {
        await open(e.data.docId);
        return e.data.docId;
      }
      toast(e.message);
      return null;
    }
  }

  /** 评审页、资讯详情里的「存入知识库」按钮；已入库时显示「已在知识库」，点击打开对应条目 */
  function button(src) {
    let docId = null;
    const b = h('button', { type: 'button', class: 'link', text: '存入知识库' });
    const mark = (id) => {
      docId = id;
      b.textContent = '已在知识库';
    };
    b.addEventListener('click', async () => {
      if (docId) return open(docId);
      b.disabled = true;
      try {
        const id = await saveDialog(src);
        if (id) mark(id);
      } finally {
        b.disabled = false;
      }
    });
    const q = src.reviewId != null ? `reviewId=${src.reviewId}` : `itemId=${src.itemId}`;
    api(`/api/kb/source?${q}`)
      .then((r) => r.docId && mark(r.docId))
      .catch(() => {});
    return b;
  }

  // ---------- 上传 ----------
  async function upload(files) {
    for (const f of files) {
      if (f.size > FILE_MAX) {
        toast(`「${f.name}」超过 10MB`);
        continue;
      }
      const q = typeof st.folder === 'number' ? `?folder=${st.folder}` : '';
      let res;
      try {
        res = await fetch(`/api/kb/uploads${q}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name) },
          body: f,
        });
      } catch {
        toast('上传失败，请检查网络');
        continue;
      }
      if (res.status === 401) {
        location.replace('/login');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.doc) {
        toast(data.error || `上传失败（${res.status}）`);
        continue;
      }
      if (visible() && st.view === 'list') refresh().catch(() => {});
      void afterUpload(data.doc);
    }
  }

  /** 每 2 秒轮询到处理结束；成功后弹出归类，目录有变化时才 PATCH */
  async function afterUpload(doc) {
    let d = doc;
    while (d.status === 'processing') {
      await sleep(POLL_MS);
      try {
        d = (await api(`/api/kb/docs/${d.id}`)).doc;
      } catch (e) {
        if (e.status === 404) return;
      }
    }
    if (visible() && st.view === 'list') refresh().catch(() => {});
    if (d.status !== 'ready') return toast(`「${d.title}」处理失败：${d.error || '未知错误'}`);
    const pick = await classify({ heading: `归类「${d.title}」`, suggest: { docId: d.id }, current: d.folder_id });
    if (!pick || pick.folderId === d.folder_id) return;
    await moveDoc(d.id, pick.folderId);
  }

  // ---------- 入口 ----------
  async function load() {
    st.view = 'list';
    st.docId = null;
    renderTabs();
    for (const [key] of TABS) $(`kb-pane-${key}`).hidden = key !== st.tab;
    if (st.tab !== 'docs') wiki.activate(st.tab);
    try {
      await Promise.all([loadTree(), wiki.refreshStatus().then(() => loadList())]);
    } catch (e) {
      toast(e.message);
    }
  }

  let qt;
  $('kb-q').addEventListener('input', () => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      st.q = $('kb-q').value.trim();
      st.view = 'list';
      st.docId = null;
      loadList().catch((e) => toast(e.message));
    }, 300);
  });
  $('kb-new-folder').addEventListener('click', () => newFolder(null));
  $('kb-new-note').addEventListener('click', newNote);
  $('kb-upload').addEventListener('click', () => $('kb-file').click());
  $('kb-file').addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    upload(files);
  });
  wiki.mount({ wiki: $('kb-pane-wiki'), ask: $('kb-pane-ask'), lint: $('kb-pane-lint') });
  $('kb-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') st.cancel?.();
  });
  $('kb-dialog').addEventListener('click', (e) => {
    if (e.target === $('kb-dialog')) st.cancel?.();
  });

  return { load, open, saveDialog, button, openWiki };
}
