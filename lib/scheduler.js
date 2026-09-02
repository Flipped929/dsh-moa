/**
 * 自动调度矩阵（2026-08-27 用户裁定；2026-09-02 订阅优先修订）：
 * 用户不指定席位模型，插件按 模型特性 × 任务类型 × 架构纪律 × 成本 自动分派。
 *
 * 模型画像（2026-09-02 订阅优先，用户裁定）：
 * - kimi-k3：Allegro 年会员订阅额度、跨家族、多模态 → devil/架构 UI/视觉（spawn 常驻）
 * - GLM-5.3-flash：coding plan Pro 订阅额度、快 → 常规档主力（codex CLI，按需冷启动）
 * - GLM-5.3：同订阅、深推理 → 高 stakes critic/难片第一顺位（codex CLI）
 * - DeepSeek 系（v4-pro / v4-flash-vision-exp）：峰谷计费、价格高 → 仅补充：
 *   大上下文 devil、dev 平面 critic（防与 executor=glm 同源）、executor-pro 难片、
 *   navigator 内控；批量 DeepSeek 任务排低谷/周末。
 *
 * 纪律：devil 永远跨家族（防同模型盲区）；视觉材料仅 analyst 席换 k3 多模态（其余席位保持家族多样性）；
 * 高 stakes critic 升 GLM-5.3；dev 平面 executor=glm 时 critic 强制 v4-pro（不同源）；
 * 角色文件自带模型的角色（executor 系列/architect-k3/reviewer 系列/navigator）保留 roster 默认。
 */

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

export function isImagePath(p) {
  const lower = String(p ?? '').toLowerCase();
  return IMAGE_EXTS.some((e) => lower.endsWith(e));
}

function slot(str) {
  const i = str.indexOf('/');
  return { provider: str.slice(0, i), model: str.slice(i + 1) };
}

/** 北京时间峰谷（2026-08-17/23 规则）：高峰=工作日 9-12/14-18；周末全天低谷。 */
export function isPeakHour(now = new Date()) {
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  const h = bj.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export function assignSeats({ mode, stakes, needVision, bigContextChars }, resolved, roster) {
  const cheap = slot(resolved.cheapModel);
  const deep = slot(resolved.deepModel);
  const vision = slot(resolved.visionModel);
  const pro = slot(resolved.proModel);
  const devilSlot = slot(resolved.devilModel);
  const k3Small = bigContextChars > 200000; // 材料超 ~200K 字符：k3 席位改 DeepSeek 大上下文读全量

  const lineups = {
    review: [
      { role: 'analyst', focus: '声索核查与结构合理性' },
      { role: 'critic', focus: '对抗挑错与风险' },
      { role: 'devil', focus: '跨家族反向论证' },
    ],
    research: [
      { role: 'analyst', focus: '事实与数据角度' },
      { role: 'devil', focus: '反面与风险角度（跨家族）' },
    ],
    write: [
      { role: 'analyst', focus: '起草' },
      { role: 'critic', focus: '挑刺与修订建议' },
    ],
  };
  // 开发平面（2026-08-28 用户架构，2026-09-02 订阅优先修订）：
  // 后端主力=glm-5.3-flash；高难度=glm-5.3 第一顺位 + executor-pro(v4-pro) 第二顺位复核
  // 前端：glm-flash 主力 + k3 深度参与（视觉走查）；测试：glm-flash 主力 + glm 评审
  // 异步内控：navigator=v4-pro（2026-08-28 裁定；低谷/周末优先）
  lineups['dev-backend'] = stakes === 'high'
    ? [{ role: 'executor-glm', focus: '高难度后端开发（第一顺位）' }, { role: 'executor-pro', focus: '高难度后端开发（第二顺位复核）' }, { role: 'critic', focus: 'diff 审查（与 executor 不同源）' }]
    : [{ role: 'executor-glm-flash', focus: '后端开发执行' }, { role: 'critic', focus: 'diff 审查' }];
  lineups['dev-frontend'] = [
    { role: 'executor-glm-flash', focus: '前端开发执行' },
    { role: 'architect-k3', focus: 'UI 深度参与与视觉走查' },
  ];
  lineups['test'] = [
    { role: 'executor-glm-flash', focus: '测试编写与执行' },
    { role: 'executor-glm', focus: '测试评审（深度参与）' },
    { role: 'critic', focus: '覆盖与漏洞挑错' },
  ];
  lineups['audit'] = [
    { role: 'navigator', focus: '异步内控：运行记录核查/抽检/成本对比' },
  ];

  // 联评满编（2026-09-02 用户裁定：claude 不加入席位）：GLM 双档 + k3 跨家族
  lineups['review-full'] = [
    { role: 'analyst', focus: '声索核查与结构合理性' },
    { role: 'critic', focus: '对抗挑错与风险' },
    { role: 'devil', focus: '跨家族反向论证（k3）' },
    { role: 'reviewer-glm', focus: 'GLM 家族深审视角（glm-5.3）' },
  ];

  const lineup = lineups[mode] ?? lineups.review;
  const isDevPlane = mode === 'dev-backend' || mode === 'dev-frontend' || mode === 'test';

  return lineup.map((seat) => {
    const base = roster.get(seat.role) ?? {};
    // 矩阵槽位只作用于通用角色（analyst/critic/devil）；
    // 角色文件自带模型的角色（executor 系列/architect-k3/reviewer 系列/navigator）保留 roster 默认
    let m = { provider: base.provider, model: base.model };
    if (seat.role === 'devil') m = k3Small ? pro : devilSlot;
    else if (needVision && seat.role === 'analyst') m = vision;
    else if (seat.role === 'critic' && stakes === 'high') m = isDevPlane ? pro : deep;
    else if (seat.role === 'analyst' || seat.role === 'critic') m = cheap;
    // provider=codex 即 codex CLI runtime（codex exec -m <model>），不是 DSH spawn 通道
    if (m.provider === 'codex') m = { ...m, runtime: 'codex' };
    return { ...base, ...seat, ...m, focus: seat.focus };
  });
}

export function describeMatrix(resolved) {
  return [
    `常规席=${resolved.cheapModel}（GLM 订阅）`,
    `高stakes critic=${resolved.deepModel}（GLM 订阅；dev 平面=${resolved.proModel}）`,
    `视觉席=${resolved.visionModel}（k3 订阅多模态）`,
    `devil=${resolved.devilModel}（k3 订阅跨家族）`,
    `DeepSeek 补充=${resolved.proModel}（大上下文/navigator/难片，排低谷）`,
  ].join('；');
}
