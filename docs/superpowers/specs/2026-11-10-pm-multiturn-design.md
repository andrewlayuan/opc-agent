# 产品顾问：多轮对话、文档版本与下载（第一期）设计

日期：2026-11-10
范围：三期规划中的第一期（A）。B（统一交互日志与长期记忆）、C（技能沉淀与画像自更新）另行设计。

## 1. 目标与成功标准

用户在产品顾问拿到首版评审后，能在同一会话里继续迭代：

- 追问：得到简短回答，文档不变。
- 修改要求：得到一份完整的新版本文档。
- 由模型自动判断是追问还是修改；输入框提供「改写文档」开关，打开时强制改写。
- 每个版本都能查看、切换、复制、下载 Markdown、打开打印页另存 PDF。
- 每个版本都能手动编辑 Markdown 原文，保存后成为「手动修改」新版本，之后的对话基于它进行。
- 会话、消息、版本都持久保存在本机 SQLite，历史列表可回到任一会话继续。

成功标准：

- 已有评审迁移后显示为该会话的 v1，内容不丢。
- 一次追问只调用一次模型；回答模式 120 秒内完成，改写模式与首版评审耗时相当。
- 打印页和下载内容不执行任何来自模型或用户的 HTML 或脚本。
- 后端测试与 UI 模拟流程全部通过，tsc 检查无报错。

不在本期范围：跨会话记忆、交互日志、技能沉淀、Word 导出、多人协作。

## 2. 数据模型

新增第 4 个迁移（`packages/core/db.ts` 的 `MIGRATIONS` 末尾追加一项）：

```sql
CREATE TABLE pm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  kind TEXT NOT NULL,              -- 'ask' | 'revise'（user 填请求模式；assistant 填实际结果）
  content TEXT NOT NULL DEFAULT '',
  version_n INTEGER,               -- assistant 改写时产出的版本号
  status TEXT NOT NULL DEFAULT 'done', -- 'running' | 'done' | 'error'
  error TEXT
);
CREATE INDEX pm_messages_review ON pm_messages(review_id, id);

CREATE TABLE pm_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,            -- 'ai_initial' | 'ai_revise' | 'manual'
  content TEXT NOT NULL,
  message_id INTEGER,              -- 触发改写的 assistant 消息
  note TEXT,                       -- 变更说明（模型给出，或手动版为空）
  UNIQUE (review_id, n)
);

ALTER TABLE pm_reviews ADD COLUMN updated_at INTEGER;

INSERT INTO pm_versions(review_id, n, created_at, source, content)
  SELECT id, 1, coalesce(finished_at, created_at), 'ai_initial', content
  FROM pm_reviews WHERE status = 'done' AND content IS NOT NULL;
UPDATE pm_reviews SET updated_at = coalesce(finished_at, created_at);
```

约定：

- 首版评审完成时同时写入 `pm_reviews.content`（兼容）和 `pm_versions` v1。
- 新版本号取同一会话当前最大 n 加 1，在事务中插入；`UNIQUE (review_id, n)` 兜底。
- 新增消息或新版本时更新 `pm_reviews.updated_at`，历史列表按它倒序。
- 删除会话会通过外键级联删除消息与版本（`foreign_keys = ON` 已开启）。

## 3. 后端（`packs/pm/advisor.ts`）

新增方法：

- `get(id)`：在现有返回字段之外增加 `messages`（全部）、`versions`（只含 n、source、created_at、note）、`latest`（最新版本号）；`content` 改为最新版本正文。
- `version(id, n)`：返回某一版的正文。
- `ask(id, text, mode)`：发起一轮追问，返回 assistant 消息 id，在后台执行。
- `saveManual(id, content, baseN)`：保存手动版本。
- `exportMarkdown(id, n)`：返回下载用的文本，带一个简短的头部（标题、版本、时间、原始需求），以及引用来源列表。

### 3.1 追问的校验

依次检查，不通过就抛出中文错误，由 API 转成 400 或 409：

1. 会话存在，且首版已完成（`status = 'done'`）。否则提示「首版评审完成后才能继续对话」。
2. `text` 去掉首尾空白后为 2–4000 字。
3. `mode` 只能是 `auto` 或 `revise`，其他值按 `auto` 处理。
4. 同一会话没有 `status='running'` 的消息，否则返回 409「上一轮还在进行中」。
5. 全局运行中的任务数（首版加追问）不超过 `MAX_RUNNING = 2`。

通过后，在一个事务里插入 user 消息（status done）和 assistant 消息（status running），然后在后台执行。

### 3.2 上下文组装

system 提示词：

- 资深商业化 PM 的角色设定，沿用首版的语气与原则。
- 本会话所用框架的说明。从 `pm_reviews.skills` 读取，总预算 20000 字，按框架数量均分。
- 输出协议（见 3.3）。

messages：

