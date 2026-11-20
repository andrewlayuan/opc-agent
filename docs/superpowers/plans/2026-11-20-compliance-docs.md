# 合规第二期：材料起草 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按产品的判定结果与资料，用「模板骨架 + 模型逐章填写」起草 10 种合规材料，支持章级编辑、版本、差异、回退、定稿锁定，导出 md / html / docx。

**Architecture:** 纯数据模板（`templates.ts`）+ 资料校验（`facts.ts`）+ 材料存储（`docs-store.ts`）+ 模型调用与清洗（`docs-gen.ts`）+ 导出（`docs-export.ts`，复用抽出的 `packages/core/mdhtml.ts` 与现有 `convertHtmlToDocx`）。接口在新文件 `apps/server/compliance-docs-api.ts`，由 `compliance-api.ts` 的 `route` 转交；前端新文件 `compliance-docs.js`。生成由前端逐章驱动，无后台队列。

**Tech Stack:** Node 24（TS 类型剥离，构造函数不能用参数属性）、`node:sqlite`、`node:test`、原生 ES 模块前端、LibreOffice（已有）。

**Spec:** `docs/superpowers/specs/2026-11-20-compliance-docs-design.md`

## Global Constraints

- 分支 `feat/compliance-docs`（从 `main` cc7a911 切出）；提交作者与提交者均为 `andrewlayuan <andrewlayuan@users.noreply.github.com>`。
- 全量检查 `sh /tmp/opc-check-ui.sh`（node 测试 + tsc + UI 模拟），每个任务结束必须通过。单测：`node --disable-warning=ExperimentalWarning --test <files>`。
- 迁移号 12；所有 `user_version` 断言由 11 改为 12。
- 占位格式 `【待填：字段名】`，正则 `/【待填：([^】\n]{1,40})】/g`。
- 每章模型输出 ≤6000 字（码点）；手工保存 ≤20000 字；每章版本 ≤50（当前版本不删）。
- 模型调用 `temperature 0.3`、`maxTokens 2500`、非 JSON；失败 502「模型调用失败，请稍后重试」；未配置 400 沿用 `NO_LLM`。
- 错误文案逐字：「请先完成问卷判定」「当前判定不需要这份材料」「未知材料」「材料已存在」「材料不存在」「章节不存在」「内容已在别处更新，请刷新」「材料已定稿，先取消定稿」「章节已从模板移除」「还有未生成的章节」「还有待填内容」「只能删除模板已移除的章节」「模型没有返回内容」「导出格式不对」。
- 导出未定稿提示「草稿（未定稿），仅供参考，以属地主管部门口径为准」；末尾声明「本材料由 AI 辅助起草，提交或公示前请由专业人士审核」。
- 前端只用 textContent / DOM 构建；SDK 隐私政策链接只接受 https，展示经 `safeHref`。
- 写作要点中的条款编号只用 spec 3.2 与第一期 CATALOG 已列出的；其余只写法规名。

## Review Focus

1. 等模型期间材料被定稿或删除 → 写入时事务内重查，分别 409 / 404，不得 500 或写进已定稿材料（Task 4）。
2. 改答后条件章消失再出现 → 先标 `removed=1`，再满足时恢复 `removed=0`，正文与版本保留（Task 4）。
3. SDK 字段含 `|`、换行 → 表格不被打断（`|`→`\|`，换行→空格）（Task 3）。
4. LibreOffice 不可用时导出 docx → 422 透传 `ExtractError` 中文提示，md/html 不受影响（Task 7）。
5. 资料或正文含 `<script>`、`<img onerror>` → HTML 导出（即 docx 输入）全部转义（Task 6）。

---

### Task 1: 共用 Markdown → HTML 渲染（`packages/core/mdhtml.ts`）

**Files:** Create `packages/core/mdhtml.ts`、`packages/core/mdhtml.test.ts`；Modify `packs/wiki/export.ts`（删除内部 `InlineCtx`、`INLINE`、`inline`、`renderBlocks`、`esc`，改为导入）。

**Interfaces — Produces:**
- `export interface MdCtx { link?(target: string, label: string | undefined): string; cite?(doc: number, ord: number): number; img?(id: number, alt: string): string; mark?: boolean }`
- `export function renderMdHtml(body: string, ctx?: MdCtx): string` — 块级同 wiki 原实现，新增管道表格；行内新增占位：`ctx.mark` 为真输出 `<mark style="background:#ffeb3b">【待填：x】</mark>`，否则转义原文。
- `export function escHtml(s: string): string`
- 缺省回调：`[[x|y]]` → `y || x`；`[^d:o]` → 转义原文；`![alt](asset:n)` → `alt || 图片`。

- [ ] **Step 1: 写失败测试**

