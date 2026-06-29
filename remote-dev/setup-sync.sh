#!/usr/bin/env bash
# setup-sync.sh — install Mutagen on the laptop and create two-way file sync
# sessions to the remote dev desktop, so Claude Code (running remotely) edits
# files that stay mirrored on the laptop. Run FROM your laptop.
#
#   ./remote-dev/setup-sync.sh
#
# Edit the SYNCS array below to change which folders sync. Format:
#   "name|local-path|remote-path"
# Idempotent: skips installs and sync sessions that already exist.
set -euo pipefail

HOST="${DEVBOX_HOST:-zongrenl-dev}"
MUTAGEN_VERSION="0.18.1"

# name | local (laptop) | remote (host)
SYNCS=(
  "atx|$HOME/Documents/ATX|$HOST:/home/zongrenl/ATX"
  "idf|$HOME/Documents/IDF|$HOST:/home/zongrenl/IDF"
)

# Excluded everywhere: VCS is handled by --ignore-vcs. These are heavy/derived
# or machine-specific (Brazil build/ trees, media, caches) — not worth syncing.
IGNORES=(
  "*.mov" "*.mp4" "*.avi" "*.mkv"
  ".DS_Store" "node_modules/" "__pycache__/" ".venv/" "*.pyc"
  "build/" "/build" ".brazil/" "env/"
)

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log() { echo -e "${BLUE}▶${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }
die() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

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

# --- create sync sessions (skip if the named session already exists) ---
existing="$("$MUTAGEN" sync list 2>/dev/null | grep -oE 'Name: [a-zA-Z0-9_-]+' | awk '{print $2}' || true)"
for entry in "${SYNCS[@]}"; do
  IFS='|' read -r name local remote <<<"$entry"
  if grep -qx "$name" <<<"$existing"; then
    ok "sync '${name}' already exists — skipping"
    continue
  fi
  [ -d "$local" ] || die "local path missing: $local"
  ssh "$HOST" "mkdir -p '${remote#*:}'"
  log "Creating sync ${BOLD}${name}${RESET}: ${local} ⇄ ${remote}"
  "$MUTAGEN" sync create \
    --name="$name" --mode=two-way-safe --ignore-vcs \
    "${IGNORE_FLAGS[@]}" \
    "$local" "$remote"
  ok "sync '${name}' created"
done

echo ""
ok "Done. Monitor with ${BOLD}mutagen sync list${RESET} or ${BOLD}mutagen sync monitor <name>${RESET}."
