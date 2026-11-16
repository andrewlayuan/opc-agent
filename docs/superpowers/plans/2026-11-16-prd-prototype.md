# PRD 转 HTML 原型（E）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在产品顾问评审页里，把 PRD 生成可点击的多页 HTML 原型，支持对话修改、版本历史、标注模式、单文件导出。

**Architecture:** 新增 `packs/proto/`：`types` 公共类型与上限，`store` 管 `pm_prototypes` 表，`sanitize` 白名单清理，`parse` 解析模型输出，`assemble` 拼装自包含文档，`prompts` 和 `runner` 负责生成与修改任务，`shell/` 是原型外壳（CSS 与脚本）。接口在 `apps/server/proto-api.ts`，前端是 `public/proto-panel.js`（评审页面板）与 `public/proto-full.*`（全屏页）。`packs/proto` 只通过构造参数拿到 PRD 正文，不 import `packs/pm`。

**Tech Stack:** Node ≥22.18（`node:sqlite`、`node --test`、原生 TS 类型擦除），零 npm 依赖；前端为原生 JS ES module；原型外壳为普通脚本。

**Spec:** `docs/superpowers/specs/2026-11-16-prd-prototype-design.md`

## Global Constraints

- 不新增 npm 依赖；TS 只用可被类型擦除的语法（不用 enum、namespace、参数属性）。
- SQL 一律参数绑定；状态更新一律带 `AND status = 'running'`，返回是否命中。
- 字数一律按码点计算（`[...s].length`）；字节上限用 `Buffer.byteLength`。
- 上限逐字取自 spec 第 11 节，集中放在 `PROTO_LIMITS`（Task 1），其他模块不得另写数字。
- 进入提示词的 PRD 正文、修改要求、页面摘要一律经过 `fence`（`packs/memory/events.ts`）。
- 模型输出的 HTML 必须经过 `sanitizeHtml` 才能入库；`assemble` 只拼装已清理的 HTML。
- 前端（管理端）只用 `h()` 和 `textContent` 写 DOM；原型外壳 `proto.js` 不使用 `innerHTML`、`eval`、`new Function`。
- 错误文案逐字采用 spec 与本计划给出的写法。
- 所有接口都要求登录，写操作要求同源（沿用 `handleApi` 开头的检查）。
- 提交时带身份参数：`git -c user.name=andrewlayuan -c user.email=andrewlayuan@users.noreply.github.com commit`。
- 每个任务结束都运行 `/tmp/opc-check.sh`，看到 `# fail 0` 和 `TSC_OK` 才算通过；改了前端的任务还要运行 `/tmp/opc-check-ui.sh`，看到 `ALL PASS`。

## 与 spec 的偏差

- spec 第 2 节的 `outline.ts` 改名为 `parse.ts`，同时负责大纲、改动计划和页面输出三种模型输出的解析；另加 `types.ts` 放公共类型与上限。
- spec 第 4.1 节「`pages` 3–10 个」：提示词要求 3–10 页；解析时 1–2 页也接受（spec 只规定少于 1 页失败）。
- 新增：`<a href="#/slug">` 或 `href="#slug"` 在清理时转换成 `data-goto="slug"`（见 Review Focus 1）；`data-goto` 的值不是 slug 时，外壳按页面标题再匹配一次（Review Focus 2）。

## Review Focus

