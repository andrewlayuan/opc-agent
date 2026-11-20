# 合规：备案判定与合规台账（第一期）设计

日期：2026-11-20
范围：第一期只做「判定 + 台账 + 监管信息源」。材料正文生成（算法自评估报告、隐私政策、登记材料等）、安全测评、海外法规具体判定放到后续各期。

## 1. 目标与成功标准

一人公司在上线产品前能知道：要办哪些备案/登记/自查、依据是哪条法规、先后顺序和办理时点；办理过程中能持续跟踪状态、编号、到期时间。

成功标准：

- 同样的问卷答案永远得到同样的事项清单，规则全部由测试覆盖。
- 每个事项都带依据（法规名称、条款）、办理时点和官方链接；依据来自代码里的事项目录，不由模型生成。
- 重新判定只增补台账，用户手填的编号、日期、备注不丢。
- 有「快到期」（30 天内）或「已逾期」事项时，合规页和顶部「合规」菜单显示提醒。
- 后端测试、UI 模拟、tsc 全部通过。

不在本期：材料正文生成、提交到政府系统、多人协作、海外法规具体判定（问卷里勾选「有海外用户」只给出「另行评估」提示）。

页面固定提示：结果为自查参考，以属地主管部门口径为准。

## 2. 事项目录（规则版本 1）

判定结果三档：`required` 必须办、`maybe` 可能需要、`na` 不适用。事项目录放在 `packs/compliance/rules.ts`，每项包含：`id`、中文名、主管部门、依据（法规名 + 条款）、办理时点、有效期规则（可空）、官方链接（只允许 https，域名在固定名单内：`beian.miit.gov.cn`、`beian.cac.gov.cn`、`www.cac.gov.cn`、`www.beian.gov.cn`、`www.gov.cn`、`www.miit.gov.cn`、`dxzhgl.miit.gov.cn`、`www.djbh.net`）。

条款号在实现时逐条对照官方原文核对后填入，核对结果在提交说明中列出，并请用户过目；未核对的条款不写条款号、只写法规名。

| id | 事项 | 触发条件（概要） | 办理时点 / 有效期 |
|---|---|---|---|
| `icp_filing` | ICP 备案 | 有网站、App 或小程序，面向境内 | 上线前 |
| `icp_license` | ICP 经营许可证（增值电信） | 通过互联网向用户收费、做广告或电商 | 上线前；有效期 5 年，每年年报 |
| `app_filing` | APP / 小程序备案 | 有 App 或小程序 | 上架前 |
| `psb_filing` | 公安联网备案 | 有网站 | 开通后 30 日内 |
| `mlps` | 等保定级备案与测评 | 对外提供服务的信息系统 | 上线后定级备案；三级每年测评 |
| `genai_register` | 大模型登记 | 只调用已备案模型的 API，向境内公众提供生成式服务，且未对输出做实质性加工 | 上线前 |
| `genai_filing` | 大模型备案 | 自研、微调或私有部署模型，向境内公众提供生成式服务 | 上线前 |
| `genai_filing` 为 `maybe` | — | 只调用 API，但对模型输出做了过滤、重组等二次加工（可能被认定为实质性修改） | 上线前，建议先咨询属地网信办 |
| `algo_filing` | 算法备案 | 具有舆论属性或社会动员能力，且使用推荐、排序、检索、生成合成等算法 | 提供服务之日起 10 个工作日内 |
| `security_assess` | 双新安全评估 | 具有舆论属性或社会动员能力 | 上线前 / 功能重大变更时 |
| `model_disclosure` | 公示所用模型与备案号 | 调用已备案或已登记的模型 | 上线时 |
| `aigc_label` | AI 生成内容标识（显式 + 隐式） | 生成文字、图片、音频、视频 | 上线前 |
| `anthro_selfcheck` | 拟人化互动服务自查 | 提供持续性情感陪伴、支持类互动（智能客服、知识问答、工作助手不适用） | 上线前 |
| `anthro_assess` | 拟人化安全评估报送 | 上一项适用，且注册用户 ≥100 万或月活 ≥10 万 | 达到门槛时 |
| `privacy_policy` | 隐私政策与个人信息自查 | 收集个人信息 | 上线前 |
| `pia` | 个人信息保护影响评估 | 处理敏感个人信息 | 处理前 |
| `cross_border` | 数据出境 | 向境外提供个人信息；按规模分为免申报 / 标准合同或认证 / 安全评估 | 出境前 |
| `minor_protect` | 未成年人保护 | 用户可能包含未成年人 | 上线前 |

