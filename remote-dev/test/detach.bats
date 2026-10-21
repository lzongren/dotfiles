#!/usr/bin/env bats
# The ssh stub runs the remote string through a shell, as sshd does, so a
# command split by missing quoting reaches the tmux stub as extra arguments.

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export TMUX_LOG="$BATS_TEST_TMPDIR/tmux.log"
  mkdir -p "$STUBS" "$BATS_TEST_TMPDIR/home"
  : >"$CALLS"
  : >"$TMUX_LOG"
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
echo "ssh $*" >>"$CALLS"
[ "${SSH_EXIT:-0}" -eq 0 ] || exit "$SSH_EXIT"
exec bash -c "${!#}"
SH
  cat >"$STUBS/tmux" <<'SH'
#!/bin/bash
if [ "${1:-}" = has-session ]; then
  exit "${TMUX_HAS:-1}"
fi
{
  echo '--- tmux'
  printf '%s\n' "$@"
} >>"$TMUX_LOG"
SH
  printf '#!/bin/bash\necho "mosh $*" >>"$CALLS"\n' >"$STUBS/mosh"
  printf '#!/bin/bash\nexit 1\n' >"$STUBS/nc"
  printf '#!/bin/bash\nexit 1\n' >"$STUBS/mutagen"
  chmod +x "$STUBS"/*
  export PATH="$STUBS:/usr/bin:/bin"
  export HOME="$BATS_TEST_TMPDIR/home"
  export SHELL=/usr/bin/false

  ROOT="$BATS_TEST_TMPDIR/work"
  REMOTE="$BATS_TEST_TMPDIR/remote"
  mkdir -p "$ROOT/app" "$REMOTE"
  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  cat >"$DEVBOX_CONFIG" <<EOF
DEVBOX_HOST="stub-host"
DEVBOX_REMOTE_HOME="$REMOTE"
DEVBOX_SYNCS="
work|$ROOT|work
"
EOF
}

tmux_args() { sed -n '/^--- tmux$/,$p' "$TMUX_LOG" | sed '1d'; }

@test "detach: starts a detached session over ssh and reports it" {
  cd "$BATS_TEST_TMPDIR"
  run "$DEVBOX" --detach api
  [ "$status" -eq 0 ]
  [ "$output" = "created api" ]
  [ "$(tmux_args | sed -n 1,4p | tr '\n' ' ')" = "new-session -d -s api " ]
  ! grep -q '^mosh ' "$CALLS"
  grep -q 'BatchMode=yes' "$CALLS"
}

@test "detach: an existing session is reported, not recreated" {
  cd "$BATS_TEST_TMPDIR"
  TMUX_HAS=0 run "$DEVBOX" --detach api
  [ "$status" -eq 0 ]
  [ "$output" = "exists api" ]
  [ ! -s "$TMUX_LOG" ]
}

@test "detach: --cc from a sync root creates the workspace and passes the agent command as one argument" {
  cd "$ROOT"
  run "$DEVBOX" --detach --cc proj
  [ "$status" -eq 0 ]
  [[ "$output" == *"created proj"* ]]
  [ -d "$ROOT/proj" ]
  [ -d "$REMOTE/work/proj" ]
  args="$(tmux_args)"
  [ "$(printf '%s\n' "$args" | sed -n 1,6p | tr '\n' ' ')" = "new-session -d -s proj -c $REMOTE/work/proj " ]
  [ "$(printf '%s\n' "$args" | wc -l | tr -d ' ')" -eq 7 ]
  [[ "$(printf '%s\n' "$args" | sed -n 7p)" == "if command -v claude"*"claude --continue || exec claude"* ]]
}

@test "detach: an unreachable host fails without printing a session" {
  cd "$BATS_TEST_TMPDIR"
  SSH_EXIT=255 run "$DEVBOX" --detach api
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not start api on stub-host"* ]]
  [[ "$output" != *"created"* ]]
}

@test "ssh transport: the agent command reaches tmux as one argument" {
  cd "$BATS_TEST_TMPDIR"
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" --cc demo
  [ "$status" -eq 0 ]
  args="$(tmux_args)"
  [ "$(printf '%s\n' "$args" | sed -n 1,4p | tr '\n' ' ')" = "new-session -A -s demo " ]
  [ "$(printf '%s\n' "$args" | wc -l | tr -d ' ')" -eq 5 ]
  [[ "$(printf '%s\n' "$args" | sed -n 5p)" == "if command -v claude"* ]]
}

@test "detach: a name the workspace rules refuse fails instead of starting in the root" {
  cd "$ROOT"
  run "$DEVBOX" --detach --cc build
  [ "$status" -eq 2 ]
  [[ "$output" == *"'build' cannot be a workspace folder"* ]]
  ! grep -q '^ssh ' "$CALLS"
  [ ! -e "$ROOT/build" ]
}

@test "detach: the remote folder is made in the same ssh call as the session" {
  cd "$ROOT"
  run "$DEVBOX" --detach --cc proj
  [ "$status" -eq 0 ]
  [ "$(grep -c '^ssh ' "$CALLS")" -eq 1 ]
}

@test "detach: a failed remote mkdir fails the call and creates nothing locally" {
  printf 'not a dir' >"$REMOTE/work"
  cd "$ROOT"
  run "$DEVBOX" --detach --cc proj
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not start proj"* ]]
  [ ! -e "$ROOT/proj" ]
  [ ! -s "$TMUX_LOG" ]
}

@test "detach: --fresh starts a new conversation in an existing folder instead of continuing one" {
  mkdir -p "$REMOTE/work/app"
  cd "$ROOT/app"
  run "$DEVBOX" --detach --fresh --cc app-review
  [ "$status" -eq 0 ]
  [[ "$output" == *"created app-review" ]]
  args="$(tmux_args)"
  [ "$(printf '%s\n' "$args" | sed -n 1,6p | tr '\n' ' ')" = "new-session -d -s app-review -c $REMOTE/work/app " ]
  [[ "$(printf '%s\n' "$args" | sed -n 7p)" == *"exec claude;"* ]]
  [[ "$(printf '%s\n' "$args" | sed -n 7p)" != *"--continue"* ]]
  [ ! -e "$ROOT/app/app-review" ]
}

@test "detach: --fresh codex starts codex without resuming the last conversation" {
  cd "$ROOT/app"
  run "$DEVBOX" --detach --fresh --codex app-codex
  [ "$status" -eq 0 ]
  [[ "$(tmux_args | sed -n 7p)" == *"exec codex;"* ]]
  [[ "$(tmux_args | sed -n 7p)" != *"resume"* ]]
}

@test "detach: a shell starts in the folder given, even a sync root itself" {
  cd "$BATS_TEST_TMPDIR"
  run "$DEVBOX" --detach root-sh "$ROOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"created root-sh" ]]
  [ "$(tmux_args | sed -n 1,4p | tr '\n' ' ')" = "new-session -d -s root-sh " ]
  [ "$(tmux_args | sed -n 5,6p | tr '\n' ' ')" = "-c $REMOTE/work " ]
  [ ! -e "$ROOT/root-sh" ]
}

@test "detach: --fresh --cc with a path starts there, not in a new workspace folder" {
  cd "$BATS_TEST_TMPDIR"
  run "$DEVBOX" --detach --fresh --cc root-cc "$ROOT"
  [ "$status" -eq 0 ]
  [ "$(tmux_args | sed -n 1,6p | tr '\n' ' ')" = "new-session -d -s root-cc -c $REMOTE/work " ]
  [ ! -e "$ROOT/root-cc" ]
}
