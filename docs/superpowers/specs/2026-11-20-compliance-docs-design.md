# 合规：材料起草（第二期）设计

日期：2026-11-20
前置：第一期「判定 + 台账 + 监管信息源」（`docs/superpowers/specs/2026-11-20-compliance-design.md`）已合并。
范围：按产品的判定结果与资料，用「模板骨架 + 模型填写」起草 10 种合规材料；站内按章编辑，章级版本历史与差异、回退；定稿锁定；导出 Markdown / HTML / Word。

## 1. 目标与成功标准

一人公司上线前，能在同一处拿到可直接使用的材料初稿：公示类（隐私政策、用户协议、算法公示、模型公示、未成年人保护说明）挂到站内或 App；报送类（应用说明、自评估报告、安全评估报告、标识方案）交给监管或代理机构。

- 缺的信息不编造：一律输出 `【待填：字段名】` 并高亮；有待填时不能定稿。
- 用户改过的内容不丢：每章每次生成、保存、回退都留版本，可看差异、回退。
- 资料改了能看出来：生成时记录输入摘要，资料变化后对应章节提示「资料已更新」。
- 没配置模型也能用：固定章照常生成，模型章留空并提示。

不在本期：提交到政府系统、电子签章、多人审批、海外法规材料、安全测评（题库抽测）。

## 2. 资料

字段清单定义在 `packs/compliance/facts.ts`，前端按 meta 渲染表单；保存时逐项校验，清单外字段丢弃。空串视为未填。

### 2.1 全局主体（`cp_entity`，一行）

| key | 名称 | 校验 |
|---|---|---|
| `company_name` | 公司全称 | ≤100 字 |
| `credit_code` | 统一社会信用代码 | 空或 18 位，`^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$` |
| `address` | 注册地址 | ≤200 字 |
| `contact_email` | 联系邮箱 | 空或邮箱格式，≤100 |
| `contact_phone` | 联系电话 | ≤30 字 |
| `pi_officer` | 个人信息保护负责人 | ≤30 字 |
| `pi_officer_contact` | 负责人联系方式 | ≤100 字 |

### 2.2 产品资料（`cp_products.facts`）

| key | 名称 | 分组 | 校验 |
|---|---|---|---|
| `public_name` | 对外名称 | 对外信息 | ≤60 字 |
| `site` | 网址或 App 名称 | 对外信息 | ≤200 字 |
| `complaint` | 投诉举报渠道 | 对外信息 | ≤200 字 |
| `effective_date` | 材料生效日期 | 对外信息 | 空或 `YYYY-MM-DD` |
| `model_name` | 所用模型名称 | 模型 | ≤100 字 |
| `model_filing_no` | 备案号或上线编号 | 模型 | ≤100 字 |
| `model_provider` | 模型提供方 | 模型 | ≤100 字 |
| `data_location` | 数据存放地 | 数据 | ≤100 字 |
| `retention` | 个人信息保存期限 | 数据 | ≤200 字 |
| `sdks` | 第三方 SDK | 数据 | 数组 ≤30 行；每行 `name` ≤60（必填）、`purpose` ≤100、`data` ≤200、`policy_url` 空或 https 且 ≤300 |
| `minor_mode` | 是否有未成年人模式 | 未成年人 | `''` / `yes` / `no` |

已有数据直接使用：问卷答案（转为选项中文名）、判定结果及理由、产品名与描述。

## 3. 材料与模板

模板定义在 `packs/compliance/templates.ts`（纯数据 + 纯函数），`TEMPLATES_VERSION` 整体版本号，每种材料另有 `version`。

```ts
interface Chapter {
  key: string;                 // 材料内唯一
  title: string;
  mode: 'fixed' | 'model';
  when?: (a: Answers) => boolean;          // 不满足则该章不出现
  uses: string[];              // 用到的资料字段（'entity.xxx' / 'facts.xxx'）
  render?: (ctx: Ctx) => string;           // fixed：模板文字 + 字段替换
  points?: string[];           // model：写作要点（含法规依据）
}
interface DocTemplate { kind: string; name: string; usage: 'public' | 'filing'; items: string[]; version: number; chapters: Chapter[] }
```

### 3.1 种类、对应事项与可起草条件

必须先有判定（`cp_assessments` 至少一条），否则 400「请先完成问卷判定」。`items` 中任一事项在最近一次判定里为 `required` 或 `maybe` 即可起草；`items` 为空表示任何产品都可起草。

