/**
 * 自动调度矩阵（2026-08-27 用户裁定）：用户不指定席位模型，插件按
 * 模型特性 × 任务类型 × 架构纪律 × 成本 自动分派。
 *
 * 模型画像（当前常用三模型）：
 * - v4-flash-vision-exp：快、便宜（高峰 3/9 元/M）且多模态 → 批量执行、初稿、常规对抗（默认常规档）
 * - v4-flash-vision-exp：同上 + 视觉（图片材料）→ 核图/截图任务
 * - v4-pro：强推理、贵（高峰 9/27 元/M）→ 高 stakes 深审、难片
 * - kimi-k3：跨家族视角、多模态、订阅额度 → devil 对抗/独立语义核查
 *
 * 纪律：devil 永远跨家族（防同模型盲区）；高 stakes critic 升 pro；
 * 视觉材料自动换 vision 席；超大上下文材料避开 k3（262K 口径）。
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
  const vision = slot(resolved.visionModel);
  const pro = slot(resolved.proModel);
  const devilSlot = slot(resolved.devilModel);
  const k3Small = bigContextChars > 200000; // 材料超 ~200K 字符：k3 席位改 v4 家族读全量

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
  // 开发平面模式（2026-08-28 用户架构）：GLM 家族全走 codex runtime
  // 后端：glm-flash 主力，glm 第一顺位/v4-pro 第二顺位（高难度）
  // 前端：glm-flash 主力 + k3 深度参与（视觉走查）
  // 测试：glm-flash 主力 + glm/v4-pro 深度参与
  // 异步内控：v4-pro（低谷/周末优先），多模态核查 vision-exp
  lineups['dev-backend'] = stakes === 'high'
    ? [{ role: 'executor-glm', focus: '高难度后端开发（第一顺位）' }, { role: 'executor-pro', focus: '高难度后端开发（第二顺位复核）' }, { role: 'critic', focus: 'diff 审查' }]
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

  // 联评满编（2026-09-02 用户裁定）：三家族全到——v4 + k3 + GLM(codex) + claude
  lineups['review-full'] = [
    { role: 'analyst', focus: '声索核查与结构合理性' },
    { role: 'critic', focus: '对抗挑错与风险' },
    { role: 'devil', focus: '跨家族反向论证（k3）' },
    { role: 'reviewer-glm-flash', focus: 'GLM 家族视角（codex）' },
    { role: 'reviewer-claude', focus: 'claude 家族视角（真实成本记账）' },
  ];

  const lineup = lineups[mode] ?? lineups.review;

  return lineup.map((seat) => {
    const base = roster.get(seat.role) ?? {};
    let m;
    if (seat.role === 'devil') m = k3Small ? pro : devilSlot;
    else if (needVision) m = seat.role === 'devil' ? devilSlot : vision;
    else if (seat.role === 'critic' && stakes === 'high') m = pro;
    else m = cheap;
    return { ...base, ...seat, ...m, focus: seat.focus };
  });
}

export function describeMatrix(resolved) {
  return [
    `常规席=${resolved.cheapModel}`,
    `高stakes critic=${resolved.proModel}`,
    `视觉席=${resolved.visionModel}`,
    `devil=${resolved.devilModel}`,
  ].join('；');
}
