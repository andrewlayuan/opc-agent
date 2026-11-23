# 知识库：查询扩写、批量导入、导出整库 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 评审 / 追问 / 页面智能搜索时用 DeepSeek 扩写检索词补召回；页面支持多文件与整个文件夹导入；一键导出整个知识库为 zip。

**Architecture:** 新增 `packs/kb/expand.ts`（扩写 + 缓存 + 每日次数，迁移 15），召回与搜索函数加可选 `extra` 检索词；`packs/kb/folders.ts` 加 `ensureFolders`；新增 `packs/kb/export.ts` 复用 `ZipWriter`。前端改 `kb.js`，产品顾问取知识库改为异步。

**Tech Stack:** Node 22 + TypeScript（`--experimental-strip-types` 直接运行）、`node:sqlite`、`node:test`、原生 JS 前端；无第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-24-kb-expand-import-export-design.md`

## Global Constraints

- 不引入第三方依赖；模型只走 `packages/core/llm.ts` 的 `Llm`。
- 迁移只追加在 `packages/core/db.ts` 的 `MIGRATIONS` 末尾，本期为 15；所有断言 `user_version` 为 14 的测试改为 15（8 个文件：`packs/pm/attachments.test.ts`、`packs/memory/migrate.test.ts`、`packs/memory/skills.test.ts`、`packs/kb/migrate.test.ts`、`packs/proto/store.test.ts`、`packs/wiki/migrate.test.ts`、`packs/compliance/store.test.ts`、`packs/growth/platforms.test.ts`），`packs/pm/pm.test.ts:218` 的 DROP 列表补上新表。
- SQL 一律参数绑定；FTS 短语双引号转义；`LIKE` 用 `ESCAPE '\'` 并转义 `\ % _`。
- 提示词中的用户 / 资料文本经 `fence()`（`packs/memory/events.ts`）。
- 前端用户 / 模型文本只经 `textContent` 或 `h(..., { text })`。
- 错误文案固定中文；`KbError(status, msg)` 映射为同状态码。
- 环境变量：`OPC_KB_EXPAND`（`off` 关闭，默认开）、`OPC_KB_EXPAND_DAILY_CALLS`（默认 100，范围 0–10000，0 等同关闭）。
- 数值（设计原文）：扩写最多 12 个、每个 2–20 字；标题最多 200 个、每个截 40 字；问题截 400 字；缓存 7 天、最多 2000 条；调用记录留 30 天；评审超时 8 秒、智能搜索 15 秒；两字词 LIKE 补查最多 8 个（kb_chunks 50 行、Wiki 20 行）；扩写词每命中一个 +2 分；批量一次最多 500 个文件、并发 3、轮询 2 秒、`ids` 最多 100 个；`/folders/ensure` 最多 500 条路径、每条 ≤400 字；导出上限 1.5GB；文件名最长 80 码点。
- 每个任务：先写测试并确认失败 → 实现 → 相关测试通过 → `sh /tmp/opc-check-ui.sh` 输出 `ALL PASS`、`# fail 0`、`TSC_OK` → 提交（作者 `andrewlayuan <andrewlayuan@users.noreply.github.com>`）。
- 分支：`feat/kb-expand-import-export`，完成后快进合并到 main。

## Review Focus

1. 同一问题被评审与追问同时扩写（并发两次 `expand`）→ 只调用一次模型，两边拿到同一结果。Task 1 加测试。
2. 模型返回的检索词含 `"`、`*`、`NEAR`、`OR`、`%`、`_` 等 FTS / LIKE 特殊字符 → 不报错、不变成通配，只按字面匹配。Task 2 加测试。
3. 问题只有标点 / 表情，或超过 400 字 → 不调模型（或截断后调）、不抛错，召回与现在一致。Task 1 加测试。
4. 拖入的文件夹里有只差大小写的同级目录名（`Docs` 与 `docs`）→ 导出时同一目录下按忽略大小写去重为 `docs (2)`，解压到 Windows / macOS 不互相覆盖。Task 6 加测试。
5. 导入的文件直接位于被拖入文件夹的根部（相对目录为空字符串）→ 映射到当前选中的目标文件夹，而不是「未归类」。Task 4 加测试。

---

### Task 1：迁移 15 与查询扩写（`packs/kb/expand.ts`）