1. **模型用 `<a href="#/detail">` 而不是 `data-goto` 写跳转**：跳转要能用，不能因为删了 `href` 而失效。测试在 Task 2。
2. **模型在 `data-goto` 里写页面标题**（如 `data-goto="订单详情"`）：要能跳到标题相同的页面，而不是进入「这一页还没有设计」。测试在 Task 4。
3. **评审页轮询时整体重绘**（PRD 追问进行中，每 3 秒调用一次 `renderReview`）：原型面板和 iframe 不能被重建，否则预览会闪动并回到第一页。测试在 Task 8。
4. **产品名里有 `/`、`"`、`\`、换行**：下载文件名要能正常保存，响应头不能被注入。测试在 Task 4。
5. **模型输出整份文档**（带 `<html><head><style>…<body>`，但没有 `<main>`）：取 `<body>` 里的内容，`<style>`、`<head>` 都要去掉，不能当成截断。测试在 Task 3。

---

### Task 0: 工作区与检查脚本

- [ ] **Step 1:** 运行 `git worktree add .worktrees/proto -b feat/proto`。
- [ ] **Step 2:** 把 `/tmp/opc-check.sh`、`/tmp/opc-check-ui.sh` 里的 `/opt/opc-agent` 改成 `/opt/opc-agent/.worktrees/proto`（`opc-check.sh` 里 `typeRoots` 那一行仍然指向 `/opt/opc-agent/deepseek-harness/node_modules/@types`）。修改 `/tmp/opc-ui-sim.mjs` 的源码拼接：如果 `${PUB}/proto-panel.js` 存在，也像 `kb.js` 一样去掉 `export ` 并删掉 `app.js` 里对应的 `import` 行，拼接顺序为 `kb.js`、`proto-panel.js`、`app.js`。
- [ ] **Step 3:** 运行 `/tmp/opc-check.sh`（期望 234 个通过、`TSC_OK`）和 `/tmp/opc-check-ui.sh`（期望 `ALL PASS`）。

---

### Task 1: 迁移 8、公共类型与存储

**Files:**
- Modify: `packages/core/db.ts`（`MIGRATIONS` 追加第 8 个）
- Create: `packs/proto/types.ts`、`packs/proto/store.ts`
- Test: `packs/proto/store.test.ts`；修改 `packs/pm/attachments.test.ts:22`、`packs/memory/migrate.test.ts:39`、`packs/kb/migrate.test.ts:11`（期望值 7 → 8）；`packs/pm/pm.test.ts:202` 的回退脚本加上 `DROP TABLE IF EXISTS pm_prototypes;`

**Interfaces:**
- Produces（`types.ts`）：
  - `type Device = 'phone' | 'desktop'`；`const THEMES = ['blue','green','violet','orange','slate','rose'] as const`；`type Theme`
  - `interface OutlinePage { slug: string; title: string; purpose: string; content: string; links: string[] }`
  - `interface Outline { product: string; device: Device; theme: Theme; nav: string[]; data: Record<string, unknown>; pages: OutlinePage[] }`
  - `interface ProtoPage { slug: string; title: string; html: string; error: string | null }`
  - `interface Progress { stage: 'queued' | 'outline' | 'plan' | 'pages'; done: number; total: number }`
  - `interface ProtoRow { id; review_id; n; created_at; finished_at: number | null; status: 'running' | 'done' | 'error'; base_version_n; from_n: number | null; request: string; note: string; progress: Progress; outline: Outline | null; pages: ProtoPage[]; error: string | null }`（数字字段都是 `number`）
  - `type ProtoMeta = Omit<ProtoRow, 'outline' | 'pages'> & { product: string | null; device: Device | null; pages: { slug: string; title: string; error: string | null }[] }`
  - `class ProtoError extends Error { status: 400 | 404 | 409 | 503 }`
  - `const PROTO_LIMITS = { prdOutlineChars: 12000, prdPageChars: 6000, requestMax: 1000, pagesMax: 10, slugRe: /^[a-z0-9-]{1,32}$/, titleMax: 20, purposeMax: 400, productMax: 20, navMax: 5, dataBytes: 4096, pageBytes: 40960, docBytes: 409600, taskMs: 480000, pageConcurrency: 3, globalTasks: 2, versionsMax: 20, revisePagesMax: 10, outlineTokens: 3000, pageTokens: 6000, outlineTimeoutMs: 120000, pageTimeoutMs: 180000, summaryChars: 300 }`
  - `const RESTART_MSG = '服务重启，生成中断，请重试'`
- Produces（`store.ts`，第一个参数都是 `db: DB`）：
  - `createVersion(db, reviewId: number, v: { baseVersionN: number; fromN: number | null; request: string }): ProtoRow` —— 同一评审已有 `running` 时抛 `ProtoError(409, '原型正在生成')`；`n` = 现有最大 `n` + 1；插入后裁剪：版本数超过 20 时，删除 `n > 1` 中最小、且不是 `running` 的版本。
  - `getVersion(db, reviewId, n): ProtoRow | null`；`listVersions(db, reviewId): ProtoMeta[]`（按 `n` 升序）
  - `setProgress(db, id, p: Progress): boolean`；`saveOutline(db, id, o: Outline): boolean`；`savePages(db, id, pages: ProtoPage[]): boolean`
  - `finish(db, id, r: { status: 'done' | 'error'; note?: string; error?: string | null }): boolean`
  - `restart(db, reviewId, n): ProtoRow` —— 只能对 `error` 版本操作，否则抛 `ProtoError(409, '只能重试失败的版本')`；同一评审已有 `running` 时抛 409「原型正在生成」；把状态改回 `running`，清空 `error`，重置 `progress`。
  - `recover(db): number` —— 把所有 `running` 改为 `error` + `RESTART_MSG`。

- [ ] **Step 1: 写失败的测试**（`store.test.ts`，用 `openDb(':memory:')`，先插入评审 #1 和它的 PRD v1）
  - `user_version` 为 8；`pm_prototypes` 有 `UNIQUE(review_id, n)`；删除评审后原型级联删除。
  - `createVersion` 连续调用两次，第二次抛 409「原型正在生成」；第一次 `finish` 之后可以再建，得到 `n = 2`。
  - 建 22 个版本（每个都先 `finish`）后，`listVersions` 返回 20 个，`n` 为 `[1, 4, 5, …, 22]`；再建一个得到 `n = 23`（版本号不复用）。
  - `finish` 之后再调用 `setProgress`、`savePages`，都返回 `false`。
  - `restart`：对 `done` 版本抛 409「只能重试失败的版本」；对 `error` 版本成功，状态变为 `running`，`error` 为 `null`。
  - `recover` 返回改动条数，被改的行 `error === '服务重启，生成中断，请重试'`。
  - `listVersions` 返回的 `pages` 只有 `slug`、`title`、`error`，并带 `product`、`device`（没有大纲时为 `null`）。
- [ ] **Step 2:** 运行 `node --test packs/proto/store.test.ts`，确认失败。
- [ ] **Step 3:** 实现。迁移 8 的建表语句照抄 spec 第 3 节；`progress` 默认值 `{"stage":"queued","done":0,"total":0}`；`outline` 列在没有大纲时存 `'null'`，读出时解析为 `null`。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过（包括改过期望值的三个迁移测试）。
- [ ] **Step 5:** 提交 `feat(proto): 迁移 8 与原型版本存储`。

---

### Task 2: 页面 HTML 白名单清理

**Files:**
- Create: `packs/proto/sanitize.ts`
- Test: `packs/proto/sanitize.test.ts`

**Interfaces:**
- Produces:
  - `type Token = { t: 'open'; tag: string; attrs: [string, string][]; self: boolean } | { t: 'close'; tag: string } | { t: 'text'; v: string }`（注释、CDATA、doctype 在分词阶段丢弃；`tag` 和属性名一律小写；属性值已解码实体）
  - `tokenize(html: string): Token[]`（Task 4 的测试用它来搭建简易 DOM）
  - `sanitizeHtml(html: string): string`
  - `textOf(html: string, max: number): string`：取清理后的纯文本，空白合并，按码点截断到 `max` 字。

- [ ] **Step 1: 写失败的测试**。每条都是 `sanitizeHtml(输入)` 对比期望输出，或断言输出里不含某个子串：
  - 整段删除：`<script>alert(1)</script>`、`<style>a{}</style>`、`<iframe src=x></iframe>`、`<svg><foreignObject><div>x</div></foreignObject></svg>`、`<svg><animate attributeName="x"/></svg>`、`<svg><use href="#a"/></svg>`、`<template><p>x</p></template>`、`<noscript>x</noscript>` 的输出里都没有 `script`、`alert`、`x`、`foreignObject`、`animate`、`use`。
  - 事件属性和危险链接：`<div onclick="a()" onmouseover=b>t</div>` → `<div>t</div>`；`<img src=x onerror=alert(1)>` → 输出里没有 `onerror`，也没有 `img`；`<a href="javascript:alert(1)">x</a>` → `x`；`<a href="&#106;avascript:alert(1)">x</a>` → `x`。
  - 拆开的标签：`<scr<script>x</script>ipt>alert(1)</script>` 的输出里没有 `<script`；大小写混用 `<ScRiPt>` 一样被删。
  - 注释和 CDATA：`<!-- <script>x</script> -->ok`、`<![CDATA[<script>]]>ok` → `ok`。
  - `style` 属性：`style="color:red;background:url(x);width:expression(1);margin:4px"` → 只保留 `color:red;margin:4px`；`style="position:fixed"` → 去掉整个 `style`。
  - 白名单保留：`<div class="card list" data-goto="detail" aria-label="x" role="button">` 原样保留；`<input type="checkbox" checked name="a">` 保留；`<input type="file">` 的 `type` 被去掉；`class="ok bad!name"` 只剩 `ok`；`data-goto="a b"`（不合法）被去掉。
  - **Review Focus 1**：`<a href="#/order-detail" class="btn">去看</a>` → `<span class="btn" data-goto="order-detail">去看</span>`；`href="#order-detail"` 同样转换；`<a href="https://x.com">` → 只保留文字。
  - 结构完整：`<div><p>a<div>b` → `<div><p>a<div>b</div></p></div>`；`</main>` 提前出现时被丢弃（输出里没有 `main` 闭合标签，除非有对应的开标签）。
  - 转义：`<p title='a"b'>1 < 2 & 3</p>` → `<p title="a&quot;b">1 &lt; 2 &amp; 3</p>`。
  - 幂等：对上面每个输入，`sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x)`。
  - `textOf('<div>订单 <b>#123</b></div>  <p>已发货</p>', 6)` → `订单 #123`（按码点截断到 6 字）。
