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
  local version="$1" out="$2" commands="${3:-dev,devbox,sessions,dotfiles-tools}"
  local payload command commit
  payload="$BATS_TEST_TMPDIR/dotfiles-tools-$version"
  mkdir -p "$payload/bin" "$payload/lib" "$payload/remote-dev" "$out"

  case "$version" in
    1.0.0) commit="1111111111111111111111111111111111111111" ;;
    *) commit="2222222222222222222222222222222222222222" ;;
  esac

  printf '%s\n' "$version" >"$payload/VERSION"
  while IFS= read -r command; do
    [ -n "$command" ] || continue
    if [ "$command" = dotfiles-tools ]; then
      cp "$REPO_ROOT/bin/dotfiles-tools" "$payload/bin/dotfiles-tools"
    else
      printf '#!/usr/bin/env bash\nprintf "%%s %%s (commit %.12s)\\n" "%s" "%s"\n' \
        "$commit" "$command" "$version" >"$payload/bin/$command"
      chmod +x "$payload/bin/$command"
    fi
  done < <(printf '%s\n' "$commands" | tr ',' '\n')
  cp "$REPO_ROOT/lib/dotfiles-tools-version.sh" "$payload/lib/dotfiles-tools-version.sh"
  cp "$REPO_ROOT/remote-dev/lib.sh" "$payload/remote-dev/lib.sh"
  cp "$REPO_ROOT/remote-dev/setup-remote.sh" "$payload/remote-dev/setup-remote.sh"
  cp "$REPO_ROOT/remote-dev/setup-sync.sh" "$payload/remote-dev/setup-sync.sh"
  cp "$REPO_ROOT/remote-dev/tmux.conf" "$payload/remote-dev/tmux.conf"

  cat >"$payload/release.env" <<EOF
DOTFILES_TOOLS_RELEASE_VERSION=$version
DOTFILES_TOOLS_RELEASE_COMMIT=$commit
DOTFILES_TOOLS_RELEASE_TAG=tools-v$version
DOTFILES_TOOLS_RELEASE_COMMANDS=$commands
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

  write_payload_checksums "$payload"
  pack_payload "$payload" "$out"
}

write_payload_checksums() {
  local payload="$1" file
  (
    cd "$payload"
    find . -type f ! -name checksums.txt -print | LC_ALL=C sort | while IFS= read -r file; do
      file="${file#./}"
      printf '%s  %s\n' "$(sha256_file "$file")" "$file"
    done >checksums.txt
  )
}

pack_payload() {
  local payload="$1" out="$2" version archive
  version="$(tr -d '[:space:]' <"$payload/VERSION")"
  archive="$out/dotfiles-tools-$version.tar.gz"
  mkdir -p "$out"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$(dirname "$payload")" "$(basename "$payload")"
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

@test "verification rejects unchecked files and duplicate checksum entries" {
  build_release
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  release_dir="$PREFIX/opt/dotfiles-tools/releases/$VERSION"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$release_dir/bin/unchecked"
  chmod +x "$release_dir/bin/unchecked"

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"file is not covered by checksums.txt: bin/unchecked"* ]]

  rm "$release_dir/bin/unchecked"
  first_line="$(head -1 "$release_dir/checksums.txt")"
  printf '%s\n' "$first_line" >>"$release_dir/checksums.txt"
  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"duplicate checksum path"* ]]
}

@test "verification rejects invalid hashes and missing declared commands" {
  build_release
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  release_dir="$PREFIX/opt/dotfiles-tools/releases/$VERSION"
  sed '1s/^[0-9a-f]*/not-a-sha256/' "$release_dir/checksums.txt" >"$release_dir/checksums.txt.new"
  mv "$release_dir/checksums.txt.new" "$release_dir/checksums.txt"

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid checksum hash"* ]]

  tar -xOf "$DIST/dotfiles-tools-$VERSION.tar.gz" "dotfiles-tools-$VERSION/checksums.txt" >"$release_dir/checksums.txt"
  rm "$release_dir/bin/sessions"
  awk '$2 != "bin/sessions"' "$release_dir/checksums.txt" >"$release_dir/checksums.txt.new"
  mv "$release_dir/checksums.txt.new" "$release_dir/checksums.txt"
  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"declared command is missing or not executable: sessions"* ]]
}

