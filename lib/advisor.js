/**
 * advisor 执行器：无工具 llm.stream 直调（对齐 pi-moa 成本模型）。
 * 并行调度，收集文本与 usage；单席失败不影响其他席位（errorKind 分类）。
 */
import { truncateMiddle } from './redact.js';

async function collectStream(stream) {
  let text = '';
  let usage = null;
  let failed = null;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text ?? '';
    else if (chunk.type === 'usage') usage = chunk.usage ?? chunk;
    else if (chunk.type === 'finish') {
      if (chunk.usage) usage = chunk.usage;
      const kind = chunk.reason?.kind;
      if (kind === 'error' || kind === 'aborted') failed = kind;
    }
  }
  return { text: text.trim(), usage, failed };
}

export async function runAdvisors(ctx, seats, { baseSystem, prompt, maxTokens, temperature, signal }) {
  return Promise.all(seats.map(async (seat) => {
    try {
      const { text, usage, failed } = await collectStream(ctx.llm.stream({
        provider: seat.provider,
        model: seat.model,
        system: seat.systemPrompt ?? baseSystem,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: seat.maxTokens ?? maxTokens,
        temperature: seat.temperature ?? temperature,
        signal,
      }));
      return { seat, ok: Boolean(text) && !failed, text, usage, errorKind: failed };
    } catch (e) {
      return { seat, ok: false, text: '', usage: null, errorKind: 'exception', error: String(e?.message ?? e) };
    }
  }));
}

export function buildAdvisorPrompt({ task, files, maxChars }) {
  const sections = [`## 任务\n${task}`];
  for (const f of files ?? []) sections.push(`## 文件 ${f.path}\n${f.content}`);
  return truncateMiddle(sections.join('\n\n'), maxChars);
}
