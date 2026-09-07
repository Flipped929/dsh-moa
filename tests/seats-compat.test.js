import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverSeatPrompt } from '../lib/seats.js';

const parentAgent = { session: { header: { id: 'p-1' } } };
const QUEUE_PROMPT_V4 = Symbol.for('dsh.subagent.queuePrompt');
const DELIVER_PROMPT_V5 = Symbol.for('dsh.subagent.deliverPrompt');

test('派活兼容：DSH ≤alpha.3 走 followup（options 形态）', async () => {
  let captured = null;
  const subagents = {
    followup(parent, childId, content, options) {
      captured = { parent, childId, content, options };
      return Promise.resolve('ok');
    },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-1', '任务包', undefined);
  assert.equal(captured.parent, parentAgent);
  assert.equal(captured.childId, 'c-1');
  assert.deepEqual(captured.content, [{ type: 'text', text: '任务包' }]);
  assert.deepEqual(captured.options.source, { kind: 'plugin', plugin: 'dsh-moa' });
});

test('派活兼容：DSH ≥0.1.3 走 deliverPrompt 符号通道（6 参 + delivery=queue）', async () => {
  let captured = null;
  const subagents = {
    [DELIVER_PROMPT_V5](parent, childId, content, source, signal, delivery) {
      captured = { parent, childId, content, source, signal, delivery };
      return Promise.resolve('ok');
    },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-2', '任务包', 'sig');
  assert.equal(captured.parent, parentAgent);
  assert.equal(captured.childId, 'c-2');
  assert.deepEqual(captured.content, [{ type: 'text', text: '任务包' }]);
  assert.deepEqual(captured.source, { kind: 'plugin', plugin: 'dsh-moa' });
  assert.equal(captured.signal, 'sig');
  assert.equal(captured.delivery, 'queue'); // 任务派发=排队成独立轮次；steer 留作未来席位催办
});

test('派活兼容：DSH alpha.4 走 queuePrompt 符号通道（位置参数形态）', async () => {
  let captured = null;
  const subagents = {
    [QUEUE_PROMPT_V4](parent, childId, content, source, signal) {
      captured = { parent, childId, content, source, signal };
      return Promise.resolve('ok');
    },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-3', '任务包', 'sig');
  assert.equal(captured.parent, parentAgent);
  assert.equal(captured.childId, 'c-3');
  assert.deepEqual(captured.content, [{ type: 'text', text: '任务包' }]);
  assert.deepEqual(captured.source, { kind: 'plugin', plugin: 'dsh-moa' });
  assert.equal(captured.signal, 'sig');
});

test('派活兼容：deliverPrompt 优先于 queuePrompt（新版符号先测到）', async () => {
  let usedDeliver = false;
  const subagents = {
    [DELIVER_PROMPT_V5]() { usedDeliver = true; return Promise.resolve('ok'); },
    [QUEUE_PROMPT_V4]() { throw new Error('不应走旧符号通道'); },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-4', '任务包', undefined);
  assert.equal(usedDeliver, true);
});

test('派活兼容：三通道都不存在时响亮报错（契约变动信号）', async () => {
  await assert.rejects(
    () => deliverSeatPrompt({}, parentAgent, 'c-5', '任务包', undefined),
    /无 followup（≤alpha\.3）\/ queuePrompt（alpha\.4）\/ deliverPrompt（≥0\.1\.3）/,
  );
});

test('派活兼容：subagents 为 undefined 时走报错分支而非 TypeError（可选链防御）', async () => {
  await assert.rejects(
    () => deliverSeatPrompt(undefined, parentAgent, 'c-6', '任务包', undefined),
    /subagents 契约不可用/,
  );
});

test('派活兼容：followup 若与符号并存仍优先（向后兼容别名）', async () => {
  let usedFollowup = false;
  const subagents = {
    followup() { usedFollowup = true; return Promise.resolve('ok'); },
    [DELIVER_PROMPT_V5]() { throw new Error('不应走符号通道'); },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-7', '任务包', undefined);
  assert.equal(usedFollowup, true);
});
