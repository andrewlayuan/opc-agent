# PRD 转 HTML 原型（E）设计

日期：2026-11-16
范围：三期路线中的 E（PRD 转 HTML 原型），之后是 C（技能沉淀）。在产品顾问评审页里，把一份 PRD 生成可点击的多页 HTML 原型，支持对话修改、版本历史、标注模式和单文件导出。

## 1. 目标与成功标准

原型先用来自己验证想法：PRD 落成界面之后，能发现遗漏的页面和流程。需要时再导出成单个 HTML 文件，拿去做用户访谈、给客户演示，或交给开发和设计。

成功标准：

- 对一份「写 PRD 初稿」评审点「生成原型」，2 分钟内得到一份 3–10 页、能点击跳转、带一致假数据的原型；手机端产品用手机框，SaaS 后台用桌面宽屏。
- 在原型输入框里说「登录页加一个微信登录」，只重新生成相关的页面，得到新版本；旧版本可以切换查看。
- 标注模式下能看到每页的用途说明、每个可交互元素的去向，以及一张页面地图。
- 下载得到的单个 HTML 文件双击就能离线打开，交互完整；文件里没有模型写的脚本。
- 原型在隔离来源里运行，读不到登录 cookie，调不了任何接口，也发不出网络请求。
- 单元测试、接口测试、UI 模拟全部通过；真实冒烟测试通过。

不在本期范围：公开分享链接、真实图片（只用占位图）、把原型的改动同步回 PRD、原型存入知识库、在原型对话里上传参考图、点选原型元素来提修改、原型生成时召回知识库。

## 2. 总体方案

分页生成，样式和交互用我们提供的组件和外壳：

1. 模型先输出一份「原型大纲」（JSON），再逐页输出页面主体 HTML，绕开单次 8000 tokens 的输出上限。
2. 页面只能使用外壳提供的组件类和声明式交互属性（`data-goto` 等）。模型写的脚本、样式表、外链一律在服务器端清理掉。
3. 服务器把外壳 CSS、外壳脚本和各页 HTML 拼成一个自包含的 HTML 文档。预览和导出用的是同一份。
4. 对话修改时，模型先给出改动计划，只重新生成计划里列出的页面，其余页面原样复制。

模块划分：

| 位置 | 职责 |
| --- | --- |
| `packs/proto/outline.ts` | 大纲与改动计划的 JSON 校验、修正 |
| `packs/proto/sanitize.ts` | 页面 HTML 白名单清理（自写分词器，无第三方依赖） |
| `packs/proto/assemble.ts` | 拼装完整文档、计算外壳脚本哈希、生成 CSP |
| `packs/proto/prompts.ts` | 大纲、页面、改动计划三类提示词 |
| `packs/proto/store.ts` | `pm_prototypes` 的读写、版本上限、重启恢复 |
| `packs/proto/runner.ts` | 生成与修改任务：并发、重试、总时限、事件 |
| `packs/proto/shell/proto.css`、`proto.js` | 原型外壳：布局、组件、交互、标注模式 |
| `apps/server/proto-api.ts` | 接口 |
| `apps/server/public/proto-panel.js` | 评审页里的原型面板 |
| `apps/server/public/proto-full.html`、`proto-full.js` | 全屏页 |

`packs/proto` 只依赖 `packages/core`（数据库、模型），以及 `packs/pm` 里读取评审和版本的函数，不反向被 `packs/pm` 依赖。

## 3. 数据模型（`packages/core/db.ts` 第 8 个迁移）

```sql
CREATE TABLE pm_prototypes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES pm_reviews(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  base_version_n INTEGER NOT NULL,          -- 基于 PRD 的哪一版
  from_n INTEGER,                           -- 修改时基于原型的哪一版；首次生成为空
  request TEXT NOT NULL DEFAULT '',         -- 本版的修改要求；首次生成为空
  note TEXT NOT NULL DEFAULT '',            -- 模型对本版改动的一句话说明
  progress TEXT NOT NULL DEFAULT '{}',      -- {"stage":"outline|pages","done":3,"total":7}
  outline TEXT NOT NULL DEFAULT '{}',
  pages TEXT NOT NULL DEFAULT '[]',         -- [{slug,title,html,error}]
  error TEXT,
  UNIQUE (review_id, n)
);
CREATE INDEX pm_prototypes_review ON pm_prototypes(review_id, n);
```