- [ ] **Step 2:** 运行测试，确认失败。
- [ ] **Step 3:** 实现。按 spec 第 5 节的标签、属性白名单实现。分词器按字符状态机扫描，属性值支持双引号、单引号和不加引号三种写法。删除整段的元素，要跳过直到对应的闭合标签为止（同名元素嵌套时计数）；遇到原始文本元素（`script`、`style`、`xmp`、`plaintext`、`noscript`、`template`）时，按原始文本扫描到闭合标签。实体解码支持 `&#nn;`、`&#xhh;`，以及 `amp lt gt quot apos nbsp` 这几个命名实体。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(proto): 页面 HTML 白名单清理`。

---

### Task 3: 模型输出解析

**Files:**
- Create: `packs/proto/parse.ts`
- Test: `packs/proto/parse.test.ts`

**Interfaces:**
- Consumes: `Outline`、`OutlinePage`、`PROTO_LIMITS`、`THEMES`（Task 1）
- Produces:
  - `parseOutline(raw: unknown): Outline | null` —— 页数少于 1 返回 `null`。
  - `parsePlan(raw: unknown, current: Outline): { note: string; outline: Outline; pages: { slug: string; change: string }[] }` —— 不合法时抛 `ProtoError(400, …)`，文案见 Step 1。
  - `extractPage(text: string): { html: string; truncated: boolean }`

- [ ] **Step 1: 写失败的测试**
  - `parseOutline`：
    - 12 页时截到 10 页；`pages` 为空或不是数组时返回 `null`。
    - slug `'订单 详情'`、重复的 `'home'` 被改成 `p2`、`p3`…（按页面位置编号，`p` 后接 1 起的序号），同时 `nav` 和其他页的 `links` 里对旧 slug 的引用也改掉；如果有两页都叫 `home`，引用指向第一页。
    - `device: 'tablet'` → `'desktop'`；`theme: 'pink'` → `'blue'`。
    - 标题超过 20 字截断；`nav` 里不存在的 slug 被去掉，最多留 5 个。
    - `data` 序列化后超过 4096 字节时变为 `{}`。
    - `links` 不是字符串数组时变为 `[]`。
  - `parsePlan`：
    - `pages` 引用的 slug 不在新大纲里时，丢掉这一项；新大纲里有、`current` 里没有的页面自动加进 `pages`，`change` 为「新页面」。
    - 合并后超过 10 页时，抛 400「改动太大，建议按新 PRD 重新生成」。
    - `note` 为空，或者 `pages` 为空，抛 400「没理解修改要求，请换个说法」。
    - 新大纲不合法时（`parseOutline` 返回 `null`），同样抛「没理解修改要求，请换个说法」。
  - `extractPage`：
    - ```` ```html\n<main><div>x</div></main>\n``` ```` → `{ html: '<div>x</div>', truncated: false }`
    - `'说明文字<main class="a">x</main>多余'` → `html: 'x'`
    - `'<main><div>x'` → `truncated: true`
    - **Review Focus 5**：`'<!doctype html><html><head><style>a{}</style></head><body><div>x</div></body></html>'` → `{ html: '<div>x</div>', truncated: false }`（`style` 留给 `sanitizeHtml` 删，这里只要求不含 `<head`、`<body`）
    - 没有 `<main` 也没有 `<body` 时，整段原样返回，`truncated: false`。
- [ ] **Step 2:** 运行测试，确认失败。
- [ ] **Step 3:** 实现。slug 重命名时先对整份大纲建立「旧 slug → 新 slug」映射，再统一替换引用。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(proto): 大纲、改动计划与页面输出解析`。