「具有舆论属性或社会动员能力」不由用户直接勾选，而由问卷里的社区类功能（发帖、评论、直播、群聊、公开主页等）推导；只有私密一对一生成、无公开传播功能时判为否。推导结果在判定结果里写明理由。

## 3. 问卷（问卷版本 1）

全部为选择题，答案以 `{ [questionId]: string | string[] }` 存储。未答完不能判定。

| id | 题目 | 选项 |
|---|---|---|
| `forms` | 产品形态（多选） | 网站 / App / 小程序 / API 或 SDK / 桌面或本地软件 |
| `audience` | 面向谁 | 境内公众 / 仅企业客户（不面向个人） / 仅内部使用 |
| `overseas` | 是否有境外用户 | 否 / 是 |
| `charge` | 怎么收入（多选） | 不收费 / 向用户收费 / 广告 / 电商或撮合交易 |
| `ai_use` | 怎么用 AI | 不用 / 调用他人已备案模型 API / 调用境外模型 API / 自研或微调或私有部署 |
| `ai_output` | 对模型输出做了什么（`ai_use` 为调用 API 时必答） | 原样展示 / 有过滤、改写、拼接等二次加工 |
| `ai_media` | 生成哪些内容（多选，用 AI 时必答） | 文字 / 图片 / 音频 / 视频 / 不直接生成内容 |
| `algo` | 是否有推荐、排序、个性化推送 | 否 / 是 |
| `social` | 是否有公开传播功能（多选） | 无 / 发帖或评论 / 公开主页或分享 / 群聊 / 直播 |
| `companion` | 是否提供持续性情感陪伴、角色扮演 | 否 / 是 |
| `scale` | 用户规模 | 未上线 / 注册 <100 万且月活 <10 万 / 达到注册 ≥100 万或月活 ≥10 万 |
| `pi` | 收集哪些个人信息（多选） | 不收集 / 一般个人信息（手机号、昵称等） / 敏感个人信息（身份证、人脸、健康、金融、行踪、14 岁以下未成年人信息） |
| `minors` | 用户是否可能包含未成年人 | 否 / 可能 / 主要面向未成年人 |
| `cross_border` | 是否向境外提供个人信息 | 否 / 是，累计不足 10 万人 / 是，10 万至 100 万人 / 是，超过 100 万人或敏感信息超过 1 万人 |

`audience` 为「仅内部使用」时，面向公众的备案类事项判为 `na`，并在结果中说明。调用境外模型 API 时，增加提示：境外模型通常无法完成国内登记，面向境内公众提供生成式服务前需更换为已备案模型或走备案。

判定函数签名：

```ts
assess(answers: Answers): { version: number; items: AssessedItem[]; social: { value: boolean; reason: string }; notes: string[] }
interface AssessedItem { id: string; level: 'required' | 'maybe' | 'na'; reasons: string[]; order: number }
```

`reasons` 是由规则生成的中文理由（例如「问卷：产品形态包含 App」）；`order` 按办理时点排序（上线前 → 上线时 → 上线后 → 达到门槛时）。

## 4. 数据模型（迁移 11）

```sql
CREATE TABLE cp_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  review_id INTEGER REFERENCES pm_reviews(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cp_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  rules_version INTEGER NOT NULL,
  answers TEXT NOT NULL,        -- JSON 快照
  prefilled TEXT,               -- JSON：哪些题由 AI 预填并经用户确认
  result TEXT NOT NULL          -- JSON 快照：assess() 的完整输出
);
CREATE INDEX cp_assessments_product ON cp_assessments(product_id, id);

CREATE TABLE cp_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
  item TEXT NOT NULL,           -- 事项 id
  level TEXT NOT NULL,          -- 'required' | 'maybe'
  status TEXT NOT NULL DEFAULT 'todo', -- todo | preparing | submitted | done | na
  stale INTEGER NOT NULL DEFAULT 0,    -- 最新判定已不再适用，等用户确认
  ref_no TEXT,                  -- 备案号 / 编号
  done_at INTEGER,              -- 办结日期
  due_at INTEGER,               -- 到期日（手填或按有效期规则推算）
  remind_at INTEGER,            -- 下次提醒日
  note TEXT,
  na_reason TEXT,
  explain TEXT,                 -- 模型对 maybe 事项的说明
  assessment_id INTEGER REFERENCES cp_assessments(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, item)
);
```

