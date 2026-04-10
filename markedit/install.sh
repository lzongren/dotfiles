#!/usr/bin/env bash
# Install or update the MarkEdit-preview extension
# https://github.com/MarkEdit-app/MarkEdit-preview

set -euo pipefail

REPO="MarkEdit-app/MarkEdit-preview"
DEST="$HOME/Library/Containers/app.cyan.markedit/Data/Documents/scripts"
FILE="markedit-preview.js"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log() { echo -e "${BLUE}▶${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }
die() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

# Resolve latest release download URL via GitHub API
log "Fetching latest release info from ${BOLD}${REPO}${RESET}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

RELEASE_JSON=$(curl -fsSL "$API_URL") || die "Failed to fetch release info"

DOWNLOAD_URL=$(echo "$RELEASE_JSON" \
  | grep -o '"browser_download_url": *"[^"]*\.zip"' \
  | head -1 \
  | sed 's/.*"\(https[^"]*\)"/\1/')

[[ -z "$DOWNLOAD_URL" ]] && die "Could not find download URL in release JSON"

TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"/\1/')
log "Latest version: ${BOLD}${TAG}${RESET}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

log "Downloading release archive"
curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/release.zip"

unzip -qo "$TMPDIR/release.zip" -d "$TMPDIR"

# Find the full (non-lite) markedit-preview.js
SRC=$(find "$TMPDIR" -name "$FILE" -not -path "*/lite/*" | head -1)
[[ -z "$SRC" ]] && die "Could not find ${FILE} in release archive"

mkdir -p "$DEST"
cp "$SRC" "$DEST/$FILE"

ok "Installed ${BOLD}${FILE}${RESET} (${TAG})"
echo -e "  Restart MarkEdit to apply the changes."