```ts
test('renderMdHtml：转义、标题降级、列表、引用', () => {
  const html = renderMdHtml('# 标题\n<script>x</script>\n\n- a & b\n- **c**\n\n> 引');
  assert.ok(html.includes('<h2>标题</h2>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(html.includes('<ul><li>a &amp; b</li><li><strong>c</strong></li></ul>'));
  assert.ok(html.includes('<blockquote><p>引</p></blockquote>'));
});
test('renderMdHtml：管道表格，首行表头，分隔行跳过，\\| 还原，单元格转义', () => {
  assert.equal(renderMdHtml('| 名称 | 用途 |\n| --- | --- |\n| <b>A</b> | 统计 \\| 分析 |'),
    '<table><tr><th>名称</th><th>用途</th></tr><tr><td>&lt;b&gt;A&lt;/b&gt;</td><td>统计 | 分析</td></tr></table>');
});
test('renderMdHtml：占位 mark 模式高亮，默认只转义', () => {
  assert.equal(renderMdHtml('联系 【待填：联系邮箱】', { mark: true }), '<p>联系 <mark style="background:#ffeb3b">【待填：联系邮箱】</mark></p>');
  assert.equal(renderMdHtml('联系 【待填：联系邮箱】'), '<p>联系 【待填：联系邮箱】</p>');
});
test('renderMdHtml：外链只保留文字与网址文本', () => {
  assert.equal(renderMdHtml('[官网](https://a.com)'), '<p>官网（https://a.com）</p>');
});
```

- [ ] **Step 2:** 运行 `node --disable-warning=ExperimentalWarning --test packages/core/mdhtml.test.ts` → 失败（模块不存在）。
- [ ] **Step 3: 实现**：把 wiki 的 `INLINE`、`inline`、`renderBlocks`、`esc` 移入；`INLINE` 末尾追加 `|【待填：([^】\n]{1,40})】`；`renderBlocks` 增加表格：以 `|` 开头的连续行为一张表，匹配 `/^\|?\s*:?-{3,}/` 的分隔行跳过，按未转义 `|` 切分，`\|` 还原，每格走 `inline`。`pageToHtml` 改调 `renderMdHtml(page.body, ctx)`。
- [ ] **Step 4:** 运行 `--test packages/core/mdhtml.test.ts packs/wiki/export.test.ts` → 全 PASS（wiki 原测试不改）。
- [ ] **Step 5:** 全量检查通过后提交 `refactor(core): 抽出 Markdown→HTML 渲染，支持表格与待填高亮`。

---

### Task 2: 资料字段、校验与迁移 12（`packs/compliance/facts.ts`）

**Files:** Create `packs/compliance/facts.ts`、`facts.test.ts`；Modify `packages/core/db.ts`（迁移 12，SQL 逐字取 spec 第 6 节）；`user_version` 期望改 12：`packs/pm/attachments.test.ts`、`packs/memory/keeper.test.ts`、`packs/memory/migrate.test.ts`、`packs/kb/migrate.test.ts`、`packs/proto/store.test.ts`、`packs/wiki/migrate.test.ts`、`packs/compliance/store.test.ts`（测试名改「迁移 11–12」，并断言 `cp_entity`、`cp_docs`、`cp_doc_sections`、`cp_doc_revisions` 存在）；`packs/pm/pm.test.ts` 与 `packs/memory/migrate.test.ts` 回退用例的 DROP 列表最前加 `DROP TABLE IF EXISTS cp_doc_revisions; DROP TABLE IF EXISTS cp_doc_sections; DROP TABLE IF EXISTS cp_docs; DROP TABLE IF EXISTS cp_entity;`。

**Interfaces:**
- Consumes: `CpError`、`createProduct`、`getProduct`（`store.ts`）。
- Produces:
  - `export interface FieldDef { key: string; label: string; group?: '对外信息' | '模型' | '数据' | '未成年人'; type: 'text' | 'date' | 'select' | 'sdks'; max?: number; options?: [string, string][] }`
  - `export const ENTITY_FIELDS: FieldDef[]`、`export const FACT_FIELDS: FieldDef[]`（key、名称、上限逐字取 spec 2.1 / 2.2；`minor_mode` 选项 `[['', '未填'], ['yes', '有'], ['no', '没有']]`）
  - `export interface Sdk { name: string; purpose: string; data: string; policy_url: string }`
  - `export type Entity = Record<string, string>`；`export type Facts = { [k: string]: string | Sdk[] | undefined; sdks?: Sdk[] }`
  - `export function validateEntity(input: unknown): Entity`、`export function validateFacts(input: unknown): Facts` — 非法抛 `CpError(400, '<字段名>格式不对' | '<字段名>不超过 N 字')`；去首尾空白；空串省略；清单外丢弃；`sdks` 为数组时保留（含空数组）。
  - `export function fieldLabel(path: string): string` — `'entity.company_name'` → `'公司全称'`；未知 path 抛 `Error`。
  - `export function getEntity(db: DB): Entity`、`export function saveEntity(db: DB, input: unknown, now?: number): Entity`
  - `export function getFacts(db: DB, productId: number): Facts`（404）、`export function saveFacts(db: DB, productId: number, input: unknown, now?: number): Facts`（整体覆盖，并更新 `cp_products.updated_at`）

- [ ] **Step 1: 写失败测试**

