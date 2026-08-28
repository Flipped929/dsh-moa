import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

function resolveWorkspaceRoot(ctx, agent) {
  return ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent?.session })?.workspaceRoot
    ?? ctx.get?.('sandboxPolicy')?.workspaceRoot
    ?? process.cwd();
}

function isOutside(parent, child) {
  const rel = relative(parent, child);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function createMoaCardTool(ctx) {
  return defineTool({
    name: 'moa_write_card',
    description: 'Create a MoA result card as a new markdown file inside .pi/moa; existing files cannot be overwritten.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative markdown path inside .pi/moa' },
      content: { type: 'string', required: true, description: 'Result card content' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? 'card written' }],
    },
    async execute(args, exec) {
      const wsRoot = resolveWorkspaceRoot(ctx, exec.agent);
      const cardRoot = resolve(wsRoot, '.pi/moa');
      const target = resolve(wsRoot, args.path);

      if (!target.startsWith(`${cardRoot}${sep}`)) throw new Error('moa_write_card: path must be inside .pi/moa');
      if (!args.path.endsWith('.md')) throw new Error('moa_write_card: path must end with .md');

      let realParent;
      try {
        mkdirSync(dirname(target), { recursive: true });
        realParent = realpathSync(dirname(target));
      } catch (e) {
        throw new Error(`moa_write_card: cannot prepare result card path: ${e.message}`);
      }
      if (isOutside(realpathSync(wsRoot), realParent)) throw new Error('moa_write_card: path must be inside .pi/moa');

      const candidate = join(realParent, basename(target));
      try {
        const realCardRoot = realpathSync(cardRoot);
        if (isOutside(realCardRoot, candidate)) throw new Error('moa_write_card: path must be inside .pi/moa');
      } catch (e) {
        if (e.message.startsWith('moa_write_card:')) throw e;
        throw new Error(`moa_write_card: cannot resolve result card directory: ${e.message}`);
      }

      try {
        writeFileSync(candidate, args.content, { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') throw new Error('moa_write_card: file already exists');
        throw e;
      }
      const written = realpathSync(candidate);
      if (isOutside(realpathSync(cardRoot), written)) throw new Error('moa_write_card: path must be inside .pi/moa');
      return { path: written, summary: `moa_write_card: wrote ${written}` };
    },
  });
}
