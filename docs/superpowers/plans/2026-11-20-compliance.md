# 合规：备案判定与台账（第一期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「合规」模块：问卷 → 规则判定要办的备案/登记/自查事项 → 按产品维护台账与到期提醒；并把网信办公告接入情报。

**Architecture:** `packs/compliance` 下四个文件（纯函数规则表、数据库存储、模型预填与解释、提醒计算），`apps/server/compliance-api.ts` 处理 `/api/compliance/*`，前端新文件 `apps/server/public/compliance.js` 以 `initCompliance(deps)` 接入 `app.js`。信息源新增 `page-list` 类型，解析器放在 `packages/core/feed.ts`。

**Tech Stack:** Node ≥22.18 原生运行 .ts、`node:test`、`node:sqlite`；前端原生 JS（`h()` 辅助）；无第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-20-compliance-design.md`

## Global Constraints

- 不新增任何第三方依赖。
- SQL 一律参数绑定；所有用户与模型文本在前端只经 `textContent` 写入。
- 官方链接只来自 `rules.ts` 事项目录，https，域名限 `beian.miit.gov.cn`、`beian.cac.gov.cn`、`www.cac.gov.cn`、`www.beian.gov.cn`、`www.gov.cn`、`www.miit.gov.cn`、`dxzhgl.miit.gov.cn`、`www.djbh.net`。
- 条款号必须对照官方原文核对后才写；未核对的只写法规名。
- 页面固定提示文案：「结果为自查参考，以属地主管部门口径为准。」
- 规则版本 `RULES_VERSION = 1`；问卷版本与规则版本同号。
- 提醒窗口 30 天；产品名 1–60 字，描述 ≤8000 字，编号 ≤100 字，预填依据 ≤200 字，解释 ≤600 字，请求体 ≤64KB。
- 提交作者：`GIT_AUTHOR_NAME=andrewlayuan GIT_AUTHOR_EMAIL=andrewlayuan@users.noreply.github.com`（committer 相同）；每次提交后用 `git show HEAD:<file> | grep -c <关键符号>` 核对落盘。
- 每个任务结束跑 `sh /tmp/opc-check-ui.sh`（全量测试 + `TSC_OK` + UI 模拟 `ALL PASS`）。
- 编辑工具易超时并延迟覆盖：用 heredoc 补丁脚本（锚点唯一的 `rep()`，`/tmp/rep.mjs`），单条命令 <8000 字节。

## Review Focus

1. 重新判定时用户手填的编号、日期、备注被覆盖 —— 期望完全保留（Task 2 `assessAndMerge 保留手填字段`）。
2. 答案里混入非法选项或多选题传成字符串 —— 期望 400 并指出题目，不做部分判定（Task 1 `validateAnswers`）。
3. 条件题（`ai_output`、`ai_media`）在不用 AI 时被要求作答或被忽略不当 —— 期望不用 AI 时这两题可缺省，用 AI 时必答（Task 1）。
4. 模型预填返回选项外的值、带 URL 或超长依据 —— 期望丢弃或截断，绝不落库（Task 5）。
5. `page-list` 列表页混入站外或非文章链接（`javascript:`、栏目页）—— 期望只保留同域名文章链接（Task 6）。

---

### Task 1: 规则表与判定（`rules.ts`）

**Files:**
- Create: `packs/compliance/rules.ts`
- Test: `packs/compliance/rules.test.ts`

**Interfaces:**
- Produces:
  - `export const RULES_VERSION = 1`
  - `export type Level = 'required' | 'maybe' | 'na'`
  - `export type Answers = Record<string, string | string[]>`
  - `export interface Question { id: string; title: string; multi: boolean; options: { value: string; label: string }[]; when?: (a: Answers) => boolean }`（`when` 为假时该题不必答；序列化到 meta 时改为 `dependsOn` 文本说明）
  - `export const QUESTIONS: Question[]`（14 题，id 与选项值见下）
  - `export interface CatalogItem { id: string; name: string; authority: string; basis: string; timing: string; timingOrder: 0 | 1 | 2 | 3; links: { label: string; url: string }[]; validity?: { years?: number; yearlyReminder?: boolean } }`
  - `export const CATALOG: CatalogItem[]`（18 项，id 同设计第 2 节）
  - `export function validateAnswers(a: unknown): { ok: true; answers: Answers } | { ok: false; missing: string[]; invalid: string[] }`
  - `export interface AssessedItem { id: string; level: Level; reasons: string[]; order: number }`
  - `export interface AssessResult { version: number; items: AssessedItem[]; social: { value: boolean; reason: string }; notes: string[] }`
  - `export function assess(a: Answers): AssessResult`（调用前须已通过 `validateAnswers`）
  - `export function nextDates(item: string, doneAt: number): { due_at: number | null; remind_at: number | null }`

选项值（存储用，英文短码）：
`forms`: web, app, miniapp, api, desktop · `audience`: public, b2b, internal · `overseas`: no, yes · `charge`: free, paid, ads, commerce · `ai_use`: none, cn_api, foreign_api, own · `ai_output`: raw, processed · `ai_media`: text, image, audio, video, none · `algo`: no, yes · `social`: none, post, profile, group, live · `companion`: no, yes · `scale`: prelaunch, small, large · `pi`: none, general, sensitive · `minors`: no, maybe, mainly · `cross_border`: no, lt10w, 10w_100w, gt100w。
多选题：`forms`、`charge`、`ai_media`、`social`、`pi`；其中 `charge` 的 free、`ai_media` 的 none、`social` 的 none、`pi` 的 none 与同题其他选项互斥（同时出现记为 invalid）。
条件题：`ai_output` 仅在 `ai_use ∈ {cn_api, foreign_api}` 时必答；`ai_media` 仅在 `ai_use ≠ none` 时必答。

判定要点（`reasons` 用中文写出触发它的问卷事实）：
- `audience = internal`：除 `privacy_policy`、`pia`、`cross_border`、`mlps` 外全部 `na`，`notes` 加「仅内部使用：面向公众的备案类事项不适用」。
- 舆论属性 `social.value = social 含 post|profile|group|live`；`reason` 列出命中的功能，或「无公开传播功能」。
- `genai_register`：`audience=public` 且 `ai_use=cn_api` 且 `ai_output=raw` → required；`ai_output=processed` → 改为 `genai_filing` maybe。
- `genai_filing`：`audience=public` 且 `ai_use=own` → required。
- `ai_use=foreign_api` 且 `audience=public`：`genai_register`、`genai_filing` 均 `maybe`，`notes` 加境外模型提示（设计第 3 节原文）。
- `algo_filing`：舆论属性为真 且（`algo=yes` 或 `ai_use≠none`）→ required。
- `security_assess`：舆论属性为真 → required。
- `model_disclosure`：`ai_use ∈ {cn_api}` 且 `audience=public` → required。
- `aigc_label`：`ai_media` 含 text|image|audio|video 且 `audience≠internal` → required。
- `anthro_selfcheck`：`companion=yes` 且 `audience=public` → required；`anthro_assess`：再加 `scale=large` → required，`scale=small|prelaunch` → maybe。
- `icp_filing`：`forms` 含 web|app|miniapp 且 `audience≠internal` → required；`icp_license`：再加 `charge` 含 paid|ads|commerce → required；`app_filing`：`forms` 含 app|miniapp；`psb_filing`：`forms` 含 web；`mlps`：`forms` 含 web|app|miniapp|api → required。
- `privacy_policy`：`pi≠none` → required；`pia`：`pi` 含 sensitive 或 `cross_border≠no` → required；`cross_border`：`cross_border≠no` → required，`reasons` 按档位写出「免申报 / 标准合同或认证 / 安全评估」。
- `minor_protect`：`minors ∈ {maybe, mainly}` → required。
- `overseas=yes`：`notes` 加「有境外用户：境外法规（如 GDPR、EU AI Act）另行评估」。
- 未触发的事项一律 `na`，`reasons` 为空；`items` 包含全部 18 项，按 `order`（=`timingOrder`）再按目录顺序排序。

`nextDates`：`icp_license` → `due_at = doneAt + 5 年`，`remind_at = doneAt + 1 年`；`mlps` → `remind_at = doneAt + 1 年`，`due_at = null`；其他 → 都为 null。

- [ ] **Step 1: 核对依据**

对 18 项逐一打开官方原文（网信办、工信部、国务院网站），记录法规全称与条款号到 `/tmp/compliance-basis.md`；查不到原文的只写法规名。提交说明里附这份核对清单。

- [ ] **Step 2: 写失败的测试 `packs/compliance/rules.test.ts`**

用例与断言（`level(id)` 为取某事项档位的辅助函数）：
- `纯工具网站`：forms=[web]、public、free、ai none、pi=[general]、minors no、cross no、social [none] → required 恰为 {icp_filing, psb_filing, mlps, privacy_policy}，`social.value === false`。
- `调 API 的 AI 写作 App`：forms=[app]、public、charge=[paid]、cn_api、raw、ai_media=[text]、social [none] → required 含 genai_register、model_disclosure、aigc_label、icp_filing、icp_license、app_filing；`level('genai_filing') === 'na'`；`level('algo_filing') === 'na'`。
- 同上但 ai_output=processed → `level('genai_filing') === 'maybe'`，`level('genai_register') === 'na'`。
- `自研模型的陪伴应用`：own、companion yes、social [post]、scale large、pi=[sensitive]、minors maybe → required 含 genai_filing、algo_filing、security_assess、anthro_selfcheck、anthro_assess、pia、minor_protect；scale small 时 `level('anthro_assess') === 'maybe'`。
- `有境外用户的 SaaS`：forms=[web,api]、b2b、overseas yes、cross 10w_100w → `notes` 含「另行评估」；`level('cross_border') === 'required'` 且 reasons 含「标准合同或认证」；b2b 时 `level('genai_register')` 在 cn_api 下为 'na'。
- `仅内部使用`：internal → 除四项外全部 na，`notes` 含「仅内部使用」。
- `境外模型 API`：public + foreign_api → genai_register、genai_filing 均 maybe，`notes` 含「境外模型」。
- `validateAnswers`：缺题返回 missing；`charge` 为字符串 → invalid 含 charge；`pi=['none','general']` → invalid 含 pi；选项外值 → invalid；ai_use none 时缺 ai_output、ai_media 仍 ok。
- `每项都有依据与时点`：`CATALOG` 每项 basis、timing 非空；每个 link 以 `https://` 开头且 hostname 在常量名单内；`CATALOG.length === 18`；`QUESTIONS.length === 14`。
- `每个事项至少有一个触发用例`：遍历上面所有画像的结果，断言 `CATALOG` 中每个 id 至少在一个画像里不是 'na'。
- `nextDates`：icp_license 办结于 2026-01-01 → due 2031-01-01、remind 2027-01-01；mlps → remind 一年后、due null；icp_filing → 都 null。
- `同样输入同样结果`：`assess(a)` 两次 deepEqual。