```ts
test('validateEntity：信用代码、邮箱、长度；清单外丢弃；空串省略', () => {
  assert.deepEqual(validateEntity({ company_name: ' 某某科技有限公司 ', credit_code: '', foo: 1 }), { company_name: '某某科技有限公司' });
  throwsCp(() => validateEntity({ credit_code: '123' }), 400);
  throwsCp(() => validateEntity({ contact_email: 'a@' }), 400);
  throwsCp(() => validateEntity({ company_name: '字'.repeat(101) }), 400);
  throwsCp(() => validateEntity('x'), 400);
  assert.equal(validateEntity({ credit_code: '91110108MA01ABCD2X' }).credit_code, '91110108MA01ABCD2X');
});
test('validateFacts：日期、选项、SDK 行', () => {
  throwsCp(() => validateFacts({ effective_date: '2026/11/20' }), 400);
  throwsCp(() => validateFacts({ minor_mode: 'maybe' }), 400);
  throwsCp(() => validateFacts({ sdks: [{ name: 'x', policy_url: 'http://a.com' }] }), 400);
  throwsCp(() => validateFacts({ sdks: [{ name: '' }] }), 400);
  throwsCp(() => validateFacts({ sdks: Array.from({ length: 31 }, () => ({ name: 'a' })) }), 400);
  assert.deepEqual(validateFacts({ sdks: [{ name: ' 友盟 ', purpose: '统计', policy_url: 'https://u.com/p' }] }).sdks,
    [{ name: '友盟', purpose: '统计', data: '', policy_url: 'https://u.com/p' }]);
  assert.deepEqual(validateFacts({ sdks: [] }), { sdks: [] });
});
test('fieldLabel 与存取', () => {
  assert.equal(fieldLabel('facts.sdks'), '第三方 SDK');
  assert.throws(() => fieldLabel('facts.nope'));
  // tmpDb：getEntity 初始 {}；saveEntity 两次后为后者；saveFacts(pid,{site},9) 后 getFacts 回显、产品 updated_at===9；getFacts(999) 404
});
```

- [ ] **Step 2:** 运行确认失败。
- [ ] **Step 3:** 实现迁移 12 与 `facts.ts`；改各测试版本号与 DROP 列表。
- [ ] **Step 4:** 全量检查 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 主体与产品资料字段、校验与迁移 12`。

---

### Task 3: 材料模板（`packs/compliance/templates.ts`）

**Files:** Create `packs/compliance/templates.ts`、`templates.test.ts`。

**Interfaces:**
- Consumes: `Answers`、`AssessResult`、`CATALOG`、`QUESTIONS`、`assess`（`rules.ts`）；Task 2 `Entity`、`Facts`、`fieldLabel`。
- Produces:
  - `export const TEMPLATES_VERSION = 1`
  - `export interface Ctx { entity: Entity; facts: Facts; answers: Answers; product: { name: string; description: string } }`
  - `export interface Chapter { key: string; title: string; mode: 'fixed' | 'model'; when?: (a: Answers) => boolean; uses: string[]; render?: (c: Ctx) => string; points?: string[] }`
  - `export interface DocTemplate { kind: string; name: string; usage: 'public' | 'filing'; items: string[]; version: number; chapters: Chapter[] }`
  - `export const TEMPLATES: DocTemplate[]`；`export function templateOf(kind: string): DocTemplate | undefined`
  - `export function chaptersFor(t: DocTemplate, a: Answers): Chapter[]`
  - `export function availability(t: DocTemplate, result: AssessResult | null): { ok: true } | { ok: false; reason: string }` — 无判定「请先完成问卷判定」；`items` 非空且全为 `na`「当前判定不需要这份材料」。
  - `export function kindsForItem(itemId: string): string[]`
  - `export const PLACEHOLDER_RE`；`export function ph(label: string): string`；`export function placeholdersIn(text: string): string[]`（去重保序）
  - `export function v(c: Ctx, path: string): string` — 取 `entity.x` / `facts.x`，空则 `ph(fieldLabel(path))`
  - `export function answerText(a: Answers): string[]` — 每题「题目：选项中文名、…」，跳过未出现的题

章节 key 逐字如下（F = 固定章，其余为模型章；括号为 `when`）。`kind`、`name`、`usage`、`items` 取 spec 3.1，标题取 spec 3.2：
- `privacy_policy`：`intro` F、`collect`、`ai`（`ai_use≠none`）、`cookies`、`sharing`、`sdks` F、`storage` F、`cross_border`（`cross_border≠no`）、`security`、`rights` F、`minors`（`minors≠no`）、`updates` F、`contact` F
- `terms`：`accept` F、`service`、`account`、`conduct`、`ai`（`ai_use≠none`）、`payment`（`charge` 含 `free` 以外的值）、`ip`、`liability`、`change` F、`law` F、`contact` F
- `app_statement`：`basic` F、`service`、`model` F、`users`、`flow`、`safety`、`label`、`complaint` F
- `algo_selfassess`：`basic`、`principle`、`data`、`risks`、`measures`、`governance`、`conclusion`
- `algo_disclosure`：`principle`、`purpose`、`mechanism`、`choice`
- `model_disclosure`：`name` F、`filing_no` F、`provider` F、`placement` F
- `security_report`：`basic`、`s1_officer`、`s2_identity`、`s3_logs`、`s4_harmful`、`s5_tech`、`s6_complaint`、`s7_cac`、`s8_police`、`conclusion`
- `anthro_report`：`basic`、`features`、`users`、`identity`、`addiction`、`content`、`privacy`、`emergency`、`conclusion`
- `aigc_label_plan`：`scope`、`explicit`、`implicit`、`notice`、`logs`、`check`
- `minor_statement`：`identity`、`mode`、`time`、`content`、`spending`、`under14`、`guardian`

固定章正文与写作要点由实现者撰写（遵守条款编号规则）。`sdks` 章：`facts.sdks` 未定义输出 `ph('第三方 SDK')`；空数组输出「本产品未接入第三方 SDK。」；否则表格 `| 名称 | 用途 | 收集的信息 | 隐私政策 |`。

- [ ] **Step 1: 写失败测试**（`writer()` 画像同 `store.test.ts`；`ctxWith(entity, facts, product?)` 与 `FULL_ENTITY`/`FULL_FACTS` 为测试内 helper）

```ts
test('10 种材料；items 在 CATALOG 中；key 唯一；uses 可解析；固定章有 render、模型章有 points', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.kind), ['privacy_policy', 'terms', 'app_statement', 'algo_selfassess', 'algo_disclosure', 'model_disclosure', 'security_report', 'anthro_report', 'aigc_label_plan', 'minor_statement']);
  // 逐项断言，失败信息带 `${kind}.${key}`
});
test('固定章：资料齐全无占位；每个 uses 字段缺失时出现其占位', () => {
  for (const t of TEMPLATES) for (const c of t.chapters.filter((x) => x.mode === 'fixed')) {
    assert.deepEqual(placeholdersIn(c.render!(ctxWith(FULL_ENTITY, FULL_FACTS))), [], `${t.kind}.${c.key}`);
    for (const u of c.uses) assert.ok(placeholdersIn(c.render!(ctxWith({}, {}))).includes(fieldLabel(u)), `${t.kind}.${c.key} ${u}`);
  }
});
test('SDK 表格：| 与换行转义；未填与空列表区分', () => {
  const sdks = templateOf('privacy_policy')!.chapters.find((c) => c.key === 'sdks')!;
  assert.ok(sdks.render!(ctxWith({}, { sdks: [{ name: 'A|B', purpose: '统计\n分析', data: '', policy_url: '' }] })).includes('| A\\|B | 统计 分析 |'));
  assert.ok(sdks.render!(ctxWith({}, { sdks: [] })).includes('本产品未接入第三方 SDK。'));
  assert.deepEqual(placeholdersIn(sdks.render!(ctxWith({}, {}))), ['第三方 SDK']);
});
test('条件章随答案出现或省略', () => {
  const keys = (kind: string, a: Answers) => chaptersFor(templateOf(kind)!, a).map((c) => c.key);
  assert.ok(!keys('privacy_policy', writer({ ai_use: 'none', cross_border: 'no', minors: 'no' })).some((k) => ['ai', 'cross_border', 'minors'].includes(k)));
  assert.ok(['ai', 'cross_border', 'minors'].every((k) => keys('privacy_policy', writer({ cross_border: 'lt10w', minors: 'maybe' })).includes(k)));
  assert.ok(!keys('terms', writer({ charge: ['free'] })).includes('payment'));
});
test('availability 与 kindsForItem', () => {
  assert.deepEqual(availability(templateOf('privacy_policy')!, null), { ok: false, reason: '请先完成问卷判定' });
  const r = assess(writer());
  assert.deepEqual(availability(templateOf('privacy_policy')!, r), { ok: true });
  assert.deepEqual(availability(templateOf('security_report')!, r), { ok: false, reason: '当前判定不需要这份材料' });
  assert.deepEqual(kindsForItem('algo_filing'), ['algo_selfassess', 'algo_disclosure']);
});
test('placeholdersIn 去重保序；v 缺值返回占位', () => {
  assert.deepEqual(placeholdersIn('【待填：A】x【待填：B】【待填：A】'), ['A', 'B']);
  assert.equal(v(ctxWith({}, {}), 'entity.contact_email'), '【待填：联系邮箱】');
});
```

- [ ] **Step 2:** 运行确认失败。 - [ ] **Step 3:** 实现。 - [ ] **Step 4:** 单测与全量 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 十种材料模板与占位`。

