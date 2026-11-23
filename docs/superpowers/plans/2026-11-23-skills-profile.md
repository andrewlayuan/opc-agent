# 技能沉淀与画像自更新 实现计划

设计：`docs/superpowers/specs/2026-11-23-skills-profile-design.md`

## 全局约束

- 不引入第三方依赖；SQLite 走 `node:sqlite`，模型走 `packages/core/llm.ts`。
- 迁移只能追加在 `packages/core/db.ts` 的 `MIGRATIONS` 末尾（本期为 14），不改已有迁移。
- 用户与模型文本一律 `textContent`；提示词里的数据用 `fence()` 处理尖括号。
- 错误文案固定中文，HTTP 状态映射沿用 `MemoryError` → `HttpError`。
- 每个任务先写测试并确认失败，再实现；完成后跑 `node --test` 相关文件 + `sh /tmp/opc-check-ui.sh`。

## Task 1：迁移 14 与存储（`packs/memory/skills.ts`）

- 迁移 14：`skills`、`skill_revisions`、`profile_versions` 三张表 + 索引（设计第 4 节）。
- `skills.ts` 导出：
  - `SKILL_LIMITS = { max: 40, revMax: 20, profileRevMax: 50, nameMin: 8, nameMax: 40, sceneMin: 20, sceneMax: 200, stepsMin: 2, stepsMax: 8, stepMax: 200, cautionsMax: 5, cautionMax: 120, exampleMax: 600 }`
  - `validateSkill(input): SkillInput`（长度、条数、去空白；不合法抛 `MemoryError(400, ...)`）
  - `listSkills(db, o?: { status?: SkillStatus })`、`getSkill(db, id)`（含 `revisions: number`）
  - `createSkill(db, input, o: { source, status?, now? })`
  - `updateSkill(db, id, input, o: { origin, reason?, manual?, now? })`（写新版本；`manual=1`）
  - `setSkillStatus(db, id, status)`（`candidate|active|retired`，非法 400）
  - `deleteSkill(db, id)`
  - `listSkillRevisions(db, id)`、`restoreSkill(db, id, rev)`（写 `origin='restore'` 的新版本）
  - `writeProfile(db, content, o: { origin, reason?, eventIds?, now? })`：内容去空白后与当前相同 → 不写；否则把旧内容写进 `profile_versions`（若与最后一版相同则跳过），再更新 `profile`，同步 `memory_changes`。
  - `listProfileVersions(db)`、`restoreProfile(db, rev)`
  - `skillsText(db, ids)`：拼 `<skills>` 块（召回用，另见 Task 4）
- 上限：新增时 `COUNT(*) >= 40` → `MemoryError(409, '技能最多 40 条')`。
- 版本截断：写入后删除 `rev <= max(1, n - 19)` 的技能版本、`rev <= n - 49` 的画像版本。
- 测试 `skills.test.ts`：校验边界（7/8/40/41 字、步骤 1/2/8/9 条）、409 上限、版本截断、`manual` 不再被自动覆盖的判断由 Task 2 覆盖、画像「无实质变化不写版本」与回退。

## Task 2：沉淀（`packs/memory/crystallize.ts`）

- `buildCrystallizeMessages(events, existing, now)`：`<events>` 与 `<skills>` 围栏，声明只作素材；输出 `{"skills":[...]}` 含 `evidence`。
- `validateCrystals(out, events, existing)`：
  - 逐条校验字段（复用 `validateSkill`）；
  - `evidence` 去空白后必须逐字包含于至少 2 条事件的 `summary`（不满足丢弃）；
  - 与现有技能名归一化相同 → 归为 update；`manual=1` 的现有技能列为 `blocked`（不覆盖，页面提示）；
  - 最多 5 条新增 + 5 条更新。
- `crystallize(db, llm, o)`：读事件 → 调模型 → 校验 → 写库（新增 `candidate`、更新写新版本 `origin='auto'`）→ 返回 `{ added, updated, blocked, dropped }`。
- 测试 `crystallize.test.ts`：evidence 对不上被丢、重复名归并、manual 不覆盖、字段不合法被丢、模型异常 502。

## Task 3：调度与预算（`consolidate.ts` + `config.ts`）

