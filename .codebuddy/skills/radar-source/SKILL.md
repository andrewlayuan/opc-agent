---
name: radar-source
description: 给 P0 情报雷达新增或修改一个信息源（RSS、GitHub Trending/Release、arXiv、Hacker News、Product Hunt、公司博客等）时使用。
---
<!-- 由 npm run sync 从 .agents/ 生成，请勿直接修改 -->
# 新增信息源的做法
1. 在 `packs/radar/sources/<id>.ts` 实现 `Source` 接口：`id`、`kind`(product|tech|market)、`fetch(since): Promise<RawItem[]>`
2. 网络请求一律用 `packages/core/fetch` 的 `politeFetch`（带 UA、限速 1 次/秒、按 ETag 缓存、遵守 robots.txt）
3. 只采集公开信息；不登录、不绕过付费墙、不抓个人隐私字段
4. 把一份真实响应存成夹具 `packs/radar/sources/__fixtures__/<id>.*`，测试只读夹具，不联网
5. 在 `packs/radar/sources.yaml` 登记：id、url、kind、频率、许可说明
6. 给 `evals/product/radar/` 加 1 个用例：给定夹具，应抽出哪些条目（标题、链接、日期）
