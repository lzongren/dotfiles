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
trap 'rm -rf "$SMOKE_TMP"' EXIT

"$BOOTSTRAP" --prefix "$PREFIX" install "$VERSION" \
  --archive "$ARCHIVE" \
  --checksums "$CHECKSUMS"

PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/devbox" --version | grep -F "devbox $VERSION (commit "
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/devbox-status.30s.sh" --version | grep -F "devbox-status $VERSION (commit "
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" status
"$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify

printf 'DEVBOX_HOST="smoke-fixture"\n' >"$SMOKE_TMP/devbox-config"
DEVBOX_CONFIG="$SMOKE_TMP/devbox-config" "$PREFIX/bin/devbox" sync ls | grep -F 'No synced folders configured.'
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
