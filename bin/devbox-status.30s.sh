#!/bin/bash
# SwiftBar plugin: show devbox session status in the macOS menu bar.
# Filename encodes refresh interval (30s). Install SwiftBar, then symlink:
#   ln -sf ~/Personal/dotfiles/bin/devbox-status.30s.sh ~/Library/Application\ Support/SwiftBar/Plugins/
#
# Menu bar shows: "⬡ N" (N active sessions). Dropdown lists each session with
# state, idle time, running command, and working directory.

DEVBOX="$(cd "$(dirname "$0")" && pwd)/devbox"

# Grab raw status (timeout handled inside devbox status).
raw="$("$DEVBOX" status --raw 2>/dev/null)"
if [ -z "$raw" ]; then
  echo "⬡ –"
  echo "---"
  echo "devbox: unreachable | color=red"
  exit 0
fi

total="$(wc -l <<<"$raw" | tr -d ' ')"
attached="$(grep -c '|1|' <<<"$raw" || true)"

echo "⬡ ${attached}/${total}"
echo "---"

now="$(date +%s)"
while IFS='|' read -r name att act cmd path; do
  [ -n "$name" ] || continue
  icon="●"
  [ "$att" = 0 ] && icon="○"
  # Compact idle time
  d=$((now - act))
  [ "$d" -lt 0 ] && d=0
  if [ "$d" -lt 60 ]; then
    idle="${d}s"
  elif [ "$d" -lt 3600 ]; then
    idle="$((d / 60))m"
  elif [ "$d" -lt 86400 ]; then
    idle="$((d / 3600))h"
  else idle="$((d / 86400))d"; fi

  # Shorten path: strip /local/home/<user> or /home/<user> → ~/rest
  short="$path"
  if [[ "$short" =~ ^/local/home/[^/]+(/.+)?$ ]]; then
    short="${BASH_REMATCH[1]#/}"
  elif [[ "$short" =~ ^/home/[^/]+(/.+)?$ ]]; then
    short="${BASH_REMATCH[1]#/}"
  fi
  # shellcheck disable=SC2088  # intentional display string, not a path to expand
  [ -z "$short" ] && short="~" || short="~/$short"

  echo "${icon} ${name} — ${cmd:-?} (${idle}) | font=Menlo size=12"
  echo "  ${short} | font=Menlo size=11 color=gray"
done <<<"$raw"

echo "---"
echo "Summarize (LLM) | terminal=true bash=$DEVBOX param1=status param2=--summary"
echo "Refresh | refresh=true"
echo "devbox doctor | terminal=true bash=$DEVBOX param1=doctor"
