import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../packages/core/db.ts';
import type { DB } from '../../packages/core/db.ts';
import { ENTITY_FIELDS, FACT_FIELDS, fieldLabel, getEntity, getFacts, saveEntity, saveFacts, validateEntity, validateFacts } from './facts.ts';
import { CpError, createProduct, deleteProduct, getProduct } from './store.ts';

function tmpDb(): { db: DB; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cpf-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const throwsCp = (fn: () => unknown, status: number, msg?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof CpError && e.status === status && (!msg || msg.test(e.message)));

test('字段清单：主体 7 项、产品资料 11 项，key 与 spec 一致', () => {
  assert.deepEqual(ENTITY_FIELDS.map((f) => f.key), ['company_name', 'credit_code', 'address', 'contact_email', 'contact_phone', 'pi_officer', 'pi_officer_contact']);
  assert.deepEqual(FACT_FIELDS.map((f) => f.key), ['public_name', 'site', 'complaint', 'effective_date', 'model_name', 'model_filing_no', 'model_provider', 'data_location', 'retention', 'sdks', 'minor_mode']);
  assert.ok(FACT_FIELDS.every((f) => f.group));
});

test('validateEntity：信用代码、邮箱、长度；清单外丢弃；空串省略', () => {
  assert.deepEqual(validateEntity({ company_name: ' 某某科技有限公司 ', credit_code: '', foo: 1 }), { company_name: '某某科技有限公司' });
  throwsCp(() => validateEntity({ credit_code: '123' }), 400, /统一社会信用代码格式不对/);
  throwsCp(() => validateEntity({ contact_email: 'a@' }), 400, /联系邮箱格式不对/);
  throwsCp(() => validateEntity({ company_name: '字'.repeat(101) }), 400, /公司全称不超过 100 字/);
  throwsCp(() => validateEntity({ address: 3 }), 400, /注册地址格式不对/);
  throwsCp(() => validateEntity('x'), 400);
  throwsCp(() => validateEntity([]), 400);
  assert.equal(validateEntity({ credit_code: '91110108MA01ABCD2X' }).credit_code, '91110108MA01ABCD2X');
  assert.equal(validateEntity({ contact_email: 'a@b.cn' }).contact_email, 'a@b.cn');
});

test('validateFacts：日期、选项、SDK 行', () => {
  throwsCp(() => validateFacts({ effective_date: '2026/11/20' }), 400, /材料生效日期格式不对/);
  throwsCp(() => validateFacts({ effective_date: '2026-02-30' }), 400);
  throwsCp(() => validateFacts({ minor_mode: 'maybe' }), 400);
  throwsCp(() => validateFacts({ sdks: [{ name: 'x', policy_url: 'http://a.com' }] }), 400);
  throwsCp(() => validateFacts({ sdks: [{ name: '' }] }), 400);
  throwsCp(() => validateFacts({ sdks: 'x' }), 400);
  throwsCp(() => validateFacts({ sdks: [null] }), 400);
  throwsCp(() => validateFacts({ sdks: Array.from({ length: 31 }, () => ({ name: 'a' })) }), 400);
  assert.deepEqual(validateFacts({ sdks: [{ name: ' 友盟 ', purpose: '统计', policy_url: 'https://u.com/p', x: 1 }] }).sdks, [
    { name: '友盟', purpose: '统计', data: '', policy_url: 'https://u.com/p' },
  ]);
  assert.deepEqual(validateFacts({ sdks: [] }), { sdks: [] });
  assert.deepEqual(validateFacts({ effective_date: '2026-11-20', minor_mode: '' }), { effective_date: '2026-11-20' });
});

test('fieldLabel：entity.* / facts.*；未知抛错', () => {
  assert.equal(fieldLabel('entity.company_name'), '公司全称');
  assert.equal(fieldLabel('facts.sdks'), '第三方 SDK');
  assert.throws(() => fieldLabel('facts.nope'));
  assert.throws(() => fieldLabel('company_name'));
});

test('存取：主体单行覆盖；产品资料随产品，整体覆盖并更新产品时间；删除产品后 404', () => {
  const { db, done } = tmpDb();
  assert.deepEqual(getEntity(db), {});
  saveEntity(db, { company_name: 'A', address: '北京' }, 1);
  assert.deepEqual(saveEntity(db, { company_name: 'B' }, 2), { company_name: 'B' });
  assert.deepEqual(getEntity(db), { company_name: 'B' });
  const pid = createProduct(db, { name: 'p' });
  assert.deepEqual(getFacts(db, pid), {});
  saveFacts(db, pid, { site: 'a.com', retention: '1 年' }, 9);
  saveFacts(db, pid, { site: 'b.com' }, 10);
  assert.deepEqual(getFacts(db, pid), { site: 'b.com' });
  assert.equal(getProduct(db, pid).product.updated_at, 10);
  throwsCp(() => getFacts(db, 999), 404);
  throwsCp(() => saveFacts(db, 999, {}), 404);
  deleteProduct(db, pid);
  throwsCp(() => getFacts(db, pid), 404);
  done();
});