1. user：首版的原始需求，以及首版的雷达引用（编号、标题、来源，与首版一致，便于延续 [n] 角标）。
2. assistant：「当前文档（v{n}）」，加上最新版本全文。
3. 最近的对话轮次，从新往旧累加，总长不超过 12000 字，超出时丢弃最早的轮次。失败的轮次不放入。改写轮次的 assistant 内容只放变更说明，不放全文，因为最新全文已在第 2 条里。
4. user：本次输入。`mode = revise` 时附加一句「本轮要求：输出改写后的完整文档」。

### 3.3 输出协议与解析

要求模型第一行只输出 `[改写]` 或 `[回答]`。

- `[改写]`：随后是完整的新文档 Markdown；文档结束后另起一行写 `---变更说明---`，后面用一句话说明改了什么（不超过 80 字）。
- `[回答]`：随后是简短回答，不超过 1500 字。

解析规则（纯函数 `parseTurn(raw, mode)`，单独测试）：

- 去掉开头的空白后，匹配第一行的标记，全角或半角方括号都接受。
- 没有标记时：`revise` 模式把全文当作改写，`auto` 模式当作回答。
- `revise` 模式下模型返回了 `[回答]`，仍按回答处理，同时在消息里如实显示，不强行生成版本。
- 改写结果去掉 URL 后为空，或少于 200 字，视为失败，提示「模型没有返回完整文档」，避免用残缺内容覆盖。
- 变更说明缺失时，使用「根据你的要求修订」。

调用参数：

- 改写（`revise` 模式，或 `auto` 下模型选择改写）：`maxTokens 8000`，`timeoutMs 300000`。
- auto 无法预知走哪一路，统一按改写的参数调用。回答本身较短，不会因此变慢。

结果写入：

- 改写：在事务中插入新版本（`source = 'ai_revise'`，带 note），然后把 assistant 消息更新为 `kind = 'revise'`、`content = note`、`version_n = n`、`status = 'done'`。
- 回答：把 assistant 消息更新为 `kind = 'ask'`、`content = 回答`、`status = 'done'`。
- 失败：消息 `status = 'error'`，`error` 截断到 300 字。

### 3.4 手动版本

- `content` 去掉首尾空白后为 1–40000 字。
- `baseN` 必须等于当前最新版本号，否则返回 409「已有更新的 v{latest}」。
- 有进行中的轮次时也返回 409，因为它可能马上产出新版本。
- 插入时 `source = 'manual'`，`note` 为空，不产生对话消息。

### 3.5 启动时的清理

服务重启后，仍为 running 的 assistant 消息改为 error「服务重启，已中断」。写在构造函数中现有首版清理语句旁边，现有语句为 `UPDATE pm_reviews SET status='error' ... WHERE status='running'`。

## 4. API（`apps/server/main.ts`）

全部要求登录；写操作要求同源（沿用现有中间件）；路径中的 id 和 n 用 `\d+` 匹配后转为整数。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/pm/reviews/:id` | - | `{review}`，含 messages、versions、latest、content |
| GET | `/api/pm/reviews/:id/versions/:n` | - | `{version: {n, source, created_at, note, content}}` |
| POST | `/api/pm/reviews/:id/messages` | `{text, mode}`，最大 16KB | 202 `{messageId}` |
| POST | `/api/pm/reviews/:id/versions` | `{content, baseN}`，最大 96KB | 201 `{n}` |
| GET | `/api/pm/reviews/:id/versions/:n/download` | - | `text/markdown; charset=utf-8`，以附件形式下载 |
| GET | `/print/pm/:id/:n` | - | `text/html`，需要登录，未登录跳转登录页 |

- 下载文件名为 `opc-review-{id}-v{n}.md`，只由数字组成，不包含任何用户输入；同时设置 `X-Content-Type-Options: nosniff`。
- 打印页使用现有的 CSP 响应头（`style-src 'self'`，不允许内联样式），不含任何 `<script>`，样式通过外链 `/print.css` 引入。`print.css` 加入 `staticFor` 白名单，与其他静态资源一样无需登录，因为它不含数据。
- `/print/pm/...` 不在 `/api/` 下，所以在静态分发之前单独处理：未登录时 302 跳转到 `/login`，会话或版本不存在时返回 404 纯文本页。
- `GET /api/pm/reviews` 列表每项增加 `latest`（版本数）、`turns`（user 消息数）、`updated_at`。

## 5. 打印页渲染（新文件 `packs/pm/render.ts`）

纯函数 `renderPrintHtml(view, version)`，输出完整的 HTML 文档字符串。

- 先用 `escapeHtml` 处理所有文本，转义 `& < > " '`，再识别以下结构：`#`–`####` 标题、无序和有序列表、`**粗体**`、行内代码、代码块、`|` 表格、引用块、分隔线、段落。
- 不支持原始 HTML，不生成任何链接，因为模型输出中的 URL 已被剔除；引用来源只显示标题和来源名称。
- `[n]` 角标原样保留为文本。
- 页面内容依次为：标题「产品顾问评审 · v{n}」、模式标签、生成时间、版本来源、原始需求（引用块）、正文、引用来源列表、页脚提示「浏览器 打印 → 另存为 PDF」。
- `print.css`（新增，加入 `apps/server/http.ts` 的静态白名单）：A4 页面，正文 11pt，表格加边框，`@media print` 下隐藏提示，避免在标题后分页。

