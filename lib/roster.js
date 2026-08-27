/**
 * roster 角色注册表：包内默认角色 + 用户层角色文件（~/.dsh/moa/roles/*.json）。
 * 解析全收、生效白名单（ROLE_KEYS）；注册新角色 = 丢一个 JSON 文件，不动插件、不重启进程（下次挂载生效）。
 * 角色只能做减法：sandbox/approval 永远继承父会话，本模块无权更改。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles');
const ROLE_KEYS = ['name', 'description', 'provider', 'model', 'maxTokens', 'temperature', 'systemPrompt'];

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function loadRoleFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const role = {};
  for (const k of ROLE_KEYS) if (raw[k] !== undefined) role[k] = raw[k];
  for (const k of ['name', 'provider', 'model']) {
    if (typeof role[k] !== 'string' || !role[k]) throw new Error(`missing/invalid "${k}"`);
  }
  return role;
}

export function createRoster(resolved) {
  const roles = new Map();
  const loadDir = (dir, origin) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const role = loadRoleFile(join(dir, f));
        roles.set(role.name, { ...role, origin });
      } catch (e) {
        console.warn(`[dsh-moa] skip role file ${f}: ${e.message}`);
      }
    }
  };
  loadDir(PACKAGE_ROLES_DIR, 'package');
  loadDir(expandHome(resolved.rolesDir), 'user');
  return {
    list: () => [...roles.values()],
    get: (name) => roles.get(name),
    seatsFor: (names) => names.map((n) => roles.get(n)).filter(Boolean),
  };
}