---

### Task 4: 原型外壳与文档拼装

**Files:**
- Create: `packs/proto/shell/proto.css`、`packs/proto/shell/proto.js`、`packs/proto/assemble.ts`
- Test: `packs/proto/assemble.test.ts`、`packs/proto/shell.test.ts`

**Interfaces:**
- Consumes: `ProtoRow`、`Device`（Task 1），`tokenize`（Task 2）
- Produces（`assemble.ts`）：
  - `SHELL: { css: string; js: string; hash: string }` —— 在模块加载时读取 `shell/` 下的两个文件；`hash` 为 `proto.js` 内容的 SHA-256 base64。
  - `protoCsp(forMeta: boolean): string` —— 值逐字取自 spec 第 7 节；`forMeta` 为 `true` 时不含 `frame-ancestors`。
  - `assemble(row: ProtoRow, opts?: { device?: Device }): string` —— 结构按 spec 第 7 节。失败的页面输出占位：`<main><div class="empty">此页生成失败</div></main>`。
  - `protoFileName(row: ProtoRow): string` —— `<产品名>-原型-v<n>.html`。产品名去掉 `\ / : * ? " < > |` 和控制字符，结果为空时用「原型」。
- Produces（`proto.js` 与外层的约定）：
  - 消息格式见 spec 第 6.4 节。
  - 页面选择器：`section.pg[data-slug]`。
  - 只用这些 DOM API：`document.getElementById`；`document.querySelectorAll` / `el.querySelectorAll` / `el.closest`，选择器只用 `.类名`、`[属性]`、`[属性="值"]`、`标签.类名` 四种写法（可以用逗号并列）；以及 `classList`、`dataset`、`getAttribute`、`setAttribute`、`createElement`、`appendChild`、`textContent`、`addEventListener`、`location.hash`、`window.parent.postMessage`。

- [ ] **Step 1: 写失败的测试**
  - `assemble.test.ts`：
    - `protoCsp(false)` 里有 `script-src 'sha256-${SHELL.hash}'` 和 `frame-ancestors 'self'`；`protoCsp(true)` 里没有 `frame-ancestors`。
    - `assemble` 的结果里，`<meta http-equiv="Content-Security-Policy"` 的值等于 `protoCsp(true)`。
    - 结果里只有一个 `<script>` 标签（不算 `type="application/json"` 的那个），它的内容的 SHA-256 等于 `SHELL.hash`。
    - 大纲里 `product` 为 `'</script><script>alert(1)'` 时，`proto-data` 数据块里没有 `</script`；`<title>` 里是转义后的文本。
    - `opts.device` 会覆盖大纲里的 `device`，体现在 `body` 的类上；主题类为 `theme-<theme>`。
    - 失败的页面输出「此页生成失败」占位。
    - **Review Focus 4**：`protoFileName` 对产品名 `'律/审"通\n'` 返回 `'律审通-原型-v3.html'`；对空产品名返回 `'原型-原型-v3.html'`。
  - `shell.test.ts`：用 `tokenize` 把 `assemble` 的输出搭成一个简易 DOM（只实现上面列出的那些 API，另加一个 `fire(el, 'click' | 'submit')`，事件会沿父节点冒泡）。用 `node:vm` 运行 `SHELL.js`，`window.parent.postMessage` 记录下发出的消息。准备 3 页：`home`、`detail`、`me`，`home` 里放各种交互元素。断言：
    - 启动后只显示 `home`（其他页带 `hidden`），并发出 `{ type: 'proto:ready', pages: ['home', 'detail', 'me'] }`。
    - 点 `[data-goto="detail"]` 后，显示 `detail`，`location.hash === '#/detail'`，并发出 `proto:page`；点 `[data-back]` 回到 `home`。
    - **Review Focus 2**：点 `[data-goto="订单详情"]`（`detail` 页的标题是「订单详情」）会跳到 `detail`。
    - 点 `[data-goto="nope"]` 后，显示「这一页还没有设计」。
    - `data-open="filter"` 让 `#filter.sheet` 加上 `open` 类；在它里面点 `[data-close]` 后，`open` 类被去掉。
    - `data-tab="t:b"` 让 `[data-tab="t:b"]` 和对应的 `.tab-panel[data-tab-panel="t:b"]` 加上 `on` 类，同组的其他项去掉 `on`。
    - `data-toggle` 切换自身的 `on` 类；`data-toast="已收藏"` 让 `#proto-toast` 显示文字「已收藏」。
    - 在 `form[data-goto="me"][data-toast="已提交"]` 上触发 `submit` 后，跳到 `me`，并且提示「已提交」。
    - 外层发来 `{ type: 'proto:notes', on: true }` 后，`body` 加上 `notes` 类，每页顶部出现说明卡（内容是大纲里的 `purpose`）；`source` 不是 `window.parent` 的消息被忽略；`{ type: 'proto:goto', slug: 'me' }` 让页面跳到 `me`。
