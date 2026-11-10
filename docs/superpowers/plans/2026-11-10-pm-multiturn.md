# 产品顾问多轮对话、文档版本与下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 首版评审完成后，产品顾问可以在同一会话里多轮追问或改写，支持多个文档版本、手动编辑、下载 Markdown 和打印成 PDF。

**Architecture：**
- 在 `pm_reviews`（会话头）之外，新增 `pm_messages`（对话）和 `pm_versions`（文档版本）两张表。
- 纯逻辑放进新文件 `packs/pm/turn.ts`（输出解析、上下文组装）和 `packs/pm/render.ts`（Markdown 导出、打印页 HTML）。`PmAdvisor` 负责校验、落库和后台执行。
- `main.ts` 只做路由和响应头，前端在现有 `renderReview` 的基础上扩展。

**Tech Stack：** Node ≥22.18，原生 TS 运行，`node:sqlite`，`node:test`，原生 JS 前端，零第三方依赖。

**Spec：** `docs/superpowers/specs/2026-11-10-pm-multiturn-design.md`

## Global Constraints

- 不新增任何第三方依赖；TS 只能用 Node 原生可以剥离的类型语法（不用 enum、namespace、参数属性）。
- 前端只用 `h()` 和 `textContent` 写 DOM，禁止使用 innerHTML；服务端拼的 HTML 必须先经过 `escapeHtml`。
- 所有 SQL 都用 `prepare(...).run/get/all` 绑定参数，禁止拼接用户输入。
- 追问文字限 2–4000 字；手动版本限 1–40000 字；回答不超过 1500 字；变更说明不超过 80 字；改写结果不能少于 200 字。
- 对话历史预算 12000 字；追问时框架说明总预算 20000 字；全局并发 `MAX_RUNNING = 2`（首版和追问合计）。
- 追问的模型调用参数：`maxTokens 8000`，`temperature 0.5`，`timeoutMs 300000`。
- 错误文案与 spec 一致：「首版评审完成后才能继续对话」「上一轮还在进行中」「已有更新的 v{n}」「模型没有返回完整文档」「服务重启，已中断」「根据你的要求修订」。
- 写操作都要登录且同源（沿用现有中间件）；下载文件名只用 `opc-review-{id}-v{n}.md`。
- 每个任务结束时运行 `npm test` 和 `node deepseek-harness/node_modules/.bin/tsc -p /tmp/opc-tsconfig.json`，两者都要零失败。
- **前置条件**：工作区里还有没提交的多选和空白页修复改动，要先单独提交一次（需要用户同意）。只在本地提交，用户要求时才推送。提交身份：`git -c user.name=andrewlayuan -c user.email=andrewlayuan@users.noreply.github.com commit`。
- IDE 编辑工具超时时，改用 `/tmp/opc-patch/lib.mjs` 的 `patch(file, [[old,new],...])` 做精确替换，写完要回读确认。

## Review Focus