**Files:**
- Modify: `packages/core/db.ts`（追加迁移 15）、`packages/core/config.ts`（两个配置项）、上面列出的 8 个 `user_version` 测试与 `packs/pm/pm.test.ts:218`
- Create: `packs/kb/expand.ts`、`packs/kb/expand.test.ts`

**Interfaces:**
- Produces:
  - `EXPAND = { max: 12, termMin: 2, termMax: 20, titles: 200, titleChars: 40, queryChars: 400, ttlMs: 7 * DAY, cacheMax: 2000, callsKeepMs: 30 * DAY, timeoutMs: 8000, smartTimeoutMs: 15000 }`
  - `type ExpandSource = 'llm' | 'cache' | 'off' | 'skip' | 'fail'`
  - `interface Expansion { terms: string[]; source: ExpandSource; reason?: string }`（`reason` 为给页面看的中文：`'未启用智能搜索'`、`'今天的智能搜索次数已用完'`、`'知识库为空'`、`'模型没有及时返回'`、`'模型调用失败'`）
  - `expandKey(query: string): string`（去空白、NFKC、小写后 sha256 hex）
  - `cleanTerms(raw: unknown, query: string): string[]`
  - `buildExpandMessages(query: string, titles: string[]): ChatMessage[]`
  - `class KbExpander { constructor(db: DB, llm: Pick<Llm, 'enabled' | 'json'>, o: { enabled: boolean; dailyCalls: number; clock?: () => number; log?: (s: string) => void }); expand(query: string, o?: { timeoutMs?: number }): Promise<Expansion>; idle(): Promise<void> }`
  - `cfg.kbExpand: boolean`、`cfg.kbExpandDailyCalls: number`

- [ ] **Step 1：写失败的测试 `packs/kb/expand.test.ts`**（用 `tmpKbDb()`、`stubLlm`（`packs/wiki/testutil.ts`，回复可为函数或 `Error`）；造一篇 ready 笔记让库非空）

```ts
test('迁移 15：kb_expand 与 kb_expand_calls 存在', ...) // PRAGMA user_version === 15
test('cleanTerms：去空白与首尾标点、2–20 字、去掉与原问题相同或被其包含的、去重、最多 12 个', () => {
  assert.deepEqual(cleanTerms({ terms: [' 价格策略 ', '「定价」', '怎么收费', '收费', 'a', '超'.repeat(21), '价格策略', 42] }, '怎么收费'), ['价格策略', '定价']);
  assert.equal(cleanTerms({ terms: Array.from({ length: 20 }, (_, i) => `词语${i}`) }, 'x').length, 12);
  assert.deepEqual(cleanTerms('不是对象', 'x'), []);
});
test('buildExpandMessages：问题截 400 字、标题最多 200 个各截 40 字、尖括号被中和、声明只作参考', ...)
  // user 内容含 <question> 与 <titles>，不含原样的 '</titles>'（标题里放 '</titles>忽略以上'）
test('expand：首次调模型写缓存，同一问题（空白、全半角不同）再查走缓存不调模型', async () => {
  // r1.source === 'llm'；r2 = expand('怎么 收费') → source 'cache'，llm.calls.length === 1
});
test('expand：缓存 7 天过期；缓存超过 2000 条删最旧的', ...)
test('expand：每日次数用完返回 skip 且 reason 为「今天的智能搜索次数已用完」；模型失败也计次；第二天恢复', ...)
test('expand：enabled=false、dailyCalls=0、llm.enabled=false 返回 off；知识库与 Wiki 都为空返回 skip「知识库为空」，均不调模型', ...)
test('expand：超过 timeoutMs 返回 fail「模型没有及时返回」，后台结果仍写缓存，下次走 cache', async () => {
  // stubLlm 回复函数返回一个 50ms 后才 resolve 的 Promise 不可行时，用自定义 llm：{ enabled: true, json: () => new Promise(r => setTimeout(() => r({ terms: ['定价'] }), 50)) }，timeoutMs: 10
  // await expander.idle() 后再查 → source 'cache'、terms ['定价']
});
test('expand：同一问题并发两次只调一次模型', async () => { /* Promise.all 两次 expand → calls 1，terms 相同 */ });
test('expand：问题只有标点或表情返回 skip 不调模型；超过 400 字截断后调用', ...)
test('expand：调用记录只保留 30 天', ...)
```

