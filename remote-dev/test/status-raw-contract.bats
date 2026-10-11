#!/usr/bin/env bats
# Pins the status --raw byte contract shared with web/server/sessions.ts:
# the same fixture pair feeds the vitest parser tests, so a format change
# fails both suites in the same CI run instead of breaking the web silently.

setup() {
  DEVBOX="$BATS_TEST_DIRNAME/../../bin/devbox"
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUBS"
  printf '#!/bin/bash\ncat %q\n' "$REPO/web/test/fixtures/tmux-probe.txt" >"$STUBS/ssh"
  printf '#!/bin/bash\nshift\nexec "$@"\n' >"$STUBS/timeout"
  chmod +x "$STUBS"/*
  export PATH="$STUBS:/usr/bin:/bin"

  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  printf 'DEVBOX_HOST="stub-host"\n' >"$DEVBOX_CONFIG"
}

@test "status --raw output byte-equals the shared web fixture" {
  run "$DEVBOX" status --raw
  [ "$status" -eq 0 ]
  [ "$output" = "$(cat "$REPO/web/test/fixtures/status-raw.txt")" ]
}

@test "the fixture keeps the rows the web parser depends on" {
  grep -q '^cc-atx|2|' "$REPO/web/test/fixtures/status-raw.txt"
  grep -q '^api - ~/work/api|' "$REPO/web/test/fixtures/status-raw.txt"
  grep -q '|1|claude|' "$REPO/web/test/fixtures/status-raw.txt"
}