- [ ] **Step 3: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test packs/compliance/rules.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `rules.ts`**

- [ ] **Step 5: 运行确认通过**，再跑 `sh /tmp/opc-check-ui.sh`，Expected: 全部通过、`TSC_OK`、`ALL PASS`

- [ ] **Step 6: 提交** `feat(compliance): 规则表与判定`（说明中附依据核对清单）

### Task 2: 迁移 11、存储与提醒（`store.ts`、`reminders.ts`）

**Files:**
- Modify: `packages/core/db.ts`（`MIGRATIONS` 末尾追加第 11 项，SQL 原样取设计第 4 节）
- Modify: `packs/kb/migrate.test.ts`、`packs/memory/migrate.test.ts`、`packs/wiki/migrate.test.ts`、`packs/pm/attachments.test.ts`、`packs/proto/store.test.ts`（`user_version` 断言 10 → 11；`packs/memory/migrate.test.ts` 的 `V5_DROP` 最前面加 `DROP TABLE IF EXISTS cp_items; DROP TABLE IF EXISTS cp_assessments; DROP TABLE IF EXISTS cp_products;`）
- Create: `packs/compliance/store.ts`、`packs/compliance/reminders.ts`
- Test: `packs/compliance/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `assess`、`AssessResult`、`Answers`、`nextDates`、`RULES_VERSION`、`CATALOG`
- Produces（`store.ts`，同步，出错抛 `CpError`）：
  - `export class CpError extends Error { status: 400 | 404 | 409; detail?: Record<string, unknown> }`
  - `export type ItemStatus = 'todo' | 'preparing' | 'submitted' | 'done' | 'na'`
  - `export interface ProductView { id; name; description; review_id: number | null; created_at; updated_at }`
  - `export interface ItemView { id; item; level: 'required' | 'maybe'; status: ItemStatus; stale: boolean; ref_no; done_at; due_at; remind_at; note; na_reason; explain; updated_at }`（可空字段为 `T | null`）
  - `export interface AssessmentView { id; created_at; rules_version; answers: Answers; prefilled: string[]; result: AssessResult }`
  - `createProduct(db, { name, description }, reviewId?: number | null, now?): number`
  - `updateProduct(db, id, patch: { name?: string; description?: string }, now?): void`
  - `deleteProduct(db, id): void`
  - `listProducts(db, now?): (ProductView & { required: number; open: number; alerts: number })[]`（按 `updated_at` 倒序）
  - `getProduct(db, id): { product; assessment: AssessmentView | null; items: ItemView[] }`（items 按 `CATALOG` 顺序）
  - `assessAndMerge(db, productId, answers, prefilled: string[], now?): { assessmentId: number; result: AssessResult }`
  - `updateItem(db, itemId, patch & { keep?: boolean }, now?): ItemView`（patch 可含 status、ref_no、done_at、due_at、remind_at、note、na_reason）
  - `saveExplain(db, itemId, text): void`；`getItem(db, itemId): (ItemView & { product_id: number }) | null`
- Produces（`reminders.ts`）：
  - `export const REMIND_DAYS = 30`
  - `export interface Reminder { itemId; productId; productName; item; name; kind: 'soon' | 'overdue'; date: number }`
  - `export function alertOf(it, now): { kind; date } | null`（取 `remind_at`、`due_at` 中较早的非空值；`status = na` 为 null）
  - `export function listReminders(db, now?): Reminder[]`（逾期在前，再按日期升序）

`updateItem` 规则：status 限五值；改为 `na` 时 `na_reason` 必须非空（≤200 字）；`ref_no` ≤100 字；日期为 ≥0 的安全整数；改为 `done` 且 `done_at` 缺省用 `now`；改为 `done` 且 `due_at`、`remind_at` 都为空时用 `nextDates` 填充；`keep: true` 或改为 `na` 都清除 `stale`；事务内完成。

- [ ] **Step 1: 写失败的测试 `packs/compliance/store.test.ts`**（setup 照 `packs/pm/pm.test.ts`）
  - `迁移 11：三张表存在，user_version=11`
  - `createProduct 校验`：名称空或 61 字 → 400；描述 8001 字 → 400；reviewId 不存在 → 404；带 reviewId 时 description 取 `pm_reviews.input`。
  - `assessAndMerge 新建台账`：AI 写作 App 画像 → 台账条数 = required + maybe 数；`cp_assessments` 一条且 `rules_version = 1`。
  - `assessAndMerge 保留手填字段`：判定后填 ref_no `京ICP备2026000001号`、note、status submitted；改答案再判定 → 三项不变，`assessment_id` 更新。
  - `不再适用只标 stale`：第二次去掉 App → `app_filing.stale === true`、status 不变；`keep: true` 后 stale false；另一条改 `na` + 原因后 stale false。
  - `maybe 升级为 required 时清除 stale 并更新 level`。
  - `updateItem 校验`：status 'x'、na 缺原因、ref_no 101 字、due_at -1 → 400；不存在 → 404。
  - `办结推算`：icp_license done、done_at 2026-01-01 → due 2031-01-01、remind 2027-01-01；手填过 due_at 的不覆盖。
  - `listReminders`：remind_at=now+10 天 → soon；due_at=now-1 天 → overdue 且排前；now+40 天、status na → 不出现。
  - `listProducts 计数`：required、open（非 done/na）、alerts。
  - `deleteProduct 级联`：三张表都无该产品数据；再删 → 404。
- [ ] **Step 2: 运行确认失败**：`node --disable-warning=ExperimentalWarning --test packs/compliance/store.test.ts`
- [ ] **Step 3: 实现迁移、`store.ts`、`reminders.ts`，更新 5 个迁移测试**
- [ ] **Step 4: `sh /tmp/opc-check-ui.sh` 全部通过**
- [ ] **Step 5: 提交** `feat(compliance): 迁移 11、台账存储与到期提醒`

### Task 3: 接口（`compliance-api.ts`）

**Files:**
- Create: `apps/server/compliance-api.ts`
- Modify: `apps/server/main.ts`（在 `handleProtoApi` 一行后加 `if (await handleComplianceApi({ db, llm: radar.llm, record }, req, res, method, url)) return;`）
- Modify: `packs/memory/events.ts`（`EventKind` 加 `'compliance_assess'`，`refType` 加 `'product'`）
- Test: `apps/server/compliance-api.test.ts`（测试服务器照 `apps/server/wiki-api.test.ts` 的 `setup()`）

**Interfaces:**
- Consumes: Task 1、2 全部导出；`HttpError`、`readJson`、`sendJson`（`apps/server/http.ts`）
- Produces:
  - `export interface ComplianceDeps { db: DB; llm: Llm; record?: (e: EventInput) => void; prefill?: PrefillFn; explain?: ExplainFn }`（`PrefillFn`、`ExplainFn` 类型由 Task 5 定义；本任务里先声明同名类型占位，未注入时这两个路由返回 501「尚未开放」，Task 5 接上默认实现）
  - `export async function handleComplianceApi(deps, req, res, method, url: URL): Promise<boolean>`（路径不以 `/api/compliance/` 开头返回 false）
  - 路由与错误码按设计第 6 节；`CpError` 映射为同状态码，`detail` 并入响应体。
  - `GET meta` → `{ version, questions: [{ id, title, multi, options, dependsOn? }], catalog, notice: '结果为自查参考，以属地主管部门口径为准。' }`
  - `POST products/:id/assess` 请求 `{ answers, prefilled?: string[], version: number }`：`version !== RULES_VERSION` → 409「问卷已更新，请刷新」；校验失败 → 400 `{ error: '问卷未答完或有非法选项', missing, invalid }`；`prefilled` 只留合法题 id；成功返回 `getProduct()`；随后 `deps.record?.({ kind: 'compliance_assess', refType: 'product', refId: id, summary: '合规自查：<产品名>', payload: { required: [中文名…] } })`，异常只记日志。
- 鉴权：由 `main.ts` 分发前统一校验，与其他 `handle*Api` 相同；本任务测试不覆盖 401，Task 7 线上用未登录 curl 确认。

- [ ] **Step 1: 写失败的测试**（每条一个 `test()`）：meta 结构（14 题、18 项、notice）；产品增删改查与 400/404；assess 的 400（`missing` 正确）、409、成功后返回台账且 record 调用一次、`payload.required` 为中文名；`PATCH items/:id` 的 400/404/成功；`GET reminders`；prefill/explain 未注入时 501；非法 id（`abc`、`0`）→ 400；未知子路径 → 404 `{ error: '接口不存在' }`。
- [ ] **Step 2: 运行确认失败**：`node --disable-warning=ExperimentalWarning --test apps/server/compliance-api.test.ts`
- [ ] **Step 3: 实现并接入 `main.ts` 与 `events.ts`**
- [ ] **Step 4: `sh /tmp/opc-check-ui.sh` 全部通过**
- [ ] **Step 5: 提交** `feat(compliance): 接口`

### Task 4: 前端页面（`compliance.js`）

**Files:**
- Create: `apps/server/public/compliance.js`
- Modify: `apps/server/public/index.html`（顶部菜单在「产品顾问」后加 `<button data-view="compliance" …>合规</button>`；`<main>` 内加 `<section id="view-compliance" hidden>`，内含 `#cp-side`（产品列表）、`#cp-tabs`（`pm-tabs kb-tabs`）、`#cp-main`）
- Modify: `apps/server/public/app.js`（`TAB_VIEWS` 加 `'compliance'`，放在 `'pm'` 之后；`show()` 的视图列表加 `compliance`，进入时调用 `cp.load()`；`import { initCompliance } from './compliance.js'`；`const cp = initCompliance({ h, api, toast, show, safeHref })`；`init()` 里调用 `cp.refreshBadge()`）
- Modify: `apps/server/public/style.css`（`.cp-*` 样式块追加在文件末尾；菜单角标 `.tab-badge`）
- Modify: `/tmp/opc-ui-sim.mjs`（加载 `compliance.js` 的方式照现有 `kb.js` 拼接：去掉 `export`，去掉 `app.js` 里对它的 import 行；补 `GET /api/compliance/*` 路由）