1. 有一轮追问还在进行时删除会话：后台写入会因为外键失败或丢数据。期望删除返回 409「上一轮还在进行中」。（Task 3 测试）
2. 模型把改写的文档包在 ```markdown 代码围栏里：期望剥掉外层围栏，不把它当作正文的一部分。（Task 2 测试）
3. 手动保存的内容和最新版完全相同：期望 400「内容没有变化」，不生成空版本。（Task 3 测试）
4. 首版失败（status=error）的会话：期望追问返回 400「首版评审完成后才能继续对话」，UI 不显示输入区和版本栏。（Task 3、Task 6 测试）
5. 轮询期间切换到另一个会话：期望旧会话迟到的响应被丢弃，不覆盖当前视图。（Task 6 UI 模拟）

---

### Task 1：数据迁移、首版写入 v1、启动清理

**Files：**
- Modify：`packages/core/db.ts`（在 `MIGRATIONS` 末尾追加第 4 项）
- Modify：`packs/pm/advisor.ts`（构造函数中的清理逻辑；`run()` 完成时写入 v1）
- Test：`packs/pm/pm.test.ts`

**Interfaces：**
- Produces：表 `pm_messages`、`pm_versions`，字段 `pm_reviews.updated_at`。表结构与 spec 第 2 节的 SQL 逐字一致，回填语句也照搬。
- Produces：首版完成时，在同一事务里执行 `UPDATE pm_reviews SET status='done', content=?, finished_at=?, updated_at=?`，并插入 `pm_versions(review_id, 1, now, 'ai_initial', content)`。

- [ ] **Step 1：写失败测试**

```ts
test('多轮：迁移回填旧评审为 v1，首版完成写入 v1', async () => {
  const { db, advisor, done } = setup({ chat: () => '# 结论\n' + '正文'.repeat(150) });
  const id = advisor.start({ input: '给团队做一个周报自动生成工具', presets: ['idea'], skills: [], useRadar: false });
  await waitDone(advisor, id);
  const v = db.prepare('SELECT n, source, content FROM pm_versions WHERE review_id=?').all(id) as { n: number; source: string; content: string }[];
  assert.equal(v.length, 1);
  assert.equal(v[0].n, 1);
  assert.equal(v[0].source, 'ai_initial');
  assert.match(v[0].content, /^# 结论/);
  assert.ok(Number((db.prepare('SELECT updated_at FROM pm_reviews WHERE id=?').get(id) as { updated_at: number }).updated_at) > 0);
  done();
});

test('多轮：迁移把旧的已完成评审回填为 v1', () => {
  // 先建一个完整的库，再退回 user_version=3 的结构（SQLite 3.51 支持 DROP COLUMN），重新打开时触发第 4 个迁移
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pm-mig-'));
  const file = path.join(dir, 't.db');
  let db = openDb(file);
  db.exec('DROP TABLE pm_messages; DROP TABLE pm_versions; ALTER TABLE pm_reviews DROP COLUMN updated_at; PRAGMA user_version = 3;');
  db.prepare("INSERT INTO pm_reviews(created_at, finished_at, status, mode, input, content) VALUES (1, 2, 'done', 'idea', 'x', '旧内容')").run();
  db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input) VALUES (1, 'error', 'idea', 'y')").run();
  db.close();
  db = openDb(file);
  const v = db.prepare('SELECT review_id, n, source, content, created_at FROM pm_versions').all();
  assert.deepEqual(v.map((x) => ({ ...x })), [{ review_id: 1, n: 1, source: 'ai_initial', content: '旧内容', created_at: 2 }]);
  assert.equal((db.prepare('SELECT updated_at FROM pm_reviews WHERE id=2').get() as { updated_at: number }).updated_at, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多轮：重启时进行中的轮次标记为中断', () => {
  const { db, advisor, done } = setup({});
  const rid = Number(db.prepare("INSERT INTO pm_reviews(created_at, status, mode, input, content) VALUES (1, 'done', 'idea', 'x', 'c')").run().lastInsertRowid);
  db.prepare("INSERT INTO pm_messages(review_id, created_at, role, kind, status) VALUES (?, 1, 'assistant', 'ask', 'running')").run(rid);
  new PmAdvisor(db, advisor.llm, advisor.skills, () => {});
  const m = db.prepare('SELECT status, error FROM pm_messages').get() as { status: string; error: string };
  assert.equal(m.status, 'error');
  assert.equal(m.error, '服务重启，已中断');
  done();
});
```

- [ ] **Step 2：运行测试，确认失败**
  - 命令：`npm test 2>&1 | grep -E "^not ok|# (pass|fail)"`
  - 期望：上面 3 个测试失败，报 no such table: pm_versions。
- [ ] **Step 3：实现迁移与写入**
  - 迁移按 spec 第 2 节的 SQL 照写。
  - `run()` 的最后一条 UPDATE 改为事务（`BEGIN` / `COMMIT` / 出错时 `ROLLBACK`），在里面同时写 v1 和 `updated_at`。
  - 构造函数里，在现有 pm_reviews 清理语句后面追加：`UPDATE pm_messages SET status='error', error='服务重启，已中断', finished_at=? WHERE status='running'`。
- [ ] **Step 4：运行测试，确认全部通过，tsc 无报错**
- [ ] **Step 5：提交**
  - `git add packages/core/db.ts packs/pm/advisor.ts packs/pm/pm.test.ts`
  - 提交信息：`feat(pm): 新增对话与版本表，首版写入 v1`

---

### Task 2：轮次纯函数 `packs/pm/turn.ts`

**Files：**
- Create：`packs/pm/turn.ts`
- Test：`packs/pm/turn.test.ts`（新文件，`npm test` 的 glob 已经覆盖）

**Interfaces：**
- Produces：

```ts
export type TurnMode = 'auto' | 'revise';
export type TurnResult = { kind: 'revise'; doc: string; note: string } | { kind: 'ask'; answer: string };
export interface TurnMsg { role: 'user' | 'assistant'; kind: 'ask' | 'revise'; content: string; status: 'running' | 'done' | 'error' }
export const HISTORY_BUDGET = 12000;
export const TURN_PROTOCOL: string; // 输出协议说明，原文见 spec 3.3
export function normMode(x: unknown): TurnMode;          // 'revise' 原样返回，其他一律视为 'auto'
export function parseTurn(raw: string, mode: TurnMode): TurnResult; // 改写结果少于 200 字时抛出 Error('模型没有返回完整文档')
export function pickHistory(msgs: TurnMsg[], budget?: number): TurnMsg[]; // 去掉 status !== 'done' 的消息，从新往旧累加 content 长度，超出预算就停止，最后按时间正序返回
export function buildTurnMessages(a: {
  system: string; input: string; refsText: string;
  latestN: number; latestDoc: string; history: TurnMsg[]; text: string; mode: TurnMode;
}): { role: 'system' | 'user' | 'assistant'; content: string }[];
```

- `buildTurnMessages` 的顺序按 spec 3.2：
  1. system。
  2. user：原始需求，加上 refsText。
  3. assistant：`当前文档（v{latestN}）：\n\n{latestDoc}`。
  4. history 依次展开。
  5. user：本次输入 text。mode 为 revise 时在末尾追加 `\n\n本轮要求：输出改写后的完整文档`。
- `parseTurn` 处理规则：
  - 先 trim。
  - 标记的正则：`/^[\[【]\s*(改写|回答)\s*[\]】]\s*\n?/`。
  - 改写正文用 `/\n-{3}\s*变更说明\s*-{3}\s*\n/` 切分，前一段是正文，后一段是说明。
  - 正文如果整体被 ```（可带 markdown 或 md 语言标记）包住，剥掉外层围栏。
  - 正文剔除 URL 的规则与首版一致：`/https?:\/\/\S+/g`。
  - 回答截到 1500 字，说明截到 80 字，说明为空时用「根据你的要求修订」。

- [ ] **Step 1：写失败测试**

```ts
const doc = '# 新版\n' + '内容'.repeat(150);
test('parseTurn：改写与回答两种标记，全角与半角方括号都识别', () => {
  assert.deepEqual(parseTurn(`[改写]\n${doc}\n---变更说明---\n重写了定价`, 'auto'), { kind: 'revise', doc, note: '重写了定价' });
  assert.deepEqual(parseTurn('【回答】\n因为滩头市场更小', 'auto'), { kind: 'ask', answer: '因为滩头市场更小' });
});
test('parseTurn：缺少标记时 auto 当回答、revise 当改写；缺少说明时用默认说明', () => {
  assert.equal(parseTurn('直接回答', 'auto').kind, 'ask');
  assert.deepEqual(parseTurn(doc, 'revise'), { kind: 'revise', doc, note: '根据你的要求修订' });
  assert.equal(parseTurn('[回答]\n只是解释', 'revise').kind, 'ask');
});
test('parseTurn：剥掉外层代码围栏、剔除 URL、过短内容视为失败', () => {
  const r = parseTurn('[改写]\n```markdown\n' + doc + ' https://x.com/a\n```\n---变更说明---\n改了', 'auto');
  assert.equal(r.kind, 'revise');
  assert.ok(r.kind === 'revise' && !r.doc.includes('```') && !r.doc.includes('https://'));
  assert.throws(() => parseTurn('[改写]\n太短', 'auto'), /模型没有返回完整文档/);
  assert.equal((parseTurn('[回答]\n' + '长'.repeat(3000), 'auto') as { answer: string }).answer.length, 1500);
});
test('pickHistory：跳过失败和进行中的轮次，超出预算时丢弃最早的', () => {
  const m = (content: string, status: TurnMsg['status'] = 'done'): TurnMsg => ({ role: 'user', kind: 'ask', content, status });
  const out = pickHistory([m('a'.repeat(50)), m('err', 'error'), m('b'.repeat(50)), m('c'.repeat(50)), m('run', 'running')], 120);
  assert.deepEqual(out.map((x) => x.content[0]), ['b', 'c']);
});
test('buildTurnMessages：顺序正确，包含最新版全文，revise 时追加本轮要求', () => {
  const msgs = buildTurnMessages({ system: 'SYS', input: '原始需求', refsText: '[1] 标题', latestN: 3, latestDoc: 'DOC3', history: [], text: '改定价', mode: 'revise' });
  assert.deepEqual(msgs.map((x) => x.role), ['system', 'user', 'assistant', 'user']);
  assert.match(msgs[2].content, /当前文档（v3）[\s\S]*DOC3/);
  assert.match(msgs[3].content, /改定价[\s\S]*本轮要求：输出改写后的完整文档/);
  assert.equal(normMode('revise'), 'revise');
  assert.equal(normMode('rm -rf'), 'auto');
});
```

- [ ] **Step 2：运行测试，确认失败**（找不到模块 `./turn.ts`）
- [ ] **Step 3：按上面的 Interfaces 实现 `turn.ts`**
- [ ] **Step 4：运行测试，确认通过，tsc 无报错**
- [ ] **Step 5：提交**
  - `git add packs/pm/turn.ts packs/pm/turn.test.ts`
  - 提交信息：`feat(pm): 轮次输出解析与上下文组装`

---

### Task 3：`PmAdvisor` 多轮能力（ask、saveManual、version、详情与列表扩展）

**Files：**
- Modify：`packs/pm/advisor.ts`
- Test：`packs/pm/pm.test.ts`

**Interfaces：**
- Consumes：Task 2 的 `parseTurn`、`pickHistory`、`buildTurnMessages`、`normMode`、`TURN_PROTOCOL`、`TurnMsg`。
- Produces（导出自 `advisor.ts`）：

```ts
export class PmError extends Error { status: 400 | 404 | 409; constructor(status: 400 | 404 | 409, message: string) }
export interface MessageView { id: number; created_at: number; role: 'user' | 'assistant'; kind: 'ask' | 'revise'; content: string; version_n: number | null; status: 'running' | 'done' | 'error'; error: string | null }
export interface VersionMeta { n: number; source: 'ai_initial' | 'ai_revise' | 'manual'; created_at: number; note: string | null }
export interface VersionView extends VersionMeta { content: string }
// ReviewView 新增字段：updated_at: number; latest: number; versions: VersionMeta[]; messages: MessageView[]
// content 改为最新版本正文；没有任何版本时为 null，latest 为 0
// list() 每项新增：updated_at、latest（版本数）、turns（user 消息数），按 updated_at DESC 排序
ask(id: number, text: string, mode: unknown): number;          // 返回 assistant 消息 id
saveManual(id: number, content: string, baseN: unknown): number; // 返回新版本号
version(id: number, n: number): VersionView | null;
refs(id: number): ReviewRef[];                                  // 把 get() 里的引用查询抽出来，Task 4 和 Task 5 复用
```

- 校验顺序与错误码，按 spec 3.1 / 3.4：
  - 会话不存在：404「评审不存在」。
  - 模型未启用：400「未配置 DEEPSEEK_API_KEY，无法调用模型」（沿用首版文案）。
  - 首版未完成：400「首版评审完成后才能继续对话」。
  - text 长度不合法：400「请输入 2–4000 字」。
  - 有进行中的轮次：409「上一轮还在进行中」。
  - 并发已满：400，沿用现有文案。
  - `saveManual`：
    - baseN 不是当前最新版本号：409「已有更新的 v{latest}」。
    - 内容和最新版相同：400「内容没有变化」。
    - 长度不合法：400「内容需在 1–40000 字之间」。
- `delete(id)`：存在 running 的消息时，抛出 PmError 409「上一轮还在进行中」。
- 后台执行：
  - system 用 `this.systemPrompt(skills, 20000) + '\n\n' + TURN_PROTOCOL`。现有 `systemPrompt` 增加可选参数 `total = SKILLS_TOTAL_CHARS`。
  - refsText 由 `this.refs(id)` 按现有的 `refLine` 格式拼出。
  - 历史取本会话 id 小于当前 user 消息的所有消息，交给 `pickHistory`。
  - 改写消息放进历史时，content 本身就是说明。
  - 结果在事务中落库：新版本号为 `max(n)+1`，同时更新 `pm_reviews.updated_at`。
  - 失败时 error 截断到 300 字。
  - `this.running` 的计数和首版共用。

- [ ] **Step 1：写失败测试**（在 setup 里做一个 fake chat：取最后一条 user 消息，包含「改」字就返回 `[改写]\n` + 长文档 + `\n---变更说明---\n改了定价`，否则返回 `[回答]\n解释`。辅助函数 `waitTurn(advisor, id)` 轮询，直到不存在 running 的消息。）

```ts
test('多轮：回答不产生版本，改写产生 v2，并以最新版为上下文', async () => {
  const seen: string[] = [];
  const { advisor, done } = setup({ chat: (m) => { seen.push(m.map((x) => x.content).join('\n')); return fakeTurn(m); } });
  const id = await doneReview(advisor);                      // 跑完首版，得到 v1
  advisor.ask(id, '为什么选这个市场？', 'auto'); await waitTurn(advisor, id);
  let r = advisor.get(id)!;
  assert.equal(r.latest, 1);
  assert.equal(r.messages.at(-1)!.kind, 'ask');
  advisor.ask(id, '把定价改成年费', 'auto'); await waitTurn(advisor, id);
  r = advisor.get(id)!;
  assert.equal(r.latest, 2);
  assert.equal(r.versions[1].source, 'ai_revise');
  assert.equal(r.versions[1].note, '改了定价');
  assert.equal(r.messages.at(-1)!.version_n, 2);
  assert.match(seen.at(-1)!, /当前文档（v1）/);
  done();
});
test('多轮：并发、首版未完成、首版失败、长度这些情况都会被拒绝', async () => {
  // 首版 running 时 ask：抛 PmError，status 400，/首版评审完成后才能继续对话/
  // 首版 error 时 ask：同上
  // text='x'：status 400
  // 上一轮还没完成（fake chat 返回一个永远不 resolve 的 Promise）时再次 ask：status 409，/上一轮还在进行中/
  // 此时 delete(id)：status 409
});
test('多轮：手动版本、冲突、内容未变化，之后的追问基于手动版', async () => {
  // saveManual(id, '# 手改\n...', 1) 返回 2，source 为 'manual'
  // saveManual(id, 'x', 1)：status 409，/已有更新的 v2/
  // saveManual(id, 与 v2 相同的内容, 2)：status 400，/内容没有变化/
  // ask 之后 seen.at(-1) 匹配 /当前文档（v2）[\s\S]*# 手改/
});
test('多轮：删除会话时级联删除消息与版本；list 返回 latest/turns', async () => {
  // list()[0] 等于 { latest: 2, turns: 1 }（只断言这两个字段）
  // delete 之后，pm_messages 和 pm_versions 里都没有这个 review_id 的记录
});
```

- [ ] **Step 2：运行测试，确认失败**
- [ ] **Step 3：实现上面的接口**
- [ ] **Step 4：运行全部测试，确认通过，tsc 无报错**（原有 35 个测试也要全过）
- [ ] **Step 5：提交**
  - `git add packs/pm/advisor.ts packs/pm/pm.test.ts`
  - 提交信息：`feat(pm): 多轮追问、改写版本与手动编辑`

---

### Task 4：导出与打印渲染 `packs/pm/render.ts` 和 `print.css`

**Files：**
- Create：`packs/pm/render.ts`、`apps/server/public/print.css`
- Modify：`apps/server/http.ts`（`STATIC` 加入 `'/print.css': { file: 'print.css', type: 'text/css; charset=utf-8' }`）
- Test：`packs/pm/render.test.ts`

**Interfaces：**
- Consumes：`ReviewView`、`VersionView`、`ReviewRef`，来自 Task 3。
- Produces：

```ts
export function escapeHtml(s: string): string;  // 转义 & < > " '
export function exportMarkdown(r: ReviewView, v: VersionView, refs: ReviewRef[]): string;
export function renderPrintHtml(r: ReviewView, v: VersionView, refs: ReviewRef[]): string;
export const SOURCE_LABEL: Record<VersionMeta['source'], string>; // 首版 / AI 改写 / 手动修改
```

- `exportMarkdown` 的结构：
  - 开头是 `# 产品顾问评审 · v{n}`，接着列出「方案」「版本：v{n}（来源）· 时间」「原始需求」（每行前加 `> `）。
  - 然后是 `---` 分隔线和正文。
  - 有引用时，末尾加 `## 引用来源`，每条一行 `[n] 标题（来源） URL`。
