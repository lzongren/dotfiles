#!/usr/bin/env bash
# Build the immutable dotfiles-tools GitHub Release payload.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/dist"
ALLOW_DIRTY=false
TAG=""

usage() {
  cat <<'EOF'
Usage: release/build.sh [--output DIR] [--tag tools-vX.Y.Z] [--allow-dirty]

Builds dotfiles-tools-X.Y.Z.tar.gz plus SHA256SUMS. Release automation must
pass the triggering tag; local development builds may use --allow-dirty.
EOF
}

die() {
  echo "release/build.sh: $*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || die "--output requires a directory"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] || die "--tag requires a value"
      TAG="$2"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

VERSION="$(tr -d '[:space:]' <"$REPO_ROOT/VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "invalid VERSION: $VERSION"
EXPECTED_TAG="tools-v$VERSION"
[ -z "$TAG" ] && TAG="$EXPECTED_TAG"
[ "$TAG" = "$EXPECTED_TAG" ] || die "tag '$TAG' does not match VERSION '$VERSION' (expected $EXPECTED_TAG)"

COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" || die "repository commit is unavailable"
if [ "$ALLOW_DIRTY" != true ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  die "working tree is dirty; commit the release inputs or use --allow-dirty for local testing"
fi

BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-tools-build.XXXXXX")"
trap 'rm -rf "$BUILD_TMP"' EXIT
PAYLOAD_NAME="dotfiles-tools-$VERSION"
PAYLOAD="$BUILD_TMP/$PAYLOAD_NAME"
ARCHIVE_NAME="$PAYLOAD_NAME.tar.gz"
mkdir -p "$PAYLOAD/bin" "$PAYLOAD/lib" "$PAYLOAD/remote-dev" "$OUTPUT_DIR"

cp "$REPO_ROOT/VERSION" "$PAYLOAD/VERSION"
cp "$REPO_ROOT/bin/dev" "$PAYLOAD/bin/dev"
cp "$REPO_ROOT/bin/devbox" "$PAYLOAD/bin/devbox"
cp "$REPO_ROOT/bin/devbox-status.30s.sh" "$PAYLOAD/bin/devbox-status.30s.sh"
cp "$REPO_ROOT/bin/sessions" "$PAYLOAD/bin/sessions"
cp "$REPO_ROOT/bin/dotfiles-tools" "$PAYLOAD/bin/dotfiles-tools"
cp "$REPO_ROOT/lib/dotfiles-tools-version.sh" "$PAYLOAD/lib/dotfiles-tools-version.sh"
cp "$REPO_ROOT/remote-dev/README.md" "$PAYLOAD/remote-dev/README.md"
cp "$REPO_ROOT/remote-dev/config.example" "$PAYLOAD/remote-dev/config.example"
cp "$REPO_ROOT/remote-dev/lib.sh" "$PAYLOAD/remote-dev/lib.sh"
cp "$REPO_ROOT/remote-dev/setup-remote.sh" "$PAYLOAD/remote-dev/setup-remote.sh"
cp "$REPO_ROOT/remote-dev/setup-sync.sh" "$PAYLOAD/remote-dev/setup-sync.sh"
cp "$REPO_ROOT/remote-dev/tmux.conf" "$PAYLOAD/remote-dev/tmux.conf"

{
  printf 'DOTFILES_TOOLS_RELEASE_VERSION=%s\n' "$VERSION"
  printf 'DOTFILES_TOOLS_RELEASE_COMMIT=%s\n' "$COMMIT"
  printf 'DOTFILES_TOOLS_RELEASE_TAG=%s\n' "$TAG"
  printf 'DOTFILES_TOOLS_RELEASE_COMMANDS=dev,devbox,devbox-status.30s.sh,sessions,dotfiles-tools\n'
} >"$PAYLOAD/release.env"

{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "name": "dotfiles-tools",\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "tag": "%s",\n' "$TAG"
  printf '  "commit": "%s",\n' "$COMMIT"
  printf '  "checksums": "checksums.txt"\n'
  printf '}\n'
} >"$PAYLOAD/manifest.json"

(
  cd "$PAYLOAD"
  find . -type f ! -name checksums.txt -print | LC_ALL=C sort | while IFS= read -r file; do
    file="${file#./}"
    printf '%s  %s\n' "$(sha256_file "$file")" "$file"
  done >checksums.txt
)

COPYFILE_DISABLE=1 tar --no-xattrs -czf "$BUILD_TMP/$ARCHIVE_NAME" -C "$BUILD_TMP" "$PAYLOAD_NAME"
mv "$BUILD_TMP/$ARCHIVE_NAME" "$OUTPUT_DIR/$ARCHIVE_NAME"
MANIFEST_NAME="$PAYLOAD_NAME-manifest.json"
cp "$PAYLOAD/manifest.json" "$OUTPUT_DIR/$MANIFEST_NAME"
{
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$ARCHIVE_NAME")" "$ARCHIVE_NAME"
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$MANIFEST_NAME")" "$MANIFEST_NAME"
} >"$OUTPUT_DIR/SHA256SUMS"

echo "built $OUTPUT_DIR/$ARCHIVE_NAME"
echo "wrote $OUTPUT_DIR/$MANIFEST_NAME"
echo "wrote $OUTPUT_DIR/SHA256SUMS"