**Interfaces:**
- Consumes: Task 3 的接口
- Produces: `initCompliance(deps) → { load(): Promise<void>; refreshBadge(): Promise<void>; newFromReview(reviewId: number): Promise<void> }`（Task 7 用 `newFromReview`）

页面行为（设计第 8 节）：
- 左栏产品列表：名称、「必须办 n」、有提醒时红色数字；「新建产品」打开表单（名称、描述、「从产品顾问评审带入」下拉，选项来自 `GET /api/pm/reviews`）。
- 子标签「问卷 / 判定结果 / 台账」；新建后默认「问卷」，已有判定的产品默认「判定结果」；选中的子标签按产品记在内存里。
- 问卷：单选用 `chip` 按钮组，多选同样，互斥选项点选时自动取消其他；条件题在不满足时隐藏；「判定」按钮在答完前禁用并显示「还有 n 题未答」。
- 判定结果：三组标题「必须办 / 可能需要 / 不适用（折叠）」；每项显示名称、主管部门、依据、办理时点、触发理由、官方链接（`safeHref`，`target=_blank rel=noopener noreferrer`）；顶部显示舆论属性结论与理由、`notes`、规则版本与判定时间、固定提示文案。
- 台账：表格；状态下拉、编号输入框、办结日期与到期日 `type=date`；失焦或改动即 `PATCH`，失败 toast 并恢复原值；改为「不适用」时 `prompt` 原因，取消则恢复；`stale` 行显示「最新判定已不再适用」与「确认不适用 / 保留」两个按钮；顶部状态筛选（全部 / 未办结 / 有提醒）。
- 菜单角标：`GET reminders` 的条数 >0 时在「合规」按钮内追加 `<span class="tab-badge">n</span>`，0 时移除；进入合规页、台账改动后都刷新。
- 删除产品：`confirm('删除「名称」及其判定和台账？')`。

