#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)/bin"
url="$("$BIN_DIR/devbox" web url)"
port="${url#http://127.0.0.1:}"
port="${port%%/*}"
token="${url#*#t=}"
base="http://127.0.0.1:$port"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check() {
  local want="$1" got
  shift
  got="$(code "$@")"
  if [ "$got" = "$want" ]; then
    echo "ok   $want $*"
  else
    echo "FAIL want $want got $got: $*" >&2
    exit 1
  fi
}

check 401 "$base/api/sessions"
check 200 -H "Authorization: Bearer $token" "$base/api/health"
check 200 -H "Authorization: Bearer $token" "$base/api/sessions"
check 403 -H "Host: evil.example" "$base/api/health"
check 404 --path-as-is "$base/assets/../../etc/passwd"
check 200 "$base/"

echo "automated live checks passed for $base"
cat <<'EOF'

Manual checklist:
- the table matches `devbox status` row for row (attached dot, clients, cmd, path)
- `printf '\a'` inside a remote tmux session shows the bell badge within 5s
- a space-named session renders dimmed with a tooltip, no action
- drop the network: banner shows "as of Ns" and stale rows stay; recovery within 5s of reconnect
- a second `devbox web` reuses the same URL without starting a second server
- `devbox web stop` leaves no node process and `devbox web url` then fails
EOF
