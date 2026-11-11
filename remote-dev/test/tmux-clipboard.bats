#!/usr/bin/env bats
# mosh forwards "\e]52;c;…" but drops tmux's default "\e]52;;…", so
# remote-dev/tmux.conf must make tmux's clipboard writes carry the c selection.
#
# Run:  bats remote-dev/test/          (bats-core)

setup() {
  command -v tmux >/dev/null || skip "tmux not installed"
  SOCK="devbox-clip-$$"
  LOG="$BATS_TEST_TMPDIR/client.log"
  # tmux.conf loads resurrect/continuum from ~; a real HOME would restore the
  # user's sessions into this throwaway server.
  export HOME="$BATS_TEST_TMPDIR"
  unset TMUX
}

teardown() { tmux -L "$SOCK" kill-server 2>/dev/null || true; }

client_bytes() {
  local cmd="stty rows 24 cols 80; TERM=xterm-256color tmux -L $SOCK attach"
  # util-linux script takes the command via -c; BSD script takes it as args.
  if script --version >/dev/null 2>&1; then
    sleep 4 | script -q -f -c "$cmd" "$LOG" >/dev/null 2>&1
  else
    sleep 4 | script -q "$LOG" sh -c "$cmd" >/dev/null 2>&1
  fi
}

@test "load-buffer -w reaches the client as OSC 52 with the c selection" {
  tmux -L "$SOCK" -f "$BATS_TEST_DIRNAME/../tmux.conf" new-session -d -s t -x 80 -y 24 \
    "sleep 1.5; printf hello | tmux load-buffer -w -; sleep 1.5"
  client_bytes
  LC_ALL=C grep -a -q $'\033]52;c;aGVsbG8=' "$LOG"
  ! LC_ALL=C grep -a -q $'\033]52;;' "$LOG"
}
