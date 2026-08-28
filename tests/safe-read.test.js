import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeRead } from '../lib/tool.js';

test('safeRead rejects a symlink that escapes the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-moa-safe-read-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-moa-safe-out-'));
  try {
    await mkdir(join(root, 'inside'), { recursive: true });
    await writeFile(join(outside, 'secret.md'), 'escaped');
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));

    const result = safeRead(root, 'escape.md', 100);
    assert.equal(result.error, 'outside-workspace');
    assert.equal('content' in result, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('safeRead treats missing targets as not found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-moa-safe-read-'));
  try {
    assert.deepEqual(safeRead(root, 'missing.md', 100), {
      path: 'missing.md',
      error: 'not-found',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
