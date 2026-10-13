#!/usr/bin/env bats
# Tests for the devbox web launcher. node/npm/curl/open are PATH stubs logging
# to $CALLS; the stub node writes the state.json the real server would and
# sleeps so pid/marker checks see a live process.

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"

  TREE="$BATS_TEST_TMPDIR/tree"
  mkdir -p "$TREE/bin" "$TREE/remote-dev" "$TREE/web/src" "$TREE/web/server" "$TREE/web/dist-server"
  cp "$REPO/bin/devbox" "$TREE/bin/"
  cp "$REPO/remote-dev/lib.sh" "$TREE/remote-dev/"
  touch "$TREE/web/index.html" "$TREE/web/package.json" "$TREE/web/package-lock.json" \
    "$TREE/web/vite.config.ts" "$TREE/web/tsconfig.json" "$TREE/web/tsconfig.server.json"
  DEVBOX="$TREE/bin/devbox"

  STUBS="$BATS_TEST_TMPDIR/stubs"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export DEVBOX_WEB_STATE="$BATS_TEST_TMPDIR/webstate"
  mkdir -p "$STUBS" "$DEVBOX_WEB_STATE"
  : >"$CALLS"

  cat >"$STUBS/node" <<'SH'
#!/bin/bash
if [ "${1:-}" = --version ]; then
  echo "${NODE_STUB_VERSION:-v22.9.0}"
  exit 0
fi
env | grep -E '^DEVBOX_(BIN|WEB_STATE|WEB_PORT)=' >>"$CALLS"
echo "node $*" >>"$CALLS"
printf '{"pid":%s,"port":%s,"token":"tok123","version":"0.0.0"}' "$$" "${DEVBOX_WEB_PORT:-7733}" >"$DEVBOX_WEB_STATE/state.json"
sleep 60
SH
  printf '#!/bin/bash\necho "npm $*" >>"$CALLS"\n' >"$STUBS/npm"
  printf '#!/bin/bash\necho "curl $*" >>"$CALLS"\nexit "${CURL_EXIT:-0}"\n' >"$STUBS/curl"
  printf '#!/bin/bash\necho "open $*" >>"$CALLS"\n' >"$STUBS/open"
  chmod +x "$STUBS"/*
  export PATH="$STUBS:/usr/bin:/bin"

  export DEVBOX_CONFIG="$BATS_TEST_TMPDIR/config"
  printf 'DEVBOX_HOST="stub-host"\n' >"$DEVBOX_CONFIG"
}

teardown() {
  pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DEVBOX_WEB_STATE/state.json" 2>/dev/null)"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  true
}

@test "web: missing web/ sources fails with the checkout hint" {
  BARE="$BATS_TEST_TMPDIR/bare"
  mkdir -p "$BARE/bin"
  cp "$REPO/bin/devbox" "$BARE/bin/"
  run "$BARE/bin/devbox" web
  [ "$status" -eq 1 ]
  [[ "$output" == *"requires the web/ sources"* ]]
}

@test "web: node older than 22 fails with an actionable error" {
  NODE_STUB_VERSION=v20.11.0 run "$DEVBOX" web
  [ "$status" -eq 1 ]
  [[ "$output" == *"node >=22"* ]]
}

@test "web: first run builds, starts, prints the fragment URL, opens it" {
  run "$DEVBOX" web
  [ "$status" -eq 0 ]
  [[ "$output" == *"http://127.0.0.1:7733/#t=tok123"* ]]
  grep -q '^npm ci$' "$CALLS"
  grep -q '^npm run build$' "$CALLS"
  [ -f "$TREE/web/dist-server/.stamp" ]
  grep -q "^DEVBOX_BIN=$(cd -P "$TREE/bin" && pwd)$" "$CALLS"
  grep -q "^DEVBOX_WEB_STATE=$DEVBOX_WEB_STATE$" "$CALLS"
  grep -q '^DEVBOX_WEB_PORT=7733$' "$CALLS"
  grep -q 'dist-server/server/index.js' "$CALLS"
  grep -q '^open http://127.0.0.1:7733/#t=tok123$' "$CALLS"
}

@test "web: --no-open suppresses the browser" {
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  ! grep -q '^open ' "$CALLS"
}

@test "web: --port overrides the listen port" {
  run "$DEVBOX" web --no-open --port 7900
  [ "$status" -eq 0 ]
  [[ "$output" == *"http://127.0.0.1:7900/#t=tok123"* ]]
  grep -q '^DEVBOX_WEB_PORT=7900$' "$CALLS"
}

@test "web: a fresh stamp skips the build and a healthy server is reused" {
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  [[ "$output" == *"http://127.0.0.1:7733/#t=tok123"* ]]
  [ "$(grep -c '^npm ci$' "$CALLS")" -eq 1 ]
  [ "$(grep -c 'dist-server/server/index.js' "$CALLS")" -eq 1 ]
  grep -q '^curl .*/api/health' "$CALLS"
}

@test "web: --rebuild forces a build even with a fresh stamp" {
  run "$DEVBOX" web --no-open
  run "$DEVBOX" web --no-open --rebuild
  [ "$status" -eq 0 ]
  [ "$(grep -c '^npm ci$' "$CALLS")" -eq 2 ]
}

@test "web: a source file newer than the stamp triggers a rebuild" {
  mkdir -p "$TREE/web/dist-server"
  touch -t 202001010000 "$TREE/web/dist-server/.stamp"
  touch "$TREE/web/src/newfile.ts"
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  grep -q '^npm ci$' "$CALLS"
}