---

### Task 4: 材料存储、版本、定稿与模板同步（`packs/compliance/docs-store.ts`）

**Files:** Create `packs/compliance/docs-store.ts`、`docs-store.test.ts`。

**Interfaces:**
- Consumes: Task 2 `getEntity`、`getFacts`；Task 3 全部；`getProduct`、`CpError`（`store.ts`）；`lineDiff`、`DiffLine`（`packs/wiki/diff.ts`）。
- Produces:
  - `export const SECTION_MAX = 20000`、`export const REVISIONS_KEEP = 50`
  - `export type Origin = 'fixed' | 'generate' | 'edit' | 'restore'`
  - `export interface SectionView { key: string; title: string; mode: 'fixed' | 'model'; ord: number; body: string; rev: number; origin: Origin | null; stale: boolean; removed: boolean; placeholders: string[]; updated_at: number }`
  - `export interface DocView { id: number; product_id: number; kind: string; name: string; usage: 'public' | 'filing'; status: 'draft' | 'final'; template_version: number; finalized_at: number | null; created_at: number; updated_at: number; sections: SectionView[] }`
  - `export interface DocCard { kind: string; name: string; usage: 'public' | 'filing'; items: string[]; available: boolean; reason: string | null; doc: { id: number; status: 'draft' | 'final'; placeholders: number; stale: number; pending: number } | null }`
  - `export interface GenContext { doc: DocView; template: DocTemplate; chapter: Chapter; ctx: Ctx; reasons: string[]; hash: string }`
  - `export function loadCtx(db: DB, productId: number): { ctx: Ctx; result: AssessResult | null }`
  - `export function inputHash(t: DocTemplate, ch: Chapter, ctx: Ctx, reasons: string[]): string` — sha256 hex，内容按 spec 4.4
  - `export function listDocs(db: DB, productId: number): DocCard[]`
  - `export function createDoc(db: DB, productId: number, kind: unknown, now?: number): DocView`
  - `export function getDoc(db: DB, docId: number, now?: number): DocView` — 先模板同步（补章 `rev=0`；不再适用标 `removed=1`；再次适用恢复 `removed=0`；更新 `template_version` 与 `ord`），再算 `stale` 与 `placeholders`
  - `export function prepareGenerate(db: DB, docId: number, key: string): GenContext` — 404「章节不存在」；409「材料已定稿，先取消定稿」/「章节已从模板移除」；`reasons` 为该材料 `items` 在最近判定中的理由合集
  - `export function writeGenerated(db: DB, docId: number, key: string, body: string, origin: 'fixed' | 'generate', hash: string, now?: number): SectionView` — 事务内重查：材料不存在 404，已定稿 409
  - `export function saveSection(db: DB, docId: number, key: string, body: unknown, baseRev: unknown, now?: number): SectionView`
  - `export function listRevisions(db: DB, docId: number, key: string): { n: number; origin: Origin; created_at: number; chars: number }[]`（新到旧）
  - `export function getRevision(db: DB, docId: number, key: string, n: number): { n: number; body: string; origin: Origin; created_at: number; diff: { lines: DiffLine[]; clipped: boolean } }` — `diff = lineDiff(版本正文, 当前正文)`
  - `export function restoreSection(db: DB, docId: number, key: string, n: unknown, now?: number): SectionView`
  - `export function finalizeDoc(db: DB, docId: number, now?: number): DocView` — 未移除章有 `rev=0` → `CpError(400, '还有未生成的章节', { pending: string[] })`；有占位 → `CpError(400, '还有待填内容', { placeholders: { key: string; title: string; fields: string[] }[] })`
  - `export function unfinalizeDoc(db: DB, docId: number, now?: number): DocView`
  - `export function deleteDoc(db: DB, docId: number): void`；`export function deleteSection(db: DB, docId: number, key: string): void`
  - `export function docProductId(db: DB, docId: number): number`（404「材料不存在」）