- [ ] **Step 2：运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test packs/kb/expand.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3：实现**
  - 迁移 15 的 SQL 照抄设计 2.3（`kb_expand`、`kb_expand_calls`、索引 `kb_expand_calls_at`）。
  - `config.ts`：`kbExpand: process.env.OPC_KB_EXPAND?.trim().toLowerCase() !== 'off'`，`kbExpandDailyCalls: int('OPC_KB_EXPAND_DAILY_CALLS', 100, 0, 10000)`。
  - 提示词文案照抄设计 2.2；`llm.json(messages, 400)`。
  - 「问题只有标点或表情」：`recallTerms(query)` 为空且去掉 `\p{P}\p{S}\s` 后不足 2 个码点 → `skip`（reason `'问题太短'`）。
  - 「当天」：本地时区 0 点（`new Date(now); setHours(0,0,0,0)`）。
  - 并发合并：`Map<key, Promise<Expansion>>`，模型调用结束（成功或失败）后删除；超时只影响本次返回值，后台 promise 继续，`idle()` 等待所有进行中的调用。
  - 标题来源：`SELECT title FROM kb_docs WHERE status = 'ready' ORDER BY updated_at DESC LIMIT 200` 加 `folderPaths(db)` 的路径，合计取前 200。库空判断：`kb_docs` 无 ready 且 `wiki_pages` 无 `deleted = 0`。
- [ ] **Step 4：运行通过**：上面的命令 PASS；再跑 `sh /tmp/opc-check-ui.sh`。
- [ ] **Step 5：提交** `feat(kb): 查询扩写：缓存、每日次数、超时兜底，迁移 15`

### Task 2：召回与搜索支持扩写词（`packs/kb/search.ts`、`packs/wiki/recall.ts`）

**Files:**
- Modify: `packs/kb/search.ts`、`packs/wiki/recall.ts`
- Test: `packs/kb/search.test.ts`、`packs/wiki/recall.test.ts`

**Interfaces:**
- Consumes: 无（扩写词由调用方传入）
- Produces:
  - `recallKb(db, query, o = { limit, perDoc, budget }, extra: string[] = [])`（新增第 4 参数，其余不变）
  - `searchKb(db, q, limit = 50, extra: string[] = [])`
  - `recallWiki(db, query, extra: string[] = [])`（Wiki 未命中时调用 `recallKb(db, query, undefined, extra)`）
  - `extraScore(hay: string, extra: string[]): number`（段落中出现的扩写词个数，小写比较），`export` 供两个文件共用

- [ ] **Step 1：写失败的测试**

```ts
// search.test.ts
test('recallKb：问「怎么收费」原方式召回为空；扩写给出「价格」「定价策略」后召回「价格策略」段落', () => {
  // 造笔记「价格策略」正文「我们按席位定价，每席每月 99 元……」
  assert.equal(recallKb(db, '怎么收费').refs.length, 0);
  assert.equal(recallKb(db, '怎么收费', undefined, ['价格', '定价策略']).refs[0].title, '价格策略');
});
test('recallKb：两字扩写词经 LIKE 补候选（原问题三元组一个都不中时也能召回）', ...)
test('recallKb：extra 为空时结果与不传逐条一致', ...)
test('recallKb：扩写词含 " * NEAR OR % _ 不报错且只按字面匹配', () => {
  // extra ['"价格"', '价*', 'NEAR', 'a OR b', '100%', '_x'] → 不抛错；'100%' 不匹配正文里的 '1000'
});
test('searchKb：传 extra 时「怎么收费」能找到「价格策略」，每篇一条', ...)
// recall.test.ts
test('recallWiki：扩写词命中 Wiki 页面；Wiki 未命中时把 extra 传给 recallKb', ...)
```

- [ ] **Step 2：运行确认失败**：`node --disable-warning=ExperimentalWarning --test packs/kb/search.test.ts packs/wiki/recall.test.ts` → 新用例 FAIL
- [ ] **Step 3：实现**（规则照设计 2.4）
  - FTS 候选：`[...terms, ...extra.filter(t => len(t) >= 3)]` 各自加引号 OR 连接。
  - 两字词：`extra.filter(t => len(t) === 2).slice(0, 8)`，一条 SQL：`... WHERE d.status='ready' AND (c.body LIKE ? ESCAPE '\' OR c.heading LIKE ? ESCAPE '\' OR d.title LIKE ? ESCAPE '\' OR ...) LIMIT 50`，与 FTS 候选按 `doc_id:ord` 去重合并（LIKE 来的 rank 排在 FTS 之后）。
  - 分数 `hits + 2 * extraScore`；门槛 `hits >= minHits || extraScore >= 1`；排序分数降序再 rank。
  - `searchKb` 传了 `extra` 时：FTS 短语 OR 结果后追加扩写候选（同上），按分数重排后每篇取一段；`snippet` 无 FTS 片段时用 `likeSnippet(body, 命中的第一个扩写词)`。
