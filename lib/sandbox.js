/** Support DSH <= rc.1 service lookup and rc.2 direct context capability. */
export function getSandboxPolicy(ctx) {
  return ctx.sandboxPolicy ?? ctx.get?.('sandboxPolicy');
}