- [ ] **Step 2:** 运行测试，确认失败。
- [ ] **Step 3:** 实现。
  - `proto.css`：实现 spec 第 6.1 节列出的组件类，两种布局 `body.phone` / `body.desktop`，6 套主题变量，约 30 个图标（CSS `mask` 加 `data:` SVG），`ph-img`、`avatar`，标注模式下的虚线框和说明卡、页面地图浮层，`#proto-toast`。
  - `proto.js`：整个脚本包在一个 IIFE 里。启动时读取 `#proto-data`，生成导航（手机模式是底部 Tab 栏，桌面模式是侧边栏，导航项来自 `outline.nav`）和顶部标题栏，然后处理 spec 第 6.2、6.3、6.4 节的全部行为。
  - 导出的文件里，右下角固定一个「标注」开关按钮。外层页面通过 `proto:notes` 消息控制时，这个按钮隐藏（`body.embedded`）。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(proto): 原型外壳与文档拼装`。

---

### Task 5: 提示词与首次生成

**Files:**
- Create: `packs/proto/prompts.ts`、`packs/proto/runner.ts`
- Modify: `packs/memory/events.ts`（`EventKind` 加上 `'proto_create' | 'proto_revise'`，并都加入 `PM_EVENT_KINDS`）
- Test: `packs/proto/runner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `store`，Task 2 的 `sanitizeHtml`，Task 3 的 `parseOutline`、`extractPage`，Task 4 的 `assemble`（检查整份文档大小），`EventInput`、`fence`（`packs/memory/events.ts`），`LlmPort`（`packs/pm/ingest.ts`）
- Produces（`prompts.ts`，都返回 `ChatMessage[]`）：
  - `outlinePrompt(title: string, prd: string)`
  - `pagePrompt(o: Outline, page: OutlinePage, prd: string, x?: { current?: string; change?: string; retry?: boolean })`
  - `planPrompt(o: Outline, summaries: { slug: string; title: string; text: string }[], request: string)`（Task 6 使用）
  - `COMPONENT_GUIDE: string`：组件类名和交互属性的写法说明，必须和 Task 4 的 `proto.css`、`proto.js` 一致；页面提示词里要求「只输出一个 `<main>…</main>`，不写 `<script>`、`<style>`、`href`、`src`、`on*`」。
- Produces（`runner.ts`）：
  - `class ProtoRunner`，构造参数为 `(db: DB, llm: LlmPort, deps: { prd: (reviewId: number, n: number) => { title: string; content: string; status: string } | null; onEvent?: (e: EventInput) => void; log?: (s: string) => void; limits?: Partial<typeof PROTO_LIMITS> })`
  - `generate(reviewId: number, versionN: number): ProtoMeta` —— 同步完成检查并写入 `running` 行，后台开始执行，然后立即返回。
    - `!llm.enabled` → 503「未配置模型，无法生成原型」。
    - `prd()` 返回 `null` → 400「文档版本不存在」。
    - 评审的 `status` 不是 `done` → 409「评审还没完成」。
  - `idle(): Promise<void>` —— 等所有任务（包括排队中的）结束，供测试使用。

- [ ] **Step 1: 写失败的测试**。桩模型按提示词内容分派：包含「原型大纲」时返回大纲 JSON，否则当作页面请求，返回 `<main><div class="card">{slug}</div></main>`。用 `limits` 把并发、时限调小。
  - 成功：生成后 `idle()`，版本 1 的状态为 `done`；每页都有 HTML，`progress` 为 `{ stage: 'pages', done: 3, total: 3 }`；`onEvent` 收到一条 `proto_create`，`refType: 'review'`，`summary` 为「生成原型：律审通，3 页」。
  - 页面并发：桩模型记录同时进行的调用数，最大值不超过 `pageConcurrency`（设为 2）。
  - 截断后重试：某页第一次返回 `<main><div>`，第二次正常返回；该页成功，第二次调用的提示词里包含「上次输出过长被截断」。
  - 部分失败：某页两次都抛错，版本状态为 `done`，该页 `error` 不为空、`html` 为空；全部页面都失败时，状态为 `error`，`error === '页面生成失败，请重试'`。
  - 模型写的脚本：页面返回 `<main><script>x</script><div onclick="y">ok</div></main>`，入库的 HTML 为 `<div>ok</div>`。
  - 大纲失败：两次都返回非 JSON，状态为 `error`，`error === '原型规划失败，请重试'`。
  - 总时限：`taskMs` 设为 50；某页的桩永不返回，状态为 `done`（其他页成功），该页的 `error === '超时'`。
  - 评审被删：页面生成过程中删掉评审，任务结束时不抛错、不写库，也不发事件。
  - 全站排队：`globalTasks` 设为 1，两个评审同时调用 `generate`，第二个的 `progress.stage` 先是 `queued`，之后两个都成功。
  - 第二次 `generate` 时同一评审已有 `running`，抛 409。
  - 前置检查：`llm.enabled` 为 `false` 时抛 503；版本不存在时抛 400；评审不是 `done` 时抛 409。
  - PRD 截断：传进大纲提示词的 PRD 不超过 12000 字，超出时提示词里有「后文已截断」。