- [ ] **Step 4：运行通过** + `sh /tmp/opc-check-ui.sh`
- [ ] **Step 5：提交** `feat(kb): 召回与搜索接受扩写词：两字词补查、+2 分、命中一个即相关`

### Task 3：接入评审与页面智能搜索

**Files:**
- Modify: `packs/pm/advisor.ts`（`AdvisorHooks.kb`、`userContext`、`kbContext`、两处调用）、`apps/server/main.ts`、`apps/server/kb-api.ts`、`apps/server/public/kb.js`、`apps/server/public/style.css`
- Test: `packs/pm/pm.test.ts`、新建 `apps/server/kb-api.test.ts`（照 `apps/server/memory-api.test.ts:37` 起临时服务器的写法）、`/tmp/opc-ui-sim.mjs`

**Interfaces:**
- Consumes: `KbExpander.expand`（Task 1）、`recallWiki(db, q, extra)` / `searchKb(db, q, limit, extra)`（Task 2）
- Produces:
  - `AdvisorHooks.kb?: (query: string) => Promise<{ text: string; refs: KbRef[] }> | { text: string; refs: KbRef[] }`
  - `KbApiDeps` 增加 `expander?: Pick<KbExpander, 'expand'>`、`tmpDir: string`（Task 6 用）
  - `GET /api/kb/docs?q=…&smart=1` → `{ hits, terms: string[], source: ExpandSource, reason?: string }`；不带 `smart` 时响应不变

- [ ] **Step 1：写失败的测试**

```ts
// pm.test.ts
test('知识库：hooks.kb 返回 Promise 时首版与追问都等待并召回', ...)
test('知识库：hooks.kb 异步抛错时评审照常完成，无 kb 引用', ...)
// kb-api.test.ts
test('GET /api/kb/docs?smart=1：返回 terms 与 source；未配置扩写时 source off、hits 为普通结果', ...)
// opc-ui-sim.mjs（新增一组）
// 搜索后出现「没找到想要的？智能搜索」；点击后请求带 smart=1，显示「已按这些说法搜索：价格、定价策略」；
// source 为 skip 时显示 reason，原结果保留
```

- [ ] **Step 2：运行确认失败**
- [ ] **Step 3：实现**
  - `advisor.ts`：`userContext` / `kbContext` 改 `async`，`await this.hooks.kb(query)`；调用点 `packs/pm/advisor.ts:362`、`:793` 加 `await`。
  - `main.ts`：`const kbExpander = new KbExpander(db, radar.llm, { enabled: cfg.kbExpand, dailyCalls: cfg.kbExpandDailyCalls, log: console.log })`；`kb: async (q) => recallWiki(db, q, (await kbExpander.expand(q)).terms)`；`handleKbApi` 传 `expander: kbExpander`。
  - `kb-api.ts`：`smart=1` 时 `expand(term, { timeoutMs: EXPAND.smartTimeoutMs })` 后 `searchKb(db, term, 50, x.terms)`。
  - `kb.js`：搜索结果区底部按钮；结果上方一行 `.kb-smart-terms`。
- [ ] **Step 4：运行通过** + `sh /tmp/opc-check-ui.sh`
- [ ] **Step 5：提交** `feat(kb): 评审召回与页面智能搜索接入查询扩写`

### Task 4：建目录与批量查询接口

**Files:**
- Modify: `packs/kb/folders.ts`、`apps/server/kb-api.ts`、`packs/kb/docs.ts`（如需按 id 列表取 `DocView`，复用 `docViews`）
- Test: `packs/kb/folders.test.ts`、`apps/server/kb-api.test.ts`

**Interfaces:**
- Produces:
  - `ensureFolders(db: DB, parentId: number | null, paths: string[], now?: number): { map: Record<string, number | null>; capped: boolean }`（`''` 映射到 `parentId`）
  - `POST /api/kb/folders/ensure` body `{ parentId: number | null, paths: string[] }` → `200 { map, capped }`
  - `GET /api/kb/docs?ids=1,2,3` → `{ docs: DocView[] }`（最多 100 个；不存在的 id 不返回；非法 400）