- [ ] **Step 1: 在 UI 模拟里写失败的断言**（新段落「✓ 合规：新建、问卷、判定、台账、角标」）：
  - `index.html` 默认顺序里 `compliance` 紧跟在 `pm` 后（用模拟里按 HTML 顺序收集的 `tabs` 列表）。
  - 模拟预置了旧的菜单顺序，新菜单按 `savedTabOrder` 规则追加到末尾：把现有三处顺序断言（初始化迁移、拖动后、Alt+→ 后）各在末尾补上 `'compliance'`。
  - 进入后左栏显示 2 个产品；新建表单提交 body 为 `{ name: '写作助手', description: '…' }`。
  - 问卷未答完时判定按钮 disabled 且文案含「未答」；选择 `ai_use=none` 后 `ai_output` 题不显示。
  - 判定请求 body 含 `version: 1`；结果页「必须办」组含模拟返回的 `ICP 备案`；官方链接 `href` 以 `https://` 开头。
  - 台账把状态改为「已办结」发出 `PATCH /api/compliance/items/31` body `{ status: 'done' }`；改为「不适用」且 prompt 返回 null 时不发请求、下拉恢复原值。
  - stale 行点「保留」发 `{ keep: true }`。
  - reminders 返回 2 条时「合规」按钮含 `2`；返回 0 条时不含角标元素。