- [ ] **Step 2:** 运行测试，确认失败。
- [ ] **Step 3:** 实现。
  - 大纲调用的参数：`{ json: true, maxTokens: outlineTokens, temperature: 0.4, timeoutMs: outlineTimeoutMs }`；页面调用的参数：`{ maxTokens: pageTokens, temperature: 0.5, timeoutMs: pageTimeoutMs }`。
  - 页面并发用一个简单的信号量；总时限用 `Promise.race` 加定时器，到点后，还没开始和还没结束的页面都记为「超时」。
  - 每完成一页，就调用 `savePages` 和 `setProgress`；任何一次 `store` 写入返回 `false`，都视为评审已被删除，直接结束。
  - 拼装后的文档超过 `docBytes` 时，状态为 `error`「原型过大，请减少页面」。
  - 事件的 `payload` 为 `{ request, note, pages: 页面标题数组 }`。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(proto): 原型首次生成`。

---

### Task 6: 对话修改、重试与按新 PRD 重新生成

**Files:**
- Modify: `packs/proto/runner.ts`
- Test: `packs/proto/runner.test.ts`（追加）

**Interfaces:**
- Consumes: `parsePlan`（Task 3）、`planPrompt`（Task 5）、`textOf`（Task 2）
- Produces（`ProtoRunner` 新增）：
  - `revise(reviewId: number, fromN: number, text: string): ProtoMeta` —— 检查顺序：模型（503，同 `generate`）→ 文字长度 → 版本状态。
    - `text` 去掉首尾空白后为 1–1000 字，否则抛 400「修改要求需在 1–1000 字之间」。
    - 第 `fromN` 版不存在：404「原型版本不存在」。
    - 该版是 `running`：409「请等生成完成」；是 `error`：409「这一版生成失败，请先重试」。
  - `retry(reviewId: number, n: number): ProtoMeta` —— 调用 `restart` 之后，按这一版的 `from_n` 决定：为空就重跑首次生成，否则用同样的 `request` 重跑修改。

- [ ] **Step 1: 写失败的测试**（桩模型在提示词包含「修改要求」时返回改动计划）
  - 只重新生成计划里的页面：对 v1（3 页）提修改，计划只列出 `login`，结果 v2 的另外两页 `html` 和 v1 完全相同，页面调用只发生一次；v2 的 `from_n === 1`，`request` 为原文，`note` 为计划里的 `note`；事件为 `proto_revise`，`summary` 为「修改原型：」加上要求的前 60 字。
  - 新增和删除页面：新大纲删掉 `me`、新增 `pay`，v2 里没有 `me`，`pay` 是新生成的。
  - 基于旧版本修改：先有 v1、v2，再对 v1 提修改，得到 v3，`from_n === 1`，没改的页面和 v1 相同。
  - 计划超过 10 页时，v2 的状态为 `error`，`error` 为「改动太大，建议按新 PRD 重新生成」。
  - 计划的 JSON 两次都解析失败时，`error` 为「没理解修改要求，请换个说法」。
  - 计划提示词里每页只带不超过 300 字的摘要；修改要求经过 `fence`（要求里写 `</request>` 时，提示词里不会出现原样的 `</request>`）。
  - 前置检查：文字长度、版本不存在、对 `running`/`error` 版本提修改，分别报出上面三种文案。
  - `retry`：失败的修改版本重试后成功，`n` 不变，`from_n` 和 `request` 也不变；失败的首次生成版本重试时，重新走大纲；对 `done` 版本重试抛 409。
  - 按新 PRD 重新生成：在已有 v1 的情况下调用 `generate(reviewId, 2)`，得到 v2，`from_n` 为 `null`，`base_version_n === 2`，`request` 为「按 PRD v2 重新生成」。
- [ ] **Step 2:** 运行测试，确认失败。
- [ ] **Step 3:** 实现。计划调用的参数：`{ json: true, maxTokens: outlineTokens, temperature: 0.3, timeoutMs: outlineTimeoutMs }`；`progress.stage` 先是 `plan`，再是 `pages`（`total` 为要重新生成的页数）。被修改页面的提示词里，带上这一页当前的 HTML 和 `change`。
- [ ] **Step 4:** 运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(proto): 对话修改与重试`。

---

### Task 7: 接口与服务接线

**Files:**
- Create: `apps/server/proto-api.ts`
- Modify: `apps/server/main.ts`（构造 `ProtoRunner`；在 `/api/pm/` 路由之前调用 `handleProtoApi`；新增 `/proto/:id/:n` 页面路由；启动时调用 `recover`）、`apps/server/http.ts`（`STATIC` 加上 `/proto-panel.js`、`/proto-full.js`）
- Create: `apps/server/public/proto-full.html`（本任务只放最小骨架，Task 8 补全）
- Test: `/tmp/opc-proto-api.sh`（参照 `/tmp/opc-kb-api.sh`：临时数据目录、随机端口、不配置模型）

