#!/usr/bin/env zsh
# motd-p10k-warning.zsh — REAL in-use test: prove that sourcing sessions-motd.zsh
# ABOVE the Powerlevel10k instant-prompt preamble does NOT trigger the
# "Console output during zsh initialization detected" warning, while sourcing it
# BELOW the preamble DOES (so the test can actually fail).
#
# This validates the fix's core claim: the motd must print BEFORE p10k's instant
# prompt engages, so p10k captures nothing (no warning AND no prompt jump — the
# "Recommended" outcome). Both positions are tested in p10k's real verbose mode.
#
# Unlike test/sessions.bats (which unit-tests bin/sessions with mock data), this
# spins up genuine interactive zsh sessions under a zsh/zpty PTY with real p10k +
# gitstatus and asserts on p10k's actual startup behavior.
#
# Usage:   zsh test/motd-p10k-warning.zsh
# Exit:    0 = pass (below warns, above clean)  1 = fail  77 = skipped
#
# Skips (exit 77) when the environment can't run the check: no zsh/zpty, no p10k
# theme, no ~/.p10k.zsh, or no ~/.cache/gitstatus (headless CI) — p10k's instant
# prompt only engages on a real terminal that answers cursor-position queries.
#
# Why zpty: p10k's instant prompt only engages if the cache file
#   $XDG_CACHE_HOME/p10k-instant-prompt-<user>.zsh
# exists at launch, written by an async `zle -F` callback that needs real zle
# idle cycles + terminal query responses. A bare expect/script(1) PTY never
# primes it; zpty answers the DSR/DA queries so the prompt renders and the dump
# fires. We prime with a motd-free zshrc (the cache signature is cwd:P9K_SSH:%#,
# independent of the motd), then exhibit with the position under test.

emulate -L zsh
setopt no_unset pipe_fail

zmodload zsh/zpty 2>/dev/null     || { print -r -- "SKIP: no zsh/zpty";       exit 77 }
zmodload zsh/datetime 2>/dev/null || { print -r -- "SKIP: no zsh/datetime";   exit 77 }

local SELF_DIR=${0:A:h}
local REPO=${SELF_DIR:h}
local MOTD=$REPO/sessions-motd.zsh
local THEME
for THEME in /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme \
             /usr/share/powerlevel10k/powerlevel10k.zsh-theme \
             $HOME/.oh-my-zsh/custom/themes/powerlevel10k/powerlevel10k.zsh-theme; do
  [[ -r $THEME ]] && break
done
[[ -r $MOTD ]]           || { print -r -- "SKIP: no sessions-motd.zsh at $MOTD"; exit 77 }
[[ -r $THEME ]]          || { print -r -- "SKIP: powerlevel10k theme not found"; exit 77 }
[[ -r $HOME/.p10k.zsh ]] || { print -r -- "SKIP: no ~/.p10k.zsh";                exit 77 }
[[ -d $HOME/.cache/gitstatus ]] || { print -r -- "SKIP: no ~/.cache/gitstatus (headless?)"; exit 77 }

local user=${(%):-%n}