- `renderPrintHtml`：
  - 结构是 `<!doctype html><html lang="zh-CN">`，加上 `<link rel="stylesheet" href="/print.css">`。
  - 没有 script，没有内联 style。
  - 支持 spec 第 5 节列出的块级结构。行内只支持粗体和行内代码，并且要先转义再替换。
  - 引用只输出标题和来源，不带链接。
  - 时间用 `Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' })`。

- [ ] **Step 1：写失败测试**

```ts
test('打印页：转义注入内容，不输出脚本和链接，结构正确渲染', () => {
  const html = renderPrintHtml(view({ input: '<img src=x onerror=alert(1)>' }), ver('# 标题\n\n- **重点** `code`\n\n| a | b |\n|---|---|\n| <script>x</script> | "q" |\n\n```\n<b>raw</b>\n```'), [{ n: 1, id: 1, title: '<i>t</i>', url: 'https://a.com', source: 's' }]);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/ (href|src)=/.test(html.replace('href="/print.css"', '')));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.match(html, /&quot;q&quot;/);
  assert.match(html, /&lt;i&gt;t&lt;\/i&gt;/);
});
test('Markdown 导出：头部、正文和引用来源', () => {
  const md = exportMarkdown(view({ input: '第一行\n第二行' }), ver('正文', 3, 'manual'), [{ n: 1, id: 1, title: 'T', url: 'https://a.com', source: 'S' }]);
  assert.match(md, /^# 产品顾问评审 · v3/);
  assert.match(md, /手动修改/);
  assert.match(md, /> 第一行\n> 第二行/);
  assert.match(md, /## 引用来源\n\[1\] T（S） https:\/\/a\.com/);
});
```

