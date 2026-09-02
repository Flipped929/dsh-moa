#!/usr/bin/env node
/** DSH 升级后一键自检：cd 到 profile 目录跑 node <repo>/scripts/smoke.mjs */
const fail = (msg) => { console.error('❌', msg); process.exitCode = 1; };
const ok = (msg) => console.log('✅', msg);
try {
  const m = await import('dsh-moa');
  ok(`import: ${m.name}`);
  const cfg = m.Config({});
  ok(`Config: navigator=${cfg.navigatorProvider}/${cfg.navigatorModel}`);
  const roster = (await import('dsh-moa/lib/roster.js')).createRoster(cfg);
  ok(`roster: ${roster.list().length} 个角色`);
  const tools = await import('@deepseek-ai/dsh-tools');
  typeof tools.defineTool === 'function' ? ok('dsh-tools.defineTool 契约在') : fail('dsh-tools.defineTool 缺失——上游契约变动');
  const z = (await import('@deepseek-ai/schemastery')).default;
  typeof z?.object === 'function' ? ok('schemastery z 契约在') : fail('schemastery 导出变动');
} catch (e) {
  fail(`挂载冒烟失败: ${e.message}`);
}
console.log(process.exitCode ? '\n有 FAIL 项：升级后插件不兼容' : '\n全部通过：当前 DSH 版本与插件兼容');
