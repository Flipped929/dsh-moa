import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignSeats, describeMatrix, isPeakHour, modelExpiryNote } from '../lib/scheduler.js';

// 架构 v3.3（2026-09-12 用户裁定）：DeepSeek 家族现仅 deepseek-flash 一个模型（走 DeepSeek-V4.1-flash），
// 高 stakes critic / 异构 devil / 视觉席 / 异步内控 navigator 四处槽位共用该模型；
// GLM-5.3-flash 常规主力、GLM-5.3 高难度执行；kimi-k3 作可指派子模型。
const DS = 'deepseek-flash';
const roster = new Map(Object.entries({
  analyst: { name: 'analyst', provider: 'zai-coding-cn', model: 'glm-5.3-flash', systemPrompt: 'a' },
  critic: { name: 'critic', provider: 'zai-coding-cn', model: 'glm-5.3-flash', systemPrompt: 'c' },
  devil: { name: 'devil', provider: 'deepseek-official', model: DS },
  'reviewer-glm': { name: 'reviewer-glm', provider: 'zai-coding-cn', model: 'glm-5.3' },
  'reviewer-glm-flash': { name: 'reviewer-glm-flash', provider: 'zai-coding-cn', model: 'glm-5.3-flash' },
  'executor-glm': { name: 'executor-glm', provider: 'codex', model: 'glm-5.3', runtime: 'codex' },
  'executor-glm-flash': { name: 'executor-glm-flash', provider: 'codex', model: 'glm-5.3-flash', runtime: 'codex' },
  'executor-pro': { name: 'executor-pro', provider: 'deepseek-official', model: DS },
  'architect-k3': { name: 'architect-k3', provider: 'kimi-coding', model: 'k3' },
  'vision-aux': { name: 'vision-aux', provider: 'kimi-coding', model: 'k3' },
  navigator: { name: 'navigator', provider: 'deepseek-official', model: DS },
}));

const resolved = {
  cheapModel: 'zai-coding-cn/glm-5.3-flash',
  visionModel: `deepseek-official/${DS}`,
  criticModel: `deepseek-official/${DS}`,
  devilModel: `deepseek-official/${DS}`,
  navigatorProvider: 'deepseek-official',
  navigatorModel: DS,
};

test('review 三席：analyst/critic=GLM-5.3-flash(spawn 常驻)、devil=deepseek-flash 异构跨家族', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: false }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model, s.runtime]), [
    ['analyst', 'zai-coding-cn', 'glm-5.3-flash', undefined],
    ['critic', 'zai-coding-cn', 'glm-5.3-flash', undefined],
    ['devil', 'deepseek-official', DS, undefined],
  ]);
});

test('high stakes：critic 走 criticModel 深审槽（DeepSeek 唯一模型 deepseek-flash）', () => {
  const r = assignSeats({ mode: 'review', stakes: 'high', needVision: false }, resolved, roster);
  const critic = r.find((s) => s.role === 'critic');
  assert.equal(critic.provider, 'deepseek-official');
  assert.equal(critic.model, DS);
  const d = assignSeats({ mode: 'dev-backend', stakes: 'high', needVision: false }, resolved, roster);
  const dCritic = d.find((s) => s.role === 'critic');
  assert.equal(dCritic.provider, 'deepseek-official');
  assert.equal(dCritic.model, DS);
  assert.equal(d.find((s) => s.role === 'executor-glm').model, 'glm-5.3');
  assert.equal(d.find((s) => s.role === 'executor-pro').model, DS);
});

test('视觉材料：analyst 席换 deepseek-flash（原生多模态），critic 保持 GLM，并追加第二家族 vision-aux（k3）', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: true }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model]), [
    ['analyst', 'deepseek-official', DS],
    ['critic', 'zai-coding-cn', 'glm-5.3-flash'],
    ['devil', 'deepseek-official', DS],
    ['vision-aux', 'kimi-coding', 'k3'],
  ]);
});

test('vision-aux 只在有视觉材料时出现（且第二家族：不与视觉席/ devil 同模型）', () => {
  const noVision = assignSeats({ mode: 'review', stakes: undefined, needVision: false }, resolved, roster);
  assert.ok(!noVision.some((s) => s.role === 'vision-aux'));
  const withVision = assignSeats({ mode: 'review', stakes: undefined, needVision: true }, resolved, roster);
  const aux = withVision.find((s) => s.role === 'vision-aux');
  assert.equal(aux.provider, 'kimi-coding');
  assert.notEqual(aux.model, DS);
});

