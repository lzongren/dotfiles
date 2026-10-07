#!/usr/bin/env bats
# Tests for devbox_remote_dir: map a local $PWD under a synced folder to the
# corresponding remote directory. Pure — no network.

setup() {
  DEVBOX_CONFIG=/nonexistent . "$BATS_TEST_DIRNAME/../lib.sh"
  CFG="$BATS_TEST_TMPDIR/config"
  cat > "$CFG" <<'EOF'
DEVBOX_HOST="h"
DEVBOX_SYNCS="
work|/Users/me/Documents/Work|Work
notes|/Users/me/Documents/Notes|/opt/notes
"
EOF
  RH="/home/me"    # pretend remote home
}

@test "exact sync root maps to remote root (relative remote)" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/Work "$RH"
  [ "$status" -eq 0 ]
  [ "$output" = "/home/me/Work" ]
}

@test "subfolder maps under remote root" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/Work/abc "$RH"
  [ "$output" = "/home/me/Work/abc" ]
}

@test "deep subfolder preserved" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/Work/a/b/c "$RH"
  [ "$output" = "/home/me/Work/a/b/c" ]
}

@test "absolute remote path used as-is" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/Notes/x "$RH"
  [ "$output" = "/opt/notes/x" ]
}

@test "pwd outside any synced folder prints nothing" {
  run devbox_remote_dir "$CFG" /Users/me/Downloads "$RH"
  [ "$output" = "" ]
}

@test "prefix false-match is rejected (Workshop is not under Work)" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/Workshop "$RH"
  [ "$output" = "" ]
}

@test "no config / no syncs prints nothing" {
  run devbox_remote_dir /nonexistent /Users/me/Documents/Work "$RH"
  [ "$output" = "" ]
}