- `config.ts` 增加 `skillDailyCalls: int('OPC_SKILL_DAILY_CALLS', 12, 0, 1000)`，0 表示停用；`skillsEnabled` 由 `OPC_SKILLS !== 'off'` 决定。
- `SkillKeeper`（放 `crystallize.ts`）：`notify()` 由 `MemoryKeeper` 的 `after` 钩子在整理完成后调用；条件判断在 `crystallize` 内：距上次成功 ≥ 3 天、上次成功后新增事件 ≥ 20、当日次数 < 预算。开关关、未配置模型、预算为 0 时 `notify` 不跑，`runNow` 返回 409。
- 每日次数直接按 `skill_runs` 当日行数统计（失败也算一次，避免反复重试刷调用），不另建 `meta` 表。
- `consolidate.ts` 画像写入改走 `applyProfile`（事务内版本的 `writeProfile`），带 40 字门槛、`profile_reason` 与事件 id；`undoChange` 撤销画像记 `restore` 版本，`clearMemory` 清画像版本。
- 测试：`consolidate.test.ts` 追加门槛、默认原因、撤销与清空；`keeper.test.ts` 追加 `after` 钩子与 `SkillKeeper` 的开关、并发、出错、停止。

## Task 4：召回与接入（`packs/memory/context.ts`、`packs/pm/advisor.ts`）

- `skillsFor(db, query, limit=3)`：只取 `active`；打分 = 三元组重合 ×2（name/scene）+ 步骤重合 + `hits` 归一化；截断 800 字/条、2000 字整块。
- 召回后 `uses+1`、`last_used_at`。
- `advisor.ts` 两处拼装（新建、追问）并入 `<skills>` 块；`deps.skills` 开关关闭时不拼。
- 测试：命中与不命中、开关关闭、`uses` 只加一次。

## Task 5：接口（`apps/server/memory-api.ts`）

- 设计第 8 节的路由；`GET /api/memory` 的响应追加 `skills`（仅计数与状态分布）、`profileVersions`（计数）、`skillsEnabled`、`crystallizing`。
- `POST /api/memory/skills/crystallize` 后台跑，返回 `{ started: true }`；`GET` 期间通过 `GET /api/memory` 的 `crystallizing` 轮询。
- 导出：`GET /api/memory/export?format=zip` 用 `packs/wiki/zip.ts` 打 `memories.json`、`skills.json`、`profile.md`、`profile-versions.json`；原 `?format=json` 行为不变（默认仍 json）。
- 测试 `memory-api` 已有测试文件追加：路由、状态码（400/404/409）、导出 zip 可被 `unzip -l` 读出。

## Task 6：页面（`apps/server/public/skills.js` + `index.html` + `app.js`）

- 「我的记忆」页加标签：`记忆` / `技能`；画像区下方加「画像历史」折叠区。
- `skills.js`：`initSkills({ h, api, toast, diffNodes })` → `{ load, renderProfileHistory }`。
  - 技能卡片按状态分组；每张：名称、何时用、步骤（有序）、注意、来源/版本、`采纳`/`停用`/`编辑`/`历史`/`删除`；
  - 「立即沉淀」按钮：未配置模型禁用并注明；运行中禁用并显示「正在沉淀…」；
  - 编辑表单：名称、何时用、步骤（逐条增删，2–8）、注意（逐条，0–5）、示例；
  - 历史：版本列表 + 与当前的差异（`diffNodes`）+ 回退。
- `index.html` 增加 `#mem-tabs`、`#mem-skills`、`#mem-profile-hist`；`app.js` 里切换标签，旧的渲染只在「记忆」标签激活时跑。
- 页面样式追加到 `style.css`（`sk-` 前缀，沿用现有变量）。

## Task 7：文档与验收

- README「我的记忆」追加技能与画像版本两段、`OPC_SKILLS` 与 `OPC_SKILL_DAILY_CALLS` 两个环境变量。
- `sh /tmp/opc-check-ui.sh` 追加「技能：沉淀、采纳、停用、编辑、历史、画像版本对比与回退」用例。
- 截图核对：宽屏与 390px 下的技能标签、编辑表单、画像历史。

## 风险

- 沉淀用模型归纳，容易写出空泛技能：靠 `evidence` 逐字校验 + 人工采纳挡一道。
- `consolidate.ts` 改动画像写入路径，牵动既有 383 行测试：先让所有既有测试通过再改，改完重跑。
- 事件只有 35 条时沉淀没意义：门槛 20 条未整理事件，测试里构造。
