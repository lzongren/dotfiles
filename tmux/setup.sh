#!/usr/bin/env bash
# Setup tmux with Catppuccin theme and TPM plugins
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log() { echo -e "${BLUE}▶${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }
die() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

DOTFILES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CATPPUCCIN_DIR="$HOME/.config/tmux/plugins/catppuccin/tmux"
CATPPUCCIN_TAG="v2.3.0"
TPM_DIR="$HOME/.tmux/plugins/tpm"

# Install tmux if missing
if ! command -v tmux &>/dev/null; then
  log "Installing tmux"
  brew install tmux
  ok "tmux installed"
else
  ok "tmux already installed ($(tmux -V))"
fi

# Install Catppuccin (manual clone — recommended over TPM for this plugin)
if [[ -d "$CATPPUCCIN_DIR" ]]; then
  log "Updating Catppuccin to ${BOLD}${CATPPUCCIN_TAG}${RESET}"
  git -C "$CATPPUCCIN_DIR" fetch --tags
  git -C "$CATPPUCCIN_DIR" checkout "$CATPPUCCIN_TAG" 2>/dev/null
else
  log "Installing Catppuccin ${BOLD}${CATPPUCCIN_TAG}${RESET}"
  mkdir -p "$(dirname "$CATPPUCCIN_DIR")"
  git clone -b "$CATPPUCCIN_TAG" https://github.com/catppuccin/tmux.git "$CATPPUCCIN_DIR"
fi
ok "Catppuccin ready at ${CATPPUCCIN_DIR}"

# Install TPM if missing
if [[ ! -d "$TPM_DIR" ]]; then
  log "Installing TPM"
  git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
  ok "TPM installed"
else
  ok "TPM already installed"
fi

# Symlink tmux.conf
log "Linking tmux.conf"
ln -sf "$DOTFILES_DIR/tmux/tmux.conf" "$HOME/.tmux.conf"
ok "~/.tmux.conf → $DOTFILES_DIR/tmux/tmux.conf"

# Install TPM plugins (non-interactively)
log "Installing TPM plugins"
"$TPM_DIR/bin/install_plugins"
ok "TPM plugins installed"

echo ""
ok "Done! Run ${BOLD}tmux source ~/.tmux.conf${RESET} or restart tmux to apply."
