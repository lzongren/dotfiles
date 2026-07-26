#!/usr/bin/env bats

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"
  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS" "$BATS_TEST_TMPDIR/home"

  printf '#!/bin/bash\nexit 0\n' >"$STUBS/mosh"
  printf '#!/bin/bash\nexit 0\n' >"$STUBS/nc"
  chmod +x "$STUBS/mosh" "$STUBS/nc"

  export PATH="$STUBS:/usr/bin:/bin"
  export HOME="$BATS_TEST_TMPDIR/home"
  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  printf 'DEVBOX_HOST="stub-host"\n' >"$DEVBOX_CONFIG"
}

write_probe() {
  local claude="${1:-MISSING}"
  local codex="${2:-MISSING}"
  local mosh_server="${3:-/usr/bin/mosh-server}"
  local sessions="${4:-0}"
  local disk="${5:-40}"
  cat >"$STUBS/ssh" <<SH
#!/bin/bash
cat <<'EOF'
PROBE_OK=1
UP=up 2 days
TMUX=/usr/bin/tmux
MOSH=$mosh_server
CLAUDE=$claude
CODEX=$codex
DISK=$disk
SESSIONS=$sessions
ORPHANS=0
EOF
SH
  chmod +x "$STUBS/ssh"
}

@test "doctor: optional agents and zero sessions do not block readiness" {
  write_probe MISSING MISSING

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude Code not installed (optional"* ]]
  [[ "$output" == *"Codex not installed (optional"* ]]
  [[ "$output" == *"no tmux sessions (normal; devbox <name> starts one)"* ]]
  [[ "$output" == *"READY - all required checks passed."* ]]
  [[ "$output" == *"Optional agent capabilities unavailable: 2."* ]]
}

@test "doctor: a required missing agent fails readiness" {
  write_probe MISSING OK

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor --require-agent cc

  [ "$status" -eq 1 ]
  [[ "$output" == *"Claude Code is not installed on the remote"* ]]
  [[ "$output" == *"NOT READY - 1 required check(s) failed."* ]]
}

@test "doctor: required agents can be repeated and use equals syntax" {
  write_probe OK MISSING

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor --require-agent=cc --require-agent codex

  [ "$status" -eq 1 ]
  [[ "$output" == *"Claude Code available on remote PATH"* ]]
  [[ "$output" == *"Codex is not installed on the remote"* ]]
}

@test "doctor: rejects an unknown required agent" {
  write_probe

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor --require-agent cursor

  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown agent: cursor"* ]]
}

@test "doctor: a broken optional agent warns without failing" {
  write_probe BROKEN OK

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"Claude Code is installed but failed to start"* ]]
  [[ "$output" == *"READY - all required checks passed with 1 warning(s)."* ]]
}

@test "doctor: SSH transport does not require mosh-server" {
  write_probe OK OK MISSING

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"mosh-server not installed (not required for SSH transport)"* ]]
}

@test "doctor: mosh transport requires mosh-server" {
  write_probe OK OK MISSING

  DEVBOX_TRANSPORT=mosh run "$DEVBOX" doctor

  [ "$status" -eq 1 ]
  [[ "$output" == *"mosh-server not on remote PATH"* ]]
}

@test "doctor: no configured syncs do not require Mutagen" {
  write_probe OK OK
  printf '#!/bin/bash\nexit 1\n' >"$STUBS/mutagen"
  chmod +x "$STUBS/mutagen"

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"no syncs configured; Mutagen is not required"* ]]
}

@test "doctor: configured syncs require Mutagen" {
  write_probe OK OK
  cat >>"$DEVBOX_CONFIG" <<'EOF'
DEVBOX_SYNCS="
workspace|/tmp/workspace|Workspace
"
EOF

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 1 ]
  [[ "$output" == *"Mutagen missing"* ]]
}

@test "doctor: only configured Mutagen syncs affect readiness" {
  write_probe OK OK
  cat >>"$DEVBOX_CONFIG" <<'EOF'
DEVBOX_SYNCS="
workspace|/tmp/workspace|Workspace
"
EOF
  cat >"$STUBS/mutagen" <<'SH'
#!/bin/bash
case "$*" in
  "daemon status") exit 0 ;;
  "sync list workspace")
    cat <<'EOF'
Name: workspace
Alpha:
  Connected: Yes
Beta:
  Connected: Yes
Status: Watching for changes
EOF
    ;;
  "sync list unrelated") exit 1 ;;
  *) exit 1 ;;
esac
SH
  chmod +x "$STUBS/mutagen"

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"sync 'workspace' connected (Watching for changes)"* ]]
  [[ "$output" != *"unrelated"* ]]
}

@test "doctor: SSH failure is distinct from an invalid probe" {
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
exit 255
SH
  chmod +x "$STUBS/ssh"

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 1 ]
  [[ "$output" == *"remote unreachable (stub-host)"* ]]
  [[ "$output" == *"agent checks skipped because the remote probe failed"* ]]
}

@test "doctor: successful SSH with malformed output fails the probe protocol" {
  cat >"$STUBS/ssh" <<'SH'
#!/bin/bash
echo 'unexpected login output'
SH
  chmod +x "$STUBS/ssh"

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 1 ]
  [[ "$output" == *"remote probe returned an invalid response"* ]]
}

@test "doctor: malformed disk data is a warning, not a parser error" {
  write_probe OK OK /usr/bin/mosh-server 1 unknown

  DEVBOX_TRANSPORT=ssh run "$DEVBOX" doctor

  [ "$status" -eq 0 ]
  [[ "$output" == *"remote disk usage unavailable"* ]]
  [[ "$output" == *"READY - all required checks passed with 1 warning(s)."* ]]
}
