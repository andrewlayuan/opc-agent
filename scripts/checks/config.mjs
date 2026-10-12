#!/usr/bin/env node
// 配置自检：JSON 能解析、策略里的正则能编译、两家钩子都指向同一个脚本。
import { readFileSync } from 'node:fs';
const j = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pol = j('policy/opc.policy.json');
[...pol.shell.deny, ...pol.shell.ask].forEach((r) => new RegExp(r.re));
const cb = JSON.stringify(j('.codebuddy/settings.json')), cu = JSON.stringify(j('.cursor/hooks.json'));
j('policy/bands.json');
if (!cb.includes('scripts/hooks/guard.mjs') || !cu.includes('scripts/hooks/guard.mjs')) { console.error('两家钩子必须都调用 scripts/hooks/guard.mjs'); process.exit(1); }
console.log('config: OK');
