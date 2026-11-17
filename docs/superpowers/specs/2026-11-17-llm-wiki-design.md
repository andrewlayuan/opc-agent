# LLM Wiki 知识层设计

日期：2026-11-17
范围：按 Karpathy「LLM Wiki」模式，在现有知识库（切段 + FTS5 trigram 检索）之上，增加一层由模型维护、页面互相链接的 Wiki。现有知识库保留，作为原始资料层，表结构和行为都不改。

## 1. 目标与成功标准

### 背景
现在的知识库是切段检索（RAG），每次评审都要从零开始拼凑原文片段，不会积累整理过的结论。LLM Wiki 的做法分三层：

- 原始资料：只读，是事实来源；
- Wiki：模型撰写，页面之间互相链接；
- 规范：写在提示词里，约定页面类型和写法。

操作有三种：摄入（ingest）、查询（query）和体检（lint）。

公开评测（1914 页文档、77 个问题）的结果：

| 方式 | 得分 |
| --- | --- |
| 只用 Wiki | 0.64 |
| 切段 RAG | 0.72 |
| Wiki + 它引用的原文 | 0.79 |

所以本设计让 Wiki 承担“知识地图和综合结论”的角色，召回时一定附上原文依据，不单独依赖 Wiki。

### 四个目的
用户确认四项都要：

1. 可以浏览的知识地图：实体页、概念页、页面互链、知识图谱。
2. 发现矛盾与缺口：定期体检。
3. 评审更聪明：召回整理好的结论，同时附带原文依据。
4. 直接向知识库提问：答案带引用，好的答案可以存回 Wiki。

### 成功标准
- 上传一份资料后，几分钟内自动生成它的摘要页，并新建或更新相关的实体页和概念页。页面里的关键结论都带 `[^doc:ord]` 引用，点击能打开原文对应的段落。
- 两份资料对同一件事说法不同时，相关页面会出现「矛盾」块，两边各附引用。下一次体检报告也会列出这条矛盾。
- 新开一个评审，需求里没提某个主题，评审也能用到 Wiki 里关于它的整理结论和原文依据。评审页的「参考了」一栏显示用到的 Wiki 页面。
- Wiki 为空或者没有命中时，评审召回结果和现在完全一样，因为会退回 `recallKb`。
- 任意一次摄入都可以一键撤销，页面恢复到摄入之前的样子，撤销本身也会留下记录。
- 「问 Wiki」给出带引用的回答；点「存为问答页」后，下次召回能检索到这个页面。
- 可以导出全部页面，或按页面类型、按知识库目录导出，得到一个 zip：纯文字的页面是 `.md`，可以直接用 Obsidian 打开；含图片的页面是 `.docx`。
- 每天的模型调用不超过上限，超出的任务顺延到第二天。
- 单元测试、接口测试和现有全部检查脚本都通过；用真实模型摄入现有 2 份资料，人工抽查合格。

### 不在本期范围
- 向量检索；
- 多用户；
- 从外部编辑器回写 Wiki（导出只读）；
- 模型生成图片；
- 雷达资讯自动进入 Wiki（必须先「存入知识库」）；
- 自动修复矛盾。

## 2. 关键决策（已与用户确认）

| 问题 | 决定 |
| --- | --- |
| 架构 | 方案 A：保留知识库作为原始资料层，新增 Wiki 层；召回时同时给 Wiki 页面和原文片段 |
| 摄入范围 | 只摄入知识库里的条目（上传资料、存入的评审、存入的资讯、笔记） |
| 改动如何生效 | 自动生效，可回滚：每页保留历史版本，日志列出每次的差异，可以撤销整次摄入 |
| 存储 | 页面放在数据库（`opc.db`）里；支持全部导出或按目录导出：不含图片的导出为 `.md`，含图片的导出为 `.docx` |
| 触发方式 | 入库后自动排队摄入，一次处理一条；每周自动体检一次，也可以手动触发；每天有模型调用上限 |

