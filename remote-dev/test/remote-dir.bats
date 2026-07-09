#!/usr/bin/env bats
# Tests for devbox_remote_dir: map a local $PWD under a synced folder to the
# corresponding remote directory. Pure — no network.

setup() {
  DEVBOX_CONFIG=/nonexistent . "$BATS_TEST_DIRNAME/../lib.sh"
  CFG="$BATS_TEST_TMPDIR/config"
  cat > "$CFG" <<'EOF'
DEVBOX_HOST="h"
DEVBOX_SYNCS="
atx|/Users/me/Documents/ATX|ATX
idf|/Users/me/Documents/IDF|/opt/idf
"
EOF
  RH="/home/me"    # pretend remote home
}

@test "exact sync root maps to remote root (relative remote)" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/ATX "$RH"
  [ "$status" -eq 0 ]
  [ "$output" = "/home/me/ATX" ]
}

@test "subfolder maps under remote root" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/ATX/abc "$RH"
  [ "$output" = "/home/me/ATX/abc" ]
}

@test "deep subfolder preserved" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/ATX/a/b/c "$RH"
  [ "$output" = "/home/me/ATX/a/b/c" ]
}

@test "absolute remote path used as-is" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/IDF/x "$RH"
  [ "$output" = "/opt/idf/x" ]
}

@test "pwd outside any synced folder prints nothing" {
  run devbox_remote_dir "$CFG" /Users/me/Downloads "$RH"
  [ "$output" = "" ]
}

@test "prefix false-match is rejected (ATXtra is not under ATX)" {
  run devbox_remote_dir "$CFG" /Users/me/Documents/ATXtra "$RH"
  [ "$output" = "" ]
}

@test "no config / no syncs prints nothing" {
  run devbox_remote_dir /nonexistent /Users/me/Documents/ATX "$RH"
  [ "$output" = "" ]
}