- [ ] **Step 2：运行测试，确认失败**
- [ ] **Step 3：实现 `render.ts`、`print.css` 并加入静态白名单**
  - `print.css` 的要点：`@page { size: A4; margin: 18mm }`，正文 11pt，`table, td, th { border: 1px solid #999 }`，`.hint` 在 `@media print` 下设为 `display: none`，`h1, h2, h3 { break-after: avoid }`。
- [ ] **Step 4：运行测试，确认通过，tsc 无报错**
- [ ] **Step 5：提交**
  - 提交信息：`feat(pm): Markdown 导出与打印页渲染`

---

### Task 5：API 路由（`apps/server/main.ts`）

**Files：**
- Modify：`apps/server/main.ts`（pm 路由区，大约在 171–207 行；打印路由放在静态分发之前，大约 284 行）

**Interfaces：**
- Consumes：Task 3 的 `PmError`、`ask`、`saveManual`、`version`、`refs`、`get`、`delete`，Task 4 的 `exportMarkdown`、`renderPrintHtml`。
- Produces：spec 第 4 节表格中的 6 个端点，请求和响应字段严格按表格实现。
  - `PmError` 映射为 `HttpError(e.status, e.message)`；其他 Error 仍按 400 处理（沿用现状）。
  - 请求体上限：messages 16KB，versions 96KB。
  - download 响应头：`content-type: text/markdown; charset=utf-8`，`content-disposition: attachment; filename="opc-review-{id}-v{n}.md"`，`cache-control: no-store`。
  - `/print/pm/:id/:n`：用 `^\/print\/pm\/(\d+)\/(\d+)$` 匹配，只接受 GET 和 HEAD。未登录时 302 到 `/login`；会话或版本不存在时返回 404 纯文本；正常时返回 `text/html; charset=utf-8`，`cache-control: no-store`。全局的 `securityHeaders` 已经覆盖这个路由。