## 3. 数据模型（`packages/core/db.ts` 第 9 个迁移，`user_version` 8 → 9）

```sql
CREATE TABLE wiki_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,              -- [[链接]] 用的稳定名称，规范化后的小写形式
  kind TEXT NOT NULL,                     -- source | entity | concept | compare | overview | answer
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',       -- 一句话摘要，用来生成 index
  body TEXT NOT NULL DEFAULT '',          -- Markdown，含 [[slug]] 链接、[^doc:ord] 引用、![说明](asset:ID) 图片
  source_doc INTEGER UNIQUE REFERENCES kb_docs(id) ON DELETE SET NULL,  -- 只有 source 类页面填写
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX wiki_pages_kind ON wiki_pages(kind, updated_at DESC);

CREATE TABLE wiki_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                     -- ingest | lint | fix | generate | query_save | edit | restore | revert | ask（ask 只计入额度，不可撤销）
  doc_id INTEGER,                         -- ingest 对应的资料；不设外键，资料删除后仍保留
  target_op INTEGER,                      -- revert / retry 指向的 op
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error | reverted
  pages TEXT NOT NULL DEFAULT '[]',       -- JSON [{page_id, slug, from_rev, to_rev}]，from_rev=0 表示本次新建
  note TEXT NOT NULL DEFAULT '',          -- 摘要；lint 时存问题明细 JSON
  error TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX wiki_ops_status ON wiki_ops(status, id);

CREATE TABLE wiki_revisions (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  op_id INTEGER REFERENCES wiki_ops(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,     -- 1 表示这一版把页面删除了
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, rev)
);

CREATE TABLE wiki_links (
  from_page INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_slug TEXT NOT NULL,                  -- 可以指向还不存在的页（即缺页）
  PRIMARY KEY (from_page, to_slug)
);
CREATE INDEX wiki_links_to ON wiki_links(to_slug);

CREATE TABLE wiki_cites (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL,                -- 不设外键，资料删除后用于报告「依据已失效」
  ord INTEGER NOT NULL,
  PRIMARY KEY (page_id, doc_id, ord)
);
CREATE INDEX wiki_cites_doc ON wiki_cites(doc_id);

CREATE TABLE wiki_docs (                  -- 每份资料的摄入状态
  doc_id INTEGER PRIMARY KEY,
  body_hash TEXT NOT NULL,                -- 已摄入内容的哈希（按分段拼接后计算）
  state TEXT NOT NULL,                    -- done | error | reverted
  fails INTEGER NOT NULL DEFAULT 0,
  ingested_at INTEGER NOT NULL
);

CREATE TABLE wiki_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER REFERENCES wiki_pages(id) ON DELETE SET NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage TEXT NOT NULL UNIQUE,           -- data/wiki-assets/ 下的随机文件名
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE wiki_fts USING fts5(title, summary, body, tokenize='trigram');
-- 用 rowid = wiki_pages.id；插入、删除、更新三个触发器负责同步，写法同 kb_fts
```

### 约定
- **slug**：模型写 `[[DeepSeek V4]]`，保存时规范化为 slug（去掉首尾空白，英文转小写，连续空白和标点换成 `-`，最长 80 字）。指向不存在页面的链接照样保存，体检时作为「缺页」报出。
- **原文引用**：写作 `[^12:3]`，表示 `kb_docs` 12 号资料的第 3 段。保存时校验这一段存在；不存在的引用直接删掉，并记入这次 op 的 `note`。
- **资料被删除**：对应的 source 页保留，`source_doc` 置空；`wiki_cites` 里的记录不动，体检时报为「依据已失效」。
- **图片**：只来自手动编辑时上传，文件存在 `data/wiki-assets/`，权限 600。
- **`WIKI_LIMITS`**（`packs/wiki/types.ts`）：

  | 项 | 上限 |
  | --- | --- |
  | 页面数 `pages` | 3000 |
  | 单页正文 `bodyChars` | 20000 |
  | 每页保留版本 `revisionsKept` | 50（仍被 op 引用的 `from_rev`/`to_rev` 不清理） |
  | 单张图片 `assetMax` | 5MB |
  | 每次摄入改动页数 `ingestPages` | 15 |
  | 每次撰写页数 `writeBatch` | 3 |
  | 每日模型调用 `dailyCalls` | 200（环境变量 `OPC_WIKI_DAILY_CALLS`） |
  | 体检模型调用 `lintCalls` | 20 |
  | 召回 Wiki 部分 `recallWikiBudget` | 1500 字 |
  | 召回原文部分 `recallSrcBudget` | 1500 字 |
  | 提问时原文 `askSrcBudget` | 4000 字 |
  | 导出 zip `exportMax` | 200MB |
  | MCP 单页 `mcpPage` | 8000 字 |

