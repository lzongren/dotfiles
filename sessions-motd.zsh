# Print recent agent sessions on new interactive shells. MUST be sourced ABOVE
# the p10k instant-prompt preamble — output after it triggers p10k's "console
# output during initialization" warning + a prompt jump.

# Only in interactive shells, not inside tmux/nested/editors/agents
if [[ -o interactive && -z "$TMUX" && -z "$VSCODE_PID" && -z "$INSIDE_EMACS" && -z "$CLAUDE_CODE" ]]; then
  # --no-remote: skip the 1-3s ssh; bin/sessions serves cached remote + refreshes in bg.
  "${0:A:h}/bin/sessions" --motd --no-remote 2>/dev/null
fi
