/** /moa 人机命令：status | roles | seats | reset [key] | navigator <provider/model>（模型不可见）。 */
export function createMoaCommand(ctx, resolved, roster, state, seatPool) {
  return {
    name: 'moa',
    description: 'DSH-MOA：roster 席位、常驻进程池与 navigator（内控官）',
    input: { hint: 'status | roles | seats | reset [key] | navigator <provider/model>' },
    async handler(invocation) {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (!sub || sub === 'status') {
        const providers = (() => {
          try { return ctx.llm.listProviders().map((p) => p.id ?? p.name ?? p.provider); } catch { return ['(unavailable)']; }
        })();
        return { kind: 'success', text: [
          `dsh-moa 已挂载。providers: ${providers.join(', ')}`,
          `navigator: ${state.navigator.provider}/${state.navigator.model}`,
          `roster 角色: ${roster.list().map((r) => `${r.name}=${r.provider}/${r.model}(${r.origin})`).join('；') || '(空)'}`,
          `常驻席位池: ${seatPool.list().map((s) => s.key).join('；') || '(空，首次 moa 调用时建立)'}`,
          '门控: 未启用（P2）',
        ].join('\n') };
      }
      if (sub === 'roles') {
        const lines = roster.list().map((r) => `- ${r.name} [${r.origin}] ${r.provider}/${r.model} maxTokens=${r.maxTokens ?? '-'}：${r.description ?? ''}`);
        return { kind: 'success', text: lines.join('\n') || '(无角色)' };
      }
      if (sub === 'seats') {
        const lines = seatPool.list().map((s) => `- ${s.key} → ${s.childId}${s.reattached ? '（重续接）' : ''}`);
        return { kind: 'success', text: lines.join('\n') || '(席位池为空)' };
      }
      if (sub === 'reset') {
        if (!rest.length) {
          const n = seatPool.list().length;
          seatPool.clear();
          return { kind: 'success', text: `已清空席位池（${n} 个）。席位子会话仍在 DSH 中，下次 moa 调用将新建席位进程。` };
        }
        const key = rest.join(' ');
        const existed = seatPool.drop(key);
        return { kind: 'success', text: existed ? `已从池中移除 ${key}（子会话保留，下次调用新建）` : `池中无 ${key}` };
      }
      if (sub === 'navigator' && rest.length === 1 && rest[0].includes('/')) {
        const [provider, model] = rest[0].split('/');
        state.navigator = { provider, model };
        return { kind: 'success', text: `navigator 已切换为 ${provider}/${model}（本次挂载内生效）` };
      }
      return { kind: 'error', text: '用法：/moa status | roles | seats | reset [key] | navigator <provider/model>' };
    },
  };
}
