import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG, QUESTIONS, RULES_VERSION, assess, nextDates, validateAnswers, type Answers, type AssessResult } from './rules.ts';

const base = (o: Answers = {}): Answers => ({
  forms: ['web'], audience: 'public', overseas: 'no', charge: ['free'], ai_use: 'none', algo: 'no',
  social: ['none'], companion: 'no', scale: 'prelaunch', pi: ['general'], minors: 'no', cross_border: 'no', ...o,
});
const run = (a: Answers): AssessResult => {
  const v = validateAnswers(a);
  assert.ok(v.ok, JSON.stringify(v));
  return assess(v.answers);
};
const levelOf = (r: AssessResult) => (id: string) => {
  const it = r.items.find((x) => x.id === id);
  assert.ok(it, id);
  return it.level;
};
const required = (r: AssessResult) => r.items.filter((x) => x.level === 'required').map((x) => x.id).sort();

const P = {
  tool: base(),
  writer: base({ forms: ['app'], charge: ['paid'], ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'] }),
  writerProcessed: base({ forms: ['app'], charge: ['paid'], ai_use: 'cn_api', ai_output: 'processed', ai_media: ['text'] }),
  companion: base({ forms: ['app'], ai_use: 'own', ai_media: ['text', 'audio'], companion: 'yes', social: ['post'], scale: 'large', pi: ['sensitive'], minors: 'maybe' }),
  companionSmall: base({ forms: ['app'], ai_use: 'own', ai_media: ['text'], companion: 'yes', social: ['none'], scale: 'small' }),
  saas: base({ forms: ['web', 'api'], audience: 'b2b', overseas: 'yes', cross_border: '10w_100w', ai_use: 'cn_api', ai_output: 'raw', ai_media: ['text'] }),
  internal: base({ audience: 'internal', charge: ['paid'], ai_use: 'own', ai_media: ['image'], companion: 'yes', social: ['group'], minors: 'maybe', cross_border: 'lt10w' }),
  foreign: base({ ai_use: 'foreign_api', ai_output: 'raw', ai_media: ['image'] }),
};

test('纯工具网站：只需 ICP 备案、公安备案、等保、隐私政策', () => {
  const r = run(P.tool);
  assert.deepEqual(required(r), ['icp_filing', 'mlps', 'privacy_policy', 'psb_filing']);
  assert.equal(r.social.value, false);
  assert.equal(r.social.reason, '无公开传播功能');
  assert.equal(r.version, RULES_VERSION);
});

test('调已备案模型 API 的收费写作 App：登记、公示、标识、ICP 许可与 APP 备案', () => {
  const r = run(P.writer);
  const req = required(r);
  for (const id of ['genai_register', 'model_disclosure', 'aigc_label', 'icp_filing', 'icp_license', 'app_filing']) assert.ok(req.includes(id), id);
  const level = levelOf(r);
  assert.equal(level('genai_filing'), 'na');
  assert.equal(level('algo_filing'), 'na');
  assert.equal(level('psb_filing'), 'na');
  assert.ok(r.items.find((x) => x.id === 'icp_license')!.reasons.some((s) => s.includes('向用户收费')));
});

test('对模型输出二次加工：大模型备案改为可能需要，不再走登记', () => {
  const level = levelOf(run(P.writerProcessed));
  assert.equal(level('genai_filing'), 'maybe');
  assert.equal(level('genai_register'), 'na');
});

test('自研模型的陪伴应用：备案、算法备案、双新评估、拟人化自查与评估、PIA、未成年人保护', () => {
  const r = run(P.companion);
  const req = required(r);
  for (const id of ['genai_filing', 'algo_filing', 'security_assess', 'anthro_selfcheck', 'anthro_assess', 'pia', 'minor_protect', 'model_disclosure']) assert.ok(req.includes(id), id);
  assert.equal(r.social.value, true);
  assert.ok(r.social.reason.includes('发帖或评论'));
  assert.ok(r.items.find((x) => x.id === 'anthro_assess')!.reasons.some((s) => s.includes('100 万')));
});

test('拟人化服务未达门槛：上线即需安全评估（第二十二条第一项），不写门槛理由', () => {
  const r = run(P.companionSmall);
  const it = r.items.find((x) => x.id === 'anthro_assess')!;
  assert.equal(it.level, 'required');
  assert.ok(it.reasons.some((s) => s.includes('上线')));
  assert.ok(!it.reasons.some((s) => s.includes('100 万')));
  assert.equal(levelOf(r)('algo_filing'), 'na');
});

test('有境外用户的企业 SaaS：境外另行评估、出境走标准合同或认证、B 端不需登记', () => {
  const r = run(P.saas);
  assert.ok(r.notes.some((s) => s.includes('另行评估')));
  const cb = r.items.find((x) => x.id === 'cross_border')!;
  assert.equal(cb.level, 'required');
  assert.ok(cb.reasons.some((s) => s.includes('标准合同或认证')));
  const level = levelOf(r);
  assert.equal(level('genai_register'), 'na');
  assert.equal(level('model_disclosure'), 'na');
  assert.equal(level('pia'), 'required');
});

test('仅内部使用：除隐私、PIA、出境、等保外全部不适用', () => {
  const r = run(P.internal);
  const keep = new Set(['privacy_policy', 'pia', 'cross_border', 'mlps']);
  for (const it of r.items) if (!keep.has(it.id)) assert.equal(it.level, 'na', it.id);
  assert.deepEqual(required(r), [...keep].sort());
  assert.ok(r.notes.some((s) => s.includes('仅内部使用')));
  assert.ok(r.items.find((x) => x.id === 'cross_border')!.reasons.some((s) => s.includes('免申报')));
});

test('境外模型 API 面向公众：登记与备案均为可能需要，并提示更换模型', () => {
  const r = run(P.foreign);
  const level = levelOf(r);
  assert.equal(level('genai_register'), 'maybe');
  assert.equal(level('genai_filing'), 'maybe');
  assert.ok(r.notes.some((s) => s.includes('境外模型')));
});

test('validateAnswers：缺题、类型错、互斥、选项外值逐一指出', () => {
  const empty = validateAnswers({});
  assert.equal(empty.ok, false);
  if (!empty.ok) for (const q of ['forms', 'audience', 'cross_border']) assert.ok(empty.missing.includes(q), q);

  const str = validateAnswers(base({ charge: 'paid' }));
  assert.ok(!str.ok && str.invalid.includes('charge'));
  const mutex = validateAnswers(base({ pi: ['none', 'general'] }));
  assert.ok(!mutex.ok && mutex.invalid.includes('pi'));
  const outside = validateAnswers(base({ audience: 'everyone' }));
  assert.ok(!outside.ok && outside.invalid.includes('audience'));
  const multiAsArray = validateAnswers(base({ audience: ['public'] }));
  assert.ok(!multiAsArray.ok && multiAsArray.invalid.includes('audience'));
  const emptyMulti = validateAnswers(base({ forms: [] }));
  assert.ok(!emptyMulti.ok && emptyMulti.missing.includes('forms'));
  for (const bad of [null, [], 'x', 1]) assert.equal(validateAnswers(bad).ok, false);
});

test('validateAnswers：条件题只在用 AI 时必答，多余字段被丢弃', () => {
  const ok = validateAnswers({ ...base(), extra: 'x' });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal('extra' in ok.answers, false);
  const need = validateAnswers(base({ ai_use: 'cn_api' }));
  assert.ok(!need.ok && need.missing.includes('ai_output') && need.missing.includes('ai_media'));
  const own = validateAnswers(base({ ai_use: 'own', ai_media: ['text'] }));
  assert.ok(own.ok, JSON.stringify(own));
});

test('目录：17 项、14 题，每项有依据、时点与白名单 https 链接', () => {
  const hosts = new Set(['beian.miit.gov.cn', 'beian.cac.gov.cn', 'www.cac.gov.cn', 'www.beian.gov.cn', 'www.gov.cn', 'www.miit.gov.cn', 'dxzhgl.miit.gov.cn', 'www.djbh.net']);
  assert.equal(CATALOG.length, 17);
  assert.equal(QUESTIONS.length, 14);
  assert.equal(new Set(CATALOG.map((c) => c.id)).size, 17);
  for (const c of CATALOG) {
    assert.ok(c.name && c.authority && c.basis && c.timing, c.id);
    assert.ok(c.links.length > 0, c.id);
    for (const l of c.links) {
      assert.ok(l.url.startsWith('https://'), l.url);
      assert.ok(hosts.has(new URL(l.url).hostname), l.url);
    }
  }
});

test('每个事项至少被一个画像触发，结果含全部事项且按时点排序', () => {
  const results = Object.values(P).map(run);
  for (const c of CATALOG) assert.ok(results.some((r) => r.items.some((x) => x.id === c.id && x.level !== 'na')), c.id);
  for (const r of results) {
    assert.equal(r.items.length, CATALOG.length);
    for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].order <= r.items[i].order);
    for (const it of r.items) if (it.level === 'na') assert.deepEqual(it.reasons, []);
  }
});

test('nextDates：ICP 许可 5 年到期、每年提醒；等保每年提醒；其他无', () => {
  const done = Date.UTC(2026, 0, 1);
  assert.deepEqual(nextDates('icp_license', done), { due_at: Date.UTC(2031, 0, 1), remind_at: Date.UTC(2027, 0, 1) });
  assert.deepEqual(nextDates('mlps', done), { due_at: null, remind_at: Date.UTC(2027, 0, 1) });
  assert.deepEqual(nextDates('icp_filing', done), { due_at: null, remind_at: null });
});

test('同样输入同样结果', () => {
  for (const a of Object.values(P)) assert.deepEqual(run(a), run(a));
});