## 4. 摄入

### 排队与调度（`packs/wiki/queue.ts`）
- 后台每 2 分钟扫描一次，只处理状态为 `ready` 的知识库条目。先调用 `refreshStale` 同步评审和资讯，再按 `kb_chunks` 计算内容哈希。以下情况入队：
  - `wiki_docs` 里没有这份资料；
  - 记录状态不是 `reverted`，且哈希和记录不一致。

  入队方式是新建一条 `ingest` op（状态 `queued`），同一份资料同一时间只允许有一条排队中的 op。知识库的写入代码不用改。
- 同一时间只执行一个 Wiki 任务，摄入、体检和缺页生成都在同一个队列里。产品顾问的评审或原型生成正在进行时，暂不开始新任务。
- 服务启动时，把遗留的 `running` op 改为 `error`（错误信息为「服务重启中断」），这份资料会在下次扫描时重新入队。
- **每日额度**：按本地日期统计当天所有 op 的 `llm_calls` 之和。没有用完时才开始新任务；进行中的任务允许超出，但最多超出一个任务的调用数。
- **失败处理**：自动重试最多 2 次（记在 `wiki_docs.fails` 里）。超过次数就停止自动重试，直到原文哈希变化或用户手动点「重试」。
- Wiki 任务的模型调用复用 `Llm` 实例，只占 1 个并发名额。

### 单份资料的步骤（`packs/wiki/ingest.ts`）
1. **找候选页**：用资料标题和各级标题生成三元组，在 `wiki_fts` 里检索，取前 40 页；再加上全部 overview 页，以及这份资料已有的 source 页。候选页面目录只包含 slug、类型、标题和一句话摘要。
2. **规划**（1 次调用，JSON 输出）：
   - 输入：带编号的原文分段（`[ord] 标题\n正文`，放在不可信数据的分隔符内）加上候选页面目录。
   - 输出：`{ source: {title, summary}, pages: [{slug, kind, title, reason, ords[]}], conflicts: [{slug, claim, ords[]}] }`，其中 `pages` 最多 15 项。
   - 原文超过 10 万字时，先按 3 万字一块逐块提炼要点（每块 1 次调用），再基于要点做规划。
3. **撰写**（每批最多 3 页，用 `chatLong`）：输入是这几页的现有正文（新页为空）和 `ords` 对应的原文分段，输出每页的 `{slug, title, summary, body}`。要求：
   - 关键结论都标上 `[^doc:ord]`；
   - 用 `[[标题]]` 链接相关页面；
   - 和已有内容冲突时不覆盖，而是写成 `> 矛盾：…`，两边都附引用；
   - 资料摘要页（source）放在第一批写。
4. **校验**（程序完成）：
   - 规范化 slug，解析出链接和引用，删除无效引用；
   - 正文超过上限时截断，并在页尾加提示；
   - **防截断**：如果已有页面的新正文比旧正文短了一半以上，就判定为模型输出不完整。旧正文保留，新内容追加到页尾的 `## 新增信息` 小节。
