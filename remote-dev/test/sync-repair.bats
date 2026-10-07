#!/usr/bin/env bats
# Tests for stall detection (doctor, connect) and `devbox sync repair`. The ssh
# stub runs the "remote" command here, so the remote side is a second local dir
# and repair exercises the same portable side operations on both.
#
# Run:  bats remote-dev/test/          (bats-core)

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"
  DEVBOX_CONFIG=/nonexistent . "$BATS_TEST_DIRNAME/../lib.sh"
  T="$BATS_TEST_TMPDIR"
  STUBS="$T/stubs" LOCAL="$T/local" REMOTE="$T/remote"
  export CALLS="$T/calls"
  mkdir -p "$STUBS" "$T/home" "$LOCAL" "$REMOTE"
  : >"$CALLS"
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
while [ "${1#-}" != "$1" ]; do case "$1" in -o) shift 2 ;; *) shift ;; esac; done
shift
printf 'ssh %.60s\n' "$*" >>"$CALLS"
exec bash -c "$*"
SH
  printf '#!/bin/bash\necho "mosh $*"\n' >"$STUBS/mosh"
  # One session, "proj". Status is $MUT_STATUS until the session is recreated.
  cat >"$STUBS/mutagen" <<'SH'
#!/bin/bash
echo "mutagen $*" >>"$CALLS"
state="$CALLS.state"
case "$1 $2" in
  "sync pause") [ -n "${MUT_PAUSE_FAIL:-}" ] && exit 1; echo paused >"$state" ;;
  "sync resume") echo resumed >"$state" ;;
  "sync terminate") echo gone >"$state" ;;
  "sync create") echo created >"$state" ;;
  "sync list")
    grep -qx gone "$state" 2>/dev/null && exit 1
    case "$*" in
      *Status*[\ ]*Identifier*) echo "${MUT_STATUS:-Watching} sess-1 ${MUT_CYCLES:-3} ${MUT_CONN:-true} ${MUT_CONN:-true}" ;;
      *.Conflicts*Root*) printf '%s' "${MUT_CONFLICTS:-}" ;;
      *Identifier*) echo sess-1 ;;
      *Ignore.Paths*) printf '%s\n' "$MUT_IGNORES" ;;
      *Paused*) grep -qx paused "$state" 2>/dev/null && echo true || echo false ;;
      *Conflicts*) echo "sync 'proj' watching: 0 conflict(s), 0+0 scan problem(s)" ;;
      *Status*) grep -qx created "$state" 2>/dev/null && echo Watching || echo "${MUT_STATUS:-Watching}" ;;
      *) printf 'Alpha:\n  Connected: Yes\nBeta:\n  Connected: Yes\nStatus: %s\n' "${MUT_STATUS:-Watching}" ;;
    esac
    ;;
