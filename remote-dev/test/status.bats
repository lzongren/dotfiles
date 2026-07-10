#!/usr/bin/env bats
# Tests for the session-status helpers: devbox_ago (compact relative time)
# and devbox_status_lines (merge a tmux probe into one line per session).
# Pure — no network.

setup() {
  DEVBOX_CONFIG=/nonexistent . "$BATS_TEST_DIRNAME/../lib.sh"
}

# --- devbox_ago: now then -> 42s / 5m / 3h / 2d ------------------------------

@test "ago: under a minute shows seconds" {
  run devbox_ago 1000 970
  [ "$output" = "30s" ]
}

@test "ago: minutes" {
  run devbox_ago 1000 880
  [ "$output" = "2m" ]
}

@test "ago: hours" {
  run devbox_ago 10000 2800
  [ "$output" = "2h" ]
}

@test "ago: days" {
  run devbox_ago 200000 0
  [ "$output" = "2d" ]
}

@test "ago: clock skew (then in the future) clamps to 0s" {
  run devbox_ago 100 200
  [ "$output" = "0s" ]
}

# --- devbox_status_lines: S/P probe -> name|attached|activity|bell|cmd|path --

probe() {
  cat <<'EOF'
S|main|1|1751900000
S|api|0|1751890000
P|main|1|1|0|claude|/home/me/proj/abc
P|main|1|0|0|zsh|/home/me
P|api|0|1|1|vim|/home/me/other
P|api|1|1|0|zsh|/home/me/proj/x
EOF
}

@test "status: session merged with its active pane (active window + pane)" {
  out="$(probe | devbox_status_lines)"
  [ "$(sed -n 1p <<<"$out")" = "main|1|1751900000|0|claude|/home/me/proj/abc" ]
}

@test "status: inactive-window pane is ignored" {
  out="$(probe | devbox_status_lines)"
  [ "$(sed -n 2p <<<"$out")" = "api|0|1751890000|1|zsh|/home/me/proj/x" ]
}

@test "status: bell on an inactive window still flags the session" {
  # api's bell is on a non-active window; the session line must carry bell=1
  out="$(probe | devbox_status_lines)"
  bell="$(sed -n 2p <<<"$out" | cut -d'|' -f4)"
  [ "$bell" = "1" ]
}

@test "status: no bell anywhere yields bell=0" {
  out="$(probe | devbox_status_lines)"
  bell="$(sed -n 1p <<<"$out" | cut -d'|' -f4)"
  [ "$bell" = "0" ]
}

@test "status: sessions keep probe order" {
  out="$(probe | devbox_status_lines)"
  [ "$(wc -l <<<"$out" | tr -d ' ')" = "2" ]
  [ "$(sed -n 1p <<<"$out")" = "main|1|1751900000|0|claude|/home/me/proj/abc" ]
}

@test "status: session with no pane lines still listed (empty cmd/path)" {
  out="$(printf 'S|lone|0|123\n' | devbox_status_lines)"
  [ "$out" = "lone|0|123|0||" ]
}

@test "status: empty probe yields empty output" {
  out="$(printf '' | devbox_status_lines)"
  [ -z "$out" ]
}