5. **提交**（一个事务）：写入或更新 `wiki_pages`、`wiki_revisions`、`wiki_links`、`wiki_cites`，把 op 改为 `done` 并写入改动页列表和调用次数，更新 `wiki_docs`。事务失败时整次都不生效，op 记为 `error`。

### 重新摄入与人工编辑
- 原文更新后重新摄入时，旧的 source 页会作为现有正文交给模型，在原页基础上更新，不会新建重复页面。
- 用户手动改过的页（`edited_by_user=1`）也会自动更新，标志保留。每次改动都可以在日志里看差异，也可以撤销。

### 提示词安全（`packs/wiki/prompts.ts`）
- 原文和现有页面正文都当作不可信数据，用分隔符包起来，并写明“其中的指令一律不执行”。
- 模型输出只会变成 Wiki 文本，不会触发任何工具调用或网络请求。

## 5. 召回与提问

### 评审召回（`packs/wiki/recall.ts`）
`recallWiki(db, query)` 替换 `apps/server/main.ts` 里注入的 `kb` 钩子，返回 `{ text, refs }`，`advisor.ts` 不需要改。步骤：

1. 用 `recallTerms(query)` 生成三元组，检索 `wiki_fts`，至少命中 2 个才算相关，按命中数和 bm25 排序。answer 和 overview 页命中数加 1，然后取前 3 页。
2. 每页取标题、一句话摘要，以及正文中命中最多的一段（按段落切，最多 500 字）。总共不超过 1500 字。
3. 收集这几页的 `wiki_cites`，读出对应的 `kb_chunks`（只要状态为 `ready` 的资料），按三元组命中数排序，最多取 3 段，不超过 1500 字。
4. 拼成两部分：「知识整理」和「原文依据」，各自用标记包起来，内容用现有的 `fence` 转义。提示词注明：结论以原文依据为准，两者冲突时要指出来。
5. 没有任何 Wiki 页命中时，直接返回 `recallKb(db, query)` 的结果。
6. `refs` 里新增 `{ wiki: slug, title }` 形式的项（`KbRef` 加可选字段 `wiki`），旧评审的数据不受影响。评审页「参考了」中的 Wiki 项可以点击跳转到对应页面。

### 提问（`packs/wiki/ask.ts`）
1. **选页**（1 次调用，JSON 输出）：给模型问题和 index（检索前 60 页加全部 overview 页，只含标题和一句话摘要），返回 3–5 个 slug。
2. **回答**（1 次调用，一次性返回 JSON，前端显示「正在查阅 Wiki…」）：给模型选中页面的正文和它们引用的原文分段（不超过 4000 字）。要求每个结论都标注 `[[页]]` 或 `[^doc:ord]`；依据不足时回答「知识库中没有相关内容」，不能编造。
3. 计入每日额度，额度用完时返回 429 和提示「今日额度已用完」。
4. **存为问答页**：根据问题生成 slug，正文是问题加回答，类型为 answer，记一条 `query_save` op，可以撤销。
5. 提问记录不单独存表。

### MCP（`mcp/opc-radar/server.ts`）
- 新增 `wiki_search`（`q`、`kind` → 页面列表）和 `wiki_page`（`slug`、`offset` → 正文分页，每页 8000 字）。
- 原有的 `kb_search`、`kb_doc` 保留。
- 说明文字更新为：有整理好的结论时优先用 `wiki_search` / `wiki_page`，需要细节或原文时用 `kb_doc`。

## 6. 体检（`packs/wiki/lint.ts`）

**触发**：每周一 03:00 自动运行；如果错过了（服务没在运行），就在启动后补跑。也可以手动点「立即体检」。体检是一条 `lint` op，和摄入走同一个队列。

**程序检查**（不调用模型）：
- 孤立页：没有任何反向链接，overview 页除外；
- 缺页：被链接但不存在的 slug，按被引用次数排序；
- 依据失效：引用的资料或分段已经不存在；
- 页面过时：引用的资料 `updated_at` 晚于页面的 `updated_at`；
- 无依据页：除 overview 和 answer 外，没有任何引用；
- 交叉链接缺失：正文出现了其他页面的完整标题（至少 3 个字），却没有用 `[[ ]]` 链接。