事务包装同 `store.ts` 的 `tx`（`BEGIN IMMEDIATE`）；版本裁剪 `DELETE FROM cp_doc_revisions WHERE section_id = ? AND n <= ?`，阈值 `当前 rev − 50`。

- [ ] **Step 1: 写失败测试**（`setup()`：建产品、`saveEntity` 填满、`assessAndMerge(writer())`；`bare` 为未判定产品）

```ts
test('起草：未判定/不需要/未知 400；重复 409；固定章版本 1，模型章 rev 0', () => {
  throwsCp(() => createDoc(db, bare, 'privacy_policy'), 400);
  throwsCp(() => createDoc(db, pid, 'security_report'), 400);
  throwsCp(() => createDoc(db, pid, 'nope'), 400);
  const d = createDoc(db, pid, 'privacy_policy', 10);
  throwsCp(() => createDoc(db, pid, 'privacy_policy'), 409);
  const s = (k: string) => d.sections.find((x) => x.key === k)!;
  assert.deepEqual([s('intro').rev, s('intro').origin, s('collect').rev, s('collect').origin], [1, 'fixed', 0, null]);
});
test('生成、编辑、回退各加版本；baseRev 不符 409；超长 400；差异方向', () => {
  writeGenerated(db, id, 'collect', '正文一', 'generate', prepareGenerate(db, id, 'collect').hash, 11);
  throwsCp(() => saveSection(db, id, 'collect', 'x', 0), 409);
  saveSection(db, id, 'collect', '正文二', 1, 12);
  throwsCp(() => saveSection(db, id, 'collect', 'x'.repeat(20001), 2), 400);
  const r = restoreSection(db, id, 'collect', 1, 13);
  assert.deepEqual([r.rev, r.body, r.origin], [3, '正文一', 'restore']);
  assert.deepEqual(listRevisions(db, id, 'collect').map((x) => x.origin), ['restore', 'edit', 'generate']);
  assert.deepEqual(getRevision(db, id, 'collect', 2).diff.lines, [{ t: '-', s: '正文二' }, { t: '+', s: '正文一' }]);
});
test('版本上限 50：最早的被删，取已删版本 404', () => { /* 连续 saveSection 55 次 → 列表长 50，首项 n===55；getRevision(…,1) 404 */ });
test('定稿：未生成 400 带 pending；有占位 400 带 placeholders（含 contact 章「联系邮箱」）；补全后通过；之后生成/保存/回退/删除/writeGenerated 均 409；取消定稿后可保存', () => {});
test('资料变更后用到该字段的章 stale；未生成章不算 stale', () => {
  saveFacts(db, pid, { data_location: '北京' });
  const s = (k: string) => getDoc(db, id).sections.find((x) => x.key === k)!;
  assert.equal(s('storage').stale, true);
  assert.equal(s('security').stale, false);
});
test('条件章：改答后 removed，改回恢复且正文保留；deleteSection 只删已移除章', () => {
  /* 生成 cross_border 章 → assessAndMerge(writer({cross_border:'no'})) → removed true；deleteSection(未移除章) 400；
     改回 'lt10w' → removed false 且 body 不变；再改 'no' 后 deleteSection 成功，章不再出现直到再次适用时以 rev 0 补建 */
});
test('写入时材料已删 404；删产品级联清空 cp_docs/cp_doc_sections/cp_doc_revisions', () => {});
test('listDocs：可起草与原因；待填、需更新、未生成计数', () => {});
```

