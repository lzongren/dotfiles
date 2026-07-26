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

@test "list: missing tmux server prints no sessions" {
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
echo 'error connecting to /tmp/tmux-1000/default (No such file or directory)' >&2
exit 1
SH
  chmod +x "$STUBS/ssh"

  run "$DEVBOX" list
  [ "$status" -eq 0 ]
  [ "$output" = "No sessions." ]
}

@test "list: real ssh failures still fail" {
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
echo 'ssh: Could not resolve hostname stub-host' >&2
exit 255
SH
  chmod +x "$STUBS/ssh"

  run "$DEVBOX" list
  [ "$status" -eq 1 ]
  [[ "$output" == *"Could not resolve hostname"* ]]
}

@test "bare cc is still just a session name" {
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" cc
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -t stub-host env LANG=C.UTF-8 tmux new-session -A -s cc"* ]]
  [[ "$output" != *"command -v claude"* ]]
}

@test "bare codex is still just a session name" {
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -t stub-host env LANG=C.UTF-8 tmux new-session -A -s codex"* ]]
  [[ "$output" != *"command -v codex"* ]]
}

@test "agent=cc launches Claude Code in the remote tmux session" {
  DEVBOX_TRANSPORT=ssh run "$DEVBOX" --cc feature
  [ "$status" -eq 0 ]
  [[ "$output" == *"ssh -t stub-host env LANG=C.UTF-8 tmux new-session -A -s feature"* ]]
  [[ "$output" == *"command -v claude"* ]]
  [[ "$output" == *"claude --continue"* ]]
}

@test "agent=codex launches Codex in the remote tmux session" {
  DEVBOX_TRANSPORT=mosh run "$DEVBOX" --codex feature
  [ "$status" -eq 0 ]
  [[ "$output" == *"mosh stub-host -- tmux new-session -A -s feature"* ]]
  [[ "$output" == *"command -v codex"* ]]
  [[ "$output" == *"codex resume --last"* ]]
}

@test "agent default session name includes agent and current directory" {
  mkdir -p "$BATS_TEST_TMPDIR/project"
  cd "$BATS_TEST_TMPDIR/project"

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" --codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"-s codex-project"* ]]
}

@test "agent path maps a synced local directory to the remote cwd" {
  local root
  mkdir -p "$BATS_TEST_TMPDIR/workspace/app"
  root="$(realpath "$BATS_TEST_TMPDIR/workspace")"
  cat >"$DEVBOX_CONFIG" <<EOF
DEVBOX_HOST="stub-host"
DEVBOX_REMOTE_HOME="/home/stub"
DEVBOX_SYNCS="
workspace|$root|Workspace
"
EOF

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" --cc app "$root/app"
  [ "$status" -eq 0 ]
  [[ "$output" == *"-s app -c /home/stub/Workspace/app"* ]]
  [[ "$output" == *"claude --continue"* ]]
}
