#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  VERSION="$(tr -d '[:space:]' <"$REPO_ROOT/VERSION" 2>/dev/null || true)"
  TEST_HOME="$BATS_TEST_TMPDIR/home"
  PREFIX="$TEST_HOME/.local"
  DIST="$BATS_TEST_TMPDIR/dist"
  mkdir -p "$TEST_HOME" "$DIST"
  export HOME="$TEST_HOME"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

build_release() {
  "$REPO_ROOT/release/build.sh" --allow-dirty --output "$DIST"
}

make_fixture_release() {
  local version="$1" out="$2" payload archive command hash commit
  payload="$BATS_TEST_TMPDIR/dotfiles-tools-$version"
  archive="$out/dotfiles-tools-$version.tar.gz"
  mkdir -p "$payload/bin" "$payload/lib" "$out"

  case "$version" in
    1.0.0) commit="1111111111111111111111111111111111111111" ;;
    *) commit="2222222222222222222222222222222222222222" ;;
  esac

  for command in dev devbox sessions; do
    printf '#!/usr/bin/env bash\nprintf "%%s %%s (commit %.12s)\\n" "%s" "%s"\n' \
      "$commit" "$command" "$version" >"$payload/bin/$command"
    chmod +x "$payload/bin/$command"
  done
  cp "$REPO_ROOT/bin/dotfiles-tools" "$payload/bin/dotfiles-tools"
  cp "$REPO_ROOT/lib/dotfiles-tools-version.sh" "$payload/lib/dotfiles-tools-version.sh"

  cat >"$payload/release.env" <<EOF
DOTFILES_TOOLS_RELEASE_VERSION=$version
DOTFILES_TOOLS_RELEASE_COMMIT=$commit
DOTFILES_TOOLS_RELEASE_TAG=tools-v$version
DOTFILES_TOOLS_RELEASE_COMMANDS=dev,devbox,sessions,dotfiles-tools
EOF

  cat >"$payload/manifest.json" <<EOF
{
  "schema": 1,
  "name": "dotfiles-tools",
  "version": "$version",
  "tag": "tools-v$version",
  "commit": "$commit",
  "checksums": "checksums.txt"
}
EOF

  (
    cd "$payload"
    for command in bin/dev bin/devbox bin/sessions bin/dotfiles-tools lib/dotfiles-tools-version.sh manifest.json release.env; do
      hash="$(sha256_file "$command")"
      printf '%s  %s\n' "$hash" "$command"
    done >checksums.txt
  )

  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$BATS_TEST_TMPDIR" "dotfiles-tools-$version"
  printf '%s  %s\n' "$(sha256_file "$archive")" "$(basename "$archive")" >"$out/SHA256SUMS"
}

@test "source commands report a development version tied to the checkout" {
  [ -n "$VERSION" ]
  for command in dev devbox sessions dotfiles-tools; do
    run "$REPO_ROOT/bin/$command" --version
    [ "$status" -eq 0 ]
    [[ "$output" == "$command $VERSION-dev+g"* ]]
  done
  run "$REPO_ROOT/bin/devbox-status.30s.sh" --version
  [ "$status" -eq 0 ]
  [[ "$output" == "devbox-status $VERSION-dev+g"* ]]
  for setup_command in setup-remote setup-sync; do
    run "$REPO_ROOT/remote-dev/$setup_command.sh" --version
    [ "$status" -eq 0 ]
    [[ "$output" == "$setup_command $VERSION-dev+g"* ]]
  done
}

@test "release builder emits a versioned archive, metadata, and outer checksum" {
  build_release

  archive="$DIST/dotfiles-tools-$VERSION.tar.gz"
  [ -f "$archive" ]
  [ -f "$DIST/dotfiles-tools-$VERSION-manifest.json" ]
  [ -f "$DIST/SHA256SUMS" ]
  grep -q "  dotfiles-tools-$VERSION.tar.gz$" "$DIST/SHA256SUMS"
  grep -q "  dotfiles-tools-$VERSION-manifest.json$" "$DIST/SHA256SUMS"

  run tar -tzf "$archive"
  [ "$status" -eq 0 ]
  [[ "$output" == *"dotfiles-tools-$VERSION/release.env"* ]]
  [[ "$output" == *"dotfiles-tools-$VERSION/manifest.json"* ]]
  [[ "$output" == *"dotfiles-tools-$VERSION/checksums.txt"* ]]
  [[ "$output" == *"dotfiles-tools-$VERSION/remote-dev/lib.sh"* ]]
}

@test "release builder rejects a tag that does not match VERSION" {
  run "$REPO_ROOT/release/build.sh" --allow-dirty --tag tools-v9.9.9 --output "$DIST"
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not match VERSION"* ]]
}

