/** /moa 人机命令：status | roles | navigator <provider/model>（模型不可见）。 */
export function createMoaCommand(ctx, resolved, roster, state) {
  return {
    name: 'moa',
    description: 'DSH-MOA：roster 席位与 navigator（内控官）配置',
    input: { hint: 'status | roles | navigator <provider/model>' },
    handler(invocation) {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (!sub || sub === 'status') {
        const providers = (() => {
          try { return ctx.llm.listProviders().map((p) => p.id ?? p.name ?? p.provider); } catch { return ['(unavailable)']; }
        })();
        return { kind: 'success', text: [
          `dsh-moa 已挂载。providers: ${providers.join(', ')}`,
          `navigator: ${state.navigator.provider}/${state.navigator.model}`,
          `roster 席位: ${roster.list().map((r) => `${r.name}=${r.provider}/${r.model}(${r.origin})`).join('；') || '(空)'}`,
          '门控: 未启用（P2）',
        ].join('\n') };
      }
      if (sub === 'roles') {
        const lines = roster.list().map((r) => `- ${r.name} [${r.origin}] ${r.provider}/${r.model} maxTokens=${r.maxTokens ?? '-'}：${r.description ?? ''}`);
        return { kind: 'success', text: lines.join('\n') || '(无角色)' };
      }
      if (sub === 'navigator' && rest.length === 1 && rest[0].includes('/')) {
        const [provider, model] = rest[0].split('/');
        state.navigator = { provider, model };
        return { kind: 'success', text: `navigator 已切换为 ${provider}/${model}（本次挂载内生效）` };
      }
      return { kind: 'error', text: '用法：/moa status | /moa roles | /moa navigator <provider/model>' };
    },
  };
}