- [ ] **Step 1：启动一个临时实例，用临时库和临时端口，手动用 curl 验证**
  - 启动：`OPC_PORT=4199 OPC_DATA_DIR=/tmp/opc-t OPC_FETCH_INTERVAL_MIN=1440 OPC_ADMIN_USER=t OPC_ADMIN_HASH=$(npm run -s hash-password -- 临时口令) npm start`。不加载 `/opt/opc-agent.env`，所以 LLM 未启用；首版状态 done 的会话直接用 sqlite 插入。追问会返回 400「未配置 DEEPSEEK_API_KEY」，这一项单独验证。
  - 先确认 `scripts/hash-password.ts` 的入参方式（参数还是 stdin），再用 `POST /api/login` 拿到 cookie。
  - 依次验证：
    - `POST messages`：没有 Key 时返回 400「未配置 DEEPSEEK_API_KEY」；会话不存在时返回 404。202 的正常路径已由 Task 3 的单测覆盖。
    - `POST versions` 用过期的 baseN 时返回 409。
    - download 的响应头符合上面的约定。
    - 未登录访问 print 返回 302；已登录返回 200，响应里不含 `<script`。
    - 带不同源的 Origin 发 POST 返回 403。
  - 期望：上述状态码和响应头全部符合。
- [ ] **Step 2：实现路由**
- [ ] **Step 3：重新跑 Step 1 的 curl 清单，确认全部符合；`npm test` 通过，tsc 无报错**
- [ ] **Step 4：提交**
  - 提交信息：`feat(server): 多轮、版本、下载与打印接口`