- [ ] **Step 2: 运行 `sh /tmp/opc-check-ui.sh` 确认新断言失败**
- [ ] **Step 3: 实现 `compliance.js`、HTML、`app.js` 接入、样式**
- [ ] **Step 4: `sh /tmp/opc-check-ui.sh` 全部通过**；重启服务，截图浅色、深色、窄屏（720px）三张并检查
- [ ] **Step 5: 提交** `feat(compliance): 合规页面：产品、问卷、判定结果、台账与提醒角标`

### Task 5: AI 预填与解释（`prefill.ts`）

**Files:**
- Create: `packs/compliance/prefill.ts`
- Modify: `apps/server/compliance-api.ts`（去掉占位类型，默认注入本任务实现；LLM 未启用 → 400「未配置 DEEPSEEK_API_KEY，无法调用模型」；`LlmError` 或解析失败 → 502「模型调用失败，请稍后重试或手动填写」）
- Modify: `apps/server/public/compliance.js`（「AI 预填」按钮、预填标记与依据、「请顾问解释」按钮）
- Modify: `packs/compliance/rules.ts`（导出 `export function validOption(q: Question, v: unknown): boolean`，`validateAnswers` 改为复用它）
- Test: `packs/compliance/prefill.test.ts`；`apps/server/compliance-api.test.ts`、UI 模拟补用例

