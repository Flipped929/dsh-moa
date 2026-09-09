import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignSeats, describeMatrix, isPeakHour, modelExpiryNote } from '../lib/scheduler.js';

// 架构 v3.0（2026-09-09 用户裁定，moa 三席评审收敛）：主力全订阅
// （k3 主模型 / GLM-5.3-flash 常规 / GLM-5.3 高难度执行 / v4-pro critic+navigator / v4.1 异构 devil+视觉）
const V41 = 'deepseek-v4.1-flash-expires-on-0910';
const roster = new Map(Object.entries({
  analyst: { name: 'analyst', provider: 'zai-coding-cn', model: 'glm-5.3-flash', systemPrompt: 'a' },
  critic: { name: 'critic', provider: 'zai-coding-cn', model: 'glm-5.3-flash', systemPrompt: 'c' },
  devil: { name: 'devil', provider: 'deepseek-official', model: V41 },
  'reviewer-glm': { name: 'reviewer-glm', provider: 'zai-coding-cn', model: 'glm-5.3' },
  'reviewer-glm-flash': { name: 'reviewer-glm-flash', provider: 'zai-coding-cn', model: 'glm-5.3-flash' },
  'executor-glm': { name: 'executor-glm', provider: 'codex', model: 'glm-5.3', runtime: 'codex' },
  'executor-glm-flash': { name: 'executor-glm-flash', provider: 'codex', model: 'glm-5.3-flash', runtime: 'codex' },
  'executor-pro': { name: 'executor-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  'architect-k3': { name: 'architect-k3', provider: 'kimi-coding', model: 'k3' },
  'vision-aux': { name: 'vision-aux', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
  navigator: { name: 'navigator', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}));

const resolved = {
  cheapModel: 'zai-coding-cn/glm-5.3-flash',
  visionModel: `deepseek-official/${V41}`,
  proModel: 'deepseek-official/deepseek-v4-pro',
  devilModel: `deepseek-official/${V41}`,
};

test('review 三席：analyst/critic=GLM-5.3-flash(spawn 常驻)、devil=v4.1 异构跨家族', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model, s.runtime]), [
    ['analyst', 'zai-coding-cn', 'glm-5.3-flash', undefined],
    ['critic', 'zai-coding-cn', 'glm-5.3-flash', undefined],
    ['devil', 'deepseek-official', V41, undefined],
  ]);
});

test('high stakes：critic 升 v4-pro（2026-09-02 A/B 双跑 0:3 实证回滚，两平面一致）', () => {
  const r = assignSeats({ mode: 'review', stakes: 'high', needVision: false, bigContextChars: 0 }, resolved, roster);
  const critic = r.find((s) => s.role === 'critic');
  assert.equal(critic.provider, 'deepseek-official');
  assert.equal(critic.model, 'deepseek-v4-pro');
  const d = assignSeats({ mode: 'dev-backend', stakes: 'high', needVision: false, bigContextChars: 0 }, resolved, roster);
  const dCritic = d.find((s) => s.role === 'critic');
  assert.equal(dCritic.provider, 'deepseek-official');
  assert.equal(dCritic.model, 'deepseek-v4-pro');
  assert.equal(d.find((s) => s.role === 'executor-glm').model, 'glm-5.3');
  assert.equal(d.find((s) => s.role === 'executor-pro').model, 'deepseek-v4-pro');
});

test('视觉材料：analyst 席换 v4.1（异构原生多模态），其余保持家族多样性，追加 vision-aux 辅助席', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: true, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model]), [
    ['analyst', 'deepseek-official', V41],
    ['critic', 'zai-coding-cn', 'glm-5.3-flash'],
    ['devil', 'deepseek-official', V41],
    ['vision-aux', 'deepseek-official', 'deepseek-v4-flash-vision-exp'],
  ]);
});

test('vision-aux 只在有视觉材料时出现', () => {
  const noVision = assignSeats({ mode: 'review', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.ok(!noVision.some((s) => s.role === 'vision-aux'));
});

test('review-full + 视觉：vision-aux 追加在末席', () => {
  const seats = assignSeats({ mode: 'review-full', stakes: undefined, needVision: true, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['analyst', 'critic', 'devil', 'reviewer-glm', 'vision-aux']);
});

test('audit 无 analyst 席：即使有视觉材料也不加 vision-aux', () => {
  const seats = assignSeats({ mode: 'audit', stakes: undefined, needVision: true, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['navigator']);
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

test('review-full 为 4 席（claude 不加入席位）：GLM 双档 spawn + v4.1 异构跨家族', () => {
  const seats = assignSeats({ mode: 'review-full', stakes: undefined, needVision: false, bigContextChars: 0 }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['analyst', 'critic', 'devil', 'reviewer-glm']);
  assert.equal(seats.some((s) => s.name === 'reviewer-claude'), false);
  const glm = seats.find((s) => s.role === 'reviewer-glm');
  assert.equal(glm.provider, 'zai-coding-cn');
  assert.equal(glm.model, 'glm-5.3');
  assert.equal(glm.runtime, undefined);
});

test('describeMatrix 反映 v3.0 槽位（GLM spawn 常规；v4.1 异构 devil/视觉；v4-pro critic）', () => {
  const text = describeMatrix(resolved);
  assert.match(text, /常规席=zai-coding-cn\/glm-5\.3-flash/);
  assert.match(text, /高stakes critic=deepseek-official\/deepseek-v4-pro/);
  assert.match(text, /视觉席=deepseek-official\/deepseek-v4\.1-flash-expires-on-0910/);
  assert.match(text, /devil=deepseek-official\/deepseek-v4\.1-flash-expires-on-0910/);
  assert.match(text, /临时模型，注意到期/);
});

test('modelExpiryNote：含 expires-on-MMDD 的模型给出到期/已过期提示', () => {
  assert.equal(modelExpiryNote('deepseek-v4-pro'), null); // 无标记 → 无提示
  assert.match(modelExpiryNote(V41, new Date('2026-09-09T02:00:00Z')) ?? '', /将于 09-10 到期/);
  assert.match(modelExpiryNote(V41, new Date('2026-09-10T02:00:00Z')) ?? '', /已于 09-10 到期/);
});

test('isPeakHour：周末低谷、工作日高峰窗口内外', () => {
  assert.equal(isPeakHour(new Date('2026-09-05T02:00:00Z')), false); // 周六 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T02:00:00Z')), true);  // 周五 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T04:00:00Z')), false); // 周五 12:00 BJT（12 点后）
});