---

### Task 6：前端（版本栏、编辑态、对话区、输入区、历史列表）

**Files：**
- Modify：`apps/server/public/app.js`（`renderReview`、`openReview`、`loadPmHistory`，新增 `renderVersions`、`renderThread`、`renderReply`、`sendTurn`、`saveManualVersion`）
- Modify：`apps/server/public/style.css`（新增 `.pm-versions`、`.pm-thread`、`.pm-msg.user`、`.pm-msg.assistant`、`.pm-event`、`.pm-reply`、`.pm-edit`）
- Test：`/tmp/opc-ui-sim.mjs`（扩展 fake fetch 的路由，覆盖新增的端点）

**Interfaces：**
- Consumes：Task 5 的端点和返回字段（`review.messages`、`versions`、`latest`、`content`；`version.content`）。
- Produces：`pm.view = { id, n }`（当前查看的会话和版本）、`pm.verCache: Map<string, string>`（键为 `${id}:${n}`）。
  - 页面结构和交互逐条按 spec 第 6 节实现。
  - `openReview(id)` 发请求前记下 `const token = ++pm.openSeq`；响应回来时如果 `token !== pm.openSeq` 就直接丢弃。
  - 任一轮次处于 running 时继续 3 秒轮询；`latest` 变大时自动切换到最新版本。
  - 发送按钮在点击的同一刻设为 disabled，等请求返回再根据状态恢复。