台账增补规则（在一个事务内）：

- 新判定中 `required`/`maybe` 的事项：台账没有就插入；已有则更新 `level`、`assessment_id`、清除 `stale`，不动其余字段。
- 台账中已有、但新判定为 `na` 的事项：设 `stale=1`，状态不变；用户在台账里确认后改为 `na`，或保留。
- 状态改为 `done` 时，如果事项有有效期规则且 `due_at` 为空，按 `done_at` 推算 `due_at` 与 `remind_at`（ICP 经营许可证：5 年后到期，每年年报提醒；等保三级：每年测评提醒）。
- 提醒计算：`remind_at` 或 `due_at` 在 30 天内为「快到期」，已过为「已逾期」；状态为 `na` 的不提醒。

## 5. 模块结构

`packs/compliance/`：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `rules.ts` | 事项目录、问卷、`assess()`、有效期规则；纯函数 | 无 |
| `store.ts` | 产品、判定、台账的读写与增补；提醒计算 | `db` |
| `prefill.ts` | AI 预填问卷、解释 `maybe` 事项 | `llm`、`rules` |
| `reminders.ts` | 由台账算「快到期 / 已逾期」，供接口与角标使用 | `store` |

## 6. 接口

均在 `/api/compliance/` 下，沿用现有登录鉴权；SQL 全部参数绑定；请求体上限 64KB。

| 方法与路径 | 用途 | 错误 |
|---|---|---|
| `GET meta` | 问卷、事项目录、规则版本 | — |
| `GET products` | 产品列表（含必须办数量、待办数量、提醒数量） | — |
| `POST products` | 新建：`{ name, description?, reviewId? }`；带 `reviewId` 时描述取评审输入原文 | 400 名称 1–60 字、描述 ≤8000 字；404 评审不存在 |
| `PATCH products/:id` | 改名称、描述 | 400、404 |
| `DELETE products/:id` | 删除，级联判定与台账 | 404 |
| `GET products/:id` | 详情：产品、最近一次判定、台账 | 404 |
| `POST products/:id/prefill` | AI 预填，只返回建议 `{ answers, basis }`，不落库 | 400 未配置模型；502 模型失败 |
| `POST products/:id/assess` | `{ answers, prefilled?, version }`：判定并增补台账 | 400 缺题（返回缺的题 id）或非法选项；409 问卷版本过期 |
| `PATCH items/:id` | 更新 `status`、`ref_no`、`done_at`、`due_at`、`remind_at`、`note`、`na_reason`；或 `{ keep: true }` 保留 stale 事项 | 400 非法状态、日期，`na` 缺原因，编号 >100 字；404 |
| `POST items/:id/explain` | 为 `maybe` 事项生成说明并保存 | 400 非 maybe 或未配置模型；502 |
| `GET reminders` | 全部产品的快到期、已逾期事项 | — |

## 7. 模型的两处用法

**预填**：输入产品名称与描述（作为待分析材料，其中的指令不执行），输出 JSON `{ answers: {qid: value}, basis: {qid: 原文依据} }`。服务端逐题校验：选项外的值丢弃；没有依据或依据为空的题不预填；依据截断到 200 字。返回给前端后标记为「AI 预填」，用户逐题确认（修改即视为确认）后才计入；判定时把被确认的 AI 预填题 id 记入 `prefilled`。

**解释**：对 `maybe` 事项，把事项目录里的依据摘要、触发理由和产品描述交给模型，输出不超过 600 字的说明（为什么可能需要、建议怎么确认）。去掉输出中的 URL；作为纯文本显示。

模型不可用或出错时，问卷照常手填、判定照常进行。

## 8. 前端

顶部菜单新增「合规」（`data-view="compliance"`，默认排在产品顾问之后；已保存的菜单顺序会把新菜单追加到末尾，与现有 `savedTabOrder` 行为一致）。