# run_pos <above|below> — build an isolated HOME whose .zshrc sources the motd in
# the given position relative to the instant-prompt preamble, force verbose mode
# (so a clean result means p10k truly captured nothing), prime, exhibit, and
# print WARNED / CLEAN / INVALID.
run_pos() {
  local pos=$1
  local ISO WORK CACHE
  ISO=$(mktemp -d "${TMPDIR:-/tmp}/motdp10k.XXXXXX")
  WORK=$ISO/work
  mkdir -p $ISO/.cache $WORK
  ln -s $HOME/.cache/gitstatus $ISO/.cache/gitstatus
  cp $HOME/.p10k.zsh $ISO/.p10k.zsh
  # Real session data so bin/sessions actually prints something (else no output,
  # no warning, regardless of position). Symlinked read-only; writes go to $ISO.
  [[ -d $HOME/.claude ]] && ln -s $HOME/.claude $ISO/.claude
  [[ -d $HOME/.codex  ]] && ln -s $HOME/.codex  $ISO/.codex
  CACHE=$ISO/.cache/p10k-instant-prompt-$user.zsh

  local motdline="source $MOTD"
  local preamble='if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi'

  # $1 = "motd" to include the motd, "" to prime motd-free.
  write_zshrc() {
    local m=""
    [[ $1 == motd ]] && m=$motdline
    if [[ $pos == above ]]; then
      print -r -- "$m"                        >  $ISO/.zshrc
      print -r -- "$preamble"                 >> $ISO/.zshrc
    else
      print -r -- "$preamble"                 >  $ISO/.zshrc
    fi
    print -r -- "source $THEME"               >> $ISO/.zshrc
    print -r -- '[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh' >> $ISO/.zshrc
    [[ $pos == below ]] && print -r -- "$m"   >> $ISO/.zshrc
    # Force verbose regardless of ~/.p10k.zsh: a CLEAN result then proves p10k
    # captured no output (no warning AND no jump), not merely that it was silenced.
    print -r -- 'typeset -g POWERLEVEL9K_INSTANT_PROMPT=verbose' >> $ISO/.zshrc
  }

  local CAPTURE SENT_OK
  run_shell() {
    local -F first=$1; shift
    local -a lines=("$@")
    local name=motd$$_${RANDOM} out="" chunk
    HOME=$ISO ZDOTDIR=$ISO XDG_CACHE_HOME=$ISO/.cache \
      zpty -b $name "cd $WORK && exec zsh -i"
    drain() {
      local -F until=$(( EPOCHREALTIME + $1 )); local pat=${2:-} chunk
      while (( EPOCHREALTIME < until )); do
        chunk=""
        if zpty -r -t $name chunk 2>/dev/null; then
          out+=$chunk
          [[ $chunk == *$'\e[6n'* ]] && zpty -w -n $name $'\e[1;1R'
          [[ $chunk == *$'\e[c'* || $chunk == *$'\e[0c'* ]] && zpty -w -n $name $'\e[?1;2c'
          [[ $chunk == *$'\e[>'*c* ]] && zpty -w -n $name $'\e[>0;276;0c'
          [[ -n $pat && $out == *$pat* ]] && return 0
        else
          sleep 0.03
        fi
      done
      [[ -n $pat ]] && return 1 || return 0
    }
    drain $first
    local l
    for l in "${lines[@]}"; do zpty -w $name "$l"; zpty -w -n $name $'\r'; drain 1.4; done
    zpty -w $name "print __MOTD_DONE__"; zpty -w -n $name $'\r'
    drain 8 "__MOTD_DONE__"; SENT_OK=$?
    zpty -w $name "exit"; zpty -w -n $name $'\r'; drain 0.6
    zpty -d $name 2>/dev/null
    CAPTURE=$out
  }

  # prime (motd-free) until the instant-prompt cache exists
  write_zshrc ""
  local -i i
  for (( i=1; i<=3; i++ )); do
    run_shell 1.4 "true"
    [[ -r $CACHE ]] && (( i >= 2 )) && break
  done
  if [[ ! -r $CACHE ]]; then rm -rf $ISO; print -r -- "INVALID"; return; fi

  # exhibit with the motd in the position under test
  write_zshrc motd
  FIRST_DRAIN=8 run_shell 8
  local exhibit=$CAPTURE
  local clean=${(S)exhibit//$'\e'[\[\]]([0-9\;\?]#)[a-zA-Z]/}
  clean=${clean//$'\e'[=>]/}; clean=${clean//$'\r'/}; clean=${clean//$'\a'/}

  if (( SENT_OK != 0 )); then rm -rf $ISO; print -r -- "INVALID"; return; fi
  local -i warned=0 motd=0
  [[ $exhibit == *"Console output during zsh initialization detected"* ]] && warned=1
  [[ $clean  == *"Recent agent sessions"* ]] && motd=1
  rm -rf $ISO
  (( warned )) && { print -r -- "WARNED(motd=$motd)"; return; }
  (( motd )) && { print -r -- "CLEAN(motd=$motd)"; return; }
  print -r -- "CLEAN-NOMOTD"
}

print -r -- "==> real-shell p10k instant-prompt test (zpty, isolated HOME, verbose mode)"

print -rn -- "    control: motd BELOW preamble (must warn): "
local below=$(run_pos below)
print -r -- "$below"

print -rn -- "    fix:     motd ABOVE preamble (must be clean): "
local above=$(run_pos above)
print -r -- "$above"

# Verdicts
if [[ $below == INVALID || $above == INVALID ]]; then
  print -r -- "SKIP: instant prompt would not prime in this environment (no real TTY?)"
  exit 77
fi
if [[ $below != WARNED* ]]; then
  print -r -- "SKIP: control (below) did not warn ($below) — harness cannot detect the warning here"
  exit 77
fi
if [[ $above == WARNED* ]]; then
  print -r -- "FAIL: motd above the preamble STILL triggers the p10k warning ($above)"
  exit 1
fi
if [[ $above != CLEAN\(motd=1\) ]]; then
  print -r -- "FAIL: motd above the preamble is clean but the motd did not print ($above)"
  exit 1
fi
print -r -- "PASS: below-preamble warns, above-preamble is clean and prints the motd"
exit 0
