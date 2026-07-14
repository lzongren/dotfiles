# sessions-motd.zsh — source from .zshrc to show recent agent sessions on
# new interactive shells.
#
# Usage: add to .zshrc (after PATH setup):
#   source ~/Personal/dotfiles/sessions-motd.zsh

# Only in interactive shells, not inside tmux/nested/editors/agents
if [[ -o interactive && -z "$TMUX" && -z "$VSCODE_PID" && -z "$INSIDE_EMACS" && -z "$CLAUDE_CODE" ]]; then
  # Skip remote on startup (adds 1-3s latency). Use `sessions` for the full view.
  sessions --motd --no-remote 2>/dev/null
fi