| kind | 名称 | 用途 | items |
|---|---|---|---|
| `privacy_policy` | 隐私政策 | 公示 | （任何产品） |
| `terms` | 用户协议 | 公示 | （任何产品） |
| `app_statement` | 应用说明（登记/备案用） | 报送 | `genai_register`、`genai_filing` |
| `algo_selfassess` | 算法安全自评估报告 | 报送 | `algo_filing`、`genai_filing` |
| `algo_disclosure` | 算法公示内容 | 公示 | `algo_filing` |
| `model_disclosure` | 模型公示文案 | 公示 | `model_disclosure` |
| `security_report` | 双新安全评估报告 | 报送 | `security_assess` |
| `anthro_report` | 拟人化安全评估报告 | 报送 | `anthro_assess`、`anthro_selfcheck` |
| `aigc_label_plan` | AI 生成内容标识方案 | 报送 | `aigc_label` |
| `minor_statement` | 未成年人保护说明 | 公示 | `minor_protect` |

台账事项 → 材料的反向映射由 `items` 推出，用于台账「材料」链接。

### 3.2 章节（固 = fixed，模 = model）

- **隐私政策**：引言与适用范围（固）；收集和使用的个人信息（模）；AI 功能中的信息处理（模，`ai_use≠none`）；Cookie 等技术（模）；委托处理、共享、转让、公开披露（模）；第三方 SDK 清单（固，表格）；存储地点与期限（固）；个人信息出境（模，`cross_border≠no`）；安全措施（模）；您的权利（固，个保法第四十四至四十七条）；未成年人信息（模，`minors≠no`）；政策更新（固）；联系我们（固）。
- **用户协议**：协议的接受（固）；服务内容（模）；账号注册与使用（模）；用户行为规范（模）；AI 生成内容说明（模，`ai_use≠none`，依据《生成式人工智能服务管理暂行办法》第九条）；付费与退款（模，`charge` 不只含 `free`）；知识产权（模）；免责与责任限制（模）；变更与终止（固）；法律适用与争议解决（固）；联系我们（固）。
- **应用说明**：基本情况（固）；服务内容与场景（模）；所用模型及备案情况（固）；用户群体与规模（模）；输入输出处理流程（模）；内容安全措施（模）；生成内容标识（模）；投诉举报（固）。
- **算法安全自评估报告**：算法基本情况、原理与运行机制、数据来源与使用、安全风险识别、安全防范措施、安全管理制度、评估结论（均模）。
- **算法公示内容**：基本原理、目的意图、主要运行机制、用户选择与关闭方式（均模；《互联网信息服务算法推荐管理规定》第十六条、第十七条）。
- **模型公示文案**：模型名称、备案号或上线编号、提供方、公示位置建议（均固）。
- **双新安全评估报告**：服务基本情况（模）；按《具有舆论属性或社会动员能力的互联网信息服务安全评估规定》第五条八类措施各一章（安全管理负责人与机构、用户真实身份核验与注册信息留存、日志与发布记录留存、违法有害信息防范处置、个人信息保护与防范社会动员失控的技术措施、投诉举报制度、配合网信部门的工作机制、配合公安与国家安全机关的工作机制，均模）；评估结论（模）。
- **拟人化安全评估报告**：服务基本情况、拟人化功能与场景、用户群体、身份提示、防沉迷与情感依赖防范、内容安全、个人信息保护、应急处置与人工接管、评估结论（均模）。
- **AI 生成内容标识方案**：适用的内容类型（模，按 `ai_media`）、显式标识、隐式标识（元数据）、用户协议与提示、日志留存、实施与检查（均模）。
- **未成年人保护说明**：身份识别、未成年人模式、使用时长管理、内容过滤、消费限制、不满十四周岁的个人信息处理、监护人与投诉渠道（均模）。

模板约束：
- 写作要点里的条款编号只使用第一期 CATALOG 中已核实的，或本节明确列出的；其余只写法规名。
- 每份材料导出时末尾固定附「本材料由 AI 辅助起草，提交或公示前请由专业人士审核」。

### 3.3 占位

- 占位格式：`【待填：字段名】`，正则 `/【待填：([^】\n]{1,40})】/g`。
- 固定章：缺字段直接写占位。
- 模型章：给模型的资料里缺的字段以占位值出现；要求遇到缺失信息原样输出占位，不得编造公司名、编号、日期、数量、链接。

## 4. 生成

### 4.1 流程

1. `POST products/:id/docs {kind}`：校验可起草，在事务内建 `cp_docs` 与当前模板下全部章（受 `when` 过滤）；固定章当场渲染并写版本 1（origin `fixed`），模型章 `rev = 0`（未生成）。
2. 前端对 `rev = 0` 的模型章依次调用 `POST docs/:id/sections/:key/generate`（「生成剩余章节」），逐章显示进度；单章失败（如 502 模型调用失败）标红可重试，不中断后续章；遇到 400（如未配置模型）、404、409 时逐章重试也不会成功，停下并提示原因。
3. `generate` 对固定章：重新渲染（不需要模型）；对模型章：调用模型，清洗后写新版本（origin `generate`）。

### 4.2 模型调用

