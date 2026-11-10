import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Reach, cleanMarkdown, reachCommandAllowed } from './reach.ts';

function fakeBin(script: string): { bin: string; argsFile: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  const argsFile = path.join(dir, 'args');
  const bin = path.join(dir, 'agent-reach');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nenv > '${argsFile}.env'\n${script}\n`, { mode: 0o755 });
  return { bin, argsFile, dir };
}

test('只允许白名单命令', () => {
  assert.equal(reachCommandAllowed(['v2ex', 'node', 'openai']), true);
  assert.equal(reachCommandAllowed(['web', 'read', 'https://a.com']), true);
  assert.equal(reachCommandAllowed(['xiaohongshu', 'search', 'x']), false);
  assert.equal(reachCommandAllowed(['login', 'twitter']), false);
  assert.equal(reachCommandAllowed(['uninstall']), false);
});

test('解析成功输出，参数原样传递且不经 shell，子进程拿不到 API Key', async () => {
  const f = fakeBin(`echo '{"ok":true,"items":[{"title":"t","url":"https://www.v2ex.com/t/1","author":"a","published_at":"2026-11-04T00:00:00Z","text":"x"}]}'`);
  process.env.DEEPSEEK_API_KEY_TEST_LEAK = 'secret';
  const r = new Reach({ bin: f.bin, enabled: true });
  const items = await r.run(['v2ex', 'node', 'openai', '5']);
  assert.equal(items[0].url, 'https://www.v2ex.com/t/1');
  assert.deepEqual(fs.readFileSync(f.argsFile, 'utf8').trim().split('\n'), ['v2ex', 'node', 'openai', '--limit', '5']);
  assert.doesNotMatch(fs.readFileSync(f.argsFile + '.env', 'utf8'), /secret|DEEPSEEK/);
  delete process.env.DEEPSEEK_API_KEY_TEST_LEAK;
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('拒绝注入式参数与内网 URL', async () => {
  const f = fakeBin(`echo '{"ok":true,"items":[]}'`);
  const r = new Reach({ bin: f.bin, enabled: true });
  await assert.rejects(r.run(['v2ex', 'node', 'openai; rm -rf /']), /节点名/);
  await assert.rejects(r.run(['v2ex', 'node', '--backend']), /节点名/);
  await assert.rejects(r.run(['v2ex', 'hot', '999']), /limit/);
  await assert.rejects(r.run(['web', 'read', 'http://127.0.0.1/']), /IP/);
  await assert.rejects(r.run(['web', 'read', 'https://intranet.local/x']), /本地域名/);
  await assert.rejects(r.run(['web', 'read', 'file:///etc/passwd']), /协议/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('透传 Agent-Reach 的错误码', async () => {
  const f = fakeBin(`echo '{"ok":false,"error":{"code":"RATE_LIMITED","message":"HTTP 429"}}'; exit 1`);
  const r = new Reach({ bin: f.bin, enabled: true });
  await assert.rejects(r.run(['v2ex', 'hot']), (e: Error & { code?: string }) => e.code === 'RATE_LIMITED');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('未启用时直接报 NEED_SETUP', async () => {
  const r = new Reach({ bin: '/nonexistent/agent-reach' });
  assert.equal(r.enabled, false);
  await assert.rejects(r.run(['v2ex', 'hot']), (e: Error & { code?: string }) => e.code === 'NEED_SETUP');
});

test('Markdown 清理为纯文本', () => {
  const md = '# Title\n\n![img](https://x/y.png)\nSee [the docs](https://a.com/(x)) and **bold**.\n\n---\n\n<script>bad()</script>end';
  const out = cleanMarkdown(md);
  assert.equal(out.includes('https://'), false);
  assert.match(out, /^Title\n\nSee the docs and bold\./);
  assert.doesNotMatch(out, /<script>/);
});
