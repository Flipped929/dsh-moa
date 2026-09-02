import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverSeatPrompt } from '../lib/seats.js';

const parentAgent = { session: { header: { id: 'p-1' } } };
const QUEUE_PROMPT = Symbol.for('dsh.subagent.queuePrompt');

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

test('派活兼容：DSH ≥alpha.4 走 queuePrompt 符号通道（位置参数形态）', async () => {
  let captured = null;
  const subagents = {
    [QUEUE_PROMPT](parent, childId, content, source, signal) {
      captured = { parent, childId, content, source, signal };
      return Promise.resolve('ok');
    },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-2', '任务包', 'sig');
  assert.equal(captured.parent, parentAgent);
  assert.equal(captured.childId, 'c-2');
  assert.deepEqual(captured.content, [{ type: 'text', text: '任务包' }]);
  assert.deepEqual(captured.source, { kind: 'plugin', plugin: 'dsh-moa' });
  assert.equal(captured.signal, 'sig');
});

test('派活兼容：两通道都不存在时响亮报错（契约变动信号）', async () => {
  await assert.rejects(
    () => deliverSeatPrompt({}, parentAgent, 'c-3', '任务包', undefined),
    /既无 followup.*也无 queuePrompt/,
  );
});

test('派活兼容：alpha.4 优先用 followup 若二者并存（向后兼容别名）', async () => {
  let usedFollowup = false;
  const subagents = {
    followup() { usedFollowup = true; return Promise.resolve('ok'); },
    [QUEUE_PROMPT]() { throw new Error('不应走符号通道'); },
  };
  await deliverSeatPrompt(subagents, parentAgent, 'c-4', '任务包', undefined);
  assert.equal(usedFollowup, true);
});