- [ ] **Step 2:** 运行确认失败。 - [ ] **Step 3:** 实现。 - [ ] **Step 4:** 单测与全量 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 材料存储、章级版本、定稿与模板同步`。

---

### Task 5: 逐章生成与输出清洗（`packs/compliance/docs-gen.ts`）

**Files:** Create `packs/compliance/docs-gen.ts`、`docs-gen.test.ts`。

**Interfaces:**
- Consumes: Task 3 `Ctx`、`Chapter`、`DocTemplate`、`answerText`、`v`；Task 2 `ENTITY_FIELDS`、`FACT_FIELDS`；`Llm`、`ChatMessage`（`packages/core/llm.ts`）；`stubLlm`（`packs/wiki/testutil.ts`）。
- Produces:
  - `export const CHAPTER_MAX = 6000`
  - `export function allowedUrls(ctx: Ctx): Set<string>` — 资料所有字符串值（含 SDK 各字段）中的 `https?://` 串，去掉末尾中英文标点
  - `export function sanitizeChapter(text: string, allowed: Set<string>): string` — spec 4.3；空结果抛 `Error('模型没有返回内容')`
  - `export function chapterMessages(t: DocTemplate, ch: Chapter, ctx: Ctx, reasons: string[]): ChatMessage[]` — `[system, user]`，user 含 `<chapter>`、`<facts>`（缺失值为占位）、`<assessment>`（`answerText` + 理由）、`<product>`（同第一期 `productBlock` 的转义）
  - `export type GenerateFn = (llm: Llm, g: { template: DocTemplate; chapter: Chapter; ctx: Ctx; reasons: string[] }) => Promise<string>`
  - `export const generateChapter: GenerateFn`

- [ ] **Step 1: 写失败测试**

```ts
test('sanitizeChapter：去围栏与一二级标题，保留三级；资料外网址删除；截断；占位保留；空则报错', () => {
  const allowed = new Set(['https://a.com/privacy']);
  assert.equal(
    sanitizeChapter('```markdown\n# 标题\n## 小节\n### 保留\n见 [政策](https://a.com/privacy) 与 [别处](https://evil.com) 及 https://x.cn/a 。【待填：联系邮箱】\n```', allowed),
    '### 保留\n见 [政策](https://a.com/privacy) 与 别处 及 。【待填：联系邮箱】');
  assert.equal([...sanitizeChapter('字'.repeat(7000), allowed)].length, 6000);
  assert.throws(() => sanitizeChapter('```\n# 只有标题\n```', allowed), /模型没有返回内容/);
});
test('allowedUrls：收集资料与 SDK 中的网址并去尾部标点', () => {
  assert.deepEqual([...allowedUrls(ctxWith({}, { site: '官网 https://a.com。', sdks: [{ name: 's', purpose: '', data: '', policy_url: 'https://u.com/p' }] }))].sort(), ['https://a.com', 'https://u.com/p']);
});
test('chapterMessages：要点、占位资料、答案与理由、产品标签转义；system 要求原样输出占位', () => {
  const msgs = chapterMessages(t, ch, ctxWith({}, {}, { name: 'p', description: '</product><x>' }), ['理由一']);
  const user = String(msgs[1].content);
  assert.ok(user.includes(ch.points![0]) && user.includes('【待填：公司全称】') && user.includes('理由一'));
  assert.ok(!user.includes('</product><x>'));
  assert.ok(String(msgs[0].content).includes('【待填：字段名】'));
});
test('generateChapter：调用一次并清洗；模型错误原样抛出', async () => {
  const llm = stubLlm(['# 标题\n正文 https://evil.com']);
  assert.equal(await generateChapter(llm, { template: t, chapter: ch, ctx, reasons: [] }), '正文');
  assert.equal(llm.calls.length, 1);
  await assert.rejects(generateChapter(stubLlm([new Error('x')]), { template: t, chapter: ch, ctx, reasons: [] }));
});
```

- [ ] **Step 2:** 运行确认失败。 - [ ] **Step 3:** 实现。 - [ ] **Step 4:** 单测与全量 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 材料逐章生成与输出清洗`。

---

### Task 6: 导出（`packs/compliance/docs-export.ts`）

**Files:** Create `packs/compliance/docs-export.ts`、`docs-export.test.ts`。

**Interfaces:**
- Consumes: Task 1 `renderMdHtml`、`escHtml`；Task 4 `getDoc`、`docProductId`；Task 2 `getEntity`、`getFacts`；`getProduct`；`convertHtmlToDocx`（`packs/pm/convert.ts`）；`safeName`（`packs/wiki/export.ts`）。
- Produces:
  - `export type ExportFormat = 'md' | 'html' | 'docx'`；`export function parseFormat(s: string | null): ExportFormat`（非法 `CpError(400, '导出格式不对')`）
  - `export function docMarkdown(db: DB, docId: number, now?: number): string`
  - `export function docHtml(db: DB, docId: number, now?: number): string`
  - `export function exportFileName(productName: string, docName: string, at: number, ext: string): string` — `${safeName(产品名)}-${材料名}-${YYYYMMDD}.${ext}`，日期按东八区
  - `export async function exportDoc(db: DB, docId: number, format: ExportFormat, o?: { convert?: (html: string) => Promise<Buffer>; now?: number }): Promise<{ body: Buffer; type: string; name: string }>` — type 依次 `text/markdown; charset=utf-8`、`text/html; charset=utf-8`、`application/vnd.openxmlformats-officedocument.wordprocessingml.document`

