/**
 * 值库 + 模式 双层脱敏（移植自 pi-moa redactSensitiveText 并扩展长 token 启发式）。
 * 所有发往 advisor 的上下文与 advisor 回流文本都必须经过本模块。
 */
const PATTERNS = [
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /\b(?:sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
];

export function redactText(input, extraValues = []) {
  let text = String(input ?? '');
  for (const v of extraValues) {
    if (typeof v === 'string' && v.length >= 8) text = text.split(v).join('[REDACTED]');
  }
  for (const p of PATTERNS) {
    text = text.replace(p, (m, g1) => (g1 ? `${g1}[REDACTED]` : '[REDACTED]'));
  }
  return text;
}

export function truncateMiddle(text, maxChars) {
  const s = String(text ?? '');
  if (!maxChars || maxChars <= 0 || s.length <= maxChars) return s;
  const keep = Math.max(1, Math.floor(maxChars / 2));
  return `${s.slice(0, keep)}\n…<truncated ${s.length - keep * 2} chars>…\n${s.slice(-keep)}`;
}