esac
exit 0
SH
  chmod +x "$STUBS"/*
  export PATH="$STUBS:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$T/home"
  MUT_IGNORES="$(printf '%s\n' "${DEVBOX_IGNORES[@]}")"
  export MUT_IGNORES DEVBOX_CONFIG="$T/config" DEVBOX_SYNC_WAIT_TRIES=3
  cat >"$DEVBOX_CONFIG" <<EOF
DEVBOX_HOST="stub-host"
DEVBOX_SYNCS="
proj|$LOCAL|$REMOTE
"
EOF
  NOW="$(date +%s)"
  STALL="$HOME/.local/state/devbox/stall-proj"
  mkdir -p "$HOME/.mutagen/archives" "$HOME/.mutagen/daemon"
  stamp "$HOME/.mutagen/archives/sess-1" $((NOW - 2 * 86400))
  : >"$HOME/.mutagen/daemon/daemon.sock"
  stamp "$HOME/.mutagen/daemon/daemon.sock" $((NOW - 3 * 86400))
  DKEY="$((NOW - 3 * 86400)) sess-1 3"
}

teardown() { chmod -R u+w "$T" 2>/dev/null || true; }

# Sets a file's mtime to an epoch, portably. Args: path epoch.
stamp() { touch -t "$(date -d "@$2" +%Y%m%d%H%M.%S 2>/dev/null || date -r "$2" +%Y%m%d%H%M.%S)" "$1"; }

# Writes content with an mtime. Args: path content epoch.
put() {
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" >"$1"
  stamp "$1" "$3"
}

# "old" files predate SINCE, "new" ones follow it.
diverge() {
  local old=$((NOW - 5 * 86400)) new=$((NOW - 3600))
  SINCE=$((NOW - 2 * 86400))
  put "$LOCAL/same.txt" same "$old"
  put "$REMOTE/same.txt" same "$old"
  put "$LOCAL/pull.txt" v1 "$old"
  put "$REMOTE/push.txt" v1 "$old"
  put "$REMOTE/app/node_modules/x.js" remote-ignored "$old"
  put "$LOCAL/eq.txt" eq "$new"
  put "$REMOTE/eq.txt" eq "$new"
  put "$REMOTE/pull.txt" v2-remote "$new"
  put "$LOCAL/push.txt" v2-local "$new"
  put "$LOCAL/both.txt" L "$((new - 60))"
  put "$REMOTE/both.txt" R "$new"
  put "$LOCAL/up.txt" up "$new"
  put "$REMOTE/down.txt" down "$new"
  put "$REMOTE/build/out.o" ignored "$new"
  put "$LOCAL/app/node_modules/x.js" local-ignored "$new"
}

refute_called() { ! grep -q "$@" "$CALLS"; }

@test "repair dry run: plans every category, skips ignored trees, changes nothing" {
  diverge
  run "$DEVBOX" sync repair proj --since "$SINCE"
  [ "$status" -eq 0 ]
  [[ "$output" =~ only\ local\ +1\  ]]
  [[ "$output" =~ only\ remote\ +1\  ]]
  [[ "$output" =~ identical\ +1\  ]]
  [[ "$output" =~ local\ wins\ +1\  ]]
  [[ "$output" =~ remote\ wins\ +1\  ]]
  [[ "$output" =~ changed\ on\ both\ +1\  ]]
  [[ "$output" == *"    both.txt"* ]]
  [[ "$output" == *"dry run: nothing changed"* ]]
  [ "$(cat "$LOCAL/pull.txt")" = v1 ]
  [ "$(cat "$REMOTE/push.txt")" = v1 ]
  refute_called -e 'sync pause' -e 'sync terminate'
}

@test "repair --apply refuses while files changed on both sides, and resumes the session" {
  diverge
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply
  [ "$status" -eq 1 ]
  [[ "$output" == *"1 file(s) changed on both sides; re-run with --prefer"* ]]
  [ "$(cat "$LOCAL/pull.txt")" = v1 ]
  grep -q 'sync resume proj' "$CALLS"
  refute_called 'sync terminate'
}

@test "repair --apply --prefer newest converges, backs up the losers, then resets" {
  diverge
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer newest
  [ "$status" -eq 0 ]
  [ "$(cat "$LOCAL/pull.txt")" = v2-remote ]
  [ "$(cat "$REMOTE/push.txt")" = v2-local ]
  [ "$(cat "$LOCAL/both.txt")" = R ]
  [ "$(cat "$REMOTE/both.txt")" = R ]
  [ "$(cat "$LOCAL/app/node_modules/x.js")" = local-ignored ]
  [ "$(cat "$REMOTE/app/node_modules/x.js")" = remote-ignored ]
  [ ! -e "$LOCAL/build" ]
  [ "$(tar -tzf "$HOME"/.local/share/devbox-sync-backup/proj-*-local.tar.gz | sort | tr '\n' ' ')" = "./both.txt ./pull.txt " ]
  [ "$(tar -tzf "$HOME"/.local/share/devbox-sync-backup/proj-*-remote.tar.gz)" = ./push.txt ]
  [ -z "$(find "$REMOTE" -name '._*')" ]
  pause="$(grep -n 'sync pause proj' "$CALLS" | cut -d: -f1)"
  term="$(grep -n 'sync terminate proj' "$CALLS" | cut -d: -f1)"
  create="$(grep -n 'sync create --name=proj' "$CALLS" | cut -d: -f1)"
  [ -n "$pause" ]
  [ "$pause" -lt "$term" ]
  [ "$term" -lt "$create" ]
  [[ "$output" == *"✓ backed up 2 local file(s)"* ]]
  [[ "$output" == *"sync 'proj' watching: 0 conflict(s)"* ]]
}

@test "repair --prefer remote sends both-side changes toward the remote copy" {
  diverge
  put "$LOCAL/both.txt" L "$NOW"
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer remote
  [ "$status" -eq 0 ]
  [ "$(cat "$LOCAL/both.txt")" = R ]
}

@test "repair handles names with a leading dash, a backslash, or spaces" {
  local n
  SINCE=$((NOW - 3600))
  for n in "-dash.txt" 'back\slash.txt' "with space.txt"; do
    put "$LOCAL/$n" old "$((NOW - 86400))"
    put "$REMOTE/$n" new "$NOW"
  done
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply
  [ "$status" -eq 0 ]
  [[ "$output" =~ remote\ wins\ +3\  ]]
  for n in "-dash.txt" 'back\slash.txt' "with space.txt"; do [ "$(cat "$LOCAL/$n")" = new ]; done
}

@test "repair --apply changes nothing when the session can't be paused" {
  diverge
  MUT_PAUSE_FAIL=1 run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer newest
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not pause 'proj'; nothing changed"* ]]
  [ "$(cat "$LOCAL/pull.txt")" = v1 ]
}

@test "repair failing mid-copy leaves the session paused and says how to continue" {
  diverge
  mkdir "$LOCAL/locked"
  put "$LOCAL/locked/f.txt" v1 "$((NOW - 5 * 86400))"
  put "$REMOTE/locked/f.txt" v2 "$((NOW - 3600))"
  chmod a-w "$LOCAL/locked"
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer newest
  [ "$status" -eq 1 ]
  [[ "$output" == *"✓ backed up"* ]]
  [[ "$output" == *"'proj' left paused"*"re-run devbox sync repair proj --apply"* ]]
  refute_called -e 'sync resume' -e 'sync terminate'
}

@test "repair --since takes a date as local midnight" {
  run "$DEVBOX" sync repair proj --since 2026-01-02
  [ "$status" -eq 0 ]
  [[ "$output" == *"checking changes since"*"00:00:00"* ]]
}

@test "repair rejects an option missing its value" {
  run "$DEVBOX" sync repair proj --prefer
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage: devbox sync repair"* ]]
}

@test "repair refuses to put backups inside the synced folder" {
  XDG_DATA_HOME="$LOCAL/.share" run "$DEVBOX" sync repair proj --since "$NOW"
  [ "$status" -eq 1 ]
  [[ "$output" == *"backup dir"*"inside the synced folder"* ]]
}

@test "repair without a completed-sync record asks for --since" {
  rm "$HOME/.mutagen/archives/sess-1"
  run "$DEVBOX" sync repair proj
  [ "$status" -eq 1 ]
  [[ "$output" == *"pass --since"* ]]
}

@test "repair refuses ignore patterns find can't match like Mutagen" {
  DEVBOX_IGNORES=("docs/*.tmp")
  run devbox_prune_args
  [ "$status" -eq 1 ]
  [[ "$output" == *"can't map ignore pattern 'docs/*.tmp'"* ]]
}

@test "doctor: a sync first seen not watching only warns" {
  MUT_STATUS=Scanning DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" == *"sync 'proj' not watching"*"last change synced 2d ago"* ]]
  [[ "$output" != *"sync 'proj' stalled"* ]]
  [ -f "$STALL" ]
}

@test "doctor: not watching on the same cycle count for over an hour is stalled" {
  mkdir -p "${STALL%/*}"
  echo "$DKEY|$((NOW - 7200))" >"$STALL"
  MUT_STATUS=Scanning DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" == *"sync 'proj' stalled: no sync cycle completed in 2h; last change synced 2d ago"*"devbox sync repair proj"* ]]
}

@test "doctor: a busy sync that keeps completing cycles is not stalled" {
  mkdir -p "${STALL%/*}"
  echo "$((NOW - 3 * 86400)) sess-1 2|$((NOW - 7200))" >"$STALL"
  MUT_CYCLES=3 MUT_STATUS=Scanning DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" != *"sync 'proj' stalled"* ]]
  [[ "$output" == *"sync 'proj' not watching"* ]]
}

@test "doctor: a watching sync is fine however old its last change, and clears the record" {
  stamp "$HOME/.mutagen/archives/sess-1" $((NOW - 90 * 86400))
  mkdir -p "${STALL%/*}"
  echo "$DKEY|$((NOW - 7200))" >"$STALL"
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" != *"sync 'proj' stalled"* ]]
  [[ "$output" != *"sync 'proj' not watching"* ]]
  [ ! -e "$STALL" ]
}

@test "connect: a stalled sync warns with the repair command" {
  mkdir -p "${STALL%/*}"
  echo "$DKEY|$((NOW - 7200))" >"$STALL"
  cd "$LOCAL"
  MUT_STATUS=Scanning DEVBOX_TRANSPORT=mosh run "$DEVBOX" main
  [ "$status" -eq 0 ]
  [[ "$output" == *"devbox: sync 'proj' stalled: no sync cycle completed in 2h; devbox sync repair proj"* ]]
}

@test "repair refuses when a changed file can't be read on one side" {
  [ "$(id -u)" -ne 0 ] || skip "root reads everything"
  diverge
  chmod 000 "$REMOTE/pull.txt"
  run "$DEVBOX" sync repair proj --since "$SINCE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not read every changed file on the remote side; nothing changed"* ]]
}

@test "pack never adds macOS AppleDouble entries" {
  command -v xattr >/dev/null || skip "no xattr(1)"
  put "$LOCAL/x.txt" x "$NOW"
  xattr -w com.example.test 1 "$LOCAL/x.txt"
  # bsdtar's own listing hides the "._" entries it writes; the raw bytes don't.
  printf './x.txt\0' | devbox_side local pack "$LOCAL" >"$T/x.tar"
  LC_ALL=C grep -a -q 'x\.txt' "$T/x.tar"
  ! LC_ALL=C grep -a -q '\._x\.txt' "$T/x.tar"
}

@test "doctor: a daemon restart restarts the stall clock" {
  mkdir -p "${STALL%/*}"
  echo "$((NOW - 9 * 86400)) sess-1 3|$((NOW - 7200))" >"$STALL"
  MUT_STATUS=Scanning DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" != *"sync 'proj' stalled"* ]]
  [[ "$output" == *"sync 'proj' not watching"* ]]
  [[ "$(cat "$STALL")" == "$DKEY|"* ]]
  [ "$(( $(date +%s) - $(cut -d'|' -f2 <"$STALL") ))" -lt 5 ]
}

@test "doctor: a disconnected sync is not called stalled, and the record is dropped" {
  mkdir -p "${STALL%/*}"
  echo "$DKEY|$((NOW - 7200))" >"$STALL"
  MUT_CONN=false MUT_STATUS=Connecting DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor
  [[ "$output" != *"sync 'proj' stalled"* ]]
  [ ! -e "$STALL" ]
}

@test "repair reports a conflict Mutagen already knows about, even from before the cutoff" {
  put "$LOCAL/old-conflict.txt" L "$((NOW - 9 * 86400))"
  put "$REMOTE/old-conflict.txt" R "$((NOW - 9 * 86400))"
  MUT_CONFLICTS="./old-conflict.txt" run "$DEVBOX" sync repair proj --since "$((NOW + 60))"
  [ "$status" -eq 0 ]
  [[ "$output" =~ changed\ on\ both\ +1\  ]]
  [[ "$output" == *"    old-conflict.txt"* ]]
}

@test "repair --prefer resolves a known conflict from before the cutoff" {
  put "$LOCAL/old-conflict.txt" L "$((NOW - 9 * 86400))"
  put "$REMOTE/old-conflict.txt" R "$((NOW - 9 * 86400))"
  MUT_CONFLICTS="./old-conflict.txt" run "$DEVBOX" sync repair proj --since "$((NOW + 60))" --apply --prefer remote
  [ "$status" -eq 0 ]
  [ "$(cat "$LOCAL/old-conflict.txt")" = R ]
}

@test "repair blames the sending side when it can't read a file being copied" {
  diverge
  chmod 000 "$REMOTE/pull.txt"
  MUT_CONFLICTS="" run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer newest
  [ "$status" -eq 1 ]
  [[ "$output" != *"files changed during the copy"* ]]
}

@test "repair says the sync isn't syncing when the reset fails afterwards" {
  diverge
  cat >"$STUBS/mutagen" <<'SH'
#!/bin/bash
echo "mutagen $*" >>"$CALLS"
state="$CALLS.state"
case "$1 $2" in
  "sync pause") echo paused >"$state" ;;
  "sync terminate") echo gone >"$state" ;;
  "sync create") exit 1 ;;
  "sync list")
    grep -qx gone "$state" 2>/dev/null && exit 1
    case "$*" in
      *Status*[\ ]*Identifier*) echo "Scanning sess-1 3 true true" ;;
      *Identifier*) echo sess-1 ;;
      *Paused*) grep -qx paused "$state" 2>/dev/null && echo true || echo false ;;
      *Ignore.Paths*) printf '%s\n' "$MUT_IGNORES" ;;
      *) : ;;
    esac
    ;;
esac
exit 0
SH
  chmod +x "$STUBS/mutagen"
  run "$DEVBOX" sync repair proj --since "$SINCE" --apply --prefer newest
  [ "$status" -eq 1 ]
  [[ "$output" == *"recreating 'proj' failed"* ]]
  [[ "$output" == *"both sides match but the session was not recreated"*"is not syncing until devbox sync reset proj succeeds"* ]]
}

@test "pack fails loudly when a listed file can't be read, so the copy guard trips" {
  put "$LOCAL/gone.txt" x "$NOW"
  rm "$LOCAL/gone.txt"
  run devbox_side local pack "$LOCAL" <<<"$(printf './gone.txt\0')"
  [ "$status" -ne 0 ]
}