## 6. 前端（`apps/server/public/`）

`index.html` 的 `#pm-result` 结构不变，内部由 `renderReview` 重新生成。

- **版本栏** `.pm-versions`：每个版本一个按钮，文字为「v{n}」，加上来源小字（首版、AI 改写、手动），当前查看的版本高亮，最新版本带「最新」标记。右侧依次是：复制全文、下载 .md（指向 `<a href=download>`，同源）、打印 / PDF（`target=_blank`，`rel=noopener`）、编辑。
- **文档区**：调用 `renderMarkdown(content, refs)`。切换版本时请求 `versions/:n`，按 `id:n` 缓存在内存中。
- **编辑态**：textarea 显示所查看版本的原文，提供「保存为新版本」和「取消」。保存时 `baseN` 取当前最新版本号。如果查看的不是最新版，先弹确认「将以 v{k} 为底稿生成 v{latest+1}」。409 时提示，并提供「查看最新」。
- **对话区** `.pm-thread`：
  - user 消息靠右显示。
  - assistant 的回答用 `renderMarkdown` 渲染。
  - 改写消息显示成一行「→ 生成了 v{n}：{note}」，点击切换到该版本。
  - running 状态显示「思考中…」；error 状态显示原因和「重试」按钮，重试会用原文本和原模式再发一次。
- **输入区** `.pm-reply`：
  - textarea（2–4000 字）、「改写文档」复选框、字数统计、发送按钮。
  - Ctrl/Cmd+Enter 发送。
  - 有 running 轮次时禁用；发送后清空输入并开始轮询。
- **轮询**：沿用 `pm.pollTimer`。首版或任一轮次处于 running 时，每 3 秒请求一次详情；出现新版本时自动切换到最新版。
- **历史列表**：每项显示「v{latest} · {turns} 轮」和更新时间。
- 所有文本只通过 `textContent` 和 `h()` 写入，不使用 innerHTML。

## 7. 错误处理

| 情况 | 表现 |
|---|---|
| 首版未完成就追问 | 400，输入区禁用并提示 |
| 上一轮未结束 | 409，提示「上一轮还在进行中」 |
| 全局并发已满 | 400，提示稍后再试 |
| 模型超时或报错 | 该轮显示 error 和重试按钮，文档不变 |
| 改写结果过短或为空 | 该轮 error「模型没有返回完整文档」，不生成版本 |
| 手动保存时有了更新的版本 | 409，提示并提供查看最新 |
| 版本或会话不存在 | 404 |
| 服务重启时有轮次在进行 | 启动时标记为 error「服务重启，已中断」 |

## 8. 测试

`packs/pm/pm.test.ts` 扩展（模型用现有的 fake Llm）：

- 迁移回填：已完成的旧评审得到 v1，`updated_at` 已填写。
- `parseTurn`：两种标记，全角或半角方括号，缺少标记时 auto 与 revise 的兜底，缺少变更说明，内容过短视为失败。
- `ask`：回答不产生版本；改写产生 v2，note 正确；同一会话已有进行中的轮次时拒绝；首版未完成时拒绝。
- 上下文组装：包含最新版本全文；历史超出预算时丢弃最早的轮次；失败的轮次不放入。
- `saveManual`：生成 manual 版本；baseN 过期时返回冲突；之后的 `ask` 以手动版本为底稿。
- 删除会话会级联删除消息与版本。
- `renderPrintHtml`：`<script>`、`<img onerror>`、`"` 等内容被转义并原样显示；表格、列表、标题正确渲染；不出现 `href` 或 `src`。
- 下载：文件名格式、Content-Type、附件头（在 main 层用路由级测试或手动 curl 验证）。

UI 模拟（`/tmp/opc-ui-sim.mjs` 扩展）：打开会话、发送追问后显示回答、改写后版本栏出现 v2 并自动切换、切换回 v1、编辑保存后生成 v3、409 时显示冲突提示、有进行中的轮次时输入框禁用。

## 9. 文件改动清单

- `packages/core/db.ts`：追加迁移。
- `packs/pm/advisor.ts`：get、version、ask、saveManual、exportMarkdown，以及上下文组装与启动清理。
- `packs/pm/turn.ts`（新增）：`parseTurn`、上下文裁剪等纯函数。
- `packs/pm/render.ts`（新增）：打印页渲染。
- `packs/pm/pm.test.ts`：新增测试。
- `apps/server/main.ts`：新增路由、下载和打印响应。
- `apps/server/http.ts`：静态白名单加入 `print.css`。
- `apps/server/public/app.js`、`style.css`、`print.css`（新增）：前端。
- `README.md`：产品顾问一节补充多轮对话、版本、下载说明。
