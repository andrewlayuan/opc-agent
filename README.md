# opc-agent · OPC Radar

个人 AI 技术情报雷达：定时抓取官方博客、技术大牛博客、国内外模型发布（Hugging Face）、开源框架 Release、论文和社区/媒体，经过去重后用 DeepSeek 生成中文摘要、要点分析和重要度，支持一键翻译全文和生成每日简报。情报库以 MCP 工具的形式接入 DeepSeek Harness，Agent 可以直接查询。

## 目录

| 路径 | 说明 |
| --- | --- |
| `apps/server` | Web 服务（极简界面）与 CLI |
| `packages/core` | 配置、SQLite 存储（FTS5）、安全外发（白名单、禁止访问内网、robots.txt、限速）、LLM、鉴权 |
| `packs/radar` | 信息源 `sources.json`、关注主题 `topics.json`、采集、去重、分析、「我的关注」 |
| `packs/pm` | 产品顾问：读取 pm-skills 框架，生成商业化产品评审 |
| `integrations/dsh/skills/pm-advisor` | DSH 中的产品顾问入口 skill |
| `scripts/setup-pm-skills.sh` | 拉取 pm-skills（锁定提交）并链接到 `.dsh/skills/` |
| `mcp/opc-radar` | 只读 MCP 服务（stdio） |
| `integrations/dsh` | DeepSeek Harness 的 overlay 配置 |
| `bin/dsh` | 本地 DSH 入口（Node 24，`DSH_HOME=/opt/opc-agent/.dsh`） |
| `bin/agent-reach` | Agent-Reach 入口（独立 venv，HOME 隔离在 `.agent-reach-home/`） |
| `deepseek-harness/`、`dsh-superagent-prototype/`、`agent-reach/`、`pm-skills/` | 上游仓库（单独维护，不纳入本仓库） |
| `opc-agent-starter/` | L3 护栏 starter（未启用） |

## 运行

需要 Node ≥ 22.18，项目没有第三方依赖。

```sh
bash /opt/start.sh                # 启动 Web（默认 http://127.0.0.1:4180）
npm run hash-password             # 生成 OPC_ADMIN_HASH
npm run radar:run                 # 手动执行一轮采集和分析
npm run brief                     # 在命令行生成今日简报
npm test
```

环境变量：

| 变量 | 说明 |
| --- | --- |
| `OPC_ADMIN_USER`、`OPC_ADMIN_HASH` | 必填 |
| `DEEPSEEK_API_KEY` | 必填，存放在 `/opt/opc-agent.env`（权限 600，`KEY=VALUE` 格式），由 `/opt/start.sh` 加载 |
| `OPC_PORT` | 可选 |
| `OPC_HOST` | 可选，默认 `127.0.0.1` |
| `OPC_PUBLIC_ORIGIN` | 可选 |
| `OPC_DATA_DIR` | 可选，默认 `./data` |
| `OPC_FETCH_INTERVAL_MIN` | 可选，默认 60 |
| `OPC_ANALYZE_LIMIT` | 可选，每轮最多分析的条数，默认 80 |
| `OPC_MAX_AGE_DAYS` | 可选，默认 14 |
| `OPC_LLM_MODEL` | 可选，默认 `deepseek-chat` |
| `OPC_LLM_BASE_URL` | 可选 |
| `OPC_FULLTEXT_LIMIT` | 可选，每轮最多用 Agent-Reach 补全多少条正文，默认 25，设为 0 关闭 |
| `OPC_AGENT_REACH` | 可选，设为 `off` 停用 Agent-Reach |
| `OPC_PM_SKILLS_DIR` | 可选，pm-skills 目录，默认 `./pm-skills` |

## 我的关注

动态页第一个标签「★ 我的关注」只显示你选定方向的重点内容（默认重要度 ≥3，可改为只看 ≥4 或全部），设置保存在服务端。简报页勾选「只看我的关注」可以生成聚焦这些方向的简报；24 小时内条目太少时会自动放宽到 72 小时。

主题归类：分析时由模型判定主题，再并上标题/摘要命中的关键词（`autoTag: false` 的主题只认模型判定）。`topics.json` 的主题 id 或名称变化后，历史条目会在下一轮采集时按标题+摘要自动重新归类（每 40 条一次模型调用）。

## 产品顾问（pm-skills）

「产品顾问」页面：输入需求或点子，多选评审方案（点子快评、商业模式与变现、市场与竞争、上市与增长、需求评审、战略红队、PRD 初稿），也可以展开「自选框架」单独勾选任意 pm-skills 框架；所选方案和框架会合并去重，一次最多 6 个，不选即智能匹配；可以勾选「结合雷达情报」引用库里的相关动态。评审在后台进行，通常 30 秒到 2 分钟；结果和历史保存在数据库中。

首版出来后可以在同一会话里继续对话：提问会得到简短回答，提出修改（如「定价部分按 To B 年费重写」）会生成新版本文档；勾选「改写文档」可强制改写。每个版本都可以切换查看、在 Markdown 原文上手动编辑（保存为新版本，之后的对话基于它）、下载 `.md`，或打开打印页用浏览器「打印 → 另存为 PDF」。会话、对话和全部版本都保存在本机数据库里。

方法框架来自 [pm-skills](https://github.com/phuryn/pm-skills)（MIT，锁定提交 `9af7bfd`，v2.3.0）。服务只读取 `pm-<插件>/skills/<技能>/SKILL.md` 的文本，不执行其中任何内容，拒绝符号链接和超过 64KB 的文件。法律文书、简历、代码评审类插件（`pm-toolkit`、`pm-ai-shipping`）不加载。

```sh
sh scripts/setup-pm-skills.sh   # 首次安装或升级（升级时先修改脚本里的 PM_SKILLS_REV）
```

DSH 中可以直接说「用产品顾问帮我评估……」，`pm-advisor` skill 会挑选并串联相应框架，并用 `opc_radar` 工具查找佐证。

## 接入 DeepSeek Harness

```sh
set -a; . /opt/opc-agent.env; set +a      # 从权限 600 的文件加载 DEEPSEEK_API_KEY，不要写在命令行
npm run dsh:web                           # DSH Web UI：127.0.0.1:3080，已挂载 opc_radar 工具
bin/dsh headless --patch integrations/dsh/opc-radar.cordis.yml "用 opc_radar 总结今天的 Agent 动态"
```

## Agent-Reach

[Agent-Reach](https://github.com/Panniantong/Agent-Reach)（锁定提交 `c62128a`，v1.6.1）用于两件事：

- **采集**：`kind: "reach"` 的信息源，目前是 V2EX 的 openai / claude / deepseek 节点和热门。
- **全文补全**：RSS 只给摘要（少于 1200 字）时，在分析和翻译前用 `web read` 读取原文。论文、Release 和社区帖子不补全。

雷达只允许调用 `v2ex hot`、`v2ex node`、`web read` 这三个命令。调用时不经过 shell，参数会先校验，子进程拿不到 API Key。`web read` 之前会检查目标地址不是内网，并遵守目标站点的 robots.txt。

DSH 通过 `.dsh/skills/agent-reach` 加载它的 skill，会话中的 Agent 可以直接使用 `agent-reach`。需要登录的渠道（小红书、X 等）默认没有开启。

## 自定义

- 信息源：编辑 `packs/radar/sources.json`，也可以在界面的「信息源」页添加任意 https RSS 地址。`kind` 可以是 `feed`、`hf-models` 或 `github-releases`。
- 关注主题：编辑 `packs/radar/topics.json`，其中的关键词同时用于过滤和打标签；`hint` 帮助模型判断归类边界。修改后重启服务生效。
