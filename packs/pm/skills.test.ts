import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { SKILL_LABELS, defaultSkillsDir, loadPmSkills, skillLabel } from './skills.ts';

test('skillLabel：有中文名时返回中文名，没有时退回英文名', () => {
  assert.equal(skillLabel('swot-analysis'), 'SWOT 分析');
  assert.equal(skillLabel('not-a-skill'), 'not-a-skill');
});

test('SKILL_LABELS：中文名非空、互不重复，且不含英文原名本身', () => {
  const labels = Object.entries(SKILL_LABELS);
  assert.ok(labels.length >= 65);
  for (const [name, label] of labels) {
    assert.ok(label.trim(), name);
    assert.notEqual(label, name);
  }
  assert.equal(new Set(labels.map(([, l]) => l)).size, labels.length, '中文名不能重复');
});

test('SKILL_LABELS 覆盖已安装 pm-skills 的全部框架', { skip: !fs.existsSync(defaultSkillsDir()) && '未安装 pm-skills' }, () => {
  const missing = loadPmSkills().map((s) => s.name).filter((n) => !(n in SKILL_LABELS));
  assert.deepEqual(missing, []);
});
