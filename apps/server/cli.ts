import { loadConfig } from '../../packages/core/config.ts';
import { openDb } from '../../packages/core/db.ts';
import { generateBrief } from '../../packs/radar/analyze.ts';
import { Radar } from '../../packs/radar/service.ts';

const cmd = process.argv[2];
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const radar = new Radar(db, cfg);

if (cmd === 'run') {
  console.log(await radar.runCycle());
} else if (cmd === 'brief') {
  const b = await generateBrief(db, radar.llm, radar.topics, 24);
  console.log(b.content);
  console.log('\n来源：');
  for (const it of b.items) console.log(`[${it.n}] ${it.title} — ${it.url}`);
} else {
  console.log('用法：node apps/server/cli.ts run|brief');
  process.exitCode = 1;
}
db.close();
