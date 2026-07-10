#!/bin/bash
# SwiftBar plugin: show devbox session status in the macOS menu bar.
# Filename encodes refresh interval (30s). Install SwiftBar, then symlink:
#   ln -sf ~/Personal/dotfiles/bin/devbox-status.30s.sh ~/Library/Application\ Support/SwiftBar/Plugins/
#
# Menu bar shows: "⬡ N" (N active sessions). Dropdown lists each session with
# state, idle time, running command, and working directory.

# SwiftBar runs with a minimal PATH; add Homebrew + user bins so ssh/timeout work.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin:$PATH"

# Resolve through symlink to find the real bin/ directory where devbox lives.
SELF="$(readlink -f "$0" 2>/dev/null || readlink "$0" 2>/dev/null || echo "$0")"
DEVBOX="$(cd "$(dirname "$SELF")" && pwd)/devbox"

# Grab raw status (timeout handled inside devbox status).
raw="$("$DEVBOX" status --raw 2>/dev/null)"
if [ -z "$raw" ]; then
  echo "⬡ – | color=#888888"
  echo "---"
  echo "devbox: unreachable | color=#cc4444"
  exit 0
fi

total="$(wc -l <<<"$raw" | tr -d ' ')"
attached="$(grep -c '|1|' <<<"$raw" || true)"

# Menu bar: green if any attached, gray if all detached
if [ "$attached" -gt 0 ]; then
  echo "⬡ ${attached}/${total} | sfcolor=#1a8c32"
else
  echo "⬡ 0/${total} | sfcolor=#888888"
fi
echo "---"

now="$(date +%s)"
while IFS='|' read -r name att act cmd path; do
  [ -n "$name" ] || continue

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

  # Color: green=attached+active, orange=attached+stale, dim=detached
  if [ "$att" = 1 ]; then
    if [ "$d" -lt 3600 ]; then
      color="#1a8c32" # dark green — active
    else
      color="#c47a15" # dark orange — attached but stale
    fi
    icon="●"
  else
    color="#999999" # gray — detached
    icon="○"
  fi

  # Shorten path: strip /local/home/<user> or /home/<user> → ~/rest
  short="$path"
  if [[ "$short" =~ ^/local/home/[^/]+(/.+)?$ ]]; then
    short="${BASH_REMATCH[1]#/}"
  elif [[ "$short" =~ ^/home/[^/]+(/.+)?$ ]]; then
    short="${BASH_REMATCH[1]#/}"
  fi
  # shellcheck disable=SC2088  # intentional display string, not a path to expand
  [ -z "$short" ] && short="~" || short="~/$short"

  echo "${icon} ${name} — ${cmd:-?} (${idle}) | sfcolor=${color} font=Menlo size=13"
  echo "  ${short} | sfcolor=#555555 font=Menlo size=11"
done <<<"$raw"

echo "---"
echo "Summarize (LLM) | terminal=true bash=$DEVBOX param1=status param2=--summary"
echo "Refresh | refresh=true"
echo "devbox doctor | terminal=true bash=$DEVBOX param1=doctor"
