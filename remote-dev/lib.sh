# shellcheck shell=bash
# Shared config loader for devbox + setup scripts. Sourced, not executed.
# Loads ~/.config/devbox/config (gitignored) so host/user/paths stay out of
# the public repo. Provides: DEVBOX_HOST, DEVBOX_REMOTE_HOME, DEVBOX_SYNCS.

DEVBOX_CONFIG="${DEVBOX_CONFIG:-$HOME/.config/devbox/config}"
# shellcheck source=/dev/null
[ -f "$DEVBOX_CONFIG" ] && . "$DEVBOX_CONFIG"

# Host: from config/env, else a neutral default (override in your config).
DEVBOX_HOST="${DEVBOX_HOST:-dev}"

# Resolve the remote home once, lazily — avoids hardcoding a username path.
# Caches into DEVBOX_REMOTE_HOME so callers can use it directly.
devbox_remote_home() {
  if [ -z "${DEVBOX_REMOTE_HOME:-}" ]; then
    DEVBOX_REMOTE_HOME="$(ssh "$DEVBOX_HOST" 'echo "$HOME"' 2>/dev/null)"
    [ -n "$DEVBOX_REMOTE_HOME" ] || { echo "devbox: cannot resolve remote home on '$DEVBOX_HOST'" >&2; return 1; }
  fi
  printf '%s' "$DEVBOX_REMOTE_HOME"
}