- [ ] **Step 1：扩展 UI 模拟，写断言（当前代码下应该失败）**
  1. 打开 done 状态的会话，能看到 `.pm-versions` 里有 1 个版本按钮和 `.pm-reply` 输入区。
  2. 输入「为什么」并发送：发送按钮立刻 disabled；fake 服务返回 running，接着返回 done 的回答；`.pm-thread` 最后一条是 assistant 的回答。
  3. 再发送「改定价」：fake 服务返回 latest=2；版本栏出现 v2 并自动选中；对话里出现「→ 生成了 v2：改了定价」。
  4. 点 v1：文档区显示 v1 内容；fake 服务的 `/versions/1` 被请求一次，第二次点击走缓存。
  5. 点「编辑」，修改内容后点「保存为新版本」：fake 服务返回 409 时出现「已有更新的」提示和「查看最新」按钮；返回 201 时版本栏出现 v3。
  6. 打开 status=error 的会话：不渲染 `.pm-reply` 和 `.pm-versions`。
  7. 打开会话 A，在它的轮询请求还没返回时打开会话 B，再让 A 的响应返回：页面仍然显示 B。
  8. 下载链接的 href 等于 `/api/pm/reviews/{id}/versions/{n}/download`；打印链接的 `target=_blank`，`rel` 包含 `noopener`。