test('review-full + 视觉：vision-aux 追加在末席', () => {
  const seats = assignSeats({ mode: 'review-full', stakes: undefined, needVision: true }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['analyst', 'critic', 'devil', 'reviewer-glm', 'vision-aux']);
});

test('review-full 为 4 席（claude 不进席位）；无视觉材料时不加 vision-aux', () => {
  const seats = assignSeats({ mode: 'review-full', stakes: undefined, needVision: false }, resolved, roster);
  assert.deepEqual(seats.map((s) => s.role), ['analyst', 'critic', 'devil', 'reviewer-glm']);
  assert.equal(seats.some((s) => s.name === 'reviewer-claude'), false);
  const glm = seats.find((s) => s.role === 'reviewer-glm');
  assert.equal(glm.provider, 'zai-coding-cn');
  assert.equal(glm.model, 'glm-5.3');
  assert.equal(glm.runtime, undefined);
});

test('audit：单 navigator 席（deepseek-flash），即使有视觉材料也不加 vision-aux', () => {
  const seats = assignSeats({ mode: 'audit', stakes: undefined, needVision: true }, resolved, roster);
  assert.deepEqual(seats.map((s) => [s.role, s.provider, s.model]), [['navigator', 'deepseek-official', DS]]);
});

test('大上下文材料：devil 恒为 deepseek-flash（家族唯一模型，无降级分支）', () => {
  const seats = assignSeats({ mode: 'review', stakes: undefined, needVision: false }, resolved, roster);
  const devil = seats.find((s) => s.role === 'devil');
  assert.equal(devil.provider, 'deepseek-official');
  assert.equal(devil.model, DS);
});

test('角色文件自带模型的角色不被常规槽位覆盖', () => {
  const dev = assignSeats({ mode: 'dev-frontend', stakes: undefined, needVision: false }, resolved, roster);
  assert.deepEqual(dev.map((s) => [s.role, s.model, s.runtime]), [
    ['executor-glm-flash', 'glm-5.3-flash', 'codex'],
    ['architect-k3', 'k3', undefined],
  ]);
  const audit = assignSeats({ mode: 'audit', stakes: undefined, needVision: false }, resolved, roster);
  assert.deepEqual(audit.map((s) => [s.role, s.provider, s.model]), [['navigator', 'deepseek-official', DS]]);
});

test('describeMatrix 反映 v3.3 槽位（全部 DeepSeek 槽位=deepseek-flash，无其他 DeepSeek 模型）', () => {
  const text = describeMatrix(resolved);
  assert.match(text, /常规席=zai-coding-cn\/glm-5\.3-flash/);
  assert.match(text, /高stakes critic=deepseek-official\/deepseek-flash/);
  assert.match(text, /视觉席=deepseek-official\/deepseek-flash/);
  assert.match(text, /devil=deepseek-official\/deepseek-flash/);
  assert.match(text, /异步内控 navigator=deepseek-official\/deepseek-flash/);
  assert.match(text, /视觉交叉核验=vision-aux/);
  assert.doesNotMatch(text, /临时模型/); // deepseek-flash 无到期标记
  assert.doesNotMatch(text, /v4-pro|v4-flash|vision-exp/);
});

test('modelExpiryNote：含 expires-on-MMDD 的模型给出到期/已过期提示；无标记模型无提示', () => {
  assert.equal(modelExpiryNote('deepseek-flash'), null); // 无到期标记 → 无提示
  const expiredModel = 'some-preview-expires-on-0910';
  assert.match(modelExpiryNote(expiredModel, new Date('2026-09-09T02:00:00Z')) ?? '', /将于 09-10 到期/);
  assert.match(modelExpiryNote(expiredModel, new Date('2026-09-10T02:00:00Z')) ?? '', /已于 09-10 到期/);
});

test('isPeakHour：周末低谷、工作日高峰窗口内外', () => {
  assert.equal(isPeakHour(new Date('2026-09-05T02:00:00Z')), false); // 周六 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T02:00:00Z')), true);  // 周五 10:00 BJT
  assert.equal(isPeakHour(new Date('2026-09-04T04:00:00Z')), false); // 周五 12:00 BJT（12 点后）
});