**Interfaces:**
- Consumes: `ProtoRunner`（Task 5、6），`listVersions`、`getVersion`、`recover`（Task 1），`assemble`、`protoCsp`、`protoFileName`（Task 4），`pm.version`、`pm.get`
- Produces:
  - `handleProtoApi(deps: { db: DB; runner: ProtoRunner }, req, res, method: string, url: URL): Promise<boolean>`，只处理 `/api/pm/reviews/:id/prototypes` 开头的路径，`ProtoError` 映射成同状态码的 `HttpError`。
  - 接口和返回值见 spec 第 9 节：`POST` 返回 `202 { prototype: ProtoMeta }`；`GET` 列表返回 `{ prototypes: ProtoMeta[] }`。
  - `GET …/:n/html` 的响应头：`content-type: text/html; charset=utf-8`、`content-security-policy: protoCsp(false)`、`x-frame-options: SAMEORIGIN`、`cache-control: no-store`。带 `download=1` 时加 `content-disposition: contentDisposition(protoFileName(row), false)`。`device` 参数只接受 `phone`、`desktop`，其他值忽略。版本不是 `done` 时返回 409「原型还没生成完成」。
  - `/proto/:id/:n`：未登录时 302 到 `/login`；版本不存在时 404；否则返回 `proto-full.html`，响应头同静态页。
  - `main.ts` 里 `deps.prd = (id, n) => { const v = pm.version(id, n); const r = v && pm.get(id); return v && r ? { title: r.input, content: v.content, status: r.status } : null }`，`onEvent` 接到现有的 `record()`。

- [ ] **Step 1: 写失败的接口检查**（`/tmp/opc-proto-api.sh`）。预先插入：评审 #7（`done`，PRD v1），以及评审 #7 的原型 v1（`done`，2 页，产品名 `律/审"通`）。检查：
  - 不登录访问列表返回 401；登录后返回 200，`prototypes` 长度为 1。
  - `POST` 生成接口不带 `Origin` 时返回 403；带 `Origin` 时返回 503「未配置模型，无法生成原型」。
  - `POST …/1/revise` 发送 `{"text":""}` 返回 503（模型检查在前）。
  - `GET …/1/html` 返回 200，CSP 头包含 `script-src 'sha256-`，`X-Frame-Options` 为 `SAMEORIGIN`，正文里有 `<meta http-equiv="Content-Security-Policy"`。
  - `GET …/1/html?download=1` 的 `Content-Disposition` 为 `attachment`，`filename*` 解码后为 `律审通-原型-v1.html`。
  - `GET …/9/html` 返回 404；评审 #99 的列表返回 404「评审不存在」。
  - 其他接口的 `X-Frame-Options` 仍然是 `DENY`。
  - `/proto/7/1` 未登录时 302，登录后 200；`/proto/7/9` 返回 404。
  - 服务启动前先把一个版本设为 `running`，启动后它变为 `error`，`error` 为 `服务重启，生成中断，请重试`。
- [ ] **Step 2:** 运行 `bash /tmp/opc-proto-api.sh`，确认失败。
- [ ] **Step 3:** 实现。评审不存在时，列表和生成接口都返回 404「评审不存在」。
- [ ] **Step 4:** 运行 `bash /tmp/opc-proto-api.sh`，期望全部 PASS；再运行 `/tmp/opc-check.sh`，期望全部通过。
- [ ] **Step 5:** 提交 `feat(server): 原型接口与全屏页路由`。

---

### Task 8: 前端：原型面板与全屏页

**Files:**
- Create: `apps/server/public/proto-panel.js`、`apps/server/public/proto-full.js`；补全 `apps/server/public/proto-full.html`
- Modify: `apps/server/public/app.js`（`import { initProto } from './proto-panel.js'`；在 `renderReview` 里把面板插在 `renderDoc(r)` 和 `renderThread(r)` 之间）、`apps/server/public/style.css`（面板、设备框、工具栏样式）
- Test: `/tmp/opc-ui-sim.mjs`（追加）

**Interfaces:**
- Consumes: Task 7 的接口和消息格式（spec 第 6.4 节）
- Produces:
  - `initProto({ h, api, toast }): { panel(review: ReviewView, viewN: number): HTMLElement }`
  - **Review Focus 3**：`panel()` 对同一个 `review.id` 每次都返回同一个元素，只更新里面依赖 PRD 版本的部分（「按 PRD vN 生成」的说明、PRD 更新提示条），iframe 不重建。换成另一个评审时才新建元素。
  - 轮询：只在当前评审有 `running` 版本时，每 2 秒请求一次列表；`panel()` 换到别的评审后，旧评审的轮询停止。
  - iframe：`sandbox="allow-scripts"`，`src` 为 `/api/pm/reviews/:id/prototypes/:n/html?device=…`。`message` 监听只处理 `event.source === iframe.contentWindow` 的消息；`slug` 必须在当前版本的页面列表里。