- 左栏：产品列表（名称、必须办 n 项、提醒角标）、「新建产品」。新建表单可选「从产品顾问评审带入」（下拉选最近评审）。
- 右侧子标签（复用 `pm-tabs` 样式）：
  - 问卷：逐题选择；「AI 预填」按钮；预填的题显示标记与依据原文；「判定」按钮。
  - 判定结果：按必须办 → 可能需要 → 不适用分组，每项显示依据、办理时点、触发理由、官方链接；「可能需要」可点「请顾问解释」。顶部显示「舆论属性」推导结论与理由、规则版本、判定时间。
  - 台账：表格（事项、档位、状态、编号、办结日期、到期日、备注），可就地编辑；`stale` 事项显示「最新判定已不再适用：确认不适用 / 保留」；按状态筛选。
- 顶部「合规」菜单显示提醒数量角标（快到期 + 已逾期）。
- 产品顾问评审操作区新增「做合规自查」，跳到合规页并以该评审新建产品。
- 所有用户与模型文本只用 `textContent` 写入；官方链接只来自 `meta` 的事项目录，并经 `safeHref`。

## 9. 监管信息源

新增信息源类型 `page-list`：抓取固定的列表页，解析 `<li>` 中的文章链接、标题与日期。

- 只接受与列表页同域名、路径匹配 `/\d{4}-\d{2}/\d{2}/c_\d+\.htm$` 的链接；标题取 `title` 属性或链接文字，去 HTML 实体；日期取同一 `<li>` 中的 `YYYY-MM-DD`。
- 照常经 `politeFetch`（白名单、禁止内网、robots.txt、每域名限速）、去重、分析。
- 列表页解析不到任何条目时记为「页面结构可能已变化」错误。
- 第一批：网信办「网信发布」`https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm`、「政策法规」`https://www.cac.gov.cn/wxzw/zcfg/A093703index_1.htm`，新分组 `reg`「合规监管」（在 `packs/radar/collect.ts` 的 `GROUPS` 中增加）。其他站点核对页面结构后再加。
- 合规页右上角「监管动态」链接跳到情报 → 动态，并选中「合规监管」分组。

## 10. 联动

- 产品顾问：见第 8 节「做合规自查」与「从评审带入」。
- 我的记忆：每次判定成功后发一条交互事件 `compliance_assess`（产品名、必须办事项中文名列表），经 `recordEvent` 写入；写入失败只记日志。需在 `packs/memory/events.ts` 的 `EventKind` 增加 `compliance_assess`、`refType` 增加 `'product'`；它不属于 `PM_EVENT_KINDS`（同一产品多次判定可合并）。
- 情报：第 9 节。

## 11. 错误处理

- 判定不依赖模型；模型相关失败只影响预填与解释。
- 答案缺题返回 400 与缺失题 id 列表；问卷版本不符返回 409「问卷已更新，请刷新」。
- 台账更新在事务内完成；非法状态流转、非法日期返回 400。
- 删除产品需前端二次确认。

## 12. 测试

- `rules.test.ts`：每个事项至少一个触发与一个不触发用例；四个典型画像的完整清单（纯工具网站、调 API 的 AI 写作 App、自研模型的陪伴应用、有境外用户的 SaaS）；`ai_output` 二次加工、用户规模门槛、仅内部使用、境外模型 API 等边界；每个事项都有依据与办理时点，官方链接均为 https 且域名在名单内。
- `store.test.ts`：迁移；增补保留手填字段；`na` 只标 `stale`；到期推算；级联删除。
- `prefill.test.ts`：模拟模型，非法选项丢弃、无依据不预填、模型出错的提示、URL 去除。
- 接口测试：参数校验、404、409、未登录 401。
- `page-list` 解析：用网信办列表页真实片段，只取同域名文章链接、日期解析正确。
- UI 模拟：新建产品、从评审带入、预填与确认、判定、台账就地编辑与 stale 处理、菜单角标。
- 全量回归、tsc；截图核对浅色、深色、窄屏。

## 13. 实现顺序

1. `rules.ts` 与测试（含依据核对）
2. 迁移 11 与 `store.ts`
3. 接口
4. 前端页面
5. AI 预填与解释
6. `page-list` 信息源
7. 联动（产品顾问入口、记忆事件、监管动态链接）