- [ ] **Step 1：写失败的测试**

```ts
test('ensureFolders：逐层建、同名复用、空串映射到父目录', () => {
  const r = ensureFolders(db, p, ['', '竞品', '竞品/定价', '竞品/定价']);
  assert.equal(r.map[''], p); assert.equal(r.map['竞品/定价'], 定价id); // 只建 2 个
});
test('ensureFolders：清洗名称（首尾空白、控制字符变空格、超 40 字截断）；. 与 .. 与空段丢弃', ...)
test('ensureFolders：超过 5 层的段不再建，映射到第 5 层', ...)
test('ensureFolders：建到 200 个停止，capped=true，之后的路径映射到已建好的最深一层', ...)
test('ensureFolders：parentId 不存在 404；中途失败整批回滚', ...)
test('POST /api/kb/folders/ensure：501 条路径或单条 401 字 400；GET /api/kb/docs?ids= 超过 100 个 400', ...)
```

- [ ] **Step 2：运行确认失败**
- [ ] **Step 3：实现**：在 `tx` 中逐路径处理（`tx` 来自 `packs/memory/store.ts`），清洗后调用现有 `cleanName`；深度用父目录现有深度 + 已走段数比较 `KB_LIMITS.depth`；总数比较 `KB_LIMITS.folders`。
- [ ] **Step 4：运行通过** + `sh /tmp/opc-check-ui.sh`
- [ ] **Step 5：提交** `feat(kb): 批量建目录与按 id 查询接口`

### Task 5：批量导入页面（`apps/server/public/kb.js`）

**Files:**
- Modify: `apps/server/public/kb.js`、`apps/server/public/index.html`（「导入文件夹」按钮与 `<input id="kb-dir" type="file" webkitdirectory multiple hidden>`）、`apps/server/public/style.css`（`.kb-imp-` 前缀）
- Test: `/tmp/opc-ui-sim.mjs`（需要给模拟器补 `File` 的 `webkitRelativePath` 与拖放 `webkitGetAsEntry` 桩）

**Interfaces:**
- Consumes: `POST /api/kb/folders/ensure`、`GET /api/kb/docs?ids=`（Task 4）；现有 `POST /api/kb/uploads`
- Produces（kb.js 内部，供模拟器直接调用）：
  - `planImport(entries: { name: string; size: number; dir: string; file: File }[], o: { existing: Map<string, Set<string>>; allowDupes: boolean; remaining: number }) → { take: Entry[]; skipped: { hidden: number; type: number; big: number; empty: number; dupe: number; over: number }; images: number }`（`existing` 的 key 为相对目录，值为 `${name}\u0000${size}`）

- [ ] **Step 1：写失败的模拟器用例**
  - 选择 7 个文件（含 `.DS_Store`、`__MACOSX/a.md`、`x.exe`、11MB 的 pdf、0 字节 txt、同名同大小已存在的 `a.md`、正常的 `b/c.png`）→ 摘要文本为「将导入 1 个到〔…〕，跳过 6 个（隐藏文件 2、不支持 1、超过 10MB 1、空文件 1、重复 1），其中 1 张图片需要模型识别」；勾「仍然导入重复文件」后变为导入 2 个。
  - 501 个文件 → 只取 500，提示超出部分。
  - 开始后同时进行的上传请求不超过 3；全部完成前不出现「归类」弹窗。
  - 一个上传返回 415 → 失败列表含原因；点「重试失败的」重新上传该文件。
  - 点「停止」后不再发起新的上传。
  - 根部文件（`dir: ''`）上传时带 `?folder=<当前目录 id>`。
- [ ] **Step 2：运行确认失败**：`PUB=/opt/opc-agent/apps/server/public node /tmp/opc-ui-sim.mjs`
- [ ] **Step 3：实现**
  - 入口：`#kb-dir` change、`#kb-file` 选多个（>1）、知识库页 `drop`（`items[i].webkitGetAsEntry()` 递归 `createReader().readEntries` 直到返回空数组）。单个文件仍走现有 `upload()` + 归类。
  - 支持的扩展名取 `#kb-file` 的 `accept` 属性，避免两份列表。
  - 重复检查（确认前不建任何目录）：用已加载的目录树（`GET /api/kb/tree` 的 `folders`，按 `parent_id` + `name` 逐段查找）把相对目录解析为已有的 folderId；只对已存在的目录调 `GET /api/kb/docs?folder=id` 收集 `file_name/file_size`，不存在的目录不可能有重复。用户确认后才调 `ensure`。模拟器用例补一条：摘要里点「取消」不发 `/folders/ensure`。
  - 进度面板、`beforeunload`、轮询按设计 3.1。
