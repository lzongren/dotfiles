#!/usr/bin/env bash
# Cross-platform smoke test for an already built dotfiles-tools release asset.
set -euo pipefail

BOOTSTRAP=""
ARCHIVE=""
CHECKSUMS=""
PREFIX=""
VERSION=""

die() {
  echo "release/smoke.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bootstrap)
      BOOTSTRAP="${2:-}"
      shift 2
      ;;
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    --checksums)
      CHECKSUMS="${2:-}"
      shift 2
      ;;
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    *) die "unknown or incomplete option: $1" ;;
  esac
done

[ -x "$BOOTSTRAP" ] || die "bootstrap is not executable: $BOOTSTRAP"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[ -f "$CHECKSUMS" ] || die "checksums not found: $CHECKSUMS"
[ -n "$PREFIX" ] || die "--prefix is required"
[ -n "$VERSION" ] || die "--version is required"

SMOKE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-tools-smoke.XXXXXX")"
cleanup() {
  if [ -x "$PREFIX/bin/devbox" ]; then
    DEVBOX_WEB_STATE="$SMOKE_TMP/web-state" "$PREFIX/bin/devbox" web stop >/dev/null 2>&1 || true
  fi
  rm -rf "$SMOKE_TMP"
}
trap cleanup EXIT

"$BOOTSTRAP" --prefix "$PREFIX" install "$VERSION" \
  --archive "$ARCHIVE" \
  --checksums "$CHECKSUMS"

PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/devbox" --version | grep -F "devbox $VERSION (commit "
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/devbox-status.30s.sh" --version | grep -F "devbox-status $VERSION (commit "
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" status
"$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify

printf 'DEVBOX_HOST="smoke-fixture"\n' >"$SMOKE_TMP/devbox-config"
DEVBOX_CONFIG="$SMOKE_TMP/devbox-config" "$PREFIX/bin/devbox" sync ls | grep -F 'No synced folders configured.'
web_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
web_url="$(
  DEVBOX_CONFIG="$SMOKE_TMP/devbox-config" \
    DEVBOX_WEB_STATE="$SMOKE_TMP/web-state" \
    npm_config_cache="$SMOKE_TMP/npm-cache" \
    "$PREFIX/bin/devbox" web --no-open --port "$web_port"
)"
printf '%s\n' "$web_url" | grep -E "^http://127\\.0\\.0\\.1:$web_port/#t=[A-Za-z0-9_-]+$"
DEVBOX_WEB_STATE="$SMOKE_TMP/web-state" "$PREFIX/bin/devbox" web status | grep -F 'devbox web: running'
web_token="${web_url##*#t=}"
web_ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS -m 3 -H "Authorization: Bearer $web_token" \
    "http://127.0.0.1:$web_port/api/health" >/dev/null 2>&1; then
    web_ready=1
    break
  fi
  sleep 0.25
done
[ "$web_ready" -eq 1 ] || die "devbox web health check did not become ready"
"$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
DEVBOX_WEB_STATE="$SMOKE_TMP/web-state" "$PREFIX/bin/devbox" web stop | grep -F 'devbox web: stopped'
"$PREFIX/opt/dotfiles-tools/current/remote-dev/setup-remote.sh" --version | grep -F "setup-remote $VERSION (commit "
"$PREFIX/opt/dotfiles-tools/current/remote-dev/setup-sync.sh" --version | grep -F "setup-sync $VERSION (commit "

cp "$PREFIX/opt/dotfiles-tools/current/bin/devbox" "$SMOKE_TMP/devbox.clean"
printf '\n# integrity smoke-test modification\n' >>"$PREFIX/opt/dotfiles-tools/current/bin/devbox"
if "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify >"$SMOKE_TMP/tamper.out" 2>&1; then
  die "verification accepted a modified devbox"
fi
grep -F 'checksum mismatch: bin/devbox' "$SMOKE_TMP/tamper.out"
cp "$SMOKE_TMP/devbox.clean" "$PREFIX/opt/dotfiles-tools/current/bin/devbox"
"$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify

echo "release smoke passed for dotfiles-tools $VERSION"