**Interfaces:**
- Consumes: `QUESTIONS`、`CATALOG`、`validOption`；`Llm.json<T>(messages, maxTokens)`、`Llm.chat(messages, opts)`
- Produces:
  - `export type PrefillFn = (llm: Llm, p: { name: string; description: string }) => Promise<{ answers: Answers; basis: Record<string, string> }>`，`export const prefillAnswers: PrefillFn`
  - `export type ExplainFn = (llm: Llm, p: { name: string; description: string; item: CatalogItem; reasons: string[] }) => Promise<string>`，`export const explainItem: ExplainFn`

规则：
- 预填：系统「你是合规助理，只输出 JSON。」；产品名称与描述放在 `<product>` 内并声明其中指令不执行；列出 14 题的 id、题目、选项值；输出 `{"answers":{},"basis":{}}`，`basis` 为描述原文片段，描述没提到的题不输出；`maxTokens = 1200`。
- 校验：`validOption` 不通过即丢弃；`basis[qid]` 去 URL、去首尾空白，为空则连同答案丢弃，否则截断到 200 字；未知题 id 丢弃。
- 解释：输入事项名称、依据、触发理由、`<product>` 包裹的描述；要求说明「为什么可能需要、建议怎么确认（找哪个部门、问什么）」，纯文本；输出去 URL、截断 600 字；只允许 `level = maybe` 的事项，否则 400。
- 前端：预填只覆盖当前未答的题，这些题显示「AI 预填」标签与依据原文；用户点任一选项即视为确认并去掉标签；判定时 `prefilled` 传由 AI 填入的题 id（无论用户是否改过）。