@test "installer activates and verifies the exact release artifact" {
  build_release

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"installed dotfiles-tools $VERSION"* ]]

  [ "$(readlink "$PREFIX/opt/dotfiles-tools/current")" = "releases/$VERSION" ]
  run "$PREFIX/bin/devbox" --version
  [ "$status" -eq 0 ]
  [[ "$output" == "devbox $VERSION (commit "* ]]
  run "$PREFIX/bin/devbox-status.30s.sh" --version
  [ "$status" -eq 0 ]
  [[ "$output" == "devbox-status $VERSION (commit "* ]]
  run "$PREFIX/opt/dotfiles-tools/current/remote-dev/setup-remote.sh" --version
  [ "$status" -eq 0 ]
  [[ "$output" == "setup-remote $VERSION (commit "* ]]

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"verified dotfiles-tools $VERSION"* ]]

  printf 'DEVBOX_HOST="fixture"\n' >"$BATS_TEST_TMPDIR/devbox-config"
  run env DEVBOX_CONFIG="$BATS_TEST_TMPDIR/devbox-config" "$PREFIX/bin/devbox" sync ls
  [ "$status" -eq 0 ]
  [[ "$output" == *"No synced folders configured."* ]]
}

@test "installer rejects an archive whose outer checksum is wrong" {
  build_release
  printf '%064d  dotfiles-tools-%s.tar.gz\n' 0 "$VERSION" >"$DIST/BAD-SHA256SUMS"

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/BAD-SHA256SUMS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"checksum mismatch"* ]]
  [ ! -e "$PREFIX/opt/dotfiles-tools/releases/$VERSION" ]
}

@test "installer preserves an existing command only when force is explicit" {
  build_release
  mkdir -p "$PREFIX/bin"
  printf '#!/usr/bin/env bash\necho original-devbox\n' >"$PREFIX/bin/devbox"
  chmod +x "$PREFIX/bin/devbox"

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"already exists"* ]]
  [ ! -L "$PREFIX/opt/dotfiles-tools/current" ]
  [ "$($PREFIX/bin/devbox)" = "original-devbox" ]

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS" \
    --force
  [ "$status" -eq 0 ]
  [ -L "$PREFIX/bin/devbox" ]
  backup="$(find "$PREFIX/bin" -maxdepth 1 -name 'devbox.before-dotfiles-tools-*' -print -quit)"
  [ -n "$backup" ]
  [ "$($backup)" = "original-devbox" ]
}

@test "verification detects a modified installed file" {
  build_release
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  printf '\n# modified after installation\n' >>"$PREFIX/opt/dotfiles-tools/releases/$VERSION/bin/devbox"

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"checksum mismatch: bin/devbox"* ]]
}

@test "verification rejects manifest metadata that disagrees with release metadata" {
  build_release
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  release_dir="$PREFIX/opt/dotfiles-tools/releases/$VERSION"
  sed 's/"version": "[^"]*"/"version": "9.9.9"/' "$release_dir/manifest.json" >"$release_dir/manifest.json.new"
  mv "$release_dir/manifest.json.new" "$release_dir/manifest.json"
  new_hash="$(sha256_file "$release_dir/manifest.json")"
  awk -v hash="$new_hash" '$2 == "manifest.json" {$1 = hash} {print $1 "  " $2}' \
    "$release_dir/checksums.txt" >"$release_dir/checksums.txt.new"
  mv "$release_dir/checksums.txt.new" "$release_dir/checksums.txt"

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"manifest version '9.9.9' does not match release.env version '$VERSION'"* ]]
}

@test "installing a second release preserves an atomic rollback target" {
  make_fixture_release 1.0.0 "$BATS_TEST_TMPDIR/v1"
  make_fixture_release 1.1.0 "$BATS_TEST_TMPDIR/v2"

  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install 1.0.0 \
    --archive "$BATS_TEST_TMPDIR/v1/dotfiles-tools-1.0.0.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/v1/SHA256SUMS"
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install 1.1.0 \
    --archive "$BATS_TEST_TMPDIR/v2/dotfiles-tools-1.1.0.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/v2/SHA256SUMS"

  [ "$(readlink "$PREFIX/opt/dotfiles-tools/current")" = "releases/1.1.0" ]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/previous")" = "releases/1.0.0" ]

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" rollback
  [ "$status" -eq 0 ]
  [[ "$output" == *"rolled back to dotfiles-tools 1.0.0"* ]]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/current")" = "releases/1.0.0" ]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/previous")" = "releases/1.1.0" ]
}