抬头：`# 材料名`，下一行「产品：对外名称（未填用产品名）　主体：公司全称（未填为占位）　日期：YYYY-MM-DD」，未定稿再加草稿提示行。章标题 `## 一、标题`（中文序号，跳过已移除章）。末尾 `---` 后接 AI 辅助声明。HTML 为 `<!DOCTYPE html>` 单文件、`<meta charset="utf-8">`、内联 `<style>`，正文经 `renderMdHtml(body, { mark: true })`，抬头字段经 `escHtml`。

- [ ] **Step 1: 写失败测试**

```ts
test('docMarkdown：抬头、草稿提示、中文序号、跳过已移除章、末尾声明', () => {
  const md = docMarkdown(db, id, Date.UTC(2026, 10, 20));
  assert.ok(md.startsWith('# 隐私政策\n'));
  assert.ok(md.includes('草稿（未定稿），仅供参考，以属地主管部门口径为准'));
  assert.ok(md.includes('## 一、引言与适用范围'));
  assert.ok(!md.includes('个人信息出境'));
  assert.ok(md.trimEnd().endsWith('本材料由 AI 辅助起草，提交或公示前请由专业人士审核'));
});
test('docHtml：无外部资源；占位 mark；资料与正文全部转义', () => {
  saveEntity(db, { company_name: '<script>alert(1)</script>' });
  saveSection(db, id, 'collect', '<img src=x onerror=alert(1)>', rev);
  const html = docHtml(db, id);
  assert.ok(!/<(script|img|link|iframe|a)\b/i.test(html));
  assert.ok(!/<[^>]+\s(src|href|on\w+)=/i.test(html));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<mark style="background:#ffeb3b">【待填：'));
});
test('exportDoc：docx 交给 convert；文件名去非法字符；定稿后无草稿提示；parseFormat', async () => {
  let got = '';
  const r = await exportDoc(db, id, 'docx', { convert: async (h) => ((got = h), Buffer.from('DOCX')), now: Date.UTC(2026, 10, 20) });
  assert.deepEqual([r.name, r.body.toString()], ['a b-隐私政策-20261120.docx', 'DOCX']);   // 产品名 'a/b'
  assert.ok(got.includes('<mark'));
  // 补全并定稿后 docMarkdown 不含草稿提示
  assert.throws(() => parseFormat('pdf'), (e) => e instanceof CpError && e.status === 400);
});
```

