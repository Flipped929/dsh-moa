#!/usr/bin/env bash
# 幂等恢复 dsh-moa 挂载行（DSH 升级丢 patch 行的实证防护）。用法：scripts/ensure-mount.sh [profile=web]
set -e
PROFILE="${1:-web}"
PATCH="$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
[ -f "$PATCH" ] || { echo "patch 不存在: $PATCH"; exit 1; }
python3 - "$PATCH" << 'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p)) or []
ids = [r.get('insert', [{}])[0].get('id') for r in d]
if 'dsh-moa' not in ids:
    d.insert(0, {'insert': [{'id': 'dsh-moa', 'name': 'dsh-moa'}]})
    yaml.safe_dump(d, open(p, 'w'), allow_unicode=True, sort_keys=False)
    print('已恢复 dsh-moa 挂载行')
else:
    print('挂载行已存在，无需动')
PY
echo "重启 $PROFILE profile 生效。"
