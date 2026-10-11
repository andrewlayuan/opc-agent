---
issue: <n>
status: draft        # 只能由你本人执行 npm run approve -- <n> 改为 approved（G2）
---
# 计划：<一句话>

## 改哪些文件（按顺序）
1. `packs/radar/src/xxx.ts`：___
2. `packs/radar/src/xxx.test.ts`（新增）：___

## 每条需求怎么证明
| R | 证据 |
|---|---|
| R1 | `node --test packs/radar/src/xxx.test.ts` |

## 风险与回退
- 风险：___ → 对策：___
- 回退：revert 这个 PR 即可；不涉及数据迁移 / 涉及迁移时的回退步骤 ___

## 预计
- 改动约 ___ 行；新依赖：无 / ___（许可证 ___）