- 每个版本存一份完整快照，没改的页面直接复制。一版大约 30–80KB。
- 每个评审最多保留 20 版。新版本写入时，如果超出，删除 `n` 最小的版本，但 `n = 1` 永远保留。
- 失败版本的 `outline`、`pages` 保留已经得到的部分。「重试」会在原来的 `n` 上把状态改回 `running` 重新跑：首次生成从大纲开始重来；修改则用同样的 `request`，基于同一个 `from_n` 重新做改动计划。
- 版本号 `n` 取该评审现有最大 `n` 加 1。已删除的版本号不再复用。

## 4. 生成流程（`runner.ts`）

### 4.1 大纲

输入：评审标题，以及所选 PRD 版本的正文（最多 1.2 万字，超出截断并在提示词里注明「后文已截断」）。调用 `llm.chat`，参数为 `json: true, maxTokens: 3000, temperature: 0.4, timeoutMs: 120000`。输出：

```json
{
  "product": "律审通",
  "device": "phone | desktop",
  "theme": "blue | green | violet | orange | slate | rose",
  "nav": ["home", "cases", "me"],
  "data": { "users": [...], "orders": [...] },
  "pages": [
    { "slug": "home", "title": "首页", "purpose": "…", "content": "…", "links": ["case-detail"] }
  ]
}
```

校验与修正（`outline.ts`）：

- `pages` 3–10 个；超过 10 个截掉多出的，少于 1 个记为失败。
- `slug` 必须匹配 `^[a-z0-9-]{1,32}$`，不能重复；不合法或重复的，按 `p1`、`p2`… 重新命名，同时更新 `nav` 和 `links` 里的引用。
- 标题最多 20 字，`purpose`、`content` 各最多 400 字，`product` 最多 20 字，超出截断。
- `device`、`theme` 不在可选值里时，分别改用 `desktop`、`blue`。
- `nav` 只保留存在的 slug，最多 5 个。
- `data` 序列化后不超过 4KB，超出时整体丢弃，改为 `{}`。

### 4.2 页面

每页调用一次模型，同一任务最多 3 个并发（模型调用另外还受全局 `OPC_LLM_CONCURRENCY` 名额限制）。输入包括：完整大纲、本页的说明、外壳组件与交互属性的使用说明、PRD 正文（截断到 6000 字）。参数为 `maxTokens: 6000, temperature: 0.5, timeoutMs: 180000`。要求模型只输出一个 `<main>…</main>` 元素，前后不加任何文字。

处理输出：

