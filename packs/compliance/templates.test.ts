import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entity, Facts } from './facts.ts';
import { ENTITY_FIELDS, fieldLabel } from './facts.ts';
import { CATALOG, assess, type Answers } from './rules.ts';
import {
  TEMPLATES,
  TEMPLATES_VERSION,
  answerText,
  availability,
  chaptersFor,
  kindsForItem,
  ph,
  placeholdersIn,
  templateOf,
  v,
  type Ctx,
} from './templates.ts';

const writer = (o: Answers = {}): Answers => ({
  forms: ['app'], audience: 'public', overseas: 'no', charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'], algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const FULL_ENTITY: Entity = Object.fromEntries(ENTITY_FIELDS.map((f) => [f.key, `E-${f.key}`]));
const FULL_FACTS: Facts = {
  public_name: '写作助手', site: 'https://a.com', complaint: '客服邮箱', effective_date: '2026-12-01', model_name: 'M', model_filing_no: 'No.1',
  model_provider: 'P', data_location: '北京', retention: '一年', minor_mode: 'yes',
  sdks: [{ name: '统计 SDK', purpose: '统计', data: '设备信息', policy_url: 'https://s.com/p' }],
};
const ctxWith = (entity: Entity, facts: Facts, product = { name: '产品', description: '描述' }, answers = writer()): Ctx => ({ entity, facts, answers, product });

test('10 种材料与 spec 3.1 一致；items 在 CATALOG 中；key 唯一；uses 可解析；固定章有 render、模型章有 points', () => {
  assert.equal(TEMPLATES_VERSION, 1);
  assert.deepEqual(TEMPLATES.map((t) => [t.kind, t.usage, t.items]), [
    ['privacy_policy', 'public', []],
    ['terms', 'public', []],
    ['app_statement', 'filing', ['genai_register', 'genai_filing']],
    ['algo_selfassess', 'filing', ['algo_filing', 'genai_filing']],
    ['algo_disclosure', 'public', ['algo_filing']],
    ['model_disclosure', 'public', ['model_disclosure']],
    ['security_report', 'filing', ['security_assess']],
    ['anthro_report', 'filing', ['anthro_assess', 'anthro_selfcheck']],
    ['aigc_label_plan', 'filing', ['aigc_label']],
    ['minor_statement', 'public', ['minor_protect']],
  ]);
  const ids = new Set(CATALOG.map((c) => c.id));
  for (const t of TEMPLATES) {
    assert.ok(t.name && t.version >= 1 && t.chapters.length > 0, t.kind);
    assert.ok(t.items.every((i) => ids.has(i)), t.kind);
    assert.equal(new Set(t.chapters.map((c) => c.key)).size, t.chapters.length, t.kind);
    for (const c of t.chapters) {
      assert.match(c.key, /^[a-z][a-z0-9_]{0,30}$/, `${t.kind}.${c.key}`);
      assert.ok(c.title, `${t.kind}.${c.key}`);
      for (const u of c.uses) assert.doesNotThrow(() => fieldLabel(u), `${t.kind}.${c.key} ${u}`);
      if (c.mode === 'fixed') assert.equal(typeof c.render, 'function', `${t.kind}.${c.key}`);
      else assert.ok((c.points?.length ?? 0) > 0, `${t.kind}.${c.key}`);
    }
  }
});

test('章节 key 与 spec 3.2 一致', () => {
  const keys = (k: string) => templateOf(k)!.chapters.map((c) => (c.mode === 'fixed' ? `${c.key}*` : c.key)).join(' ');
  assert.equal(keys('privacy_policy'), 'intro* collect ai cookies sharing sdks* storage* cross_border security rights* minors updates* contact*');
  assert.equal(keys('terms'), 'accept* service account conduct ai payment ip liability change* law* contact*');
  assert.equal(keys('app_statement'), 'basic* service model* users flow safety label complaint*');
  assert.equal(keys('algo_selfassess'), 'basic principle data risks measures governance conclusion');
  assert.equal(keys('algo_disclosure'), 'principle purpose mechanism choice');
  assert.equal(keys('model_disclosure'), 'name* filing_no* provider* placement*');
  assert.equal(keys('security_report'), 'basic s1_officer s2_identity s3_logs s4_harmful s5_tech s6_complaint s7_cac s8_police conclusion');
  assert.equal(keys('anthro_report'), 'basic features users identity addiction content privacy emergency conclusion');
  assert.equal(keys('aigc_label_plan'), 'scope explicit implicit notice logs check');
  assert.equal(keys('minor_statement'), 'identity mode time content spending under14 guardian');
});

test('固定章：资料齐全无占位；每个 uses 字段缺失时出现其占位', () => {
  for (const t of TEMPLATES) {
    for (const c of t.chapters.filter((x) => x.mode === 'fixed')) {
      const full = c.render!(ctxWith(FULL_ENTITY, FULL_FACTS));
      assert.ok(full.trim(), `${t.kind}.${c.key} 非空`);
      assert.deepEqual(placeholdersIn(full), [], `${t.kind}.${c.key}`);
      const empty = placeholdersIn(c.render!(ctxWith({}, {})));
      for (const u of c.uses) assert.ok(empty.includes(fieldLabel(u)), `${t.kind}.${c.key} 缺 ${u}`);
    }
  }
});

test('固定章：对外名称未填时用产品名，不出占位', () => {
  const intro = templateOf('privacy_policy')!.chapters.find((c) => c.key === 'intro')!;
  assert.ok(intro.render!(ctxWith(FULL_ENTITY, { ...FULL_FACTS, public_name: undefined }, { name: '小写作', description: '' })).includes('小写作'));
  assert.ok(intro.render!(ctxWith(FULL_ENTITY, FULL_FACTS)).includes('写作助手'));
});

test('SDK 表格：| 与换行转义；未填与空列表区分', () => {
  const sdks = templateOf('privacy_policy')!.chapters.find((c) => c.key === 'sdks')!;
  const md = sdks.render!(ctxWith({}, { sdks: [{ name: 'A|B', purpose: '统计\n分析', data: '', policy_url: '' }] }));
  assert.ok(md.includes('| 名称 | 用途 | 收集的信息 | 隐私政策 |'));
  assert.ok(md.includes('| A\\|B | 统计 分析 |'));
  assert.equal(md.split('\n').filter((l) => l.startsWith('|')).length, 3);
  assert.ok(sdks.render!(ctxWith({}, { sdks: [] })).includes('本产品未接入第三方 SDK。'));
  assert.deepEqual(placeholdersIn(sdks.render!(ctxWith({}, {}))), ['第三方 SDK']);
});

test('条件章随答案出现或省略', () => {
  const keys = (kind: string, a: Answers) => chaptersFor(templateOf(kind)!, a).map((c) => c.key);
  assert.ok(!keys('privacy_policy', writer({ ai_use: 'none', cross_border: 'no', minors: 'no' })).some((k) => ['ai', 'cross_border', 'minors'].includes(k)));
  assert.ok(['ai', 'cross_border', 'minors'].every((k) => keys('privacy_policy', writer({ cross_border: 'lt10w', minors: 'maybe' })).includes(k)));
  assert.ok(!keys('terms', writer({ charge: ['free'] })).includes('payment'));
  assert.ok(keys('terms', writer({ charge: ['ads'] })).includes('payment'));
  assert.ok(!keys('terms', writer({ ai_use: 'none' })).includes('ai'));
});

test('availability 与 kindsForItem', () => {
  assert.deepEqual(availability(templateOf('privacy_policy')!, null), { ok: false, reason: '请先完成问卷判定' });
  const r = assess(writer());
  assert.deepEqual(availability(templateOf('privacy_policy')!, r), { ok: true });
  assert.deepEqual(availability(templateOf('app_statement')!, r), { ok: true });
  assert.deepEqual(availability(templateOf('security_report')!, r), { ok: false, reason: '当前判定不需要这份材料' });
  assert.deepEqual(kindsForItem('algo_filing'), ['algo_selfassess', 'algo_disclosure']);
  assert.deepEqual(kindsForItem('genai_filing'), ['app_statement', 'algo_selfassess']);
  assert.deepEqual(kindsForItem('privacy_policy'), []);
});

test('placeholdersIn 去重保序；ph；v 缺值返回占位；answerText 用中文选项名', () => {
  assert.deepEqual(placeholdersIn('【待填：A】x【待填：B】【待填：A】'), ['A', 'B']);
  assert.equal(ph('联系邮箱'), '【待填：联系邮箱】');
  assert.equal(v(ctxWith({}, {}), 'entity.contact_email'), '【待填：联系邮箱】');
  assert.equal(v(ctxWith({ contact_email: 'a@b.cn' }, {}), 'entity.contact_email'), 'a@b.cn');
  const t = answerText(writer());
  assert.ok(t.includes('产品形态：App'));
  assert.ok(t.includes('怎么用 AI：调用他人已备案模型 API'));
  assert.ok(!answerText({ forms: ['web'] }).some((x) => x.startsWith('面向谁')));
});