@test "web: a dead pid in the state file is cleaned up and a fresh server starts" {
  touch "$TREE/web/dist-server/.stamp"
  printf '{"pid":99999999,"port":7733,"token":"old","version":"0.0.0"}' >"$DEVBOX_WEB_STATE/state.json"
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  [[ "$output" == *"#t=tok123"* ]]
  grep -q 'dist-server/server/index.js' "$CALLS"
}

@test "web: stop kills a marker-matching server and removes state" {
  run "$DEVBOX" web --no-open
  pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DEVBOX_WEB_STATE/state.json")"
  kill -0 "$pid"
  run "$DEVBOX" web stop
  [ "$status" -eq 0 ]
  ! kill -0 "$pid" 2>/dev/null
  [ ! -f "$DEVBOX_WEB_STATE/state.json" ]
}

@test "web: stop refuses to kill a recycled pid without the marker" {
  sleep 60 &
  other=$!
  printf '{"pid":%s,"port":7733,"token":"old","version":"0.0.0"}' "$other" >"$DEVBOX_WEB_STATE/state.json"
  run "$DEVBOX" web stop
  kill -0 "$other"
  [ ! -f "$DEVBOX_WEB_STATE/state.json" ]
  kill "$other"
}

@test "web: url prints the fragment URL and errors after stop" {
  run "$DEVBOX" web --no-open
  run "$DEVBOX" web url
  [ "$status" -eq 0 ]
  [ "$output" = "http://127.0.0.1:7733/#t=tok123" ]
  run "$DEVBOX" web stop
  run "$DEVBOX" web url
  [ "$status" -eq 1 ]
}

@test "web: status reports running and not-running" {
  run "$DEVBOX" web status
  [ "$status" -eq 1 ]
  [[ "$output" == *"not running"* ]]
  run "$DEVBOX" web --no-open
  run "$DEVBOX" web status
  [ "$status" -eq 0 ]
  [[ "$output" == *"running (pid "* ]]
}

@test "web: --print-config emits host, sync, ignore, and artifact lines in the pinned format" {
  cat >"$DEVBOX_CONFIG" <<EOF
DEVBOX_HOST="stub-host"
DEVBOX_SYNCS="
work|/home/me/Documents/Work|work
api|/home/me/my api|api
"
DEVBOX_ARTIFACTS="
MR|https://git\.example\.com/[^ |]+/merge_requests/[0-9]+
TICKET|T-[0-9]+|(old|new)|https://tickets.example.com/{0}
BAD|B-[0-9]+|https://tickets.example.com/
"
EOF
  run "$DEVBOX" web --print-config
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "$(printf 'host\tstub-host')" ]
  [ "${lines[1]}" = "$(printf 'sync\twork\t/home/me/Documents/Work\twork')" ]
  [ "${lines[2]}" = "$(printf 'sync\tapi\t/home/me/my api\tapi')" ]
  printf '%s\n' "${lines[@]}" | grep -qx "$(printf 'ignore\tbuild/')"
  printf '%s\n' "${lines[@]}" | grep -qx "$(printf 'ignore\tnode_modules/')"
  [ "${lines[${#lines[@]} - 3]}" = "$(printf 'artifact\tMR\t%s' 'https://git\.example\.com/[^ |]+/merge_requests/[0-9]+')" ]
  [ "${lines[${#lines[@]} - 2]}" = "$(printf 'artifact\tTICKET\t%s\t%s' 'T-[0-9]+|(old|new)' 'https://tickets.example.com/{0}')" ]
  [ "${lines[${#lines[@]} - 1]}" = "devbox: DEVBOX_ARTIFACTS link has no {0} for the match: BAD|B-[0-9]+|https://tickets.example.com/" ]
  ! printf '%s\n' "${lines[@]}" | grep -q "^artifact.BAD"
}

@test "web: an unresponsive server is replaced, not leaked" {
  run "$DEVBOX" web --no-open
  old_pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DEVBOX_WEB_STATE/state.json")"
  CURL_EXIT=7 run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  [[ "$output" == *"replacing unresponsive server"* ]]
  ! kill -0 "$old_pid" 2>/dev/null
  [ "$(grep -c 'dist-server/server/index.js' "$CALLS")" -eq 2 ]
}

@test "web: url with a dead pid errors instead of printing a dead URL" {
  printf '{"pid":99999999,"port":7733,"token":"old","version":"0.0.0"}' >"$DEVBOX_WEB_STATE/state.json"
  run "$DEVBOX" web url
  [ "$status" -eq 1 ]
  [[ "$output" == *"not running"* ]]
}

@test "web: --port rejects non-numeric and out-of-range values" {
  run "$DEVBOX" web --no-open --port abc
  [ "$status" -eq 2 ]
  run "$DEVBOX" web --no-open --port 0
  [ "$status" -eq 2 ]
  run "$DEVBOX" web --no-open --port 70000
  [ "$status" -eq 2 ]
  DEVBOX_WEB_PORT=abc run "$DEVBOX" web --no-open
  [ "$status" -eq 2 ]
  [[ "$output" == *"between 1 and 65535"* ]]
}

@test "web: a rebuild restarts a running server so it never serves a newer page" {
  run "$DEVBOX" web --no-open
  old_pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DEVBOX_WEB_STATE/state.json")"
  sleep 1
  touch "$TREE/web/src/changed.ts"
  run "$DEVBOX" web --no-open
  [ "$status" -eq 0 ]
  [[ "$output" == *"restarting the server for the new build"* ]]
  ! kill -0 "$old_pid" 2>/dev/null
  [ "$(grep -c 'dist-server/server/index.js' "$CALLS")" -eq 2 ]
}

@test "web: --help prints usage and exits zero" {
  run "$DEVBOX" web --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"usage: devbox web"* ]]
}

@test "web: help mentions the web subcommand" {
  run "$REPO/bin/devbox" --help
  [[ "$output" == *"devbox web"* ]]
}
