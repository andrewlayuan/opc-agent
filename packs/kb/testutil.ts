// 知识库测试共用：临时数据库
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';

export function tmpKbDb(): { db: DB; dir: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-kb-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
