/**
 * 自动调度矩阵（架构 v3.3，2026-09-12 用户裁定——DeepSeek 家族现仅 deepseek-flash 一个模型）：
 * 用户不指定席位模型，插件按 模型特性 × 任务类型 × 架构纪律 × 成本 自动分派。
 *
 * 模型画像：
 * - 主模型 captain：页面选的模型（插件不钉定）
 * - GLM-5.3-flash：coding plan Pro 订阅、快、多模态 → 常规档主力（DSH spawn 常驻，zai-coding-cn 直连）
 * - GLM-5.3：同订阅、深推理 → 高难度执行/难片第一顺位（executor-glm）；review-full 的 GLM 家族深审视角
 * - deepseek-flash（DeepSeek 家族唯一模型，走 DeepSeek-V4.1-flash；原生多模态、1M 上下文、峰谷计费）
 *   → 高 stakes critic、异构 devil、视觉席、异步内控 navigator 四处槽位共用
 * - kimi-k3：Allegro 年会员 → 可指派子模型（architect-k3 席 / seats 显式指派）
 *
 * 纪律：devil 应跨家族（防同模型盲区）——但默认槽位是固定模型，主模型同属 DeepSeek 家族时 devil 与主模型同族，
 * 此时须由主模型显式 seats 指派其他家族；视觉材料时 analyst 席换 visionModel（多模态），
 * 并追加 vision-aux 交叉核验席（第二家族承担，模型取自角色文件，默认 kimi-k3）；高 stakes critic 走 criticModel；
 * 角色文件自带模型的角色（executor 系列/architect-k3/reviewer 系列/navigator/vision-aux）保留 roster 默认；
 * 模型 ID 含 expires-on-MMDD 时输出到期提示（modelExpiryNote）。
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

/** 临时模型到期提示：模型 ID 含 expires-on-MMDD 时，临近/过期给出提示（北京时间判定）。 */
export function modelExpiryNote(modelId, now = new Date()) {
  const m = String(modelId ?? '').match(/expires-on-(\d{2})(\d{2})/);
  if (!m) return null;
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const today = `${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`;
  const exp = `${m[1]}${m[2]}`;
  if (today >= exp) return `模型 ${modelId} 已于 ${m[1]}-${m[2]} 到期（临时内测端点）——请把对应槽位/角色切换到当前可用模型`;
  return `模型 ${modelId} 为临时内测端点，将于 ${m[1]}-${m[2]} 到期`;
}

export function assignSeats({ mode, stakes, needVision }, resolved, roster) {
  const cheap = slot(resolved.cheapModel);
  const vision = slot(resolved.visionModel);
  const criticSlot = slot(resolved.criticModel);
  const devilSlot = slot(resolved.devilModel);

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
  // 后端主力=glm-5.3-flash；高难度=glm-5.3 第一顺位 + executor-pro（DeepSeek 复核）第二顺位
  // 前端：glm-5.3-flash 主力 + k3 深度参与（视觉走查）；测试：glm-5.3-flash 主力 + glm 评审
  // 异步内控：navigator=deepseek-flash（低谷/周末优先）
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

  // 联评满编（2026-09-02 用户裁定：claude 不加入席位）：GLM 双档 + DeepSeek 跨家族
  lineups['review-full'] = [
    { role: 'analyst', focus: '声索核查与结构合理性' },
    { role: 'critic', focus: '对抗挑错与风险' },
    { role: 'devil', focus: '跨家族反向论证' },
    { role: 'reviewer-glm', focus: 'GLM 家族深审视角（glm-5.3）' },
  ];

  const lineup = lineups[mode] ?? lineups.review;
  // 视觉交叉核验席（2026-09-12 用户裁定微调）：有图片材料且阵容含 analyst 时追加。
  // 视觉席与 devil 现同为 deepseek-flash（DeepSeek 家族唯一模型），该席改由第二家族承担——
  // 模型取自角色文件 roles/vision-aux.json（默认 kimi-coding/k3，可换 zai-coding-cn/glm-5.3-flash），
  // 矩阵不覆盖（与 executor/reviewer/navigator 系列同纪律）。
  const seats = needVision && lineup.some((s) => s.role === 'analyst')
    ? [...lineup, { role: 'vision-aux', focus: '视觉交叉核验：第二家族与视觉席 analyst 并行读图' }]
    : lineup;

  return seats.map((seat) => {
    const base = roster.get(seat.role) ?? {};
    // 矩阵槽位只作用于通用角色（analyst/critic/devil）；
    // 角色文件自带模型的角色（executor 系列/architect-k3/reviewer 系列/navigator）保留 roster 默认
    let m = { provider: base.provider, model: base.model };
    if (seat.role === 'devil') m = devilSlot;
    else if (needVision && seat.role === 'analyst') m = vision;
    else if (seat.role === 'critic' && stakes === 'high') m = criticSlot;
    else if (seat.role === 'analyst' || seat.role === 'critic') m = cheap;
    // provider=codex 即 codex CLI runtime（codex exec -m <model>），不是 DSH spawn 通道
    if (m.provider === 'codex') m = { ...m, runtime: 'codex' };
    return { ...base, ...seat, ...m, focus: seat.focus };
  });
}

export function describeMatrix(resolved) {
  const tag = (s) => (modelExpiryNote(s) ? '（临时模型，注意到期）' : '');
  return [
    `常规席=${resolved.cheapModel}（GLM 订阅）`,
    `高stakes critic=${resolved.criticModel}（DeepSeek 深审${tag(resolved.criticModel)}）`,
    `视觉席=${resolved.visionModel}（异构多模态${tag(resolved.visionModel)}）`,
    `devil=${resolved.devilModel}（异构跨家族${tag(resolved.devilModel)}）`,
    `视觉交叉核验=vision-aux（角色文件配置，默认 kimi-coding/k3）`,
    `异步内控 navigator=${resolved.navigatorProvider}/${resolved.navigatorModel}`,
  ].join('；');
}
