#!/usr/bin/env node
// 整理 AI 审查输出再发评论：去掉第一个 "## " 标题之前的过程性文字；没有内容时给一句说明，避免发空评论导致步骤失败。
// 用法：node scripts/ci/review-body.mjs < review.md > body.md
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EMPTY_NOTE = 'AI 审查没有产出内容，见 Actions 日志。';

export function reviewBody(raw = '') {
  const t = String(raw ?? '').replace(/\r\n/g, '\n');
  const i = t.search(/^## /m);
  return (i >= 0 ? t.slice(i) : t).trim() || EMPTY_NOTE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* 没有 stdin */ }
  process.stdout.write(reviewBody(raw) + '\n');
}
