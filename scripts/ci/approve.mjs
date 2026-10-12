#!/usr/bin/env node
// G2 关口：只有你本人在自己的终端运行。把计划改为 approved，记录批准人和时间，并单独提交一次。
// 用法：npm run approve -- <Issue号>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
const n = process.argv[2];
if (!n) { console.error('用法：npm run approve -- <Issue号>'); process.exit(1); }
if (!process.stdin.isTTY || process.env.CI) { console.error('拒绝：批准必须在你本人的交互终端里执行（Agent/CI 环境不行）。'); process.exit(1); }
const f = readdirSync('docs/plans').find((x) => x === `${n}.md` || x.startsWith(`${n}-`));
if (!f) { console.error(`找不到 docs/plans/${n}-*.md`); process.exit(1); }
const p = `docs/plans/${f}`;
console.log(readFileSync(p, 'utf8').split('\n').slice(0, 40).join('\n') + '\n……');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ans = (await rl.question(`\n确认批准 ${p}？输入 yes 继续：`)).trim(); rl.close();
if (ans !== 'yes') { console.log('已取消'); process.exit(1); }
let t = readFileSync(p, 'utf8');
const who = execSync('git config user.name').toString().trim();
const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
t = t.replace(/^approved_by:.*\n/m, '');
t = /^status:/m.test(t) ? t.replace(/^status:.*$/m, `status: approved\napproved_by: ${who} @ ${when}`) : t.replace(/^---\n/, `---\nstatus: approved\napproved_by: ${who} @ ${when}\n`);
writeFileSync(p, t);
execSync(`git add "${p}" && git commit -m "plan(#${n}): approved by ${who}"`, { stdio: 'inherit' });
console.log(`✅ G2 已批准：${p}。现在可以让 Agent 执行 /build ${n}`);