- 一章一次调用，`temperature 0.3`，`maxTokens 2500`，使用 `llm.chat`（非 JSON 模式）。
- system：角色（合规文书起草）、输出要求（只输出本章正文 Markdown，不写章标题，不写开场白，缺失信息原样输出占位，不编造，不输出链接除非资料里有）。
- user：`<chapter>` 标题与写作要点；`<facts>` 资料 JSON（缺失值为占位）；`<assessment>` 问卷答案中文名与判定理由；`<product>` 产品名与描述（转义 `<`、`>`、`&`，同第一期）。
- 失败 → `viaLlm` 统一 502「模型调用失败，请稍后重试」；未配置模型 → 400 `NO_LLM`。

### 4.3 输出清洗（`sanitizeChapter(text, allowedUrls)`）

- 去掉首尾空白与代码围栏包裹；删除 `#`、`##` 级标题行（三级及以下保留）。
- 网址：Markdown 链接 `[t](url)` 与裸 `https?://…`；`url` 在 `allowedUrls`（资料中出现过的所有 http(s) 串）内则保留，否则链接替换为文字、裸网址删除。
- 截断到 6000 字（按码点）。
- 结果为空 → 502「模型没有返回内容」。

### 4.4 输入摘要与「资料已更新」

- 每章 `input_hash = sha256(JSON.stringify({ tv: 模板版本, key, uses 对应的资料值, 模型章另含 answers、判定理由、产品名与描述 }))`。
- 读取材料时对每章重算；与存储值不同则 `stale = true`。`rev = 0` 的章不算 stale。

## 5. 编辑、版本与定稿

- `PUT docs/:id/sections/:key {body, baseRev}`：`baseRev ≠ 当前 rev` → 409「内容已在别处更新，请刷新」；正文 ≤20000 字；写新版本（origin `edit`，`input_hash` 沿用当前值）。
- 每章版本 `n` 递增；超过 50 个删除最早的（当前版本永不删除）。
- `GET …/revisions`：列表（`n`、origin、时间、字数）；`?rev=n` 返回该版本正文与 `lineDiff(版本, 当前)`。
- `POST …/restore {rev}`：把该版本正文写为新版本（origin `restore`，`input_hash` 取该版本的）。
- 重新生成且当前 origin 为 `edit` 时，前端先确认「将覆盖你的修改（可在历史中找回）」。
- 定稿 `POST docs/:id/finalize`：全文（未移除的章）有占位 → 400，`detail.placeholders: [{ key, title, fields: string[] }]`；有 `rev = 0` 的章 → 400「还有未生成的章节」。通过后 `status = final`，记事件 `compliance_doc_final`（refType `product`，payload `{ kind }`）。
- 定稿后：生成、保存、回退、删除 → 409「材料已定稿，先取消定稿」。`unfinalize` 恢复为 `draft`。
- 模板同步（读取材料时）：当前模板有而库里没有的章 → 补建为 `rev = 0`；库里有而模板已无（或 `when` 不再满足）的章 → `removed = 1`，不导出、不参与定稿检查，可 `DELETE docs/:id/sections/:key` 删除；模板版本记到 `cp_docs.template_version`。

## 6. 存储（迁移 12）

```sql
CREATE TABLE cp_entity (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
ALTER TABLE cp_products ADD COLUMN facts TEXT NOT NULL DEFAULT '{}';
CREATE TABLE cp_docs (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES cp_products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  finalized_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, kind)
);
CREATE TABLE cp_doc_sections (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES cp_docs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ord INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 0,
  origin TEXT,                       -- fixed / generate / edit / restore；rev=0 时为 NULL
  input_hash TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (doc_id, key)
);
CREATE TABLE cp_doc_revisions (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES cp_doc_sections(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  body TEXT NOT NULL,
  origin TEXT NOT NULL,
  input_hash TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (section_id, n)
);
```

所有写操作在事务内完成。

## 7. 接口（`/api/compliance/`，需登录）

