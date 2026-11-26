// 自定义信息源的校验与修改（添加、编辑共用同一套规则）
import type { DB } from '../../packages/core/db.ts';

export class SourceInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface SourceInput {
  name: string;
  url: URL;
  lang: 'zh' | 'en';
  filter: 0 | 1;
}

/** 只允许 https、不带凭据与非标准端口；名称必填 */
export function parseSourceInput(body: Record<string, unknown>): SourceInput {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceInputError('URL 不合法');
  }
  if (u.protocol !== 'https:') throw new SourceInputError('只支持 https 订阅地址');
  if (u.username || u.password || (u.port && u.port !== '443')) throw new SourceInputError('URL 不能带凭据或非标准端口');
  if (!name) throw new SourceInputError('请填写名称');
  return { name, url: u, lang: body.lang === 'zh' ? 'zh' : 'en', filter: body.filter ? 1 : 0 };
}

/** 修改自定义源；内置源不能改。地址变了就清掉旧的缓存与错误（已抓取的条目保留）。返回地址是否变化 */
export function updateCustomSource(db: DB, id: string, input: SourceInput): { moved: boolean } {
  const src = db.prepare('SELECT custom, url FROM sources WHERE id = ?').get(id) as { custom: number; url: string } | undefined;
  if (!src) throw new SourceInputError('信息源不存在', 404);
  if (!src.custom) throw new SourceInputError('内置信息源只能启用或停用，不能修改');
  const moved = input.url.href !== src.url;
  db.prepare(`UPDATE sources SET name = ?, url = ?, lang = ?, filter = ?${moved ? ', etag = NULL, last_modified = NULL, last_error = NULL' : ''} WHERE id = ?`).run(input.name, input.url.href, input.lang, input.filter, id);
  return { moved };
}