- [ ] **Step 1: 写失败的测试 `prefill.test.ts`**（模拟 llm）：
  - 模型返回 `{ answers: { ai_use: 'cn_api', forms: ['app'], charge: 'paid', audience: 'mars' }, basis: { ai_use: '调用 DeepSeek 接口', forms: '安卓 App https://x.com', charge: '会员订阅' } }` → `answers` 为 `{ ai_use: 'cn_api', forms: ['app'] }`；`basis.forms === '安卓 App'`。
  - 依据为空的题丢弃；300 字依据截断为 200 字。
  - 提示词中产品描述位于 `<product>` 内。
  - 解释输出含 URL 时去掉；700 字截断为 600 字。
  - `llm.json` 抛错时 `prefillAnswers` 抛出。
- [ ] **Step 2: 接口测试补**：未启用 LLM → 400；注入抛错的 prefill → 502；explain 对 required → 400，对 maybe 成功并写入 `explain`。
- [ ] **Step 3: UI 模拟补**：点「AI 预填」后 `ai_use` 题有「AI 预填」与依据；点选其他选项后标签消失；判定 body 的 `prefilled` 含 `ai_use`；「请顾问解释」显示返回文本。
- [ ] **Step 4: 运行确认失败，实现，`sh /tmp/opc-check-ui.sh` 全部通过**
- [ ] **Step 5: 提交** `feat(compliance): AI 预填问卷与灰色事项解释`

### Task 6: 监管信息源（`page-list`）

**Files:**
- Modify: `packages/core/feed.ts`（新增 `export function parsePageList(html: string, pageUrl: string): FeedEntry[]`）
- Modify: `packs/radar/collect.ts`：
  - `SourceDef.kind` 加 `'page-list'`；`GROUPS` 加 `reg: '合规监管'`；
  - 把采集循环里按 kind 选解析器的那段抽成 `export function parseEntries(src: Pick<SourceRow, 'kind' | 'url'>, text: string): FeedEntry[]`（行为与现状一致，另加 page-list 分支；page-list 解析为 0 条时抛 `页面结构可能已变化（未解析到文章链接）`；原有 feed 的「不是 RSS/Atom」判断也移进来）。
