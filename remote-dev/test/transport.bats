#!/usr/bin/env bats
# Tests for devbox transport selection and the exec'd remote command.
# ssh/mosh/nc are stubbed on PATH (print their args, no network), so these
# assert exactly what command each transport would run — including the
# LANG=C.UTF-8 wrapper on the ssh path (without it, tmux renders every
# non-ASCII glyph as '_' when the remote locale is POSIX).
#
# Run:  bats remote-dev/test/          (use bats-core, not ~/.toolbox/bin/bats)

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  printf '#!/bin/bash\necho "ssh $*"\n' > "$STUBS/ssh"
  printf '#!/bin/bash\necho "mosh $*"\n' > "$STUBS/mosh"
  # nc = the TCP:22 reachability probe; NC_EXIT simulates on/off VPN.
  printf '#!/bin/bash\nexit "${NC_EXIT:-0}"\n' > "$STUBS/nc"
  chmod +x "$STUBS"/*
  PATH="$STUBS:$PATH"

  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  printf 'DEVBOX_HOST="stub-host"\n' > "$DEVBOX_CONFIG"
}

@test "transport=ssh: tmux command is wrapped with a UTF-8 locale" {
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" mysess
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -t stub-host env LANG=C.UTF-8 tmux new-session -A -s mysess"* ]]
}

@test "transport=mosh: tmux command passed through unmodified" {
  DEVBOX_TRANSPORT=mosh run "$DEVBOX" mysess
  [ "$status" -eq 0 ]
  [[ "$output" == *"mosh stub-host -- tmux new-session -A -s mysess"* ]]
}

@test "probe: direct route (nc ok) selects mosh" {
  NC_EXIT=0 run "$DEVBOX" main
  [ "$status" -eq 0 ]
  [[ "$output" == *"mosh stub-host --"* ]]
}

@test "probe: no direct route (nc fails) falls back to ssh with UTF-8 locale" {
  NC_EXIT=1 run "$DEVBOX" main
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -t stub-host env LANG=C.UTF-8 tmux"* ]]
}

@test "default session name is main" {
  DEVBOX_TRANSPORT=ssh run "$DEVBOX"
  [ "$status" -eq 0 ]
  [[ "$output" == *"-s main"* ]]
}