| 接口 | 说明 | 错误 |
|---|---|---|
| `GET meta` | 第一期内容 + `entityFields`、`factFields`、`docKinds`（kind、name、usage、items、章节目录：key、title、mode） | — |
| `GET entity` / `PUT entity` | 全局主体 | 400 字段非法 |
| `PUT products/:id/facts` | 产品资料（整体覆盖） | 400 / 404 |
| `GET products/:id` | 第一期内容 + `facts` | 404 |
| `GET products/:id/docs` | 每种材料：`available`、不可起草原因、`doc`（id、status、placeholders 数、stale 数、未生成数） | 404 |
| `POST products/:id/docs {kind}` | 起草 | 400 未判定 / 不需要 / 未知 kind；404；409 已存在 |
| `GET docs/:id` | 材料 + 各章（body、rev、origin、stale、removed、placeholders 字段名列表） | 404 |
| `DELETE docs/:id` | 删除 | 404；409 已定稿 |
| `POST docs/:id/sections/:key/generate` | 生成一章 | 400 模型章且未配置模型；404；409 已定稿或章已移除；502 |
| `PUT docs/:id/sections/:key {body, baseRev}` | 保存 | 400 超长或格式；404；409 |
| `DELETE docs/:id/sections/:key` | 只能删已移除的章 | 400 未移除；404；409 已定稿 |
| `GET docs/:id/sections/:key/revisions[?rev=n]` | 版本列表 / 单版本与差异 | 404 |
| `POST docs/:id/sections/:key/restore {rev}` | 回退 | 404；409 已定稿 |
| `POST docs/:id/finalize` / `POST docs/:id/unfinalize` | 定稿 / 取消定稿 | 400 有占位或未生成（带 detail） |
| `GET docs/:id/export?format=md\|html\|docx` | 导出 | 400 格式；404；422 docx 转换失败 |

## 8. 导出

- 开头：材料名、产品对外名称（未填用产品名）、主体公司全称（未填为占位）、生成日期；未定稿另加「草稿（未定稿），仅供参考，以属地主管部门口径为准」。
- 章标题用「一、二、三……」编号；`removed` 章不导出；末尾附 AI 辅助声明。
- `md`：章为 `##` 标题，占位原样。
- `html`：单文件，`<style>` 内联，无外部资源，`<meta charset="utf-8">`；占位输出为 `<mark style="background:#ffeb3b">`。
- `docx`：上述 html 交给 `convertHtmlToDocx`（依赖注入，测试用桩）。
- 文件名：`{产品名}-{材料名}-{YYYYMMDD}.{ext}`，去除 `/\:*?"<>|` 与控制字符，用现有 `contentDisposition`。
- Markdown → HTML：把 `packs/wiki/export.ts` 的 `renderBlocks` / `inline` 抽到 `packages/core/mdhtml.ts`（`renderMdHtml(body, ctx)`），先转义后生成白名单标签（h2–h4、p、ul/ol/li、blockquote、pre、strong、em、table/tr/th/td、mark、img 仅由调用方 ctx 生成），新增管道表格；wiki 导出改为调用它，原测试保持通过。

## 9. 页面

- 侧栏「监管动态」下加「主体信息」：主区域显示主体表单。
- 产品标签：问卷 / 判定结果 / 台账 / **资料** / **材料**。
- 资料：按分组渲染；SDK 表可增删行；页顶列出未填字段及受影响材料（由章节 `uses` 推出）。
- 材料列表：每种一张卡片（名称、用途、对应事项、状态、待填数、需更新数）；不需要的折叠显示原因。
- 材料页：顶栏（材料名、状态、生成剩余章节、定稿/取消定稿、导出 Markdown/HTML/Word、删除）；左侧章节目录（未生成 / 已生成 / 已编辑 / 资料已更新 / 模板已移除 + 待填数）；右侧当前章预览（`renderMarkdown`，占位以 `<mark>` 节点高亮），操作：编辑（Markdown 文本框，保存/取消）、重新生成、历史（版本列表、差异、回退）。定稿后只保留导出与取消定稿。
- 台账：对应事项行加「材料」链接，打开对应材料（未起草则打开材料列表）。
- 代码：新文件 `apps/server/public/compliance-docs.js` 导出 `initComplianceDocs({ h, api, toast, renderMarkdown })`；`compliance.js` 只负责标签切换与调用；`http.ts` 静态表加该文件。全部用 textContent / DOM 构建，不用 innerHTML。

## 10. 测试

- `templates.test.ts`：key 唯一；每种材料至少一章；资料齐全时固定章无占位、缺字段有占位；可起草条件；`when` 条件章随答案出现/省略；章节 `uses` 字段都在字段清单里。
- `facts.test.ts`：主体与产品资料校验（信用代码、邮箱、日期、SDK https、长度、清单外字段丢弃）。
- `docs-store.test.ts`：起草建章与固定章版本；生成/编辑/回退各加版本；`baseRev` 冲突 409；版本上限 50；定稿检查（占位、未生成）与锁定；取消定稿；stale 判定；模板同步（补章、标记移除、删除已移除章）；删产品级联。
- `sanitize` 测试：标题行删除、资料外网址删除、资料内网址保留、截断、占位保留、空输出报错。
- `packages/core/mdhtml.test.ts`：转义、表格、占位 `<mark>`；wiki 导出原测试通过。
- `compliance-docs-api.test.ts`：全部接口与错误码；docx 用桩；HTML 导出对含 `<script>` 的资料与正文转义；未配置模型时固定章可用。
- UI 模拟：保存主体与资料、起草、生成剩余章节、编辑保存、历史与差异、回退、定稿被占位阻止、补全后定稿、导出链接、台账「材料」链接。
