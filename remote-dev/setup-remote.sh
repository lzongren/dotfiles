#!/usr/bin/env bash
# setup-remote.sh — provision an Amazon Linux 2 dev host for remote development:
# builds mosh + a modern tmux from source (the packaged versions are
# broken/ancient on AL2) and deploys the tmux config.
#
# Run FROM your laptop:  ./remote-dev/setup-remote.sh [ssh-host]
# Host resolves from the arg, else ~/.config/devbox/config (DEVBOX_HOST).
#
# Idempotent: skips anything already installed. Mutagen file sync is set up
# separately from the laptop side — see setup-sync.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"
HOST="${1:-$DEVBOX_HOST}"

MOSH_VERSION="1.4.0"
TMUX_VERSION="3.5a"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'
log() { echo -e "${BLUE}▶${RESET} $*"; }
ok() { echo -e "${GREEN}✓${RESET} $*"; }
die() {
  echo -e "${RED}✗${RESET} $*" >&2
  exit 1
}

log "Target host: ${BOLD}${HOST}${RESET}"
ssh "$HOST" 'true' || die "Cannot SSH to $HOST (set DEVBOX_HOST in ~/.config/devbox/config or pass as arg)"

# ---------------------------------------------------------------------------
# Remote build. Heredoc runs on the dev host. Encodes the AL2 gotchas:
#   - EPEL mosh links against protobuf 3.x but AL2 ships 2.5 → build from src
#   - AL2 has openssl11 (not openssl-devel); mosh's configure wants openssl.pc
#     → symlink-shim openssl11.pc → openssl.pc in a private pkgconfig dir
#   - system tmux is 1.8 (no `new-session -A`); build 3.5a to ~/.local
#   - put ~/.local/bin on PATH via .zshenv (sourced by mosh's non-login shell)
# ---------------------------------------------------------------------------
log "Provisioning remote (build deps, mosh, tmux)…"
ssh "$HOST" MOSH_VERSION="$MOSH_VERSION" TMUX_VERSION="$TMUX_VERSION" 'bash -s' <<'REMOTE'
set -euo pipefail
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RESET='\033[0m'
rlog() { echo -e "${BLUE}  ·${RESET} $*"; }
rok()  { echo -e "${GREEN}  ✓${RESET} $*"; }

mkdir -p "$HOME/.local/bin" "$HOME/.local/pkgconfig"

# --- PATH: ~/.local/bin first, for ALL shells incl. mosh's non-login shell ---
if ! grep -q 'HOME/.local/bin' "$HOME/.zshenv" 2>/dev/null; then
  cp "$HOME/.zshenv" "$HOME/.zshenv.bak" 2>/dev/null || true
  printf '\n# Prefer ~/.local/bin (tmux, mosh) over system /usr/bin\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zshenv"
  rok ".zshenv PATH updated"
else
  rok ".zshenv PATH already set"
fi

# --- build dependencies (protobuf 2.5 + libevent; openssl11 already present) ---
NEED=()
for p in gcc-c++ protobuf-devel protobuf-compiler ncurses-devel zlib-devel \
         automake autoconf libtool pkgconfig bison libevent-devel; do
  rpm -q "$p" >/dev/null 2>&1 || NEED+=("$p")
done
if (( ${#NEED[@]} )); then
  rlog "installing: ${NEED[*]}"
  sudo yum install -y "${NEED[@]}" >/dev/null
  rok "build deps installed"
else
  rok "build deps present"
fi

# --- openssl pkg-config shims (AL2 has openssl11.pc, mosh wants openssl.pc) ---
for f in openssl libcrypto libssl; do
  src="/usr/lib64/pkgconfig/${f}11.pc"
  [ -e "$src" ] && ln -sf "$src" "$HOME/.local/pkgconfig/${f}.pc"
done
export PKG_CONFIG_PATH="$HOME/.local/pkgconfig:/usr/lib64/pkgconfig"
rok "openssl pkg-config shims ready"

# --- mosh from source ---
if "$HOME/.local/bin/mosh-server" --version >/dev/null 2>&1 || \
   "$HOME/.local/bin/mosh-server" 2>&1 | grep -q UTF-8; then
  rok "mosh already built"
else
  rlog "building mosh ${MOSH_VERSION} (a few min)…"
  sudo yum remove -y mosh >/dev/null 2>&1 || true   # drop broken EPEL build
  tmp="$(mktemp -d)"; cd "$tmp"
  curl -sL "https://github.com/mobile-shell/mosh/releases/download/mosh-${MOSH_VERSION}/mosh-${MOSH_VERSION}.tar.gz" | tar xz
  cd "mosh-${MOSH_VERSION}"
  ./configure --prefix="$HOME/.local" >/tmp/mosh-cfg.log 2>&1
  make -j4 >/tmp/mosh-make.log 2>&1
  make install >/tmp/mosh-install.log 2>&1
  cd; rm -rf "$tmp"
  rok "mosh built → ~/.local/bin/mosh-server"
fi

# --- tmux from source (system is 1.8; need >= 1.9 for new-session -A) ---
if [ -x "$HOME/.local/bin/tmux" ] && "$HOME/.local/bin/tmux" -V | grep -q "${TMUX_VERSION}"; then
  rok "tmux ${TMUX_VERSION} already built"
else
  rlog "building tmux ${TMUX_VERSION} (a few min)…"
  tmp="$(mktemp -d)"; cd "$tmp"
  curl -sL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" | tar xz
  cd "tmux-${TMUX_VERSION}"
  ./configure --prefix="$HOME/.local" >/tmp/tmux-cfg.log 2>&1
  make -j4 >/tmp/tmux-make.log 2>&1
  make install >/tmp/tmux-install.log 2>&1
  cd; rm -rf "$tmp"
  # clear any stale system-tmux socket that would block the new server
  /usr/bin/tmux kill-server 2>/dev/null || true
  rm -f "/tmp/tmux-$(id -u)/default" 2>/dev/null || true
  rok "tmux built → ~/.local/bin/tmux ($("$HOME/.local/bin/tmux" -V))"
fi

# --- tmux plugins: resurrect + continuum (session persistence across reboots) ---
for p in tmux-resurrect tmux-continuum; do
  if [ -d "$HOME/.tmux/plugins/$p" ]; then
    rok "$p present"
  else
    git clone -q --depth 1 "https://github.com/tmux-plugins/$p" "$HOME/.tmux/plugins/$p"
    rok "$p cloned"
  fi
done
REMOTE
ok "Remote build complete"

# --- deploy tmux.conf ---
log "Deploying tmux.conf → ${HOST}:~/.tmux.conf"
scp -q "$SCRIPT_DIR/tmux.conf" "$HOST:~/.tmux.conf"
ok "tmux.conf deployed"

echo ""
ok "Done. Connect with ${BOLD}devbox${RESET} (or ${BOLD}devbox --raw${RESET} for plain mosh)."
echo -e "  Set up file sync next: ${BOLD}./remote-dev/setup-sync.sh${RESET}"
