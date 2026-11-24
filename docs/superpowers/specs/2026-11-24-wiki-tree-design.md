# Wiki 分类树：左侧结构化设计

日期：2026-11-24

## 1. 背景与目标

知识库页「Wiki」标签的左侧列表现在只有一层：`packs/wiki/topics.ts` 把每页按链接距离归到最近的「总览页」，生产库只有 2 个总览页，38 页里 26 页平铺在「Agent 开发知识总览」下。右侧总览页正文里「七大领域 → 核心节点」的结构是模型写的 Markdown，左侧没有用它；实测按正文小节反推层级只能覆盖 36 个页面中的 19 个，且小节名不统一，不可靠。

目标：左侧变成「领域 → 主题 → 页面」的可折叠树；新资料编入时自动挂到合适的位置；知识越多，结构越清楚。

用户已确认：

- 方案：独立的分类树（分类节点不是页面，没有正文和出处）；
- 手动调整做到最小：页面「移到…」、节点新建子节点 / 改名 / 删除空节点，不做拖动；手动调整过的页面，自动整理不再动它。

## 2. 范围

做：

1. 分类树存储（迁移 16）；
2. 摄入时随「规划」那次调用一并分类，不增加模型调用；
3. 「整理目录结构」后台操作，一次性给现有页面分类，可撤销；
4. 左侧改为可折叠树，页面详情显示路径并可「移到…」；
5. 节点的新建子节点、改名、删除空节点。

不做：节点拖动与跨层移动、按分类树导出 zip、图谱按分类着色、MCP 工具改动、总览页与问 Wiki 的行为改动。`pageTopics`（按总览页分主题）保留，页面详情里的 `topic` 字段继续返回，只是左侧不再使用。

## 3. 数据

迁移 16（`packages/core/db.ts`，`user_version` 15 → 16）：

```sql
CREATE TABLE wiki_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES wiki_nodes(id),
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,   -- 用户新建或改过名：自动整理不删除、不改名
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX wiki_nodes_name ON wiki_nodes(coalesce(parent_id, 0), title);

CREATE TABLE wiki_page_node (
  page_id INTEGER PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES wiki_nodes(id),
  manual INTEGER NOT NULL DEFAULT 0    -- 用户手动指定：自动整理不再移动
);
CREATE INDEX wiki_page_node_node ON wiki_page_node(node_id);

CREATE TABLE wiki_node_undo (          -- 「整理目录结构」前的完整快照
  op_id INTEGER PRIMARY KEY REFERENCES wiki_ops(id),
  snapshot TEXT NOT NULL
);
```

上限（`WIKI_LIMITS`）：节点最多 200 个、最深 3 层、名称 1–40 字；同一父节点下名称不重复（NFKC、去首尾空白、不区分大小写）。删除节点只允许空节点（没有子节点、没有页面）。页面被软删除后分类记录保留，页面恢复时位置不变；树里只统计未删除的页面。

`OpKind` 增加 `organize`（计入每日额度，可撤销，但走自己的撤销，见 4.3）。

## 4. 行为

### 4.1 摄入时分类（不增加模型调用）

`planPrompt` 在现有页面目录之外再给出当前分类树（缩进文本，最多 200 个节点），并要求规划里每个页面多返回一个 `path`：1–3 个字符串，表示它应放在哪条路径下，例如 `["Agent 开发","上下文工程"]`。资料摘要页和问答页不由模型分类（见下）。

`readPlan` 解析 `path`；写入页面成功后，在同一事务里为这些页面落位：

- 已有分类的页面不动。自动分类过的页面也不会因为新资料而被挪走，避免树随摄入反复抖动；
- 没有分类的页面（新页，或迁移前就有、尚未整理的页面）按 `path` 逐层匹配同名节点，匹配不到才新建；
- 一次摄入最多新建 5 个节点；超出的部分，页面放到已匹配到的最深一层；
- `path` 缺失、不是字符串数组、超过 3 层或名称非法：缺失或非法的放进「未分类」（不落位，不写 `wiki_page_node`），超过 3 层的截到第 3 层；
- 资料摘要页（`source`）固定放进系统节点「资料摘要」，问答页（`answer`）固定放进「问答」，节点不存在时创建。它们可以被用户手动移走。

写入失败（例如节点数已达上限）只影响落位，不影响页面本身的写入：页面保持未分类，并在操作记录的备注里写明。

### 4.2 手动调整

- `PUT /api/wiki/pages/:slug/node`，body `{ nodeId: number | null }`：把页面移到某节点，`null` 为取消分类。写 `manual = 1`；
- `POST /api/wiki/nodes`，body `{ title, parentId }`：新建子节点（`parentId` 为空是顶层），`manual = 1`；
- `PATCH /api/wiki/nodes/:id`，body `{ title }`：改名，置 `manual = 1`；
- `DELETE /api/wiki/nodes/:id`：只删空节点，否则 409「节点下还有内容」。

这些修改不进 `wiki_ops`，不生成页面版本（页面正文没有变）。

### 4.3 整理目录结构

`POST /api/wiki/organize` 入队一个 `organize` 操作，立即返回 `{ opId }`；执行规则：

