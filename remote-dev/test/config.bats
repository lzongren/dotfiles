#!/usr/bin/env bats
# Tests for the config-mutation functions in lib.sh (devbox_config_add/rm,
# devbox_syncs_list, devbox_sync_exists). Pure file operations — no network.
#
# Run:  bats remote-dev/test/          (use bats-core, not ~/.toolbox/bin/bats)

setup() {
  LIB="$BATS_TEST_DIRNAME/../lib.sh"
  # Load only the functions; sourcing lib.sh top-level reads a real config, so
  # point DEVBOX_CONFIG at a nonexistent path to keep that load inert.
  DEVBOX_CONFIG=/nonexistent . "$LIB"

  CFG="$BATS_TEST_TMPDIR/config"
  cat > "$CFG" <<'EOF'
DEVBOX_HOST="test-host"

DEVBOX_SYNCS="
atx|/tmp/ATX|ATX
idf|/tmp/IDF|IDF
"
EOF
}

# Assert the config still sources cleanly and DEVBOX_SYNCS has N entries.
assert_valid_with() {
  local want="$1"
  run bash -n "$CFG"; [ "$status" -eq 0 ] || { echo "config no longer parses"; return 1; }
  local n; n="$( set +u; . "$CFG"; printf '%s\n' "$DEVBOX_SYNCS" | grep -c '|' )"
  [ "$n" -eq "$want" ] || { echo "expected $want entries, got $n"; cat "$CFG"; return 1; }
}

@test "list: reads existing entries" {
  run devbox_syncs_list "$CFG"
  [ "$status" -eq 0 ]
  [[ "$output" == *"atx|/tmp/ATX|ATX"* ]]
  [[ "$output" == *"idf|/tmp/IDF|IDF"* ]]
}

@test "exists: true for present, false for absent" {
  devbox_sync_exists "$CFG" atx
  ! devbox_sync_exists "$CFG" nope
}

@test "add: appends a new entry and config stays valid" {
  run devbox_config_add "$CFG" newproj /tmp/NewProj NewProj
  [ "$status" -eq 0 ]
  devbox_sync_exists "$CFG" newproj
  assert_valid_with 3
}

@test "add: rejects a duplicate name (exit 3), config unchanged" {
  run devbox_config_add "$CFG" atx /tmp/Other Other
  [ "$status" -eq 3 ]
  assert_valid_with 2
  # the original atx entry must be intact, not overwritten
  run devbox_syncs_list "$CFG"
  [[ "$output" == *"atx|/tmp/ATX|ATX"* ]]
}

@test "add: rejects an invalid name (exit 2)" {
  run devbox_config_add "$CFG" "bad name!" /tmp/X X
  [ "$status" -eq 2 ]
  assert_valid_with 2
}

@test "add: creates the DEVBOX_SYNCS block when config has none" {
  printf 'DEVBOX_HOST="h"\n' > "$CFG"
  run devbox_config_add "$CFG" first /tmp/First First
  [ "$status" -eq 0 ]
  assert_valid_with 1
  devbox_sync_exists "$CFG" first
}

@test "add: leaves a .bak and the entry survives a reload" {
  devbox_config_add "$CFG" p /tmp/P P
  [ -f "$CFG.bak" ]
  run bash -c "set +u; . '$CFG'; echo \"\$DEVBOX_SYNCS\""
  [[ "$output" == *"p|/tmp/P|P"* ]]
}

@test "rm: removes an entry and config stays valid" {
  run devbox_config_rm "$CFG" atx
  [ "$status" -eq 0 ]
  ! devbox_sync_exists "$CFG" atx
  devbox_sync_exists "$CFG" idf
  assert_valid_with 1
}

@test "rm: unknown name is an error (exit 3), config unchanged" {
  run devbox_config_rm "$CFG" ghost
  [ "$status" -eq 3 ]
  assert_valid_with 2
}

@test "add then rm round-trips back to the original count" {
  devbox_config_add "$CFG" tmp /tmp/Tmp Tmp
  assert_valid_with 3
  devbox_config_rm "$CFG" tmp
  assert_valid_with 2
  ! devbox_sync_exists "$CFG" tmp
}

@test "add: entry with a space in the local path still parses" {
  mkdir -p "$BATS_TEST_TMPDIR/a b"
  run devbox_config_add "$CFG" spaced "$BATS_TEST_TMPDIR/a b" spaced
  [ "$status" -eq 0 ]
  assert_valid_with 3
}