- [ ] **Step 2:** 运行确认失败。 - [ ] **Step 3:** 实现。 - [ ] **Step 4:** 单测与全量 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 材料导出 Markdown、HTML、Word`。

---

### Task 7: 接口（`apps/server/compliance-docs-api.ts`）

**Files:** Create `apps/server/compliance-docs-api.ts`、`compliance-docs-api.test.ts`；Modify `apps/server/compliance-api.ts`（`meta()` 增 `entityFields`、`factFields`、`docKinds`；`GET products/:id` 增 `facts`；`route()` 未命中时转交 `routeDocs`；`ComplianceDeps` 增 `generate?: GenerateFn; convert?: (html: string) => Promise<Buffer>`；导出 `NO_LLM`、`viaLlm`、`idOf`）、`packs/memory/events.ts`（`EventKind` 加 `'compliance_doc_final'`）。

**Interfaces:**
- Consumes: Task 2/4/5/6 全部；`HttpError`、`readJson`、`sendJson`、`contentDisposition`（`http.ts`）；`ExtractError`（`packs/pm/extract.ts`）。
- Produces: `export async function routeDocs(deps: ComplianceDeps, req: http.IncomingMessage, res: http.ServerResponse, method: string, parts: string[]): Promise<boolean>`
  - 路由与错误码逐字取 spec 第 7 节；`docKinds[]` 为 `{ kind, name, usage, items, chapters: { key, title, mode, uses }[] }`（不含 `when`/`render`/`points`）。
  - `generate`：固定章用 `render` 后 `writeGenerated(..., 'fixed', hash)`，不需模型；模型章先查 `deps.llm.enabled`，再 `viaLlm(() => (deps.generate ?? generateChapter)(...))`，返回 `{ section }`。
  - `PUT …/sections/:key` 返回 `{ section }`；`GET docs/:id`、`finalize`、`unfinalize` 返回 `{ doc }`；`GET products/:id/docs` 返回 `{ docs: DocCard[] }`；`revisions` 返回 `{ revisions }` 或 `{ revision }`。
  - docx 转换抛 `ExtractError` → 以其 `status` 与 message 返回（422）；导出头 `content-type` 取 `exportDoc().type`，`content-disposition` 用 `contentDisposition(name, false)`。
  - 定稿成功记事件 `{ kind: 'compliance_doc_final', refType: 'product', refId, summary: \`定稿：${产品名} ${材料名}\`, payload: { kind } }`，失败只打日志。

- [ ] **Step 1: 写失败测试**（沿用 `compliance-api.test.ts` 的 `setup` 写法与 `ANSWERS`）

```ts
test('meta 带资料字段与材料目录；主体读写；产品资料回显', async () => {
  // meta.docKinds.length===10；docKinds[0].chapters[0] 键集合为 key/title/mode/uses
  // PUT entity { contact_email: 'a@' } → 400；PUT entity 合法 → GET entity 回显
  // PUT products/:id/facts { site } → GET products/:id .facts.site 回显；products/999/facts → 404
});
test('起草与读取：未判定 400「请先完成问卷判定」、不需要 400、重复 409；列表计数', async () => {});
test('生成：固定章无模型可用；模型章未配置 400；模型出错 502；成功 rev 1；定稿后 409', async () => {
  // offLlm: …/sections/intro/generate → 200；…/collect/generate → 400 '未配置 DEEPSEEK_API_KEY，无法调用模型'
  // generate: async () => { throw new Error('x') } → 502 '模型调用失败，请稍后重试'
  // generate: async () => '正文' → 200，section.rev===1、origin==='generate'
});
test('保存、历史、差异、回退；baseRev 冲突 409', async () => {});
test('定稿：有待填 400 带 placeholders；通过后记事件；导出 md/html/docx；docx 转换失败 422 且 md 仍可用', async () => {
  // convert: async () => { throw new ExtractError(422, '未安装 LibreOffice，无法转换') } → 422 且 error 为该文案
  // content-disposition 含 "filename*=UTF-8''"；format=pdf → 400
  // events 末项 kind==='compliance_doc_final'、payload.kind==='privacy_policy'
});
test('删除：定稿 409；只能删已移除章 400；非法 id 400；未知路径 404', async () => {});
```

- [ ] **Step 2:** 运行确认失败。 - [ ] **Step 3:** 实现。 - [ ] **Step 4:** 单测与全量 PASS。
- [ ] **Step 5:** 提交 `feat(compliance): 材料起草接口`。

---

### Task 8: 页面、文档与截图核对

**Files:** Create `apps/server/public/compliance-docs.js`；Modify `apps/server/public/compliance.js`（`TABS` 加 `['facts', '资料'], ['docs', '材料']`；侧栏「监管动态」下加「主体信息」按钮，`st.mode = 'entity'`；台账行加「材料」链接；`initCompliance` 增参 `renderMarkdown`）、`apps/server/public/app.js`（传入 `renderMarkdown`）、`apps/server/http.ts`（静态表加 `'/compliance-docs.js'`）、`apps/server/public/style.css`（`cp-doc-*`、`cp-facts-*`、`mark.cp-ph`）、`README.md`（「## 合规」节加「材料起草」小节）、`/tmp/opc-ui-sim.mjs`（新增用例，不入库）。

**Interfaces:**
- Consumes: Task 7 接口；`renderMarkdown(content, refList, opts)`（`app.js`，返回 DOM 节点数组）。
- Produces: `export function initComplianceDocs({ h, api, toast, safeHref, renderMarkdown }): { entityView(meta): Node; factsView(meta, detail, onSaved: () => void): Node; docsView(meta, pid: number, openKind?: string): Node }` — 视图自管加载与重绘；内部 `markPlaceholders(nodes)` 遍历文本节点，把占位切成 `h('mark', { class: 'cp-ph', text })`。

行为（spec 第 9 节）：
- 资料：按 `group` 分组；SDK 表可增删行（≤30）；页顶「未填：字段名（影响：材料名、…）」，由 `docKinds[].chapters[].uses` 推出。
- 材料页按钮文案：「生成剩余章节」「定稿」/「取消定稿」「导出 Markdown」「导出 HTML」「导出 Word」「删除」；目录状态：「未生成」「已生成」「已编辑」「资料已更新」「模板已移除」「生成中…」「失败，重试」。导出为 `a` 链接，`href` 为 `/api/compliance/docs/:id/export?format=md|html|docx`。
- 「生成剩余章节」按目录顺序对 `rev === 0 && !removed` 的章逐个 `await`；单章失败继续下一章；结束 `toast('已生成 N 章，失败 M 章')`。
- 重新生成且 `origin === 'edit'` 时 `confirm('将覆盖你的修改（可在历史中找回），继续？')`。
- 定稿 400 且带 `placeholders` 时渲染列表「章名：字段、字段」。

- [ ] **Step 1: 在 `/tmp/opc-ui-sim.mjs` 写失败用例**「合规材料：主体、资料、起草、逐章生成、编辑、历史、定稿、导出、台账链接」，routes 表模拟接口，断言：
  - 侧栏有「主体信息」，保存后 PUT `/api/compliance/entity` 的 body 含 `company_name`；
  - 标签依次为 问卷 / 判定结果 / 台账 / 资料 / 材料；
  - 资料页「添加一行」后保存，PUT body `sdks.length === 1`；
  - 材料列表点「隐私政策」起草 → 「生成剩余章节」按目录顺序请求；某章 routes 返回 `{ __status: 502 }` 时该章显示「失败，重试」且后续章仍被请求；
  - 预览中占位为 `MARK` 节点；编辑保存 PUT body 为 `{ body, baseRev }`；历史面板出现 `.wiki-diff .add`；
  - 定稿 400 时显示「联系我们：联系邮箱」；定稿成功后无「编辑」按钮、有「取消定稿」；
  - 「导出 Word」链接 `href` 以 `/api/compliance/docs/` 开头且含 `format=docx`；
  - 台账 `privacy_policy` 行有「材料」链接，点击切到材料标签并打开该材料。
- [ ] **Step 2:** 运行 `sh /tmp/opc-check-ui.sh` → 新用例 FAIL。
- [ ] **Step 3:** 实现前端、样式、README。
- [ ] **Step 4:** `sh /tmp/opc-check-ui.sh` → ALL PASS、TSC_OK。
- [ ] **Step 5:** 临时实例截图核对（`/tmp/opc-cp-up.sh`，端口 24180，`agent-browser --session cpshot`）：主体信息、资料页、材料列表、材料页（占位高亮、历史差异）；修正样式。
- [ ] **Step 6:** 提交 `feat(compliance): 材料起草页面、资料表单与台账联动`。