- 对象：所有未删除、`manual = 0`（或无分类记录）的页面。手动放置的页面作为现有结构上下文一并给出，但不会被移动；
- 先对当前树与分类做完整快照写入 `wiki_node_undo`；
- 页面数不超过 100 时 1 次模型调用；超过时每 100 页一次，后一批看得到前面已形成的树，最多 10 次。资料摘要页和问答页不参与；
- 输出 JSON：`{"nodes":[{"path":["领域","主题"],"pages":["slug", …]}]}`，要求每个页面只出现一次，路径遵守 3 层 / 名称规则；
- 校验：slug 必须是被允许整理的页面，重复出现取第一次，未出现的页面保持原状；节点数超限时丢弃超出的路径，其下页面放到已存在的上一层；
- 提交：一个事务内重写这些页面的分类，之后删除没有页面也没有子节点的 `manual = 0` 节点；
- 失败（模型错误、JSON 无法解析）不改动任何分类，操作记为失败，可在「体检与日志」重试，沿用现有 `retry`。

队列接入：`WikiQueue` 增加 `enqueueOrganize()`（已有排队或运行中的整理操作时直接返回其 id，与 `enqueueLint` 一致），`Runner` 增加 `organize`，`retry` 与 `drain` 的分派都加上 `organize`；`recover` 把重启中断的整理标为失败，不留下半个结果（整理在一个事务里提交，所以中断不会产生部分写入）。

撤销：现有 `revertOp` 按页面版本回滚，不适用于分类，所以 `organize` 不进 `REVERTABLE`，由 `POST /api/wiki/ops/:id/revert` 在路由里先判断操作类型，对 `organize` 调用新的 `revertOrganize`：恢复快照，整体替换整棵树与分类。手动操作在整理之后做的修改会随之丢失，所以界面上撤销前要二次确认并说明这一点。现有的页面快照式撤销不涉及分类，不受影响。

触发：

- 手动：Wiki 侧栏顶部的「整理目录」按钮；
- 提示：存在未分类页面（不含资料摘要页和问答页）时，侧栏显示一行「有 N 个页面还没有分类」，带同一个按钮；
- 不做定时自动整理。日常新页面在摄入时已经分类。

### 4.4 额度与调度

摄入阶段无新增调用。整理最多 10 次调用，计入 `wiki_ops.llm_calls`，与现有每日额度（`OPC_WIKI_DAILY_CALLS`）共用，后台任务让路规则（有评审、追问、原型在生成时暂停）不变。

## 5. 界面

- 侧栏改为可折叠的树：节点显示直属页面数与子孙总数，页面前保留现有类型圆点。顶层默认展开，展开状态保存在 `localStorage`（键 `opc.wikiTree`）；
- 未分类的页面在树的末尾「未分类」分组，没有此类页面时不显示；
- 节点行有小菜单：新建子节点（受 3 层限制，到第 3 层不显示）、改名、删除（仅空节点）。名称输入沿用知识库目录用的 `prompt`；
- 页面详情标题上方显示路径（面包屑），旁边「移到…」下拉：按路径列出全部节点，加一项「未分类」；
- 搜索时仍是平铺结果，每条后面灰色显示所属路径；
- 窄屏沿用现有侧栏折叠方式。

## 6. 接口汇总

- `GET /api/wiki/pages`：每个页面增加 `node_id`（`null` 表示未分类）；响应增加 `nodes: [{ id, parent_id, title, sort, manual, own, total }]`，`own` 为直属未删除页面数，`total` 含子孙；原有 `topics`、`topic` 保持；
- 新增：`PUT /api/wiki/pages/:slug/node`、`POST /api/wiki/nodes`、`PATCH /api/wiki/nodes/:id`、`DELETE /api/wiki/nodes/:id`、`POST /api/wiki/organize`；
- `POST /api/wiki/ops/:id/revert`：对 `organize` 操作走快照恢复。

所有新接口沿用现有登录与同源校验，请求体上限与 `BODY_SMALL` 相同。

## 7. 错误与边界

- 并发：整理期间用户手动移动页面，以事务提交时的 `manual` 标记为准，手动的优先；
- 节点名重复：新建或改名遇到同级重名返回 409；摄入与整理遇到同名一律复用；
- 节点或分类写入的任何错误不影响页面写入与摄入结果；
- 迁移回滚测试（`pm.test.ts`、`memory/migrate.test.ts` 的回滚清单）补三张新表，所有 `user_version` 断言改为 16；
- 迁移不改动现有页面：升级后所有页面先是未分类，侧栏显示提示，你点一次「整理目录」即可。

## 8. 测试

- 单元（`packs/wiki/tree.test.ts`）：路径匹配与新建、深度 / 数量 / 重名上限、摄入时只给无分类的页面落位、每次最多新建 5 个节点、非法 `path` 回退、手动标记的保护、删除空节点与非空拒绝、整理的校验与分批、快照撤销；
- 摄入（`ingest.test.ts`）：规划里带 `path` 时页面落位且调用次数不变；
- 接口（`apps/server/wiki-api.test.ts`）：新增路由、`GET /pages` 的新字段、409 与 404、撤销整理；
- 页面模拟（`apps/server/ui-sim.test.mjs`）：树渲染与折叠记忆、搜索平铺带路径、页面「移到…」、节点新建 / 改名 / 删除、未分类提示与整理按钮；
- 全量：`npm test` 与类型检查。

## 9. 与后续工作的关系

- C（情报与知识库打通）：自动入库的资讯走同一条摄入链路，同样会被分类，不需要额外处理；
- D（趋势预测）：可直接用分类树的一级节点作为领域骨架。

## 10. 不在范围

节点拖动与跨层移动、按分类树导出、图谱按分类着色、定时自动整理、`pageTopics` 的移除。
