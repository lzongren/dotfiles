#!/usr/bin/env bats
# Tests for bin/sessions — uses mock data dirs, no network.

setup() {
  export SESSIONS="$BATS_TEST_DIRNAME/../bin/sessions"
  export MOCK_HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$MOCK_HOME/.claude/sessions"
  mkdir -p "$MOCK_HOME/.codex/sessions/2026/07/13"

  # Mock Claude session
  NOW=$(date +%s)
  STARTED_MS=$(( NOW * 1000 ))
  cat > "$MOCK_HOME/.claude/sessions/1234.json" <<JSON
{"pid":1234,"sessionId":"aaa","cwd":"$MOCK_HOME/project-x","startedAt":$STARTED_MS,"status":"idle","name":"project-x"}
JSON

  # Mock Codex session
  cat > "$MOCK_HOME/.codex/sessions/2026/07/13/rollout-test.jsonl" <<JSON
{"timestamp":"2026-07-13T10:00:00Z","type":"session_meta","payload":{"session_id":"bbb","cwd":"$MOCK_HOME/project-y","originator":"codex-tui"}}
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
  HOME="$MOCK_HOME" run "$SESSIONS" --no-remote --motd
  [ "$status" -eq 0 ]
  [[ "$output" == *"agent sessions"* ]]
}

@test "empty sessions dir shows nothing in motd" {
  rm -rf "$MOCK_HOME/.claude/sessions"/* "$MOCK_HOME/.codex/sessions"/*
  HOME="$MOCK_HOME" run "$SESSIONS" --no-remote --motd --days 0
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