- [ ] **Step 4：运行通过** + `sh /tmp/opc-check-ui.sh`
- [ ] **Step 5：提交** `feat(kb): 多文件与文件夹批量导入`

### Task 6：导出整库（`packs/kb/export.ts`）

**Files:**
- Create: `packs/kb/export.ts`、`packs/kb/export.test.ts`
- Modify: `apps/server/kb-api.ts`（`GET /api/kb/export`）、`apps/server/main.ts`（传 `tmpDir: path.join(cfg.dataDir, 'tmp')`）、`apps/server/public/index.html` / `kb.js`（「导出全部」链接）
- Test: `apps/server/kb-api.test.ts`、`/tmp/opc-ui-sim.mjs`

**Interfaces:**
- Consumes: `KbFiles.file(id)`、`folderPaths(db)`、`refreshStale(db)`、`ZipWriter`（`packs/wiki/zip.ts`）
- Produces:
  - `safeName(raw: string, fallback?: string): string`
  - `csvField(v: string | number | null): string`
  - `exportKb(db: DB, files: Pick<KbFiles, 'file'>, o: { tmpDir: string; max?: number }): { file: string; bytes: number; count: number }`（超限抛 `KbError(413, '导出内容超过 1.5GB，请先删除不需要的大文件后再导出')`）

- [ ] **Step 1：写失败的测试**（解压用 `packs/pm/zip.ts` 的 `openZip`）

```ts
test('safeName：去掉 \\/:*?"<>| 与控制字符、去首尾空白和点、空则「未命名」、最长 80 码点保留扩展名', ...)
test('csvField：逗号引号换行转义；= + - @ 开头加单引号', ...)
test('exportKb：目录结构、未归类在根目录、上传导出原文件逐字节一致、笔记评审资讯为「# 标题」开头的 .md', ...)
test('exportKb：同目录重名（含只差大小写的文件与子目录 Docs / docs）编号为「名称 (2)」', ...)
test('exportKb：原文件缺失时导出正文 .md 并在清单注明「原文件缺失，已导出正文」；error 状态的上传照常导出原文件', ...)
test('exportKb：清单.csv 以 BOM 开头、列为 路径,标题,类型,状态,创建时间,更新时间,原文件名,大小', ...)
test('exportKb：超过 max 抛 413 且临时文件被删除', ...)
test('GET /api/kb/export：200、application/zip、文件名 tianshu-kb-YYYYMMDD.zip，发送后临时文件被删除', ...)
```

- [ ] **Step 2：运行确认失败**
- [ ] **Step 3：实现**：按设计 4.2 / 4.3；目录段与文件名同在一个「目录 → 已用名（小写）」表里去重；时间列用本地时间 `YYYY-MM-DD HH:mm`；路由发送方式照 `apps/server/wiki-api.ts:141-160`。
- [ ] **Step 4：运行通过** + `sh /tmp/opc-check-ui.sh`
- [ ] **Step 5：提交** `feat(kb): 导出整个知识库（原文件 + Markdown + 清单）`

### Task 7：README 与截图核对

**Files:**
- Modify: `README.md`（知识库段落补「智能搜索 / 查询扩写」「批量导入」「导出全部」，环境变量表补 `OPC_KB_EXPAND`、`OPC_KB_EXPAND_DAILY_CALLS`）

- [ ] **Step 1**：改 README。
- [ ] **Step 2**：临时实例（独立数据目录、端口 24182，不碰正式服务）造数据，`agent-browser` 截宽屏 1280 与 390px：导入摘要、进度面板（含失败）、智能搜索结果、工具栏导出按钮；发现的问题就地修复并补模拟器用例。
- [ ] **Step 3**：`sh /tmp/opc-check-ui.sh` 全部通过；清理临时实例与截图脚本产物。
- [ ] **Step 4：提交** `docs(kb): README 智能搜索、批量导入与导出`

完成后：整体审查（只读子代理）→ 修复 → 快进合并 main → 经你确认后停服务备份数据库并重启（迁移到 v15）。