- Modify: `packs/radar/sources.json`：加两条（`kind: "page-list"`、`grp: "reg"`、`lang: "zh"`、`maxItems: 20`）：`cac-wxfb`「网信办·网信发布」`https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm`；`cac-zcfg`「网信办·政策法规」`https://www.cac.gov.cn/wxzw/zcfg/A093703index_1.htm`；`$comment` 里的 kind、grp 说明同步。
- Test: `packages/core/core.test.ts`（`parsePageList`）、`packs/radar/radar.test.ts`（`parseEntries`）

**Interfaces:**
- Produces: `parsePageList(html, pageUrl): FeedEntry[]`，每条 `{ title, url, publishedAt?, content: '' }`；`parseEntries(src, text): FeedEntry[]`

解析规则：逐个匹配 `<li …>…</li>`；取其中第一个 `<a href=…>`（属性值可带或不带引号）；`href` 以 `//` 开头补 `https:`，相对路径按 `pageUrl` 解析；只保留 hostname 与 `pageUrl` 相同、pathname 匹配 `/^\/\d{4}-\d{2}\/\d{2}\/c_\d+\.htm$/` 的链接；标题取 `title` 属性，没有则取链接文字，经 `decodeEntities` 并折叠空白，空则丢弃；`publishedAt` 取同一 `<li>` 内第一个 `YYYY-MM-DD`，按东八区 00:00 转时间戳；按 url 去重，保持页面顺序。

- [ ] **Step 1: 写失败的测试**：
  - 网信办真实片段（无引号 `href=//www.cac.gov.cn/2026-11/10/c_1796065949954025.htm`、`title="…"`、`<div class="times">2026-11-10</div>`）→ url 为 `https://www.cac.gov.cn/2026-11/10/c_1796065949954025.htm`，`publishedAt === Date.UTC(2026, 10, 9, 16)`。
  - `href="javascript:void(0);"`、站外 `https://evil.example/2026-11/10/c_1.htm`、栏目页 `//www.cac.gov.cn/wxzw/A0937index_1.htm` 都被丢弃。
  - 同一 url 两次只留一条；`&ldquo;清朗&rdquo;` 解码为 `“清朗”`。
  - `parseEntries({ kind: 'page-list', url }, '<ul><li>无链接</li></ul>')` 抛出含「页面结构可能已变化」；`kind: 'feed'` 传非 XML 仍抛「不是 RSS/Atom」。
- [ ] **Step 2: 运行确认失败，实现，`sh /tmp/opc-check-ui.sh` 全部通过**
- [ ] **Step 3: 线上验证**：重启服务后 `npm run radar:run`，日志出现 `✓ 网信办·网信发布: n 条` 与 `✓ 网信办·政策法规: n 条`（n>0）
- [ ] **Step 4: 提交** `feat(radar): page-list 信息源与网信办公告`

### Task 7: 联动与收尾

**Files:**
- Modify: `apps/server/public/app.js`（`renderHead` 评审操作区在「用相同内容和框架再评一次」后加「做合规自查」，点击 `show('compliance'); cp.newFromReview(r.id)`）
- Modify: `apps/server/public/compliance.js`（`newFromReview(id)` 打开新建表单并选中该评审；页面右上角「监管动态」：`show('feed')` 后把 `#grp` 设为 `reg` 并触发 change）
- Modify: `README.md`（目录表加 `packs/compliance`：「合规：备案判定规则、台账与到期提醒」）
- Test: UI 模拟补断言

- [ ] **Step 1: UI 模拟写失败断言**：评审 #8 头部有「做合规自查」；点击后合规页新建表单的评审下拉值为 `8`；点「监管动态」后 `view-feed` 可见、`#grp` 值为 `reg`、发出带 `grp=reg` 的 items 请求。
- [ ] **Step 2: 运行确认失败，实现，`sh /tmp/opc-check-ui.sh` 全部通过**
- [ ] **Step 3: 线上验证**：重启服务；未登录 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4180/api/compliance/meta` 为 401；登录截图问卷、判定结果、台账（浅色、深色、720px）；用「调 API 的 AI 写作 App」画像实际判定一次，人工核对与 Task 1 测试一致；截图后删除临时会话、关闭浏览器
- [ ] **Step 4: 提交** `feat(compliance): 产品顾问入口、监管动态联动与文档`；用 `git show HEAD:<file> | grep -c` 核对各文件已落盘