1. 去掉 ```` ```html ```` 代码块标记，取第一个 `<main` 到最后一个 `</main>` 之间的内容。
2. `llm.chat` 不返回 `finish_reason`，所以用结构来判断是否被截断：有 `<main` 却没有 `</main>`，就视为截断，加一句「上次输出过长被截断，请精简内容后重新输出」重试一次。连 `<main` 都没有时，把整段输出当作页面内容。
3. 调用失败或第 2 步重试后仍被截断，重试一次；再失败，就把这一页记为 `error`，`html` 为空。
4. 交给 `sanitize`（第 5 节）清理。清理后超过 40KB 的，记为 `error`「页面过大」。

每完成一页就更新 `progress`。

### 4.3 收尾

- 至少一页成功时，状态改为 `done`；部分页面失败的版本仍然可以预览，失败的页面显示「此页生成失败」占位。
- 全部页面都失败时，状态改为 `error`「页面生成失败，请重试」。
- 整份文档拼装后超过 400KB 时，记为 `error`「原型过大，请减少页面」。
- 整个任务最多 8 分钟。到时还没完成的页面记为 `error`「超时」，然后按上面的规则收尾。
- 写库前先确认评审还在，不在就直接结束。
- 结束后记一条事件：首次生成为 `proto_create`，修改为 `proto_revise`。摘要是「生成原型：<产品名>，N 页」或「修改原型：<要求前 60 字>」。`payload` 里放 `{ request, note, pages: [标题…] }`。这两种事件加入 `PM_EVENT_KINDS`，交给现有的记忆整理。

### 4.4 并发

- 同一评审同一时间只能有一个 `running` 状态的原型任务，再提交时返回 409「原型正在生成」。
- 全站同时最多 2 个原型任务，超出的排队，`progress` 显示「排队中」。
- 服务启动时，把所有 `running` 状态的原型改为 `error`「服务重启，生成中断，请重试」。

## 5. 页面 HTML 清理（`sanitize.ts`）

先用一个严格的分词器把模型输出切成标签、文本、注释，再按白名单重新输出。没有第三方依赖。

- **整段删除**（连同内容）：`script`、`style`、`iframe`、`frame`、`frameset`、`object`、`embed`、`applet`、`link`、`meta`、`base`、`template`、`noscript`、`title`、`head`、`xmp`、`plaintext`、`math`，以及 `svg` 里的 `foreignObject`、`script`、`animate*`、`set`、`use`、`image`。
- **保留的标签**：`main section header footer nav article aside div span p h1–h6 ul ol li dl dt dd strong em b i u s small mark code pre blockquote br hr figure figcaption table thead tbody tfoot tr th td caption form label input textarea select option button progress`，以及 `svg` 下的 `svg g path circle rect line polyline polygon ellipse`。
- **其他标签**：去掉标签本身，保留里面的内容。
- **保留的属性**：
  - 通用：`class`、`id`、`role`、`aria-*`、`title`、`style`（按下面的规则过滤）。
  - 交互：`data-goto`、`data-back`、`data-open`、`data-close`、`data-tab`、`data-toggle`、`data-toast`、`data-label`、`data-note`。
  - 表单：`type`（只允许 `text search email tel number password date time checkbox radio range submit button`）、`name`、`value`、`placeholder`、`checked`、`selected`、`disabled`、`readonly`、`for`、`min`、`max`、`step`、`rows`、`maxlength`。
  - 表格：`colspan`、`rowspan`。
  - `svg`：`viewBox`、`width`、`height`、`fill`、`stroke`、`stroke-width`、`stroke-linecap`、`stroke-linejoin`、`d`、`cx`、`cy`、`r`、`rx`、`ry`、`x`、`y`、`x1`、`y1`、`x2`、`y2`、`points`、`transform`。属性值里不能出现 `url(`。
- **删除的属性**：所有 `on*`、`href`、`src`、`srcset`、`action`、`formaction`、`xlink:*`、`xmlns*` 等不在白名单里的属性。
- **属性值规则**：
  - `id`、`data-goto`、`data-open` 必须匹配 `^[A-Za-z0-9_:-]{1,64}$`。
  - `data-toast`、`data-label`、`data-note` 最多 60 字。
  - `class` 只保留匹配 `^[A-Za-z0-9_-]{1,40}$` 的类名，最多 12 个。
- **`style` 属性**：按声明拆开，只保留属性名在白名单里的声明（颜色、背景色、边距、内边距、宽高、对齐、字号、字重、圆角、`display`、`flex*`、`grid*`、`gap`、`border*`、`opacity`）。值里出现 `url(`、`expression`、`@`、`\`、`<`、`javascript`、`var(--` 之外的函数调用时，删掉这条声明。
- **输出**：属性一律用双引号输出，并转义 `& < > "`；文本转义 `& < >`；保留的标签按栈自动闭合，结果总是结构完整的。注释和 CDATA 丢弃。
- **实体**：先解码再判断，避免 `&#106;avascript` 这类绕过。

## 6. 外壳与交互（`packs/proto/shell/`）

### 6.1 布局与组件

`proto.css` 提供两种布局，通过 `body` 上的类切换：

- `body.phone`：顶部标题栏（标题、返回按钮）和内容区，有 `nav` 时加底部 Tab 栏。
- `body.desktop`：左侧导航（来自 `nav`）、顶栏（产品名、搜索、头像）和内容区。

外壳负责把每页的 `<main>` 放进 `<section class="pg" data-slug="…" data-title="…">`，同时只显示一页。

组件类（写进页面提示词，要求模型只用这些）：`card`、`list`/`item`、`btn`（`btn-primary`、`btn-ghost`、`btn-text`）、`field`/`input`/`select`/`switch`/`radio`/`check`、`tag`、`badge`、`avatar`（显示姓名首字）、`stat`、`table`、`empty`、`steps`、`tabs`/`tab`/`tab-panel`、`sheet`（底部弹层）、`dialog`、`banner`（提示条）、`searchbar`、`grid-2`/`grid-3`、`row`/`col`/`spacer`、文字辅助类（`muted`、`strong`、`small`、`center`）。

- 图标：内置约 30 个线条图标，写法是 `<i class="ic ic-home">`，用 CSS 的 `mask` 加 `data:` SVG 实现。
- 占位图：`<div class="ph-img" data-label="商品主图">`，显示带文字的灰色块。
- 主题：6 套主题色，用 CSS 变量实现，按大纲的 `theme` 取值。

### 6.2 交互（`proto.js`）

所有交互都用事件委托处理：

| 属性 | 行为 |
| --- | --- |
| `data-goto="slug"` | 跳到该页，写入 `#/slug`，记入历史栈 |
| `data-back` | 返回上一页；没有上一页时回到第一页 |
| `data-open="id"` / `data-close` | 打开或关闭 `sheet`、`dialog`（`data-close` 关闭离它最近的那个） |
| `data-tab="组:项"` | 在同一组里切换 `tab` 和对应的 `tab-panel` |
| `data-toggle` | 切换自身的 `on` 类，同时同步 `checkbox` 的选中状态 |
| `data-toast="文字"` | 弹出提示，2 秒后消失 |
| `form` 提交 | 阻止真正提交，然后依次执行表单上的 `data-toast`、`data-goto` |

- 跳到不存在的页面时，显示「这一页还没有设计」页，附带提示「可以在对话里让它补上」。
- 启动时读取 `#/slug`，没有就打开第一页。

### 6.3 标注模式

- 每页顶部浮出说明卡，显示大纲里这一页的 `purpose` 和 `content`。
- 所有可交互的元素加虚线框，悬停时提示「→ 订单详情」「打开：筛选弹层」「提示：已提交」等。
- 「页面地图」浮层：列出全部页面，以及每页上所有 `data-goto` 的去向；去向不存在的标红。可以点击跳转。
- 标注模式默认关闭。外层页面可以通过消息开关它，导出的文件里也有一个开关按钮。

### 6.4 和外层页面通信

原型通过 `postMessage(…, '*')` 发送消息（隔离来源下只能这样）：

- 发给外层：`{ type: 'proto:page', slug }`（切换页面时）、`{ type: 'proto:ready', pages: [slug…] }`。
- 接收外层：`{ type: 'proto:goto', slug }`、`{ type: 'proto:device', device }`、`{ type: 'proto:notes', on }`。

外层页面只处理 `event.source === iframe.contentWindow` 的消息，`slug` 必须是当前版本里存在的 slug，`device` 和 `on` 只接受固定取值，值只用作选择和开关，不会写进 DOM 结构。原型这一侧也只处理 `event.source === window.parent` 的消息。

## 7. 文档拼装与安全（`assemble.ts`）

`assemble(proto, { device, notes })` 输出一份完整的 HTML：

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="…同下…">
<title>产品名 · 原型 v3</title><style>/* proto.css */</style></head>
<body class="phone theme-blue">
  <script type="application/json" id="proto-data">{"outline":…,"pages":[{slug,title}]}</script>
  <section class="pg" data-slug="home" data-title="首页"><main>…清理后的 HTML…</main></section>
  …
  <script>/* proto.js */</script>
</body></html>
```

- `proto-data` 是 JSON 数据块，不会被执行，供标注模式读取；序列化时把 `<` 转义成 `\u003c`。
- `proto.css` 和 `proto.js` 在启动时读入内存，并算出 `proto.js` 的 SHA-256。

三层防护：

1. **白名单清理**：见第 5 节。
2. **CSP**：原型 HTML 接口返回专用的 CSP 头，文档里也用 `<meta>` 写一份：
   `default-src 'none'; script-src 'sha256-<proto.js 哈希>'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
   （`<meta>` 不支持 `frame-ancestors`，那份去掉这一项。）
3. **沙箱 iframe**：外层页面用 `<iframe sandbox="allow-scripts">` 嵌入，不加 `allow-same-origin`，原型拿到的是隔离来源。

原型 HTML 的响应把 `X-Frame-Options` 改成 `SAMEORIGIN`，并加上 `Cache-Control: no-store`。其余接口的安全头保持不变。

## 8. 对话修改

### 8.1 改动计划

输入：当前查看的原型版本的大纲；该版本每页的标题，以及清理后 HTML 的纯文本摘要（每页前 300 字）；修改要求（1–1000 字）。参数为 `json: true, maxTokens: 3000`。输出：

```json
{
  "note": "登录页增加微信登录入口",
  "outline": { …调整后的完整大纲… },
  "pages": [ { "slug": "login", "change": "在手机号登录下方增加「微信一键登录」按钮…" } ]
}
```

- `outline` 按第 4.1 节的规则校验。
- `pages` 里的 `slug` 必须存在于新大纲；新大纲里新增的页面会自动加入 `pages`。
- 一次最多重新生成 10 页，超过时返回 `error`「改动太大，建议按新 PRD 重新生成」。
- `pages` 为空、`note` 为空时，返回 `error`「没理解修改要求，请换个说法」。
- JSON 解析失败时重试一次。

### 8.2 重新生成

- 计划里列出的页面：调用模型时带上新大纲、这一页当前的 HTML（新页面没有）和 `change`，输出改好的整页，处理流程同第 4.2 节。
- 其余页面：从基础版本原样复制；新大纲里删掉的页面不再保留。
- 新版本的 `from_n` 是基础版本，`base_version_n` 沿用基础版本的值。

### 8.3 按新 PRD 重新生成

完整走一遍第 4 节的流程，`from_n` 为空，`request` 写「按 PRD v3 重新生成」，旧版本都保留。

## 9. 接口（`apps/server/proto-api.ts`）

都需要登录，写操作需要同源。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/pm/reviews/:id/prototypes` `{ versionN }` | 首次生成或按新 PRD 重新生成，返回 202 `{ prototype }` |
| `POST /api/pm/reviews/:id/prototypes/:n/revise` `{ text }` | 基于第 n 版修改，返回 202 `{ prototype }` |
| `POST /api/pm/reviews/:id/prototypes/:n/retry` | 重试失败版本，返回 202 |
| `GET /api/pm/reviews/:id/prototypes` | 版本列表：`n`、`status`、`progress`、`request`、`note`、`base_version_n`、`from_n`、`device`、`pages`（只有 slug、标题、error）、`error`、时间 |
| `GET /api/pm/reviews/:id/prototypes/:n/html?device=&download=1` | 完整 HTML；带 `download=1` 时用 `contentDisposition` 下载，文件名为 `<产品名>-原型-v<n>.html` |
| `GET /proto/:id/:n` | 全屏页（静态外层页，使用正常的 CSP） |

错误码：

- 400：参数不合法，如修改要求长度、`versionN` 不存在。
- 404：评审或原型版本不存在。
- 409：原型正在生成；或者对 `running`/`error` 状态的版本提修改（「请等生成完成」「这一版生成失败，请先重试」）。
- 503：未配置模型。

## 10. 前端

### 10.1 原型面板（`proto-panel.js`，评审页文档下方、追问区前面）

- **未生成**：「生成原型」按钮，旁边说明「约 1–2 分钟，按当前查看的 PRD v<n> 生成」。
- **生成中**：显示进度（「排队中」「正在规划页面…」「页面 3/7」），每 2 秒轮询一次。离开页面再回来，进度还在。
- **已生成**：
  - 工具栏：版本切换（v1…vn，失败版本标红并带「重试」），页面下拉框，手机/桌面切换，「标注」开关，「全屏」「下载」。
  - 预览框：手机模式是 390×844 的设备框；桌面模式按 1280 宽渲染，再用 `transform: scale()` 缩放到内容区宽度。外层页面本身在手机上打开时，预览框按屏幕宽度等比缩小。
  - 当前版本的信息：修改要求、`note`、「基于 PRD v2」「基于原型 v2」。
  - PRD 有更新时显示提示条：「原型基于 PRD v2，PRD 已更新到 v3」，带「按新 PRD 重新生成」按钮。
  - 修改输入框：占位文字「描述要怎么改原型，比如：登录页加一个微信登录」，1–1000 字，提交后基于当前查看的版本修改。
- 切换终端时，用新的 `device` 参数重新加载 iframe，并保持当前页面（`#/slug`）。

### 10.2 全屏页（`/proto/:id/:n`）

顶部是一条精简工具栏（产品名、版本、页面下拉框、终端切换、标注、下载、返回评审），下面是铺满屏幕的 iframe。

## 11. 上限汇总

| 项目 | 上限 |
| --- | --- |
| 输入 PRD | 大纲 1.2 万字，页面 6000 字 |
| 修改要求 | 1–1000 字 |
| 页面数 | 3–10 页 |
| 单页 | 模型输出 6000 tokens，超时 180 秒，清理后 40KB |
| 整份文档 | 400KB |
| 单个任务 | 8 分钟 |
| 并发 | 页面 3 个；全站原型任务 2 个；每个评审 1 个 |
| 版本 | 每个评审 20 版，`v1` 永久保留 |

成本估计：完整生成一次大约 10 万 tokens（以输入为主），修改一页大约 1–2 万。

## 12. 测试

- **`sanitize`**（重点）：
  - 常见的 XSS 写法逐条测：`<script>`、`on*`、`javascript:` 和实体编码的变体、svg 里的 `foreignObject`/`animate`/`use`、`style` 里的 `url()`/`expression`、拆开的标签（`<scr<script>ipt>`）、大小写混用、属性不加引号、注释和 CDATA 里夹带的内容、没有闭合的标签、`</main>` 提前闭合。
  - 白名单里的类名、`data-*`、表单属性都保留下来；输出可以再次清理且结果不变（幂等）。
- **`outline`**：页数边界、重复和不合法的 slug 重命名后引用同步更新、非法的 `device`/`theme`、超大的 `data`。
- **`runner`**（桩模型）：
  - 生成：并发不超过 3；截断后重试；部分页面失败；8 分钟总时限（注入时钟）；评审被删除后不写库；事件。
  - 修改：只重新生成计划里的页面，其余原样复制；基于旧版本修改；新增和删除页面；超过 10 页时报错。
  - 版本上限（保留 v1）；同一评审并发提交返回 409；全站排队；重启恢复。
- **`assemble`**：CSP 里的哈希和 `proto.js` 一致；`proto-data` 里的 `</script>` 被转义；下载的文件带 `<meta>` CSP。
- **接口脚本**：登录和同源校验、原型 HTML 的 CSP 和 `X-Frame-Options: SAMEORIGIN`、下载头、各错误码。
- **UI 模拟**：
  - 原型面板：未生成、生成中、已生成、失败四种状态；版本切换；提交修改；PRD 更新提示；只处理来自本 iframe 的消息。
  - `proto.js`：跳页、返回、弹层、Tab、开关、提示、表单提交、跳到不存在的页面、标注模式与页面地图。
- **真实冒烟**：拿线上一个 PRD 评审生成原型、修改一轮、下载，记录耗时和 token 用量；测完删除测试数据。本机没有浏览器，最终视觉效果由用户在浏览器里确认。

## 13. 部署

- 迁移 8 是新增表，不改动已有数据。上线前先备份数据库：`VACUUM INTO 'data/opc.db.bak-pre-proto'`。
- 没有新的系统依赖，Caddy 配置不用改。
- README 新增「原型」一节：用途、生成和修改方式、标注模式、导出、上限、安全说明。
