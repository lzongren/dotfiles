#!/usr/bin/env bash
# setup-sync.sh — install Mutagen on the laptop and create two-way file sync
# sessions to the remote dev host, so Claude Code (running remotely) edits
# files that stay mirrored on the laptop. Run FROM your laptop.
#
#   ./remote-dev/setup-sync.sh
#
# Folders to sync come from DEVBOX_SYNCS in ~/.config/devbox/config (copy
# remote-dev/config.example). Format, one per line: "name|local-path|remote-path"
# remote-path is relative to the remote home unless absolute.
# Idempotent: skips installs and sync sessions that already exist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

MUTAGEN_VERSION="0.18.1"

# Excluded everywhere: VCS is handled by --ignore-vcs. These are heavy/derived
# or machine-specific (e.g. build trees with absolute symlinks, media, caches).
IGNORES=(
  "*.mov" "*.mp4" "*.avi" "*.mkv"
  ".DS_Store" "node_modules/" "__pycache__/" ".venv/" "*.pyc"
  "build/" "/build" "env/"
)

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log() { echo -e "${BLUE}▶${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }
die() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

[ -n "${DEVBOX_SYNCS:-}" ] || die "No DEVBOX_SYNCS defined. Copy remote-dev/config.example to ~/.config/devbox/config and list your folders."

# --- install Mutagen on the laptop (official binary → ~/bin) ---
if command -v mutagen >/dev/null 2>&1 || [ -x "$HOME/bin/mutagen" ]; then
  ok "Mutagen present ($("${HOME}/bin/mutagen" version 2>/dev/null || mutagen version))"
else
  log "Installing Mutagen ${MUTAGEN_VERSION} → ~/bin"
  mkdir -p "$HOME/bin"
  arch="$(uname -m)"; [ "$arch" = "arm64" ] && arch="arm64" || arch="amd64"
  tmp="$(mktemp -d)"
  curl -sL "https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_darwin_${arch}_v${MUTAGEN_VERSION}.tar.gz" \
    | tar xz -C "$tmp"
  cp "$tmp/mutagen" "$tmp/mutagen-agents.tar.gz" "$HOME/bin/"
  chmod +x "$HOME/bin/mutagen"
  rm -rf "$tmp"
  ok "Mutagen installed"
fi
MUTAGEN="$(command -v mutagen || echo "$HOME/bin/mutagen")"

# --- daemon: start + register for login auto-start ---
"$MUTAGEN" daemon start 2>/dev/null || true
if "$MUTAGEN" daemon register 2>/dev/null; then
  ok "Mutagen daemon registered for auto-start at login"
else
  ok "Mutagen daemon running (already registered)"
fi

# --- build the --ignore flags once ---
IGNORE_FLAGS=()
for ig in "${IGNORES[@]}"; do IGNORE_FLAGS+=(--ignore="$ig"); done

REMOTE_HOME="$(devbox_remote_home)" || die "Could not resolve remote home on $DEVBOX_HOST"

# --- create sync sessions (skip if the named session already exists) ---
existing="$("$MUTAGEN" sync list 2>/dev/null | grep -oE 'Name: [a-zA-Z0-9_-]+' | awk '{print $2}' || true)"
while IFS='|' read -r name local remote; do
  [ -n "$name" ] || continue            # skip blank lines
  if grep -qx "$name" <<<"$existing"; then
    ok "sync '${name}' already exists — skipping"
    continue
  fi
  [ -d "$local" ] || die "local path missing: $local"
  # relative remote path → under remote home
  case "$remote" in /*) rpath="$remote" ;; *) rpath="$REMOTE_HOME/$remote" ;; esac
  ssh "$DEVBOX_HOST" "mkdir -p '$rpath'"
  log "Creating sync ${BOLD}${name}${RESET}: ${local} ⇄ ${DEVBOX_HOST}:${rpath}"
  "$MUTAGEN" sync create \
    --name="$name" --mode=two-way-safe --ignore-vcs \
    "${IGNORE_FLAGS[@]}" \
    "$local" "$DEVBOX_HOST:$rpath"
  ok "sync '${name}' created"
done <<< "$DEVBOX_SYNCS"

echo ""
ok "Done. Monitor with ${BOLD}mutagen sync list${RESET} or ${BOLD}mutagen sync monitor <name>${RESET}."
