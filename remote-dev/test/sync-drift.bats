#!/usr/bin/env bats
# Tests for stale-ignore detection, `devbox sync reset`, and the connect-time
# remote mkdir + warning. ssh/mosh/nc/mutagen are PATH stubs logging to $CALLS.
#
# Run:  bats remote-dev/test/          (bats-core)

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"
  DEVBOX_CONFIG=/nonexistent . "$BATS_TEST_DIRNAME/../lib.sh"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  mkdir -p "$STUBS" "$BATS_TEST_TMPDIR/home"
  : >"$CALLS"
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
echo "ssh $*" >>"$CALLS"
[ -n "${SSH_BANNER:-}" ] && echo "$SSH_BANNER"
[ "${SSH_EXIT:-0}" -eq 0 ] && [[ "$*" == *has-session* ]] && [ -z "${TMUX_RUNNING:-}" ] && echo created
exit "${SSH_EXIT:-0}"
SH
  printf '#!/bin/bash\necho "mosh $*"\n' >"$STUBS/mosh"
  printf '#!/bin/bash\nexit 0\n' >"$STUBS/nc"
  cat >"$STUBS/mutagen" <<'SH'
#!/bin/bash
echo "mutagen $*" >>"$CALLS"
name="${!#}"
case "$1 $2" in
  "sync terminate")
    [ -n "${MUT_TERM_FAIL:-}" ] && exit 1
    echo "$name" >>"$CALLS.gone"
    ;;
  "sync list")
    [[ " ${MUT_SESSIONS:-} " == *" $name "* ]] || exit 1
    grep -qx "$name" "$CALLS.gone" 2>/dev/null && exit 1
    case "$*" in
      *Ignore.Paths*)
        if [[ " ${MUT_STALE:-} " == *" $name "* ]]; then
          printf '%s\n' "$MUT_OLD_IGNORES"
        else
          printf '%s\n\n' "$MUT_IGNORES" # real mutagen adds a trailing blank
        fi
        ;;
      *Status*) echo "${MUT_STATUS:-Watching}" ;;
    esac
    ;;
