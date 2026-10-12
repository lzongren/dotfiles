#!/usr/bin/env bats
# Tests for `devbox --detach` and the ssh transport's remote command string.
# The ssh stub evaluates the string it receives with bash, the way the remote
# login shell would, against a tmux stub that records each argv element on its
# own line, so quoting bugs that split the agent command surface as extra
# elements instead of passing silently.

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