**模型检查**（不超过 `lintCalls` 次）：
- 矛盾：在链接图里把互相关联的页面每 3–5 页分一组，最近改过的页优先，让模型输出 `[{slugs, claim, cites}]`。
- 数据缺口：给模型 overview 页和缺页列表，输出建议补充哪类资料。

**输出**：问题明细存入 op 的 `note`（JSON）。

**自动修复**：只修两类问题，补交叉链接（在第一次出现标题的位置加上 `[[ ]]`）和删除失效引用，单独记为一条 `fix` op，可以撤销。矛盾和缺页只报告。缺页提供「生成此页」按钮，会根据链到它的页面的引用原文撰写，记为一条 `generate` op。

## 7. 回滚（`packs/wiki/revert.ts`、`diff.ts`）

- **撤销 op**：对它的 `pages` 逐页处理：
  - `from_rev=0`（本次新建）：生成一个 `deleted=1` 的版本，并把页面设为软删除（`wiki_pages.deleted=1`）；
  - 其他页：把 `from_rev` 的快照写成一个新版本。

  如果某页当前的 `rev` 已经不等于 `to_rev`（之后又被改过），就跳过这一页，返回冲突列表；带上 `force=true` 时强制恢复。撤销记为一条 `revert` op，原 op 状态改为 `reverted`。撤销的是 ingest 时，`wiki_docs.state` 置为 `reverted`，之后不会再被自动摄入。
- **软删除**：页面行和历史版本都保留，`wiki_pages.deleted=1`，同时写一版 `deleted=1` 的版本。删除时同步移除 `wiki_fts` 记录和这一页的 `wiki_links`、`wiki_cites`，恢复时重新写入。已删除页面的 slug 仍然被占用，新建同名页面时视为恢复这一页。
- **单页恢复**：恢复到指定 `rev`，记为一条 `restore` op。
- **差异**：服务端用基于最长公共子序列（LCS）的逐行 diff 计算，单页超过 2000 行时只显示前后各 200 行。

## 8. 导出（`packs/wiki/export.ts`）

**范围**：
- `all`：全部；
- `kind:<kind>`：某种页面类型；
- `folder:<id>`：这个知识库目录及其子目录下资料的 source 页，加上这些页面直接链接的 entity、concept、compare 页。

**目录结构**：
- `总览/`、`实体/`、`概念/`、`对比/`、`问答/`；
- `资料摘要/<知识库目录路径>/`；
- 根目录放 `index.md`（按类型分组，列出 `[[标题]]` 和一句话摘要）和 `log.md`（最近 200 条 op）。

**`.md` 文件**：
- 开头是 YAML 元数据：`slug`、`kind`、`updated`；
- `[[slug]]` 改写为 `[[标题]]`；
- `[^doc:ord]` 改写为脚注 `[^n]: 资料标题 › 段落标题`。

**`.docx` 文件**（正文含 `asset:`）：
- 服务端把 Markdown 渲染成 HTML：先转义所有文本，再生成标签；图片以 `data:` 形式内嵌；不包含任何外部资源链接（`<a>` 只保留文字和 URL 文本，不生成会被自动加载的资源）。
- 调用 `soffice --headless --convert-to docx`，复用 `packs/pm/convert.ts` 的执行方式：隔离的临时目录、参数数组、不经过 shell、超时 60 秒。
- 转换失败的页面改为导出 `.md`，图片放在同目录的 `<标题>.assets/` 下，并写入 `log.md`。

**zip 打包**：
- 用 `node:zlib` 的 `deflateRawSync` 实现最小的 zip 写入器（本地文件头、中央目录、CRC32，文件名以 UTF-8 标记），不引入第三方依赖。
- 先写到临时文件，再流式发送给浏览器，发送完删除。
- 超过 `exportMax` 时返回 413，并提示改为按目录导出。

