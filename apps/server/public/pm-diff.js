// 产品顾问版本对比：服务端给逐行差异，这里负责折叠未改动的行、相邻删改行做字符级高亮
export function initPmDiff({ h, api, verName }) {
  const CONTEXT = 2;
  const cache = new Map();
  let full = false;

  async function load(id, n, base) {
    const key = `${id}:${base}:${n}`;
    if (!cache.has(key)) cache.set(key, await api(`/api/pm/reviews/${id}/versions/${n}/diff?base=${base}`));
    return cache.get(key);
  }

  /** 连续未改动的行只保留与改动相邻的 CONTEXT 行，其余折叠成一段（少于 2 行不折叠） */
  function fold(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].t !== ' ') {
        out.push({ i, l: lines[i] });
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j].t === ' ') j++;
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === lines.length ? 0 : CONTEXT;
      if (j - i - head - tail < 2) {
        for (let k = i; k < j; k++) out.push({ i: k, l: lines[k] });
      } else {
        for (let k = i; k < i + head; k++) out.push({ i: k, l: lines[k] });
        out.push({ fold: lines.slice(i + head, j - tail).map((l, x) => ({ i: i + head + x, l })) });
        for (let k = j - tail; k < j; k++) out.push({ i: k, l: lines[k] });
      }
      i = j;
    }
    return out;
  }

  /** 两行去掉公共前后缀后的 [前缀, 改动, 后缀]；整行都不同时返回 null */
  function split(a, b) {
    const x = Array.from(a);
    const y = Array.from(b);
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0;
    while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    if (p + s === 0) return null;
    const cut = (z) => [z.slice(0, p).join(''), z.slice(p, z.length - s).join(''), z.slice(z.length - s).join('')];
    return [cut(x), cut(y)];
  }

  /** 一段连续删除行之后紧跟一段新增行时，按顺序两两配对做字符级高亮 */
  function marks(lines) {
    const m = new Map();
    let i = 0;
    while (i < lines.length) {
      if (lines[i].t !== '-') {
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j].t === '-') j++;
      let k = j;
      while (k < lines.length && lines[k].t === '+') k++;
      for (let q = 0; q < Math.min(j - i, k - j); q++) {
        const r = split(lines[i + q].s, lines[j + q].s);
        if (r) {
          m.set(i + q, r[0]);
          m.set(j + q, r[1]);
        }
      }
      i = k;
    }
    return m;
  }

  const CLS = { '+': 'add', '-': 'del', ' ': 'same' };
  const row = (l, mk) =>
    h('div', { class: CLS[l.t] }, `${l.t} `, ...(mk ? [mk[0], mk[1] ? h('mark', { class: 'chg', text: mk[1] }) : null, mk[2]] : [l.s]));

  /** 对比视图：st = { n, base }；onChange(n, base) 换一组版本，onExit() 退出 */
  function view(r, st, { onChange, onExit }) {
    const nums = r.versions.map((v) => v.n);
    const byN = new Map(r.versions.map((v) => [v.n, v]));
    const pick = (label, list, val, fn) => {
      const s = h('select', { 'aria-label': label, onchange: (e) => fn(Number(e.target.value)) });
      for (const n of list) s.append(h('option', { value: String(n), text: byN.has(n) ? verName(byN.get(n)) : `v${n}` }));
      s.value = String(val);
      return s;
    };
    const baseSel = pick('对比的旧版本', nums.filter((n) => n < st.n).reverse(), st.base, (b) => onChange(st.n, b));
    const toSel = pick('对比的新版本', nums.filter((n) => n >= 2).reverse(), st.n, (n) => onChange(n, st.base < n ? st.base : n - 1));
    const stats = h('span', { class: 'muted pm-diff-stats' });
    const toggle = h('button', {
      type: 'button',
      class: 'link',
      text: full ? '只看改动' : '显示全文',
      onclick: () => {
        full = !full;
        toggle.textContent = full ? '只看改动' : '显示全文';
        paint();
      },
    });
    const body = h('div', { class: 'pm-diff-body' }, h('p', { class: 'muted', text: '加载中…' }));
    const opened = new Set();
    let data = null;
    let mk = null;

    function paint() {
      if (!data) return;
      const { lines, clipped } = data.diff;
      if (!data.stats.add && !data.stats.del) return body.replaceChildren(h('p', { class: 'muted', text: '两个版本内容相同。' }));
      const out = [];
      for (const s of full ? lines.map((l, i) => ({ i, l })) : fold(lines)) {
        if (!s.fold) out.push(row(s.l, mk.get(s.i)));
        else if (opened.has(s.fold[0].i)) for (const x of s.fold) out.push(row(x.l, null));
        else
          out.push(
            h('div', { class: 'fold' },
              h('button', {
                type: 'button',
                class: 'link',
                text: `… ${s.fold.length} 行未改动，展开`,
                onclick: () => {
                  opened.add(s.fold[0].i);
                  paint();
                },
              }),
            ),
          );
      }
      body.replaceChildren(
        ...[clipped ? h('p', { class: 'muted', text: '内容过长，只比较了开头和结尾部分。' }) : null, h('div', { class: 'wiki-diff' }, h('pre', {}, out))].filter(Boolean),
      );
    }

    load(r.id, st.n, st.base).then(
      (d) => {
        data = d;
        mk = marks(d.diff.lines);
        stats.textContent = `新增 ${d.stats.add} 行 · 删除 ${d.stats.del} 行`;
        paint();
      },
      (e) => body.replaceChildren(h('p', { class: 'err', text: e.message })),
    );

    return h('div', { class: 'pm-diff' },
      h('div', { class: 'pm-versions pm-diff-bar' },
        h('label', { class: 'ver-pick' }, h('span', { class: 'muted', text: '对比' }), baseSel, h('span', { class: 'muted', text: '→' }), toSel),
        h('div', { class: 'ver-actions' }, stats, toggle, h('button', { type: 'button', class: 'link', text: '退出对比', onclick: onExit })),
      ),
      h('p', { class: 'muted pm-diff-hint', text: '- 为旧版本有而新版本没有，+ 为新版本新增；深色为一行中改动的部分。' }),
      body,
    );
  }

  return { view };
}