- [ ] **Step 2：运行 `node /tmp/opc-ui-sim.mjs`，确认新增断言失败**
- [ ] **Step 3：实现前端改动**
- [ ] **Step 4：运行 `node /tmp/opc-ui-sim.mjs`，确认输出 ALL PASS（原有断言也要通过）**
- [ ] **Step 5：提交**
  - `git add apps/server/public/app.js apps/server/public/style.css`
  - 提交信息：`feat(web): 产品顾问多轮对话、版本切换与编辑`

---

### Task 7：README、重启与端到端核对

**Files：**
- Modify：`README.md`（产品顾问一节）

- [ ] **Step 1：README 补充一段**
  - 内容：首版评审之后可以继续追问或要求修改，由 agent 自动判断，也可以勾选「改写文档」强制改写；每次改写或手动编辑都会生成新版本，可以切换查看；支持下载 .md，或打开打印页另存 PDF。
- [ ] **Step 2：重启 4180 服务**
  - 按现有流程：先用 `ss -ltnp 'sport = :4180'` 找到服务进程，核对 cwd 和 cmdline；再 TERM 掉 `/opt/start.sh`、npm 和 node 三层进程；然后执行 `setsid nohup /opt/start.sh >> /tmp/opc.log 2>&1 < /dev/null &`。
  - 期望：日志出现「产品顾问：已加载 65 个 pm-skills」，没有迁移报错；用 `curl /app.js` 得到的内容和磁盘上的 `app.js` 一致（`cmp` 无输出）。
- [ ] **Step 3：真实库核对迁移结果**
  - 用只读方式打开 `data/opc.db`，查询 `SELECT review_id, n, source FROM pm_versions`。
  - 期望：原有的 1 条已完成评审已回填为 v1。
- [ ] **Step 4：提交**
  - `git add README.md`
  - 提交信息：`docs: 产品顾问多轮与版本说明`
  - 不推送。
