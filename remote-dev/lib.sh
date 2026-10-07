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
    [ -n "$DEVBOX_REMOTE_HOME" ] || {
      echo "devbox: cannot resolve remote home on '$DEVBOX_HOST'" >&2
      return 1
    }
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
  local mut
  mut="$(devbox_mutagen)"
  [ -n "$mut" ] || {
    echo "devbox: mutagen not installed" >&2
    return 1
  }
  local rpath
  case "$remote" in
    /*) rpath="$remote" ;;
    *)
      local rhome
      rhome="$(devbox_remote_home)" || return 1
      rpath="$rhome/$remote"
      ;;
  esac
  # shellcheck disable=SC2029  # $rpath is intentionally resolved locally, then created remotely
  ssh "$DEVBOX_HOST" "mkdir -p '$rpath'" || return 1
  local ign=() i
  for i in "${DEVBOX_IGNORES[@]}"; do ign+=(--ignore="$i"); done
  "$mut" sync create --name="$name" --mode=two-way-safe --ignore-vcs \
    "${ign[@]}" "$local_path" "$DEVBOX_HOST:$rpath"
}

# Mutagen freezes ignores into a session at create time, so DEVBOX_IGNORES
# edits never reach it. Order matters once `!` patterns exist. A missing
# session is not stale. Args: mutagen-bin name.
devbox_sync_stale() {
  local live
  live="$("$1" sync list --template '{{range .}}{{range .Configuration.Ignore.Paths}}{{.}}{{"\n"}}{{end}}{{end}}' "$2" 2>/dev/null)" || return 1
  [ "$live" != "$(printf '%s\n' "${DEVBOX_IGNORES[@]}")" ]
}

# The template prints the short status (Watching), not list's "Watching for
# changes"; empty if no such session. Args: mutagen-bin name.
devbox_sync_status() {
  "$1" sync list --template '{{range .}}{{.Status}}{{end}}' "$2" 2>/dev/null
}

# shellcheck disable=SC2034  # read by bin/devbox
DEVBOX_STALL_AFTER=3600

if stat -c %Y / >/dev/null 2>&1; then
  devbox_mtime() { stat -c %Y "$1" 2>/dev/null; }
else
  devbox_mtime() { stat -f %m "$1" 2>/dev/null; }
fi

devbox_lines() { wc -l <"$1" | tr -d ' '; }

# Mutagen rewrites a session's archive (the last state both sides agreed on)
# only after a cycle that applies changes, so an idle healthy session keeps an
# old one. Empty if unknown. Args: mutagen-bin name.
devbox_sync_last_ok() {
  local id
  id="$("$1" sync list --template '{{range .}}{{.Identifier}}{{end}}' "$2" 2>/dev/null)" || return 0
  [ -n "$id" ] && devbox_mtime "${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}/archives/$id"
}

# Mutagen keeps SuccessfulCycles in memory, so it restarts at 0 with the
# daemon; the socket's mtime marks that restart. Args: mutagen-bin.
devbox_mutagen_started() { devbox_mtime "${MUTAGEN_DATA_DIRECTORY:-$HOME/.mutagen}/daemon/daemon.sock"; }

devbox_sync_paused() { [ "$("$1" sync list --template '{{range .}}{{.Paused}}{{end}}' "$2" 2>/dev/null)" = true ]; }

# Seconds the session has stayed connected and not Watching without finishing a
# sync cycle. Measured across runs: the first run records the state, later ones
# compare. Any change in daemon identity, session identity, or cycle count is
# progress and restarts the clock. Fails unless all of that is known.
# Args: mutagen-bin name.
devbox_sync_stall_age() {
  local f id cyc a b s key seen first now
  f="${XDG_STATE_HOME:-$HOME/.local/state}/devbox/stall-$2"
  read -r s id cyc a b < <("$1" sync list --template '{{range .}}{{.Status}} {{.Identifier}} {{.SuccessfulCycles}} {{.Alpha.Connected}} {{.Beta.Connected}}{{end}}' "$2" 2>/dev/null)
  [ -n "$s" ] || return 1
  if [ "$s" = Watching ] || [ "$a $b" != "true true" ]; then
    rm -f "$f"
    return 1
  fi
  key="$(devbox_mutagen_started) $id $cyc"
  [ -n "$key" ] || return 1
  now="$(date +%s)"
  [ -f "$f" ] && IFS='|' read -r seen first <"$f"
  if [ "$seen" != "$key" ] || [ -z "$first" ]; then
    first="$now"
    mkdir -p "${f%/*}" && printf '%s|%s\n' "$key" "$first" >"$f"
  fi
  echo $((now - first))
}

# Waits for Watching, then prints the session's conflict and problem counts.
# Args: mutagen-bin name.
devbox_sync_wait() {
  local i=0
  until [ "$(devbox_sync_status "$1" "$2")" = Watching ]; do
    i=$((i + 1))
    [ "$i" -gt "${DEVBOX_SYNC_WAIT_TRIES:-360}" ] && {
      echo "devbox: sync '$2' is still not watching; see mutagen sync list $2" >&2
      return 1
    }
    sleep 5
  done
  "$1" sync list --template '{{range .}}sync '"'$2'"' watching: {{len .Conflicts}} conflict(s), {{len .Alpha.ScanProblems}}+{{len .Beta.ScanProblems}} scan problem(s){{end}}' "$2"
}

# --- Repair: converge both sides of a stalled sync before `sync reset`, so the
# --- new session (which has no history) starts with nothing in conflict. ------

# Portable file operations for either side (GNU or BSD userland), run by
# devbox_side. Paths keep their "./" so none reads as an option; names with a
# tab or newline are skipped. Hashing goes through stdin so no tool escapes a
# name. COPYFILE_DISABLE and --no-xattrs keep macOS tar from adding "._"
# entries and xattr headers that GNU tar on the other side warns about.
# Args: op root [op-args]; path lists arrive NUL-separated on stdin.
# shellcheck disable=SC2016  # expanded by the bash that runs it, on either side
DEVBOX_SIDE_OPS='
op=$1 root=$2; shift 2; cd "$root" || exit 1
export COPYFILE_DISABLE=1
if stat -c %Y . >/dev/null 2>&1; then mt() { stat -c %Y "$1"; }; else mt() { stat -f %m "$1"; }; fi
if command -v sha1sum >/dev/null; then h1() { sha1sum; }; else h1() { shasum -a 1; }; fi
tx=; tar --version 2>/dev/null | grep -q bsdtar && tx=--no-xattrs
case $op in
  list)
    cut=$1; shift
    ref=$(mktemp) || exit 1
    # A reference file, not a date string: -newer needs no per-side parsing, so
    # no timezone or DST ambiguity. mtime (not ctime) matches what Mutagen
    # itself treats as changed; ctime would flag every file Mutagen wrote here.
    touch -t "$(date -d "@$cut" +%Y%m%d%H%M.%S 2>/dev/null || date -r "$cut" +%Y%m%d%H%M.%S)" "$ref" || exit 1
    tab=$(printf "\t") nl=$(printf "\nx") nl=${nl%x}
    find . \( "$@" -o -name "*$tab*" -o -name "*$nl*" \) -prune -o -type f -print | sed "s/^/A /"
    find . \( "$@" -o -name "*$tab*" -o -name "*$nl*" \) -prune -o -type f -newer "$ref" -print | sed "s/^/C /"
    rm -f "$ref" ;;
  hash) while IFS= read -r -d "" f; do h=$(h1 <"$f") && printf "%s\t%s\n" "$f" "${h%% *}"; done ;;
  mtime) while IFS= read -r -d "" f; do t=$(mt "$f") && printf "%s\t%s\n" "$f" "$t"; done ;;
  bytes) xargs -0 wc -c | awk "\$2 != \"total\" { s += \$1 } END { print s + 0 }" ;;
  free) df -Pk . | awk "NR == 2 { print \$4 * 1024 }" ;;
  pack) tar -cf - $tx --no-recursion --null -T - ;;
  unpack) tar -xf - ;;
  backup) mkdir -p "$(dirname "$1")" && tar -czf "$1" $tx --no-recursion --null -T - ;;
esac'

# Args: local|remote op root [op-args].
devbox_side() {
  local where="$1"
  shift
  if [ "$where" = local ]; then
    bash -c "$DEVBOX_SIDE_OPS" _ "$@"
  else
    # shellcheck disable=SC2029  # the ops script and its args are quoted locally
    ssh -o LogLevel=ERROR "$DEVBOX_HOST" "bash -c $(printf '%q' "$DEVBOX_SIDE_OPS") _ $(printf '%q ' "$@")"
  fi
}

# find(1) prune predicates for the VCS dirs plus DEVBOX_IGNORES, into the
# DEVBOX_PRUNE array. Fails on a pattern find can't match the way Mutagen does.
devbox_prune_args() {
  local p core anchored dir
  DEVBOX_PRUNE=(-name .git -o -name .svn -o -name .hg -o -name .bzr -o -name _darcs)
  for p in "${DEVBOX_IGNORES[@]}"; do
    core="$p" anchored="" dir=""
    case "$core" in /*) anchored=1 core="${core#/}" ;; esac
    case "$core" in */) dir=1 core="${core%/}" ;; esac
    case "$core" in "" | */* | '!'* | *'**'*)
      echo "devbox: can't map ignore pattern '$p' to find; repair supports name, name/, /name" >&2
      return 1
      ;;
    esac
    DEVBOX_PRUNE+=(-o)
    [ -n "$dir" ] && DEVBOX_PRUNE+=(-type d)
    if [ -n "$anchored" ]; then DEVBOX_PRUNE+=(-path "./$core"); else DEVBOX_PRUNE+=(-name "$core"); fi
  done
}

# Input: {local,remote}.list ("A path" per file, "C path" if changed since the
# cutoff) and conflicts (paths Mutagen already reports, which predate the
# cutoff). Output: all-*, changed-*, only-*, candidates. Args: work-dir.
devbox_repair_candidates() {
  local w="$1" s
  for s in local remote; do
    sed -n 's/^A //p' "$w/$s.list" | LC_ALL=C sort -u >"$w/all-$s"
    sed -n 's/^C //p' "$w/$s.list" | LC_ALL=C sort -u >"$w/changed-$s"
  done
  LC_ALL=C comm -23 "$w/all-local" "$w/all-remote" >"$w/only-local"
  LC_ALL=C comm -13 "$w/all-local" "$w/all-remote" >"$w/only-remote"
  LC_ALL=C sort -u "$w/changed-local" "$w/changed-remote" "$w/conflicts" |
    LC_ALL=C comm -12 - <(LC_ALL=C comm -12 "$w/all-local" "$w/all-remote") >"$w/candidates"
}

# Input: {local,remote}.sha ("path<TAB>sha1") of the candidates. Output: same,
# pull, push, conflict. Args: work-dir.
devbox_repair_classify() {
  local w="$1" s tab
  tab="$(printf '\t')"
  for s in local remote; do LC_ALL=C sort -t "$tab" -k1,1 "$w/$s.sha" >"$w/$s.by-path"; done
  LC_ALL=C join -t "$tab" "$w/local.by-path" "$w/remote.by-path" >"$w/joined"
  awk -F "$tab" '$2 == $3 { print $1 }' "$w/joined" | LC_ALL=C sort >"$w/same"
  awk -F "$tab" '$2 != $3 { print $1 }' "$w/joined" | LC_ALL=C sort >"$w/differ"
  LC_ALL=C sort -u "$w/changed-local" "$w/conflicts" | LC_ALL=C comm -12 "$w/differ" - >"$w/differ-local"
  LC_ALL=C sort -u "$w/changed-remote" "$w/conflicts" | LC_ALL=C comm -12 "$w/differ" - >"$w/differ-remote"
  LC_ALL=C comm -12 "$w/differ-local" "$w/differ-remote" >"$w/conflict"
  LC_ALL=C comm -23 "$w/differ-local" "$w/differ-remote" >"$w/push"
  LC_ALL=C comm -13 "$w/differ-local" "$w/differ-remote" >"$w/pull"
}

# Moves conflicts into pull/push per prefer; what can't be decided (equal or
# unreadable mtimes under newest) stays. Args: work-dir prefer local-root remote-root.
devbox_repair_resolve() {
  local w="$1" tab s
  tab="$(printf '\t')"
  [ -s "$w/conflict" ] || return 0
  case "$2" in
    remote) cat "$w/conflict" >>"$w/pull" ;;
    local) cat "$w/conflict" >>"$w/push" ;;
    newest)
      tr '\n' '\0' <"$w/conflict" | devbox_side local mtime "$3" | LC_ALL=C sort -t "$tab" -k1,1 >"$w/mt-local"
      tr '\n' '\0' <"$w/conflict" | devbox_side remote mtime "$4" | LC_ALL=C sort -t "$tab" -k1,1 >"$w/mt-remote"
      LC_ALL=C join -t "$tab" "$w/mt-local" "$w/mt-remote" >"$w/mt"
      awk -F "$tab" '$3 > $2 { print $1 }' "$w/mt" >>"$w/pull"
      awk -F "$tab" '$2 > $3 { print $1 }' "$w/mt" >>"$w/push"
      ;;
  esac
  for s in pull push; do LC_ALL=C sort -u -o "$w/$s" "$w/$s"; done
  LC_ALL=C sort -u "$w/pull" "$w/push" | LC_ALL=C comm -23 "$w/conflict" - >"$w/conflict.left"
  mv "$w/conflict.left" "$w/conflict"
}

devbox_is_num() { case "$1" in "" | *[!0-9]*) return 1 ;; esac }

# Args: name message paused.
devbox_repair_abort() {
  echo "devbox: $2;${3:+ '$1' left paused,} backups listed above; re-run devbox sync repair $1 --apply" >&2
  return 1
}

# Plans (and with apply=1 performs) the convergence of one configured sync:
# a file changed on one side since the last completed sync wins; a file
# changed on both needs prefer. Every replaced copy is backed up on its own
# side first; the caller resets the session afterwards.
# Args: name apply prefer since-epoch(optional).
devbox_sync_repair() {
  local name="$1" apply="$2" prefer="$3" since="$4"
  local entry lpath remote rpath rhome mut cut last w s ts lbk rbk paused="" need free lpid rpid
  entry="$(devbox_syncs_list "$DEVBOX_CONFIG" | awk -F '|' -v n="$name" '$1 == n')"
  [ -n "$entry" ] || {
    echo "devbox: no sync named '$name' in $DEVBOX_CONFIG" >&2
    return 1
  }
  IFS='|' read -r _ lpath remote <<<"$entry"
  [ -d "$lpath" ] || {
    echo "devbox: local path missing: $lpath" >&2
    return 1
  }
  rhome="$(devbox_remote_home)" || return 1
  case "$remote" in /*) rpath="$remote" ;; *) rpath="$rhome/$remote" ;; esac
  lbk="${XDG_DATA_HOME:-$HOME/.local/share}/devbox-sync-backup"
  rbk="$rhome/.local/share/devbox-sync-backup"
  case "$lbk/" in "${lpath%/}"/*)
    echo "devbox: local backup dir $lbk is inside the synced folder; set XDG_DATA_HOME elsewhere" >&2
    return 1
    ;;
  esac
  case "$rbk/" in "${rpath%/}"/*)
    echo "devbox: remote backup dir $rbk is inside the synced folder" >&2
    return 1
    ;;
  esac
  mut="$(devbox_mutagen)"
  [ -n "$mut" ] || {
    echo "devbox: mutagen not installed" >&2
    return 1
  }
  if [ -n "$since" ]; then
    cut="$since"
  else
    last="$(devbox_sync_last_ok "$mut" "$name")"
    [ -n "$last" ] || {
      echo "devbox: no record of a completed sync for '$name'; pass --since <YYYY-MM-DD|epoch>" >&2
      return 1
    }
    cut=$((last - 3600)) # the last cycle scanned a while before it saved the archive
  fi
  devbox_prune_args || return 1
  w="$(mktemp -d)" || return 1
  # shellcheck disable=SC2064  # $w must expand now, not when the trap fires
  trap "rm -rf $(printf '%q' "$w")" RETURN

  # Plan against a paused session, so nothing it syncs can slip between the
  # plan and the copy.
  if [ -n "$apply" ] && [ -n "$(devbox_sync_status "$mut" "$name")" ]; then
    "$mut" sync pause "$name" >/dev/null 2>&1
    devbox_sync_paused "$mut" "$name" || {
      echo "devbox: could not pause '$name'; nothing changed" >&2
      return 1
    }
    paused=1
  fi
  # Paths Mutagen already flags: they differ, but may have changed before the
  # cutoff, so nothing else would list them.
  "$mut" sync list --template '{{range .}}{{range .Conflicts}}./{{.Root}}{{"\n"}}{{end}}{{end}}' "$name" 2>/dev/null |
    sed '/^\.\/$/d' | LC_ALL=C sort -u >"$w/conflicts"
  devbox_side local list "$lpath" "$cut" "${DEVBOX_PRUNE[@]}" >"$w/local.list" &
  lpid=$!
  devbox_side remote list "$rpath" "$cut" "${DEVBOX_PRUNE[@]}" </dev/null >"$w/remote.list" &
  rpid=$!
  wait "$lpid" && wait "$rpid" || {
    echo "devbox: could not list files on both sides; nothing changed" >&2
    [ -n "$paused" ] && "$mut" sync resume "$name" >/dev/null 2>&1
    return 1
  }
  devbox_repair_candidates "$w"
  : >"$w/local.sha" && : >"$w/remote.sha"
  if [ -s "$w/candidates" ]; then
    tr '\n' '\0' <"$w/candidates" >"$w/candidates0"
    devbox_side local hash "$lpath" <"$w/candidates0" >"$w/local.sha" &
    lpid=$!
    devbox_side remote hash "$rpath" <"$w/candidates0" >"$w/remote.sha" &
    rpid=$!
    wait "$lpid" && wait "$rpid" || {
      echo "devbox: could not hash the changed files; nothing changed" >&2
      [ -n "$paused" ] && "$mut" sync resume "$name" >/dev/null 2>&1
      return 1
    }
  fi
  for s in local remote; do
    [ "$(devbox_lines "$w/$s.sha")" = "$(devbox_lines "$w/candidates")" ] || {
      echo "devbox: could not read every changed file on the $s side; nothing changed" >&2
      [ -n "$paused" ] && "$mut" sync resume "$name" >/dev/null 2>&1
      return 1
    }
  done
  devbox_repair_classify "$w"
  [ -n "$prefer" ] && devbox_repair_resolve "$w" "$prefer" "$lpath" "$rpath"

  echo "sync '$name': checking changes since $(date -r "$cut" 2>/dev/null || date -d "@$cut")"
  printf '  %-18s %8s  %s\n' \
    "only local" "$(devbox_lines "$w/only-local")" "copied up by the new session" \
    "only remote" "$(devbox_lines "$w/only-remote")" "copied down by the new session" \
    "identical" "$(devbox_lines "$w/same")" "changed, but already the same" \
    "local wins" "$(devbox_lines "$w/push")" "copied up now (remote copy backed up)" \
    "remote wins" "$(devbox_lines "$w/pull")" "copied down now (local copy backed up)" \
    "changed on both" "$(devbox_lines "$w/conflict")" "needs --prefer newest|local|remote"
  if [ -s "$w/conflict" ]; then
    sed 's|^\./|    |' "$w/conflict" | head -10
    [ "$(devbox_lines "$w/conflict")" -gt 10 ] && echo "    … $(($(devbox_lines "$w/conflict") - 10)) more"
  fi
  [ -n "$apply" ] || {
    echo "dry run: nothing changed; re-run with --apply"
    return 0
  }
  if [ -s "$w/conflict" ]; then
    echo "devbox: $(devbox_lines "$w/conflict") file(s) changed on both sides; re-run with --prefer newest|local|remote" >&2
    [ -n "$paused" ] && "$mut" sync resume "$name" >/dev/null 2>&1
    return 1
  fi
  tr '\n' '\0' <"$w/pull" >"$w/pull0" && tr '\n' '\0' <"$w/push" >"$w/push0"
  cat "$w/only-remote" "$w/pull" | tr '\n' '\0' >"$w/in"
  cat "$w/only-local" "$w/push" | tr '\n' '\0' >"$w/out"
  for s in local remote; do
    if [ "$s" = local ]; then
      need=$(($(devbox_side remote bytes "$rpath" <"$w/in") + $(devbox_side local bytes "$lpath" <"$w/pull0")))
      free="$(devbox_side local free "$lpath")"
    else
      need=$(($(devbox_side local bytes "$lpath" <"$w/out") + $(devbox_side remote bytes "$rpath" <"$w/push0")))
      free="$(devbox_side remote free "$rpath" </dev/null)"
    fi
    devbox_is_num "$free" && [ "$need" -lt "$free" ] || {
      echo "devbox: not enough $s disk (need $need bytes, free ${free:-unknown}); nothing changed" >&2
      [ -n "$paused" ] && "$mut" sync resume "$name" >/dev/null 2>&1
      return 1
    }
  done

  ts="$(date +%Y%m%d-%H%M%S)"
  if [ -s "$w/pull" ]; then
    s="$lbk/$name-$ts-local.tar.gz"
    devbox_side local backup "$lpath" "$s" <"$w/pull0" || devbox_repair_abort "$name" "local backup failed" "$paused" || return 1
    echo "✓ backed up $(devbox_lines "$w/pull") local file(s): $s"
    devbox_side remote pack "$rpath" <"$w/pull0" >"$w/pull.tar" &&
      devbox_side local unpack "$lpath" <"$w/pull.tar" ||
      devbox_repair_abort "$name" "copying files down failed" "$paused" || return 1
  fi
  if [ -s "$w/push" ]; then
    s="$rbk/$name-$ts-remote.tar.gz"
    devbox_side remote backup "$rpath" "$s" <"$w/push0" || devbox_repair_abort "$name" "remote backup failed" "$paused" || return 1
    echo "✓ backed up $(devbox_lines "$w/push") remote file(s): $DEVBOX_HOST:$s"
    devbox_side local pack "$lpath" <"$w/push0" >"$w/push.tar" &&
      devbox_side remote unpack "$rpath" <"$w/push.tar" ||
      devbox_repair_abort "$name" "copying files up failed" "$paused" || return 1
  fi
  LC_ALL=C sort -u "$w/pull" "$w/push" | tr '\n' '\0' >"$w/copied"
  if [ -s "$w/copied" ] && [ "$(devbox_side local hash "$lpath" <"$w/copied" | LC_ALL=C sort)" != "$(devbox_side remote hash "$rpath" <"$w/copied" | LC_ALL=C sort)" ]; then
    devbox_repair_abort "$name" "files changed during the copy" "$paused" || return 1
  fi
}

# --- Config mutation (pure: operate on a file, no network). These are the
# --- functions the bats tests exercise directly. -----------------------------

# List sync entries from a config file, one "name|local|remote" per line.
# Args: config-path. Prints nothing if the file has no DEVBOX_SYNCS.
devbox_syncs_list() {
  local cfg="$1"
  [ -f "$cfg" ] || return 0
  local syncs
  # shellcheck source=/dev/null
  syncs="$(
    set +u
    . "$cfg" 2>/dev/null
    printf '%s' "${DEVBOX_SYNCS:-}"
  )"
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
  local cfg="$1" pwd_path="$2" rhome="$3" entry l r rpath
  entry="$(devbox_sync_for "$cfg" "$pwd_path")"
  [ -n "$entry" ] || return 0
  IFS='|' read -r _ l r <<<"$entry"
  case "$r" in /*) rpath="$r" ;; *) rpath="$rhome/$r" ;; esac
  printf '%s' "$rpath${pwd_path#"$l"}"
}

# Prints the "name|local|remote" entry whose root is or contains local-path.
# The / boundary keeps Workshop out of Work. Args: cfg  local-path.
devbox_sync_for() {
  local n l r
  while IFS='|' read -r n l r; do
    [ -n "$l" ] || continue
    case "$2" in "$l" | "$l"/*)
      printf '%s|%s|%s' "$n" "$l" "$r"
      return 0
      ;;
    esac
  done < <(devbox_syncs_list "$1")
  return 0
}

# Compact relative time. Args: now-epoch then-epoch. Prints 30s/5m/3h/2d.
devbox_ago() {
  local d=$(($1 - $2))
  [ "$d" -lt 0 ] && d=0
  if [ "$d" -lt 60 ]; then
    printf '%ds' "$d"
  elif [ "$d" -lt 3600 ]; then
    printf '%dm' $((d / 60))
  elif [ "$d" -lt 86400 ]; then
    printf '%dh' $((d / 3600))
  else printf '%dd' $((d / 86400)); fi
}

# Merge a tmux status probe (stdin) into one line per session:
#   name|attached|activity|bell|cmd|path
# Probe format (see `devbox status`): S|name|attached|activity  for sessions,
# P|session|win_active|pane_active|bell|cmd|path  for panes. The "current"
# pane of a session is the active pane of its active window; bell is 1 if ANY
# window in the session has its bell flag set (needs attention).
devbox_status_lines() {
  awk -F'|' '
    $1 == "S" { order[++n] = $2; att[$2] = $3; act[$2] = $4 }
    $1 == "P" && $5 == 1 { bell[$2] = 1 }
    $1 == "P" && $3 == 1 && $4 == 1 { cmd[$2] = $6; path[$2] = $7 }
    END {
      for (i = 1; i <= n; i++) {
        s = order[i]
        printf "%s|%s|%s|%d|%s|%s\n", s, att[s], act[s], bell[s], cmd[s], path[s]
      }
    }'
}

# Add an entry to DEVBOX_SYNCS in the config file. Args: cfg name local remote.
# Backup → temp edit → validate (sources cleanly AND entry present) → atomic
# swap. On validation failure the original is left untouched. Returns non-zero
# on bad input, duplicate, or failed validation.
devbox_config_add() {
  local cfg="$1" name="$2" local_path="$3" remote="$4"
  [ -n "$name" ] && [ -n "$local_path" ] && [ -n "$remote" ] || {
    echo "devbox: add needs name/local/remote" >&2
    return 2
  }
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "devbox: name must match [A-Za-z0-9_-]" >&2
    return 2
  }
  [ -f "$cfg" ] || {
    echo "devbox: no config at $cfg" >&2
    return 2
  }
  devbox_sync_exists "$cfg" "$name" && {
    echo "devbox: sync '$name' already exists" >&2
    return 3
  }

  cp "$cfg" "$cfg.bak"
  local tmp
  tmp="$(mktemp)"
  if grep -q '^DEVBOX_SYNCS=' "$cfg"; then
    # Insert before the line that closes the DEVBOX_SYNCS="..." block.
    awk -v line="$name|$local_path|$remote" '
      /^DEVBOX_SYNCS=/ {insync=1}
      insync && NR>1 && /^"[[:space:]]*$/ {print line; insync=0}
      {print}
    ' "$cfg" >"$tmp"
  else
    cp "$cfg" "$tmp"
    printf '\nDEVBOX_SYNCS="\n%s\n"\n' "$name|$local_path|$remote" >>"$tmp"
  fi
  # Validate: parses AND sources AND contains the new entry.
  # shellcheck source=/dev/null
  if bash -n "$tmp" 2>/dev/null && (
    set +u
    . "$tmp" 2>/dev/null
    printf '%s' "${DEVBOX_SYNCS:-}" | grep -q "^$name|"
  ); then
    mv "$tmp" "$cfg"
    return 0
  fi
  rm -f "$tmp"
  echo "devbox: config edit failed validation, left unchanged (backup: $cfg.bak)" >&2
  return 1
}

# Remove an entry from DEVBOX_SYNCS. Args: cfg name. Same backup/validate dance.
devbox_config_rm() {
  local cfg="$1" name="$2"
  [ -n "$name" ] || {
    echo "devbox: rm needs a name" >&2
    return 2
  }
  [ -f "$cfg" ] || {
    echo "devbox: no config at $cfg" >&2
    return 2
  }
  devbox_sync_exists "$cfg" "$name" || {
    echo "devbox: no sync named '$name'" >&2
    return 3
  }
  cp "$cfg" "$cfg.bak"
  local tmp
  tmp="$(mktemp)"
  grep -v "^$name|" "$cfg" >"$tmp"
  if bash -n "$tmp" 2>/dev/null; then
    mv "$tmp" "$cfg"
    return 0
  fi
  rm -f "$tmp"
  echo "devbox: edit failed, unchanged (backup: $cfg.bak)" >&2
  return 1
}