**文件名**：
- 去掉 `/ \ : * ? " < > |` 和控制字符，以及开头的 `.`，最长 80 字；
- 同一目录下重名的加 ` (2)` 之类的序号；
- 路径一律由程序拼接，不会出现 `..`。

## 9. 页面（`apps/server/public/wiki.js`，在 `kb.js` 中挂载）

知识库页面顶部的标签：「资料」（即现有界面，不改）、「Wiki」、「问 Wiki」、「体检与日志」。样式沿用 `pm-tabs kb-tabs` 和 `--page-w` 宽布局。

### Wiki
- **左栏**：按类型分组的页面列表，带页数和搜索框；顶部有「导出」按钮，以及状态条（排队数、正在摄入的资料、今日已用 / 剩余调用次数）。
- **主区**：
  - 首页是知识图谱：SVG 力导向布局，自己实现，不用第三方库。超过 300 页时只显示链接最多的 300 页，以及当前页周围两层邻居。节点颜色区分类型，大小按反向链接数。支持缩放和拖动，点击节点打开页面。
  - 页面正文复用现有的 Markdown 渲染（必要时从 `app.js` 抽成公共函数），内容先转义再渲染：
    - `[[ ]]` 渲染为页面内跳转，缺页显示为红色虚线链接，点击后可以「生成此页」；
    - `[^doc:ord]` 渲染为上标，点击跳到「资料」里对应的段落。
- **右栏**：反向链接、引用的资料、版本号和更新时间，以及「编辑」「历史」「导出本页」按钮。
- **编辑**：Markdown 文本框，可以插入图片。保存时带上 `baseRev`，冲突时提示刷新。
- **历史**：版本列表，可以查看差异、恢复到某一版。

### 问 Wiki
输入框，请求期间显示进度提示，回答返回后显示，引用可以点击。下方有「存为问答页」按钮。

### 体检与日志
- 上方是最近一次体检报告，按问题类型分组，有跳转链接、「生成此页」和「立即体检」按钮。
- 下方是 op 列表，可以展开看每页的差异，有「撤销」按钮；失败的 op 有「重试」按钮。

### 「资料」里的小改动
- 每个条目显示 Wiki 状态：未编入、排队中、已编入、失败、已撤销。
- 条目上有「编入 / 重新编入」按钮。
- 条目详情页加一个链接「Wiki 摘要页」。

## 10. 接口（`apps/server/wiki-api.ts`，写法同 `kb-api.ts`）

所有接口都需要登录，写操作要经过现有的 `sameOrigin` 校验。SQL 一律用参数绑定，路径参数用白名单正则校验，slug 最长 80 字。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wiki/pages?kind=&q=` | 页面列表或搜索 |
| GET | `/api/wiki/pages/:slug` | 页面详情，含反向链接、引用和资料标题 |
| PUT | `/api/wiki/pages/:slug` | 编辑或新建，`{title, summary, body, baseRev}`，冲突返回 409 |
| POST | `/api/wiki/pages/:slug/generate` | 生成缺页（入队） |
| GET | `/api/wiki/pages/:slug/revisions` | 版本列表；`?rev=n&diff=1` 返回和当前版本的差异 |
| POST | `/api/wiki/pages/:slug/restore` | `{rev}` |
| POST | `/api/wiki/assets?page=` | 上传图片：octet-stream，只接受 png/jpg/gif/webp，按文件头识别，≤5MB |
| GET | `/api/wiki/assets/:id` | 读取图片，带 `nosniff`，使用识别出的 MIME |
| GET | `/api/wiki/graph` | 图谱的节点和边 |
| POST | `/api/wiki/ask` | 提问，返回 JSON（`Llm` 为整段返回，项目中没有 SSE） |
| POST | `/api/wiki/answers` | `{question, answer}` → 存为问答页 |
| GET | `/api/wiki/status` | 队列、额度、最近一次体检、各资料的 Wiki 状态 |
| POST | `/api/wiki/ingest/:docId` | 手动编入或重新编入（会清除 `reverted` 和失败次数） |
| POST | `/api/wiki/lint` | 立即体检 |
| GET | `/api/wiki/ops?before=&limit=` | 操作日志 |
| GET | `/api/wiki/ops/:id` | 操作详情，含每页差异 |
| POST | `/api/wiki/ops/:id/revert` | `{force?}` |
| POST | `/api/wiki/ops/:id/retry` | 重试失败的 op |
| GET | `/api/wiki/export?scope=` | 下载 zip |

## 11. 代码组织

```
packs/wiki/
  types.ts      WikiError、WIKI_LIMITS、类型
  parse.ts      slug 规范化，解析链接、引用、图片
  store.ts      页面、版本、链接、引用的读写和事务，以及 index 生成
  prompts.ts    规划、撰写、提问、体检的提示词
  ingest.ts     摄入流程
  queue.ts      扫描、队列、额度、周期体检
  recall.ts     评审召回
  ask.ts        提问
  lint.ts       体检
  revert.ts     撤销与恢复
  diff.ts       逐行差异
  export.ts     导出 md、docx 和 zip
  zip.ts        最小 zip 写入器
