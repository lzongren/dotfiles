#!/usr/bin/env bash
# run.sh — lint + test the remote-dev scripts. Used locally and by the
# pre-commit hook. Requires shellcheck and bats-core (brew install shellcheck
# bats-core). Note: ~/.toolbox/bin/bats is a DIFFERENT tool — we resolve the
# real bats-core explicitly.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"          # repo root
cd "$DIR"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fail=0

# Resolve real bats-core (skip the Amazon toolbox 'bats' if it shadows PATH).
BATS=""
for c in /opt/homebrew/bin/bats /usr/local/bin/bats "$(command -v bats 2>/dev/null || true)"; do
  [ -x "$c" ] && "$c" --version 2>&1 | grep -qi '^Bats' && { BATS="$c"; break; }
done

echo "${BOLD}shellcheck${RESET}"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x --severity=warning bin/devbox remote-dev/*.sh \
    && echo "${GREEN}✓ shellcheck clean${RESET}" || fail=1
else
  echo "  (shellcheck not installed — skipping; brew install shellcheck)"
fi

echo "${BOLD}bats${RESET}"
if [ -n "$BATS" ]; then
  "$BATS" remote-dev/test/ || fail=1
else
  echo "  (bats-core not found — skipping; brew install bats-core)"
fi

[ "$fail" -eq 0 ] && echo "${GREEN}All checks passed.${RESET}" || { echo "${RED}Checks failed.${RESET}"; exit 1; }
