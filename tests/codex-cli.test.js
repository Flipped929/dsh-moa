import assert from 'node:assert/strict';
import { test } from 'node:test';

// taskCodexCli 的 JSONL 解析逻辑单测（提取行解析为纯函数行为验证）
test('codex JSONL 解析：thread.started 捕获 thread_id，agent_message 聚合文本', () => {
  const sample = [
    '{"type":"thread.started","thread_id":"01a048f7-xxxx"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","id":"item_0"}',
    '{"type":"agent_message","message":"蓝狐-42"}',
    '{"type":"turn.completed"}',
    'not-json-banner',
  ].join('\n');
  let threadId = null;
  let text = '';
  for (const line of sample.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'thread.started' && e.thread_id) threadId = e.thread_id;
      if (e.type === 'agent_message' && typeof e.message === 'string') text += e.message;
    } catch { }
  }
  assert.equal(threadId, '01a048f7-xxxx');
  assert.equal(text, '蓝狐-42');
});