@test "installer rejects links in an otherwise checksummed archive" {
  build_release
  repack="$BATS_TEST_TMPDIR/repack"
  mkdir -p "$repack" "$BATS_TEST_TMPDIR/linked-dist"
  tar -xzf "$DIST/dotfiles-tools-$VERSION.tar.gz" -C "$repack"
  ln -s devbox "$repack/dotfiles-tools-$VERSION/bin/linked"
  pack_payload "$repack/dotfiles-tools-$VERSION" "$BATS_TEST_TMPDIR/linked-dist"

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$BATS_TEST_TMPDIR/linked-dist/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/linked-dist/SHA256SUMS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"archive contains a link or special file"* ]]
  [ ! -e "$PREFIX/opt/dotfiles-tools/releases/$VERSION" ]
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

@test "reinstall refuses different content with the same version" {
  build_release
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$DIST/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$DIST/SHA256SUMS"
  original_commit="$(sed -n 's/^DOTFILES_TOOLS_RELEASE_COMMIT=//p' "$PREFIX/opt/dotfiles-tools/current/release.env")"

  repack="$BATS_TEST_TMPDIR/repack"
  mkdir -p "$repack" "$BATS_TEST_TMPDIR/conflict-dist"
  tar -xzf "$DIST/dotfiles-tools-$VERSION.tar.gz" -C "$repack"
  payload="$repack/dotfiles-tools-$VERSION"
  conflicting_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  sed "s/$original_commit/$conflicting_commit/g" "$payload/release.env" >"$payload/release.env.new"
  mv "$payload/release.env.new" "$payload/release.env"
  sed "s/$original_commit/$conflicting_commit/g" "$payload/manifest.json" >"$payload/manifest.json.new"
  mv "$payload/manifest.json.new" "$payload/manifest.json"
  write_payload_checksums "$payload"
  pack_payload "$payload" "$BATS_TEST_TMPDIR/conflict-dist"

  run "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install "$VERSION" \
    --archive "$BATS_TEST_TMPDIR/conflict-dist/dotfiles-tools-$VERSION.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/conflict-dist/SHA256SUMS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"installed release $VERSION differs from the incoming payload"* ]]
  grep -q "DOTFILES_TOOLS_RELEASE_COMMIT=$original_commit" "$PREFIX/opt/dotfiles-tools/current/release.env"
}

@test "latest selects the highest stable tools release and ignores unrelated releases" {
  cat >"$BATS_TEST_TMPDIR/releases.json" <<'EOF'
[{"tag_name":"config-v99.0.0"},{"tag_name":"tools-v1.2.3"},{"tag_name":"tools-v2.0.0-rc.1"},{"tag_name":"tools-v1.10.0"}]
EOF
  run env DOTFILES_TOOLS_RELEASES_URL="file://$BATS_TEST_TMPDIR/releases.json" \
    "$REPO_ROOT/bin/dotfiles-tools" latest
  [ "$status" -eq 0 ]
  [ "$output" = "1.10.0" ]
}

@test "installing a second release preserves an atomic rollback target" {
  make_fixture_release 1.0.0 "$BATS_TEST_TMPDIR/v1" "devbox,dotfiles-tools,legacy"
  make_fixture_release 1.1.0 "$BATS_TEST_TMPDIR/v2" "devbox,dotfiles-tools"

  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install 1.0.0 \
    --archive "$BATS_TEST_TMPDIR/v1/dotfiles-tools-1.0.0.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/v1/SHA256SUMS"
  [ -L "$PREFIX/bin/legacy" ]
  "$REPO_ROOT/bin/dotfiles-tools" --prefix "$PREFIX" install 1.1.0 \
    --archive "$BATS_TEST_TMPDIR/v2/dotfiles-tools-1.1.0.tar.gz" \
    --checksums "$BATS_TEST_TMPDIR/v2/SHA256SUMS"

  [ "$(readlink "$PREFIX/opt/dotfiles-tools/current")" = "releases/1.1.0" ]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/previous")" = "releases/1.0.0" ]
  [ ! -e "$PREFIX/bin/legacy" ]
  [ ! -L "$PREFIX/bin/legacy" ]

  run "$PREFIX/bin/dotfiles-tools" --prefix "$PREFIX" rollback
  [ "$status" -eq 0 ]
  [[ "$output" == *"rolled back to dotfiles-tools 1.0.0"* ]]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/current")" = "releases/1.0.0" ]
  [ "$(readlink "$PREFIX/opt/dotfiles-tools/previous")" = "releases/1.1.0" ]
  [ -L "$PREFIX/bin/legacy" ]
}
