import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMoaTool } from '../lib/tool.js';

test('moa rejects non-slug seat names', async () => {
  const tool = createMoaTool({}, {}, { get: () => ({}) }, {}, {});

  await assert.rejects(
    () => tool.execute({
      task: 'review',
      seats: [{ role: '../../x', provider: 'p', model: 'm' }],
    }, { signal: undefined }),
    /席位名称/,
  );
});
