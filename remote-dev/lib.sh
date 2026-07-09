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

# Ignore patterns applied to every sync (VCS handled separately by --ignore-vcs).
# Heavy/derived or machine-specific: build trees, media, caches.
DEVBOX_IGNORES=(
  "*.mov" "*.mp4" "*.avi" "*.mkv"
  ".DS_Store" "node_modules/" "__pycache__/" ".venv/" "*.pyc"
  "build/" "/build" "env/"
)

# Path to the mutagen binary (PATH, else ~/bin fallback). Empty if missing.
devbox_mutagen() { command -v mutagen 2>/dev/null || { [ -x "$HOME/bin/mutagen" ] && printf '%s' "$HOME/bin/mutagen"; }; }

# Create one two-way-safe sync. Args: name  local-path  remote-path(rel|abs).
# Relative remote paths are resolved under the remote home. Used by both
# setup-sync.sh and `devbox sync add` so the sync recipe lives in one place.
devbox_sync_create() {
  local name="$1" local_path="$2" remote="$3"
  local mut; mut="$(devbox_mutagen)"; [ -n "$mut" ] || { echo "devbox: mutagen not installed" >&2; return 1; }
  local rpath
  case "$remote" in
    /*) rpath="$remote" ;;
    *)  local rhome; rhome="$(devbox_remote_home)" || return 1; rpath="$rhome/$remote" ;;
  esac
  # shellcheck disable=SC2029  # $rpath is intentionally resolved locally, then created remotely
  ssh "$DEVBOX_HOST" "mkdir -p '$rpath'" || return 1
  local ign=() i; for i in "${DEVBOX_IGNORES[@]}"; do ign+=(--ignore="$i"); done
  "$mut" sync create --name="$name" --mode=two-way-safe --ignore-vcs \
    "${ign[@]}" "$local_path" "$DEVBOX_HOST:$rpath"
}

# --- Config mutation (pure: operate on a file, no network). These are the
# --- functions the bats tests exercise directly. -----------------------------

# List sync entries from a config file, one "name|local|remote" per line.
# Args: config-path. Prints nothing if the file has no DEVBOX_SYNCS.
devbox_syncs_list() {
  local cfg="$1"; [ -f "$cfg" ] || return 0
  local syncs
  # shellcheck source=/dev/null
  syncs="$( set +u; . "$cfg" 2>/dev/null; printf '%s' "${DEVBOX_SYNCS:-}" )"
  printf '%s\n' "$syncs" | while IFS='|' read -r n l r; do
    [ -n "$n" ] && printf '%s|%s|%s\n' "$n" "$l" "$r"
  done
}

# True if a sync of this name exists in the config. Args: config-path name.
devbox_sync_exists() { devbox_syncs_list "$1" | grep -q "^$2|"; }

# Map a local path to the corresponding remote dir via the synced folders.
# Args: cfg  local-path  remote-home. Prints the remote dir if local-path is a
# synced root or under one, else nothing. Relative remote paths resolve under
# remote-home; absolute ones are used as-is.
devbox_remote_dir() {
  local cfg="$1" pwd_path="$2" rhome="$3" n l r rel rpath
  while IFS='|' read -r n l r; do
    [ -n "$l" ] || continue
    if [ "$pwd_path" = "$l" ]; then rel=""            # at the sync root
    elif [ "${pwd_path#"$l"/}" != "$pwd_path" ]; then rel="/${pwd_path#"$l"/}"   # under it (/ boundary avoids ATX vs ATXtra)
    else continue; fi
    case "$r" in /*) rpath="$r" ;; *) rpath="$rhome/$r" ;; esac
    printf '%s' "$rpath$rel"; return 0
  done < <(devbox_syncs_list "$cfg")
  return 0
}

# Add an entry to DEVBOX_SYNCS in the config file. Args: cfg name local remote.
# Backup → temp edit → validate (sources cleanly AND entry present) → atomic
# swap. On validation failure the original is left untouched. Returns non-zero
# on bad input, duplicate, or failed validation.
devbox_config_add() {
  local cfg="$1" name="$2" local_path="$3" remote="$4"
  [ -n "$name" ] && [ -n "$local_path" ] && [ -n "$remote" ] || { echo "devbox: add needs name/local/remote" >&2; return 2; }
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "devbox: name must match [A-Za-z0-9_-]" >&2; return 2; }
  [ -f "$cfg" ] || { echo "devbox: no config at $cfg" >&2; return 2; }
  devbox_sync_exists "$cfg" "$name" && { echo "devbox: sync '$name' already exists" >&2; return 3; }

  cp "$cfg" "$cfg.bak"
  local tmp; tmp="$(mktemp)"
  if grep -q '^DEVBOX_SYNCS=' "$cfg"; then
    # Insert before the line that closes the DEVBOX_SYNCS="..." block.
    awk -v line="$name|$local_path|$remote" '
      /^DEVBOX_SYNCS=/ {insync=1}
      insync && NR>1 && /^"[[:space:]]*$/ {print line; insync=0}
      {print}
    ' "$cfg" > "$tmp"
  else
    cp "$cfg" "$tmp"
    printf '\nDEVBOX_SYNCS="\n%s\n"\n' "$name|$local_path|$remote" >> "$tmp"
  fi
  # Validate: parses AND sources AND contains the new entry.
  # shellcheck source=/dev/null
  if bash -n "$tmp" 2>/dev/null && ( set +u; . "$tmp" 2>/dev/null; printf '%s' "${DEVBOX_SYNCS:-}" | grep -q "^$name|" ); then
    mv "$tmp" "$cfg"; return 0
  fi
  rm -f "$tmp"; echo "devbox: config edit failed validation, left unchanged (backup: $cfg.bak)" >&2; return 1
}

# Remove an entry from DEVBOX_SYNCS. Args: cfg name. Same backup/validate dance.
devbox_config_rm() {
  local cfg="$1" name="$2"
  [ -n "$name" ] || { echo "devbox: rm needs a name" >&2; return 2; }
  [ -f "$cfg" ] || { echo "devbox: no config at $cfg" >&2; return 2; }
  devbox_sync_exists "$cfg" "$name" || { echo "devbox: no sync named '$name'" >&2; return 3; }
  cp "$cfg" "$cfg.bak"
  local tmp; tmp="$(mktemp)"
  grep -v "^$name|" "$cfg" > "$tmp"
  if bash -n "$tmp" 2>/dev/null; then mv "$tmp" "$cfg"; return 0; fi
  rm -f "$tmp"; echo "devbox: edit failed, unchanged (backup: $cfg.bak)" >&2; return 1
}
