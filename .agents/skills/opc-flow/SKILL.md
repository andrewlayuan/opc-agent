---
name: opc-flow
description: 处理任何新需求、缺陷或改动时使用。规定 intent → spec → plan → 构建 → 自检 → PR 的文件链与关口，以及分支命名和 A/B/C/D 通道判断。
---
# opc 交付流程

## 第 0 步：判断通道
| 通道 | 典型 | 要走的文件 | 关口 |
|---|---|---|---|
| A 快车道 | 文案、配置、小缺陷（≤80 行，fix/chore） | Issue + plan（可很短） | G2 可直接批；CI 全绿 + 自审通过后你合并 |
| B 标准道 | 已有能力包里的小功能 | intent + plan | G1 + G2 + G3 |
| C 重点道 | 新能力包、新信息源类型、跨包改动 | intent + spec + plan | G1 + G2 + G3 |
| D 管控道 | 法务/财务/注册、密钥与数据外发、core 安全 | intent + spec + plan + ADR | 同 C，且 G3 必须逐行看代码 |

## 第 1 步：意图（G1）
复制 `docs/templates/intent.md` 到 `docs/intent/<n>-<短名>.md`，n 为 GitHub Issue 号。写完停下，请用户确认。

## 第 2 步：规格与计划（G2）
- C/D 类先写 `docs/specs/<n>-<短名>.md`：每条需求编号 R1、R2…，每条都要有"怎么验证"。
- 写 `docs/plans/<n>-<短名>.md`：改哪些文件、顺序、风险、每条 R 用哪个测试或 eval 证明。保持 `status: draft`。
- 停下，告诉用户执行 `npm run approve -- <n>`。**不要自己改 status。**

## 第 3 步：构建
- `git switch -c feat/<n>-<短名>`（缺陷用 fix/，杂项用 chore/）
- 先写或补测试，再写实现；每完成一个 R 就跑 `npm run verify:fast`
- 修缺陷：先写一个能复现的失败测试，然后只改实现代码

## 第 4 步：自检 + PR
- `npm run verify` 全绿，把最后 20 行输出贴进 PR
- 用 `verifier` 子代理逐条对照 R 编号做验收（它只报告，不修改）
- `gh pr create`，描述里按 PR 模板填写验收包；然后停下，等用户 G3