esac
exit 0
SH
  chmod +x "$STUBS"/*
  export PATH="$STUBS:/usr/bin:/bin"
  export HOME="$BATS_TEST_TMPDIR/home"
  MUT_IGNORES="$(printf '%s\n' "${DEVBOX_IGNORES[@]}")"
  MUT_OLD_IGNORES="$(printf '%s\n' "${DEVBOX_IGNORES[@]}" | grep -v -e build -e env/)"
  export MUT_IGNORES MUT_OLD_IGNORES

  ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$ROOT/app" "$BATS_TEST_TMPDIR/other"
  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  cat >"$DEVBOX_CONFIG" <<EOF
DEVBOX_HOST="stub-host"
DEVBOX_REMOTE_HOME="/home/stub"
DEVBOX_SYNCS="
work|$ROOT|work
other|$BATS_TEST_TMPDIR/other|other
gone|$BATS_TEST_TMPDIR/missing|gone
"
EOF
}

# `! cmd` mid-test never fails a bats test (set -e ignores negation); a
# function returning the negated status does.
refute_called() { ! grep -q "$@" "$CALLS"; }

@test "stale: a missing session is not stale (nothing to reset)" {
  run devbox_sync_stale mutagen work
  [ "$status" -eq 1 ]
}

@test "stale: current ignores (plus mutagen's trailing blank) are not stale" {
  MUT_SESSIONS=work run devbox_sync_stale mutagen work
  [ "$status" -eq 1 ]
}

@test "stale: a session created with an older ignore list is stale" {
  MUT_SESSIONS=work MUT_STALE=work run devbox_sync_stale mutagen work
  [ "$status" -eq 0 ]
}

@test "reset <name>: terminates, then recreates with the current ignores" {
  MUT_SESSIONS="work other" run "$DEVBOX" sync reset work
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ sync 'work' recreated"* ]]
  [[ "$output" == *"Nothing is deleted."* ]]
  grep -q 'mutagen sync terminate work' "$CALLS"
  grep -q 'mutagen sync create --name=work' "$CALLS"
  term="$(grep -n 'mutagen sync terminate work' "$CALLS" | cut -d: -f1)"
  create="$(grep -n 'mutagen sync create --name=work' "$CALLS" | cut -d: -f1)"
  [ "$term" -lt "$create" ]
  grep -q -- "--ignore=build/ --ignore=/build --ignore=env/ $ROOT stub-host:/home/stub/work" "$CALLS"
  refute_called 'terminate other'
}

@test "reset --stale: only stale sessions are recreated; missing ones are named" {
  MUT_SESSIONS="work other" MUT_STALE=work run "$DEVBOX" sync reset --stale
  [ "$status" -eq 0 ]
  grep -q 'mutagen sync create --name=work' "$CALLS"
  refute_called -e 'terminate other' -e 'create --name=other' -e 'create --name=gone'
  [[ "$output" == *"sync 'gone' has no session; devbox sync reset gone creates it"* ]]
}

@test "reset --stale: nothing stale is a no-op" {
  MUT_SESSIONS="work other gone" run "$DEVBOX" sync reset --stale
  [ "$status" -eq 0 ]
  [ "$output" = "No stale syncs." ]
  refute_called -e terminate -e create -e '^ssh'
}

@test "reset: unknown name fails without touching any session" {
  MUT_SESSIONS="work" run "$DEVBOX" sync reset nope
  [ "$status" -eq 1 ]
  [[ "$output" == *"no sync named 'nope'"* ]]
  refute_called terminate
}

@test "reset: unreachable host aborts before terminating anything" {
  MUT_SESSIONS="work" SSH_EXIT=255 run "$DEVBOX" sync reset work
  [ "$status" -eq 1 ]
  [[ "$output" == *"cannot reach stub-host; nothing reset"* ]]
  refute_called terminate
}

@test "reset: a missing local folder leaves the old session alone" {
  MUT_SESSIONS="gone" MUT_STALE=gone run "$DEVBOX" sync reset gone
  [ "$status" -eq 1 ]
  [[ "$output" == *"local path missing: $BATS_TEST_TMPDIR/missing; 'gone' left as is"* ]]
  refute_called -e terminate -e create
}

@test "reset: a session that survives terminate is not duplicated" {
  MUT_SESSIONS="work" MUT_TERM_FAIL=1 run "$DEVBOX" sync reset work
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not terminate 'work'; not recreated"* ]]
  refute_called create
}

@test "connect: creates the remote folder and stays quiet when the sync is healthy" {
  cd "$ROOT/app"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" app
  [ "$status" -eq 0 ]
  grep -q "BatchMode=yes stub-host tmux has-session -t '='app 2>/dev/null || { mkdir -p /home/stub/work/app && echo created; }" "$CALLS"
  [[ "$output" == *"mosh stub-host -- tmux new-session -A -s app -c /home/stub/work/app"* ]]
  [[ "$output" != *"devbox: "* ]]
}

@test "connect: a stale sync warns with the reset command" {
  cd "$ROOT/app"
  MUT_SESSIONS=work MUT_STALE=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" app
  [ "$status" -eq 0 ]
  [[ "$output" == *"devbox: sync 'work' has stale ignores; devbox sync reset work"* ]]
}

@test "connect: a sync that isn't watching warns" {
  cd "$ROOT/app"
  MUT_SESSIONS=work MUT_STATUS=Scanning DEVBOX_TRANSPORT=mosh run "$DEVBOX" app
  [ "$status" -eq 0 ]
  [[ "$output" == *"devbox: sync 'work' is Scanning, not watching"* ]]
}

@test "connect: a configured sync with no session warns" {
  cd "$ROOT/app"
  DEVBOX_TRANSPORT=mosh run "$DEVBOX" app
  [ "$status" -eq 0 ]
  [[ "$output" == *"devbox: sync 'work' has no session; devbox sync reset work creates it"* ]]
}

@test "connect: outside synced folders there is no mkdir and no mutagen call" {
  cd "$BATS_TEST_TMPDIR"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" main
  [ "$status" -eq 0 ]
  refute_called -e mkdir -e '^mutagen'
}

@test "connect: a name from a synced root creates that folder on both sides" {
  cd "$ROOT"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" proj
  [ "$status" -eq 0 ]
  [ -d "$ROOT/proj" ]
  grep -q "mkdir -p /home/stub/work/proj && echo created" "$CALLS"
  [[ "$output" == *"mosh stub-host -- tmux new-session -A -s proj -c /home/stub/work/proj"* ]]
}

@test "connect: --cc/--codex <name> from a synced root start the agent in the new folder" {
  cd "$ROOT"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" --cc proj
  [ "$status" -eq 0 ]
  [ -d "$ROOT/proj" ]
  [[ "$output" == *"-s proj -c /home/stub/work/proj"*"claude --continue"* ]]
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" --codex api
  [ "$status" -eq 0 ]
  [ -d "$ROOT/api" ]
  [[ "$output" == *"-s api -c /home/stub/work/api"*"codex resume --last"* ]]
}

@test "connect: remote login-shell output does not hide a created folder" {
  cd "$ROOT"
  MUT_SESSIONS=work SSH_BANNER="Welcome" DEVBOX_TRANSPORT=mosh run "$DEVBOX" proj
  [ "$status" -eq 0 ]
  [ -d "$ROOT/proj" ]
}

@test "connect: re-attaching to a running session creates no folder" {
  cd "$ROOT"
  MUT_SESSIONS=work TMUX_RUNNING=1 DEVBOX_TRANSPORT=mosh run "$DEVBOX" proj
  [ "$status" -eq 0 ]
  [ ! -e "$ROOT/proj" ]
  [[ "$output" == *"tmux new-session -A -s proj"* ]]
}

@test "connect: an unreachable host creates no local folder" {
  cd "$ROOT"
  MUT_SESSIONS=work SSH_EXIT=255 DEVBOX_TRANSPORT=mosh run "$DEVBOX" proj
  [ ! -e "$ROOT/proj" ]
}

@test "connect: the default session, subfolders, and explicit paths keep their cwd" {
  cd "$ROOT"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX"
  [[ "$output" == *"-s main -c /home/stub/work" ]]
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" --cc proj "$ROOT/app"
  [[ "$output" == *"-s proj -c /home/stub/work/app "* ]]
  cd "$ROOT/app"
  MUT_SESSIONS=work DEVBOX_TRANSPORT=mosh run "$DEVBOX" proj
  [[ "$output" == *"-s proj -c /home/stub/work/app" ]]
  [ ! -e "$ROOT/main" ] && [ ! -e "$ROOT/proj" ] && [ ! -e "$ROOT/app/proj" ]
}

@test "sync add: a relative local path is stored absolute" {
  cd "$ROOT"
  run "$DEVBOX" sync add rel ./app/
  [ "$status" -eq 0 ]
  grep -qx "rel|$ROOT/app|rel" "$DEVBOX_CONFIG"
}
