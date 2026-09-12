import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMoaCardTool } from '../lib/card-tool.js';

test('moa_write_card writes only markdown inside .pi/moa', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-moa-card-'));
  const ctx = { get: () => ({ workspaceRoot: root }) };
  const tool = createMoaCardTool(ctx);

  try {
    await tool.execute({ path: '.pi/moa/tasks/one/result.md', content: 'ok' }, {});
    const written = await readFile(join(root, '.pi/moa/tasks/one/result.md'), 'utf8');
    assert.equal(written, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moa_write_card rejects traversal, non-markdown, symlinks, and overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-moa-card-'));
  const tool = createMoaCardTool({ get: () => ({ workspaceRoot: root }) });
  try {
    await assert.rejects(
      () => tool.execute({ path: '../escape.md', content: 'x' }, {}),
      /must be inside/,
    );
    await assert.rejects(
      () => tool.execute({ path: '.pi/moa/result.txt', content: 'x' }, {}),
      /\.md$/,
    );

    const outside = join(root, 'outside');
    await mkdir(outside);
    await mkdir(join(root, '.pi/moa'), { recursive: true });
    await symlink(outside, join(root, '.pi/moa/link'));
    await assert.rejects(
      () => tool.execute({ path: '.pi/moa/link/result.md', content: 'x' }, {}),
      /must be inside/,
    );
    await writeFile(join(outside, 'planted.md'), 'do not follow');
    await symlink(join(outside, 'planted.md'), join(root, '.pi/moa/planted.md'));
    await assert.rejects(
      () => tool.execute({ path: '.pi/moa/planted.md', content: 'x' }, {}),
      /already exists/,
    );

    await tool.execute({ path: '.pi/moa/existing.md', content: 'first' }, {});
    await assert.rejects(
      () => tool.execute({ path: '.pi/moa/existing.md', content: 'second' }, {}),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moa_write_card accepts the DSH rc.2 direct sandboxPolicy capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-moa-card-rc2-'));
  const tool = createMoaCardTool({ sandboxPolicy: { workspaceRoot: root } });

  try {
    await tool.execute({ path: '.pi/moa/rc2/result.md', content: 'ok' }, {});
    assert.equal(await readFile(join(root, '.pi/moa/rc2/result.md'), 'utf8'), 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
