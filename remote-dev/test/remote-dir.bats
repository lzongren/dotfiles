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
lab|/Users/me/Documents/Lab|/opt/lab
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
  run devbox_remote_dir "$CFG" /Users/me/Documents/Lab/x "$RH"
  [ "$output" = "/opt/lab/x" ]
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

@test "workspace: a name run from a synced root is a folder under it" {
  run devbox_workspace_dir "$CFG" /Users/me/Documents/Work proj
  [ "$output" = "/Users/me/Documents/Work/proj" ]
}

@test "workspace: below a synced root, or outside one, there is none" {
  run devbox_workspace_dir "$CFG" /Users/me/Documents/Work/abc proj
  [ "$output" = "" ]
  run devbox_workspace_dir "$CFG" /Users/me/Documents/Workshop proj
  [ "$output" = "" ]
  run devbox_workspace_dir "$CFG" /Users/me/Downloads proj
  [ "$output" = "" ]
}

@test "workspace: anything but a plain folder name is refused" {
  for name in "" . .. .hidden -x a/b ../x "a b" a.b build env node_modules; do
    run devbox_workspace_dir "$CFG" /Users/me/Documents/Work "$name"
    [ "$output" = "" ]
  done
}

@test "workspace: a configured root with a trailing slash still matches" {
  printf 'DEVBOX_SYNCS="\nwork|/Users/me/Documents/Work/|Work\n"\n' >"$CFG"
  run devbox_workspace_dir "$CFG" /Users/me/Documents/Work proj
  [ "$output" = "/Users/me/Documents/Work/proj" ]
  run devbox_remote_dir "$CFG" /Users/me/Documents/Work/abc "$RH"
  [ "$output" = "/home/me/Work/abc" ]
}
