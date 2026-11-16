// 评审页的原型面板：版本、进度、预览、修改与终端切换。外部数据只通过 textContent 写入 DOM
export function initProto({ h, api, toast }) {
  let st = null;

  function newState(review) {
    return {
      id: review.id, review, viewN: 1, versions: [], selected: 0,
      device: 'phone', slug: '', notes: false, draft: '', root: null, frame: null, stage: null, select: null,
      timer: null, seq: 0, bound: false, content: null, frameMounted: false,
    };
  }

  function schedule(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (st === s && s.versions.some((v) => v.status === 'running')) s.timer = setTimeout(() => load(s), 2000);
  }

  async function load(s) {
    const seq = ++s.seq;
    try {
      const data = await api(`/api/pm/reviews/${s.id}/prototypes`);
      if (seq !== s.seq || st !== s) return;
      s.versions = data.prototypes || [];
      if (!s.versions.some((v) => v.n === s.selected)) {
        const done = [...s.versions].reverse().find((v) => v.status === 'done');
        s.selected = done ? done.n : (s.versions.length ? s.versions[s.versions.length - 1].n : 0);
      }
      render(s);
    } catch (e) {
      toast(e.message);
    }
    schedule(s);
  }

  async function post(s, path, body, msg) {
    try {
      await api(`/api/pm/reviews/${s.id}/prototypes${path}`, { method: 'POST', body });
      toast(msg);
      await load(s);
    } catch (e) {
      toast(e.message);
    }
  }

  function send(s, msg) {
    if (s.frame && s.frame.contentWindow) s.frame.contentWindow.postMessage(msg, '*');
  }

  function bind(s) {
    if (s.bound) return;
    s.bound = true;
    window.addEventListener('message', (e) => {
      if (st !== s || !s.frame || e.source !== s.frame.contentWindow) return;
      const m = e.data || {};
      if (m.type !== 'proto:page') return;
      const pages = (s.versions.find((v) => v.n === s.selected)?.pages) || [];
      if (!pages.some((p) => p.slug === m.slug)) return;
      s.slug = m.slug;
      if (s.select) s.select.value = m.slug;
    });
    window.addEventListener('resize', () => { if (st === s) updateScale(s); });
  }

  function updateScale(s) {
    if (!s.frame) return;
    const apply = () => {
      let ratio = 1;
      if (s.device === 'desktop') {
        const width = s.stage?.clientWidth || (typeof window.innerWidth === 'number' ? window.innerWidth - 40 : 1280);
        ratio = width > 0 && width < 1280 ? width / 1280 : 1;
      }
      s.frame.setAttribute('style', `transform:scale(${ratio})`);
      if (s.stage) s.stage.setAttribute('data-scale', String(ratio));
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    else apply();
  }

  function progress(v) {
    if (!v) return '';
    if (v.progress?.stage === 'queued') return '排队中';
    if (v.progress?.stage === 'outline' || v.progress?.stage === 'plan') return '正在规划页面…';
    if (v.progress?.stage === 'pages') return `页面 ${v.progress.done}/${v.progress.total}`;
    return v.status === 'running' ? '正在生成…' : '';
  }

  function frameUrl(s, n) {
    const hash = s.slug ? `#/${encodeURIComponent(s.slug)}` : '';
    return `/api/pm/reviews/${s.id}/prototypes/${n}/html?device=${s.device}${hash}`;
  }

  function render(s) {
    bind(s);
    const root = s.root;
    if (!s.content) { s.content = h('div', { class: 'proto-content' }); root.append(s.content); }
    if (!s.stage) { s.stage = h('div', { class: 'proto-stage' }); root.append(s.stage); }
    const c = s.content;
    c.replaceChildren();
    c.append(h('h3', { class: 'proto-title', text: '原型' }));
    const vs = s.versions;
    if (!vs.length) {
      c.append(h('p', { class: 'muted', text: `约 1–2 分钟，按当前查看的 PRD v${s.viewN} 生成` }));
      c.append(h('button', { text: '生成原型', onclick: () => post(s, '', { versionN: s.viewN }, '原型生成中') }));
      s.stage.setAttribute('data-visible', '0');
      return;
    }
    const v = vs.find((x) => x.n === s.selected) || vs[vs.length - 1];
    s.selected = v.n;
    const bar = h('div', { class: 'proto-bar' });
    for (const x of vs) {
      bar.append(h('button', {
        class: `proto-ver${x.n === v.n ? ' on' : ''}${x.status === 'error' ? ' err' : ''}`,
        text: `v${x.n}`,
        onclick: () => { s.selected = x.n; s.slug = ''; render(s); },
      }));
    }
    if (v.status === 'error') bar.append(h('button', { text: '重试', onclick: () => post(s, `/${v.n}/retry`, {}, '原型已重新排队') }));
    s.select = h('select', {
      class: 'proto-pages',
      onchange: (e) => { s.slug = e.target.value; send(s, { type: 'proto:goto', slug: s.slug }); },
    });
    for (const p of v.pages || []) s.select.append(h('option', { value: p.slug, text: p.title || p.slug }));
    if (s.slug) s.select.value = s.slug;
    bar.append(s.select);
    bar.append(h('button', { class: s.device === 'phone' ? 'on' : '', text: '手机', onclick: () => { s.device = 'phone'; render(s); } }));
    bar.append(h('button', { class: s.device === 'desktop' ? 'on' : '', text: '桌面', onclick: () => { s.device = 'desktop'; render(s); } }));
    bar.append(h('button', {
      class: s.notes ? 'on' : '',
      text: '标注',
      onclick: () => { s.notes = !s.notes; render(s); send(s, { type: 'proto:notes', on: s.notes }); },
    }));
    bar.append(h('a', { href: `/proto/${s.id}/${v.n}`, text: '全屏' }));
    bar.append(h('a', { href: `/api/pm/reviews/${s.id}/prototypes/${v.n}/html?download=1`, text: '下载' }));
    c.append(bar);
    if (v.status === 'running') c.append(h('p', { class: 'proto-progress', text: progress(v) }));
    if (v.status === 'error') c.append(h('p', { class: 'err', text: v.error || '生成失败' }));
    if (v.base_version_n && s.review.latest && v.base_version_n !== s.review.latest) {
      c.append(
        h('div', { class: 'proto-notice' },
          h('span', { text: `原型基于 PRD v${v.base_version_n}，PRD 已更新到 v${s.review.latest}` }),
          h('button', { text: '按新 PRD 重新生成', onclick: () => post(s, '', { versionN: s.review.latest }, '已按新 PRD 重新生成') }),
        ),
      );
    }
    const info = h('div', { class: 'proto-info' });
    if (v.request) info.append(h('div', { text: `修改要求：${v.request}` }));
    if (v.note) info.append(h('div', { text: `说明：${v.note}` }));
    info.append(h('div', { class: 'muted', text: v.from_n ? `基于原型 v${v.from_n}` : `基于 PRD v${v.base_version_n}` }));
    c.append(info);
    const input = h('input', {
      class: 'proto-revise-input', type: 'text', maxlength: '1000',
      placeholder: '描述要怎么改原型，比如：登录页加一个微信登录',
      oninput: (e) => { s.draft = e.target.value; },
    });
    if (s.draft) input.value = s.draft;
    c.append(
      h('form', {
        class: 'proto-revise',
        onsubmit: async (e) => {
          e.preventDefault();
          const text = String(s.draft || input.value || '').trim();
          if (!text) { toast('请先描述修改要求'); return; }
          await post(s, `/${v.n}/revise`, { text }, '原型修改中');
          s.draft = '';
          input.value = '';
        },
      }, input, h('button', { type: 'submit', text: '修改原型' })),
    );
    s.stage.setAttribute('data-device', s.device);
    s.stage.setAttribute('data-visible', v.status === 'done' ? '1' : '0');
    if (v.status === 'done') {
      if (!s.frame) s.frame = h('iframe', {
        class: 'proto-frame', sandbox: 'allow-scripts', title: '原型预览',
        onload: () => {
          if (s.notes) send(s, { type: 'proto:notes', on: true });
          if (s.slug) send(s, { type: 'proto:goto', slug: s.slug });
        },
      });
      if (!s.frameMounted) { s.stage.append(s.frame); s.frameMounted = true; }
      const url = frameUrl(s, v.n);
      if (s.frame.getAttribute('src') !== url) s.frame.setAttribute('src', url);
      updateScale(s);
    }
  }

  function panel(review, viewN) {
    if (!st || st.id !== review.id) {
      if (st && st.timer) clearTimeout(st.timer);
      st = newState(review);
      st.root = h('section', { class: 'proto-panel' });
      st.viewN = viewN;
      render(st);
      load(st);
    } else {
      st.review = review;
      st.viewN = viewN;
      render(st);
      schedule(st);
    }
    return st.root;
  }

  function leave() {
    if (st && st.timer) { clearTimeout(st.timer); st.timer = null; }
  }

  return { panel, leave, _poll: () => (st ? load(st) : Promise.resolve()) };
}
