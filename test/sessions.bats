#!/usr/bin/env bats
# Tests for bin/sessions — uses mock data dirs, no network.

setup() {
  export SESSIONS="$BATS_TEST_DIRNAME/../bin/sessions"
  export MOCK_HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$MOCK_HOME/.claude/sessions"
  mkdir -p "$MOCK_HOME/.codex/sessions/2026/07/13"
  export MOCK_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$MOCK_BIN"

  # The MOTD cache path only checks that devbox exists; refresh is disabled.
  cat > "$MOCK_BIN/devbox" <<'SH'
#!/bin/sh
exit 99
SH
  chmod +x "$MOCK_BIN/devbox"

  # Mock Claude session
  NOW=$(date +%s)
  STARTED_MS=$(( NOW * 1000 ))
  cat > "$MOCK_HOME/.claude/sessions/1234.json" <<JSON
{"pid":1234,"sessionId":"aaa","cwd":"$MOCK_HOME/project-x","startedAt":$STARTED_MS,"status":"idle","name":"project-x"}
JSON

  # Mock Codex session
  CODEX_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$MOCK_HOME/.codex/sessions/2026/07/13/rollout-test.jsonl" <<JSON
{"timestamp":"$CODEX_TIMESTAMP","type":"session_meta","payload":{"session_id":"bbb","cwd":"$MOCK_HOME/project-y","originator":"codex-tui"}}
JSON
}

@test "lists claude sessions from custom HOME" {
  HOME="$MOCK_HOME" run "$SESSIONS" --no-remote --days 1
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"project-x"* ]]
}

@test "lists codex sessions" {
  HOME="$MOCK_HOME" run "$SESSIONS" --no-remote --days 1
  [[ "$output" == *"codex"* ]]
  [[ "$output" == *"project-y"* ]]
}

@test "json output is valid json" {
  HOME="$MOCK_HOME" run "$SESSIONS" --no-remote --json --days 1
  [ "$status" -eq 0 ]
  echo "$output" | python3 -m json.tool >/dev/null
}

@test "motd mode limits output" {
  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --no-remote --motd
  [ "$status" -eq 0 ]
  [[ "$output" == *"agent sessions"* ]]
}

@test "motd includes remote sessions from cache" {
  mkdir -p "$MOCK_HOME/.cache/sessions"
  cat > "$MOCK_HOME/.cache/sessions/remote-entries" <<EOF
devbox|detached|$NOW|remote-cached-session||mock-dev
EOF

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --motd --no-remote
  [ "$status" -eq 0 ]
  [[ "$output" == *"remote-cached-session"* ]]
}

@test "motd ignores remote sessions from a stale cache" {
  mkdir -p "$MOCK_HOME/.cache/sessions"
  cat > "$MOCK_HOME/.cache/sessions/remote-entries" <<EOF
devbox|detached|$NOW|stale-remote-session||mock-dev
EOF
  touch -t 202001010000 "$MOCK_HOME/.cache/sessions/remote-entries"

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --motd
  [ "$status" -eq 0 ]
  [[ "$output" != *"stale-remote-session"* ]]
}

@test "motd limit caps local sessions but keeps remote sessions" {
  mkdir -p "$MOCK_HOME/.cache/sessions"
  cat > "$MOCK_HOME/.cache/sessions/remote-entries" <<EOF
devbox|detached|$(( NOW - 3600 ))|remote-beyond-local-cap||mock-dev
EOF
  for i in $(seq 1 12); do
    printf '{"type":"other"}\n' > "$MOCK_HOME/.codex/sessions/2026/07/13/rollout-local-${i}.jsonl"
  done

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --motd
  [ "$status" -eq 0 ]
  [[ "$output" == *"remote-beyond-local-cap"* ]]
  local_count="$(printf '%s\n' "$output" | grep -Ec '^(claude|codex)[[:space:]]')"
  [ "$local_count" -eq 8 ]
}

@test "refresh reaps a stale lock left by a crashed refresh" {
  # A refresh killed before its EXIT trap leaves refresh.lock behind. A lock
  # older than 60s must be reaped so the cache can update again (else wedged).
  mkdir -p "$MOCK_HOME/.cache/sessions/refresh.lock"
  touch -t 202001010000 "$MOCK_HOME/.cache/sessions/refresh.lock"

  # Mock ssh returns two sessions in the activity|attached|name format.
  cat > "$MOCK_BIN/ssh" <<'SH'
#!/bin/sh
echo "1600000000|1|reaped-ok"
echo "1600000100|0|second"
SH
  chmod +x "$MOCK_BIN/ssh"

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" "$SESSIONS" --refresh-remote-cache
  [ "$status" -eq 0 ]
  [ ! -d "$MOCK_HOME/.cache/sessions/refresh.lock" ]      # reaped + released
  grep -q "reaped-ok" "$MOCK_HOME/.cache/sessions/remote-entries"
}

@test "a fresh lock still blocks refresh (no false reap)" {
  mkdir -p "$MOCK_HOME/.cache/sessions/refresh.lock"     # mtime = now
  printf 'devbox|detached|1600000000|preexisting||mock-dev\n' \
    > "$MOCK_HOME/.cache/sessions/remote-entries"
  cat > "$MOCK_BIN/ssh" <<'SH'
#!/bin/sh
echo "1600000000|1|should-not-appear"
SH
  chmod +x "$MOCK_BIN/ssh"

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" "$SESSIONS" --refresh-remote-cache
  [ "$status" -eq 0 ]
  grep -q "preexisting" "$MOCK_HOME/.cache/sessions/remote-entries"     # untouched
  ! grep -q "should-not-appear" "$MOCK_HOME/.cache/sessions/remote-entries"
}

@test "corrupt cache line does not crash motd (non-numeric ts)" {
  mkdir -p "$MOCK_HOME/.cache/sessions"
  printf 'devbox|detached|garbagetext|badline||mock-dev\n\ndevbox|attached|%s|good||mock-dev\n' "$NOW" \
    > "$MOCK_HOME/.cache/sessions/remote-entries"

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --motd
  [ "$status" -eq 0 ]   # ago() coerces non-numeric ts to 0 instead of aborting

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --json --motd
  [ "$status" -eq 0 ]
  echo "$output" | python3 -m json.tool >/dev/null
}

@test "session name with spaces survives the refresh round-trip" {
  cat > "$MOCK_BIN/ssh" <<'SH'
#!/bin/sh
echo "1600000000|0|Reasoning and thinkinkg"
SH
  chmod +x "$MOCK_BIN/ssh"
  env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" "$SESSIONS" --refresh-remote-cache

  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --motd
  [ "$status" -eq 0 ]
  [[ "$output" == *"Reasoning and thinkinkg"* ]]   # space name intact, not split
}

@test "empty sessions dir shows nothing in motd" {
  rm -rf "$MOCK_HOME/.claude/sessions"/* "$MOCK_HOME/.codex/sessions"/*
  run env HOME="$MOCK_HOME" PATH="$MOCK_BIN:$PATH" SESSIONS_NO_REFRESH=1 \
    "$SESSIONS" --no-remote --motd --days 0
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