apps/server/wiki-api.ts
apps/server/public/wiki.js
```

`main.ts` 负责：注入 `recallWiki`、启动队列，以及在关闭服务时停止队列。

## 12. 错误处理
- 模型不可用（没有配置模型，或请求失败）：摄入 op 记为 `error`，按重试规则处理；评审召回不依赖模型，不受影响。
- 模型返回的 JSON 无法解析：重试一次，仍失败则这次 op 记为 `error`，不写入任何改动。
- 写数据库失败：事务回滚，op 记为 `error`。
- `soffice` 不可用或转换超时：对应页面退回导出为 `.md`，导出整体照常完成。
- 前端遇到 409、413、429 时显示具体原因。

## 13. 测试与验证
- **单元测试**（模型调用用桩替代）：
  - parse：slug 规范化、链接、引用、图片；
  - store：写入、版本、FTS 同步、删除与恢复；
  - ingest：规划、分批撰写、无效引用清理、防截断、事务失败不留残留；
  - queue：哈希变化入队、额度、重启恢复、失败重试、不重复入队；
  - recall：Wiki 命中、附带原文、退回 `recallKb`、字数预算；
  - ask：选页、无依据时的回答、存为问答页；
  - lint：六类程序检查、自动修复可撤销；
  - revert：整次撤销、冲突检测、`force`、撤销新建页；
  - diff；
  - export：文件名清洗、目录划分、链接与脚注改写、超出上限；
  - zip：用系统 `unzip -t` 校验生成的文件。
- **接口测试**：登录、同源校验、409 冲突、图片类型校验、提问额度 429。
- **真实验证**：
  - 用 `deepseek-flash` 摄入现有 2 份资料，人工抽查页面质量和引用准确性；
  - 拿 5 个问题对比旧召回和新召回；
  - 导出的 zip 用 Obsidian 和 Word 打开检查。
- **回归**：全部单元测试、类型检查，以及 `opc-check.sh`、`opc-check-ui.sh`、`opc-proto-api.sh`、`opc-kb-formats.sh`。

## 14. 风险
- **模型写错结论**：关键结论必须带引用；召回时附原文，并注明以原文为准；所有改动都可以撤销；体检会检查矛盾。
- **费用**：有每日额度；一次只跑一个任务；评审或原型生成进行时让路。
- **页面越写越长或质量越来越差**：有单页上限；有防截断规则；体检会报告过时页。
- **`soffice` 转换期间的网络访问**：页面 HTML 里没有外部资源，所以转换不会发起请求。给 LibreOffice 统一断网（例如用网络命名空间）是另一项独立的改进，不在本期范围。
