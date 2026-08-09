#!/usr/bin/env bash
# run.sh — lint + test the remote-dev scripts. Used locally and by the
# pre-commit hook. Requires shellcheck and bats-core (brew install shellcheck
# bats-core). Note: ~/.toolbox/bin/bats is a DIFFERENT tool — we resolve the
# real bats-core explicitly.
set -euo pipefail

STRICT=false
[[ "${1:-}" == "--strict" || "${CI:-}" == "true" ]] && STRICT=true

DIR="$(cd "$(dirname "$0")/../.." && pwd)" # repo root
cd "$DIR"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
BOLD=$'\033[1m'
RESET=$'\033[0m'
fail=0

# Resolve real bats-core (skip the Amazon toolbox 'bats' if it shadows PATH).
BATS=""
for c in /opt/homebrew/bin/bats /usr/local/bin/bats "$(command -v bats 2>/dev/null || true)"; do
  [ -x "$c" ] && "$c" --version 2>&1 | grep -qi '^Bats' && {
    BATS="$c"
    break
  }
done

SCRIPTS=(
  bin/dev
  bin/devbox
  bin/devbox-status.30s.sh
  bin/dotfiles-tools
  bin/sessions
  lib/*.sh
  release/*.sh
  remote-dev/*.sh
  remote-dev/test/run.sh
  remote-dev/test/pre-commit
)

echo "${BOLD}shellcheck${RESET}"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x --severity=warning "${SCRIPTS[@]}" &&
    echo "${GREEN}✓ shellcheck clean${RESET}" || fail=1
elif $STRICT; then
  echo "${RED}✗ shellcheck not installed (required in CI)${RESET}"
  fail=1
else
  echo "  (shellcheck not installed — skipping; brew install shellcheck)"
fi

echo "${BOLD}shfmt${RESET}"
if command -v shfmt >/dev/null 2>&1; then
  shfmt -i 2 -ci -d "${SCRIPTS[@]}" &&
    echo "${GREEN}✓ shfmt clean${RESET}" || {
    echo "${RED}✗ run: shfmt -i 2 -ci -w ${SCRIPTS[*]}${RESET}"
    fail=1
  }
elif $STRICT; then
  echo "${RED}✗ shfmt not installed (required in CI)${RESET}"
  fail=1
else
  echo "  (shfmt not installed — skipping; brew install shfmt)"
fi

echo "${BOLD}bats${RESET}"
if [ -n "$BATS" ]; then
  "$BATS" remote-dev/test/ test/ || fail=1
elif $STRICT; then
  echo "${RED}✗ bats-core not installed (required in CI)${RESET}"
  fail=1
else
  echo "  (bats-core not found — skipping; brew install bats-core)"
fi

# Real-shell integration test: sessions-motd.zsh must not trip the p10k
# instant-prompt warning. Needs a real p10k + gitstatus + zpty; self-skips
# (exit 77) on headless CI where instant prompt can't engage. Not fatal on skip.
echo "${BOLD}motd p10k (real shell)${RESET}"
if command -v zsh >/dev/null 2>&1; then
  # `|| rc=$?` so `set -e` doesn't abort run.sh when the test exits non-zero
  # (notably 77 = skipped on headless CI); we classify rc explicitly below.
  rc=0
  zsh test/motd-p10k-warning.zsh || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "${GREEN}✓ motd does not trip p10k instant-prompt warning${RESET}"
  elif [ "$rc" -eq 77 ]; then
    echo "  (skipped — no real p10k/gitstatus/tty in this environment)"
  else
    echo "${RED}✗ motd triggers the p10k instant-prompt warning${RESET}"
    fail=1
  fi
else
  echo "  (zsh not found — skipping)"
fi

[ "$fail" -eq 0 ] && echo "${GREEN}All checks passed.${RESET}" || {
  echo "${RED}Checks failed.${RESET}"
  exit 1
}
