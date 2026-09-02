import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignSeats, describeMatrix, isPeakHour } from '../lib/scheduler.js';

// 订阅优先矩阵（2026-09-02 用户裁定）单测：锁定席位模型/运行时契约
const roster = new Map(Object.entries({
  analyst: { name: 'analyst', provider: 'codex', model: 'glm-5.3-flash', systemPrompt: 'a' },
  critic: { name: 'critic', provider: 'codex', model: 'glm-5.3-flash', systemPrompt: 'c' },
  devil: { name: 'devil', provider: 'kimi-coding', model: 'k3' },
  'reviewer-glm': { name: 'reviewer-glm', provider: 'codex', model: 'glm-5.3', runtime: 'codex' },
  'reviewer-glm-flash': { name: 'reviewer-glm-flash', provider: 'codex', model: 'glm-5.3-flash', runtime: 'codex' },
  'executor-glm': { name: 'executor-glm', provider: 'codex', model: 'glm-5.3', runtime: 'codex' },
  'executor-glm-flash': { name: 'executor-glm-flash', provider: 'codex', model: 'glm-5.3-flash', runtime: 'codex' },
  'executor-pro': { name: 'executor-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  'architect-k3': { name: 'architect-k3', provider: 'kimi-coding', model: 'k3' },
  navigator: { name: 'navigator', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}));

const resolved = {
  cheapModel: 'codex/glm-5.3-flash',
  deepModel: 'codex/glm-5.3',
  visionModel: 'kimi-coding/k3',
  proModel: 'deepseek-official/deepseek-v4-pro',
  devilModel: 'kimi-coding/k3',
};

test('review 三席：analyst/critic=GLM-flash(codex)、devil=k3 跨家族', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model, s.runtime]), [
    ['analyst', 'codex', 'glm-5.3-flash', 'codex'],
    ['critic', 'codex', 'glm-5.3-flash', 'codex'],
    ['devil', 'kimi-coding', 'k3', undefined],
  ]);
});

test('high stakes：review 平面 critic 升 GLM-5.3；dev 平面升 v4-pro（与 executor=glm 不同源）', () => {
  const r = assignSeats({ mode: 'review', stakes: 'high', needVision: false, bigContextChars: 0 }, resolved, roster);
  const critic = r.find((s) => s.role === 'critic');
  assert.equal(critic.provider, 'codex');
  assert.equal(critic.model, 'glm-5.3');
  const d = assignSeats({ mode: 'dev-backend', stakes: 'high', needVision: false, bigContextChars: 0 }, resolved, roster);
  const dCritic = d.find((s) => s.role === 'critic');
  assert.equal(dCritic.provider, 'deepseek-official');
  assert.equal(dCritic.model, 'deepseek-v4-pro');
  assert.equal(d.find((s) => s.role === 'executor-glm').model, 'glm-5.3');
  assert.equal(d.find((s) => s.role === 'executor-pro').model, 'deepseek-v4-pro');
});

test('视觉材料只换 analyst 席为 k3，其余席位保持家族多样性', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: true, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model]), [
    ['analyst', 'kimi-coding', 'k3'],
    ['critic', 'codex', 'glm-5.3-flash'],
    ['devil', 'kimi-coding', 'k3'],
  ]);
});

test('大上下文（>200K 字符）：devil 改 DeepSeek 大上下文读全量', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: false, bigContextChars: 250000 }, resolved, roster);
  const devil = seats.find((s) => s.role === 'devil');
  assert.equal(devil.provider, 'deepseek-official');
  assert.equal(devil.model, 'deepseek-v4-pro');
});

test('角色文件自带模型的角色不被常规槽位覆盖', () => {
  const dev = assignSeats({ mode: 'dev-frontend', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(dev.map((s) => [s.role, s.model, s.runtime]), [
    ['executor-glm-flash', 'glm-5.3-flash', 'codex'],
    ['architect-k3', 'k3', undefined],
  ]);
  const audit = assignSeats({ mode: 'audit', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(audit.map((s) => [s.role, s.provider, s.model]), [['navigator', 'deepseek-official', 'deepseek-v4-pro']]);
});

test('review-full 为 4 席（claude 不加入席位）：GLM 双档 + k3 跨家族', () => {
  const seats = assignSeats({ mode: 'review-full', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['analyst', 'critic', 'devil', 'reviewer-glm']);
  assert.equal(seats.some((s) => s.name === 'reviewer-claude'), false);
  const glm = seats.find((s) => s.role === 'reviewer-glm');
  assert.equal(glm.provider, 'codex');
  assert.equal(glm.model, 'glm-5.3');
});

test('describeMatrix 反映订阅优先五槽位', () => {
  const text = describeMatrix(resolved);
  assert.match(text, /常规席=codex\/glm-5\.3-flash/);
  assert.match(text, /高stakes critic=codex\/glm-5\.3/);
  assert.match(text, /视觉席=kimi-coding\/k3/);
  assert.match(text, /DeepSeek 补充=deepseek-official\/deepseek-v4-pro/);
});

test('isPeakHour：周末低谷、工作日高峰窗口内外', () => {
  assert.equal(isPeakHour(new Date('2026-09-05T02:00:00Z')), false); // 周六 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T02:00:00Z')), true);  // 周五 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T04:00:00Z')), false); // 周五 12:00 BJT（12 点后）
});