- [ ] **Step 1: 写失败的 UI 模拟**。模拟环境需要补上：`window.addEventListener`、iframe 的 `contentWindow` 桩（记录收到的 `postMessage`），以及派发 `message` 事件的工具函数。断言：
  - 还没有原型时，面板里有「生成原型」按钮，说明文字里有「PRD v1」；点击后 `POST /api/pm/reviews/8/prototypes`，请求体为 `{ versionN: 1 }`。
  - 生成中时，显示「页面 2/5」；轮询到 `done` 后，出现 iframe，`src` 里有 `/prototypes/1/html`，iframe 带 `sandbox="allow-scripts"`。
  - 版本切换：有 v1、v2 时，点 v1 后 iframe 的 `src` 换成 v1；在修改框里输入「加微信登录」并提交，`POST …/1/revise`，请求体为 `{ text: '加微信登录' }`。
  - 失败版本标红，点「重试」后 `POST …/2/retry`。
  - 来自 iframe 的 `{ type: 'proto:page', slug: 'detail' }` 让页面下拉框变成 `detail`；来源不是这个 iframe，或者 `slug` 不存在时，下拉框不变。选择下拉框后，iframe 收到 `{ type: 'proto:goto', slug }`；打开「标注」开关后，iframe 收到 `{ type: 'proto:notes', on: true }`。
  - 切换到「桌面」后，iframe 的 `src` 里有 `device=desktop`。
  - PRD 已更新（`base_version_n: 1`，`review.latest: 2`）时，显示「原型基于 PRD v1，PRD 已更新到 v2」，点「按新 PRD 重新生成」后，请求体为 `{ versionN: 2 }`。
  - 「下载」链接是 `…/html?download=1`；「全屏」链接是 `/proto/8/1`。
  - **Review Focus 3**：连续两次调用 `renderReview`（同一个评审），面板元素和 iframe 元素都还是原来那一个（`===`）。
- [ ] **Step 2:** 运行 `bash /tmp/opc-check-ui.sh`，确认新增的断言失败。
- [ ] **Step 3:** 实现。
  - 预览框：手机模式是 390×844 的设备框；桌面模式下 iframe 宽 1280，用 `transform: scale(容器宽 / 1280)` 缩放，容器宽度变化时（`resize`）重新计算缩放比例。
  - `proto-full.js`：从 `location.pathname` 里取出 id 和 n，请求列表拿到版本信息，工具栏按 spec 第 10.2 节实现，消息处理规则和面板一致。
- [ ] **Step 4:** 运行 `bash /tmp/opc-check-ui.sh`，期望 `ALL PASS`、`# fail 0`、`TSC_OK`。
- [ ] **Step 5:** 提交 `feat(web): 原型面板、预览与全屏页`。

---

### Task 9: 文档、审查与上线

- [ ] **Step 1:** README 新增「原型」一节，内容按 spec 第 13 节。提交 `docs: 原型说明`。
- [ ] **Step 2:** 整体审查。派一个只读子代理审查 `main..feat/proto`，对照 spec 和本计划的 Review Focus 逐项检查，重点看：清理器有没有绕过办法、CSP 和 sandbox 有没有缺口、`postMessage` 的来源校验、任务状态的并发竞争、评审删除后的写库行为、大文档的性能。审查发现的问题修复后，把 `/tmp/opc-check.sh`、`/tmp/opc-check-ui.sh`、`/tmp/opc-proto-api.sh` 都重新跑一遍。
- [ ] **Step 3（需确认）:** 合并并上线。
  1. 运行 `git merge --ff-only feat/proto`；
  2. 执行 `VACUUM INTO 'data/opc.db.bak-pre-proto'`，把备份文件权限改为 600；
  3. 运行 `systemctl restart opc-agent`；
  4. 确认 `user_version` 为 8，日志里没有报错。
- [ ] **Step 4:** 真实冒烟测试。用临时会话，拿线上的一个 PRD 评审（如果没有，就先建一个「写 PRD 初稿」评审）：
  1. 生成原型，记录耗时和 token 用量（按服务日志或提示词长度估算）；
  2. 修改一轮，确认只有相关的页面变了；
  3. 下载，检查文件里有 `<meta>` CSP，没有模型写的 `<script>`；
  4. 用 `curl` 检查 html 接口的响应头。

  测试完删除测试数据（原型、测试评审、相关事件和记忆变更）和临时会话，删除前先备份。
- [ ] **Step 5:** 清理：删除工作区和 `feat/proto` 分支，把检查脚本的路径改回 `/opt/opc-agent`，然后用中文汇报结果，并请用户在浏览器里确认视觉效果。

---

## Self-Review 记录

- **Spec 覆盖**：
  - 第 2 节：Task 1–8；
  - 第 3 节：Task 1；
  - 第 4 节：Task 5（4.4 节的重启恢复在 Task 1、Task 7）；
  - 第 5 节：Task 2；
  - 第 6 节：Task 4；
  - 第 7 节：Task 4、Task 7；
  - 第 8 节：Task 6；
  - 第 9 节：Task 7；
  - 第 10 节：Task 8；
  - 第 11 节：Task 1（`PROTO_LIMITS`）；
  - 第 12 节：各任务的测试；
  - 第 13 节：Task 9。
- **类型一致性**：`ProtoRow`、`ProtoMeta`、`Outline`、`ProtoPage`、`Progress` 只在 Task 1 定义；`tokenize` 在 Task 2 定义，Task 4 的测试使用；`planPrompt` 在 Task 5 定义，Task 6 使用；`LlmPort` 复用 `packs/pm/ingest.ts` 里的定义。
- **Review Focus**：5 条都已加到对应任务的测试里（Task 2、4、4、8、3）。
