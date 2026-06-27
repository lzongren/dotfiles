#!/bin/bash
input=$(cat)

# Ponytail indicator
PT=""
flag="$HOME/.claude/.ponytail-active"
if [ -f "$flag" ]; then
  mode=$(head -n1 "$flag" | tr -d '[:space:]')
  if [ -z "$mode" ] || [ "$mode" = "full" ]; then
    PT="\x1b[38;5;108mPT\x1b[0m "
  else
    PT="\x1b[38;5;108mPT:$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')\x1b[0m "
  fi
fi

MODEL=$(echo "$input" | jq -r '.model.id // "?"' | sed 's/claude-//;s/global\.anthropic\.//;s/us\.anthropic\.//;s/-v[0-9].*//;s/\[.*//')
EFFORT=$(echo "$input" | jq -r '.effort.level // empty')
CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size')
USAGE=$(echo "$input" | jq '.context_window.current_usage')
ADDED=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
REMOVED=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
RATE5=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
CWD=$(echo "$input" | jq -r '.cwd // "."' | sed "s|^$HOME|~|;s|^/local/home/$USER|~|;s|~/cdd[0-9]*/Volumes/workspace/|~/ws/|;s|/src/\([^/]*\)/|/\1/|")
BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null)
COLS=${COLUMNS:-120}

# Context %
if [ "$USAGE" != "null" ] && [ "$USAGE" != "" ]; then
  CURRENT_TOKENS=$(echo "$USAGE" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
  PERCENT=$((CURRENT_TOKENS * 100 / CONTEXT_SIZE))
else
  PERCENT=0
fi

# Color context by severity
if [ "$PERCENT" -ge 80 ]; then
  CTX="\x1b[31m${PERCENT}%\x1b[0m"
elif [ "$PERCENT" -ge 50 ]; then
  CTX="\x1b[33m${PERCENT}%\x1b[0m"
else
  CTX="\x1b[32m${PERCENT}%\x1b[0m"
fi

# Model + effort
MDL="\x1b[38;2;218;119;86m${MODEL}\x1b[0m"
if [ -n "$EFFORT" ] && [ "$EFFORT" != "high" ]; then
  MDL="${MDL}\x1b[2m/${EFFORT}\x1b[0m"
fi

# Cost (always show)
COST_STR=" \x1b[33m\$$(printf '%.2f' "${COST:-0}")\x1b[0m"

# Rate limit (only when hot)
RATE=""
if [ -n "$RATE5" ]; then
  R5=$(printf '%.0f' "$RATE5")
  if [ "$R5" -ge 60 ]; then
    RATE=" \x1b[31mrl:${R5}%\x1b[0m"
  elif [ "$R5" -ge 30 ]; then
    RATE=" \x1b[33mrl:${R5}%\x1b[0m"
  fi
fi

# Branch (truncate)
BR=""
if [ -n "$BRANCH" ]; then
  [ ${#BRANCH} -gt 16 ] && BRANCH="${BRANCH:0:14}.."
  BR=" \x1b[38;5;141m${BRANCH}\x1b[0m"
fi

# Lines
LINES="\x1b[38;2;54;152;64m+${ADDED}\x1b[0m \x1b[38;2;180;50;72m-${REMOVED}\x1b[0m"

# Build left side
LEFT="${PT}${MDL} ${CTX}${COST_STR} ${LINES}${BR}${RATE}"
LEFT_PLAIN=$(printf '%b' "$LEFT" | sed $'s/\x1b\[[0-9;]*m//g')
LEFT_LEN=${#LEFT_PLAIN}

# Right side: path — truncate from left if needed
AVAIL=$((COLS - LEFT_LEN - 2))
if [ ${#CWD} -gt "$AVAIL" ] && [ "$AVAIL" -gt 5 ]; then
  CWD="..${CWD:$(( ${#CWD} - AVAIL + 2 ))}"
fi
RIGHT="\x1b[2m${CWD}\x1b[0m"

GAP=$((COLS - LEFT_LEN - ${#CWD}))
[ "$GAP" -lt 1 ] && GAP=1
PADDING=$(printf '%*s' "$GAP" '')

printf '%b%s%b\n' "$LEFT" "$PADDING" "$RIGHT"
