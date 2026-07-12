# Remote Dev: work on a cloud desktop from your laptop

Run your dev work on a remote host (e.g. an Amazon Linux 2 cloud desktop) while
keeping local files in sync. **mosh** gives a durable terminal that survives
sleep and network roaming, **tmux** keeps the session alive on the remote, and
**Mutagen** mirrors folders both ways so edits on either side stay in sync.

```
devbox  ──mosh──►  tmux 'main'  ──►  your shell   (runs on remote)
                                        ▲
Mutagen daemon (laptop) ────────────────┘
  <local folder> ⇄ remote <folder>       edits flow both ways, ~1s
```

## Why these tools

- **mosh over plain SSH** — SSH dies when your IP changes (Wi-Fi→cellular) or
  the laptop sleeps. mosh bootstraps over SSH, then runs over UDP syncing
  *screen state*, so it roams and survives sleep with instant local echo.
- **tmux on top of mosh** — mosh keeps the *connection* alive; tmux keeps the
  *session* alive on the remote (work keeps running through a full disconnect,
  and `new-session -A` re-attaches). mosh only syncs the visible screen, so
  tmux also restores scrollback.
- **Mutagen, not sshfs** — a network mount *hangs* the remote when the link
  drops. Mutagen keeps a real copy on each side and reconciles changes, so you
  always read native-speed local files; drops just pause/resume the sync.

## Configure

Host, username, and synced folders are **not** stored in this repo. Copy the
example config and fill in your values:

```bash
mkdir -p ~/.config/devbox
cp remote-dev/config.example ~/.config/devbox/config
$EDITOR ~/.config/devbox/config        # set DEVBOX_HOST and DEVBOX_SYNCS
```

`DEVBOX_HOST` is an SSH host alias (a `Host` entry in `~/.ssh/config`) or
`user@hostname`. `DEVBOX_SYNCS` lists folders to mirror.

## Setup

Two scripts, run from the laptop:

```bash
./remote-dev/setup-remote.sh      # provisions the remote (builds mosh + tmux)
./remote-dev/setup-sync.sh        # installs Mutagen + creates the file syncs
```

Put `bin/` on your PATH, then connect:

```bash
devbox            # mosh + auto-attach tmux session 'main'
devbox scratch    # a differently-named session
devbox list       # show running sessions without connecting
devbox status     # session table: state, idle, command, path
devbox status --summary  # natural language summary (uses claude CLI)
devbox doctor     # health-check every layer (see below)
devbox sync ls    # manage synced folders (see below)
devbox --raw      # plain mosh, no tmux
devbox --help     # usage + active host + synced folders
```

### Example: a full session

```bash
# One-time: register a synced folder
devbox sync add work ~/Documents/Work    # ~/Documents/Work ⇄ remote ~/work

# Day to day: connect from inside a synced folder
cd ~/Documents/Work/api
devbox api                               # opens tmux session 'api' in remote ~/work/api

# … work on the remote; edits sync back to the laptop within ~1s …

# Close the laptop / lose Wi-Fi — the session keeps running on the remote.
devbox api                               # re-attaches exactly where you left off

# Later, from another folder:
devbox list                              # api, main
devbox doctor                            # everything healthy?
```

Launching from inside a synced folder opens the remote session in the matching
remote path (`~/Documents/Work/api` → `~/work/api`); this applies only when
*creating* a session, so re-attaching keeps its own directory.

### Managing synced folders with `devbox sync`

Add or remove Mutagen syncs without hand-editing the config:

```bash
devbox sync ls                              # list configured folders
devbox sync add work ~/Documents/Work       # local ~/Documents/Work ⇄ remote ~/work
devbox sync add work ~/Documents/Work code  # …⇄ remote ~/code (explicit remote name)
devbox sync rm work                         # stop syncing (files kept on both sides)
```

`add` updates `~/.config/devbox/config` (with a `.bak` backup and a validate-or-rollback
guard) and creates the live Mutagen session in one step. `rm` removes the config entry and
terminates the session — it does **not** delete files on either side. Remote path defaults to
the sync name (under the remote home); pass a third arg for a different path, or an absolute path.

Each session name is independent and persists on the remote. Closing the tab
only drops the local connection — `devbox <name>` re-attaches. Forgot what's
running? `devbox list`.

### Troubleshooting with `devbox doctor`

If sync or `devbox` stops working — most often after the remote gets recycled
(dev desktops reboot every few days) — run `devbox doctor` for a per-layer
verdict:

```
devbox doctor — host: <your-host>
  ✓ mosh installed (laptop)
  ✓ mutagen installed (laptop)
  ✓ remote reachable (up 2 days)
  ✓ tmux on remote PATH
  ✓ mosh-server on remote PATH
  ✓ remote disk 44% used
  ✓ 2 tmux session(s) alive
  ✓ mutagen daemon running
  ✓ sync 'work' connected (Watching for changes)
```

Each line is pass (✓) / warn (!) / fail (✗) with a fix hint; exits non-zero if
anything failed. A **remote reboot** (dev desktops patch-reboot weekly) kills
the tmux server and pauses Mutagen — Mutagen auto-reconnects once the host is
back, and sessions are restored on your first `devbox <name>` afterwards:
tmux-resurrect + tmux-continuum snapshot the layout every 15 min and replay
sessions/windows/panes with their working directories on server start. Panes
that were running claude come back as `claude --continue` (resumes the last
conversation in that directory). If a sync shows disconnected long after,
`mutagen sync reset <name>`.

### What `setup-remote.sh` handles

The AL2 packages are unusable, so it builds from source and encodes the fixes:

- **mosh** — the EPEL build links protobuf 3.x but AL2 ships 2.5 (symbol-lookup
  crash); built from source against the system protobuf.
- **openssl** — AL2 has `openssl11` not `openssl-devel`; mosh's `configure`
  wants `openssl.pc`, so the script symlink-shims `openssl11.pc → openssl.pc`.
- **tmux** — system tmux is 1.8 (no `new-session -A`); builds 3.5a to
  `~/.local`, clears the stale 1.8 socket, and deploys [`tmux.conf`](tmux.conf).
- **PATH** — adds `~/.local/bin` via `.zshenv` so mosh's non-login shell finds
  the new binaries.
- **session persistence** — clones tmux-resurrect + tmux-continuum to
  `~/.tmux/plugins/` so sessions survive the weekly host reboot (see
  Troubleshooting above).

## `devbox` vs `dev`

Two different jobs, they compose:

| Command  | Where it runs | What it does |
|----------|---------------|--------------|
| `devbox` | laptop        | connect to the remote desktop (mosh + tmux) |
| [`dev`](../bin/dev) | inside the remote | open a project workspace (claude / yazi / lazygit) |

Typical flow: `devbox` to land on the remote, then `dev <project>` there.

## Daily use

- **Connect:** `devbox`. Close the laptop or change networks — reconnect with
  `devbox` and you're back in the same tmux session.
- **Files:** edit locally or on the remote; Mutagen syncs within ~1s. The
  daemon auto-starts at login and runs whether or not you're connected.
- **Sync status:** `mutagen sync list` (state, conflicts), `mutagen sync
  monitor <name>` (live). Conflicts (same file edited both sides) are flagged,
  never auto-resolved — fix the file, then `mutagen sync flush <name>`.

## Session status at a glance

After a day away it's easy to forget what sessions exist and which ones want
your attention. Three surfaces answer that, all fed by the same pipeline:
`devbox status` (CLI table + LLM summary), a Hammerspoon floating widget
(always on top), and an optional SwiftBar menu-bar plugin.

```
 LAPTOP (macOS)                                    │  REMOTE (cloud desktop)
                                                   │
 ┌────────────────────────────┐                    │
 │  Hammerspoon widget        │                    │
 │  (hammerspoon/init.lua)    │                    │
 │  ┌──────────────────────┐  │                    │
 │  │ DEVBOX   🔔 1 need…  │  │  every 30s         │
 │  │ 🔔 abc      zsh · 2m │──┼──────────┐         │
 │  │ ● api    claude · 3h │  │          ▼         │
 │  │ ○ main      zsh · 1d │  │   devbox status --raw
 │  └──────────────────────┘  │          │         │
 │   click row │    drag body │          │         │
 └─────────────┼──────────────┘          │         │
               │                         ▼         │
               │              ┌────────────────┐   │   ┌───────────────────┐
               │              │  bin/devbox    │  ssh  │  tmux server      │
               │              │  status        │───┼──►│  list-sessions -F │
               │              │                │   │   │  list-panes -F    │
               │              │  probe (1 ssh):│◄──┼───│                   │
               │              │  S|name|att|act│   │   │  #{session_*}     │
               │              │  P|…|bell|cmd|path    │  #{window_bell_flag}
               │              └───────┬────────┘   │   └───────────────────┘
               │                      │            │        ▲          ▲
               │                      ▼            │        │          │
               │              ┌────────────────┐   │     bell rung   title set
               │              │ lib.sh (awk)   │   │     by claude   "devbox:#S"
               │              │ devbox_status_ │   │     (\a on      (set-titles
               │              │ lines: merge   │   │     finish/     in tmux.conf)
               │              │ S+P → 1 line   │   │     input)      │
               │              │ per session    │   │        │        │
               │              └───────┬────────┘   │   ┌────┴────────┴────┐
               │                      │            │   │ claude / zsh /…  │
               │       name|att|act|bell|cmd|path  │   │ (your sessions)  │
               │                      │            │   └──────────────────┘
               │                      ▼            │
               │            back to widget → draw  │
               │                                   │
   ┌───────────▼───────────────────────────┐       │
   │ clickSession(name)                    │       │
   │                                       │       │
   │ 1. AX API: scan Ghostty tab titles    │       │
   │    for "devbox:<name>"                │       │
   │    found? ──► AXPress → focus tab ────┼──► Ghostty tab
   │                                       │    (already attached)
   │ 2. not found? ──► ghostty -e          │       │
   │       devbox <name> ──────────────────┼──► new Ghostty window
   │                                       │    └─► mosh ──► tmux attach
   └───────────────────────────────────────┘       │
```

Three loops tie it together:

1. **Status loop (every 30s):** widget → `devbox status --raw` → one ssh probe
   → tmux formats (`S|` session lines + `P|` pane lines with the bell flag) →
   awk merge in `lib.sh` → `name|attached|activity|bell|cmd|path` → the widget
   colors each row (🔔 yellow / ● green / ● orange / ○ gray).
2. **Attention loop (event-driven):** a command finishes and rings the bell
   (`\a`) → tmux sets `window_bell_flag` on that window → the next probe picks
   it up → the row turns 🔔 yellow. Same signal Ghostty uses for its tab alert
   — one bell, two surfaces.
3. **Focus loop (on click):** tmux titles each tab `devbox:<session>`
   (`set-titles-string`) → the widget walks Ghostty's accessibility tree for a
   matching tab title → found: `AXPress` focuses the tab; not found:
   `ghostty -e devbox <name>` opens a fresh attached window.

The widget has no state of its own — tmux on the remote is the single source
of truth, `devbox status` is the only pipe, and Ghostty tab titles are the
join key between remote sessions and local tabs.

### Hammerspoon floating widget

`hammerspoon/init.lua` draws an always-on-top panel listing every session:
state icon, name, running command, idle time, and working directory. Yellow 🔔
rows rang their bell (e.g. claude finished and wants input). Click a row to
jump to that session's Ghostty tab (or open one); drag anywhere to move it;
**Ctrl+Opt+D** toggles visibility.

```bash
brew install --cask hammerspoon
mkdir -p ~/.hammerspoon
cp hammerspoon/init.lua ~/.hammerspoon/init.lua   # or symlink
```

Grant Hammerspoon **Accessibility** permission (System Settings → Privacy &
Security) — needed for click-to-focus and dragging. Force a refresh from a
shell with `hs -c 'refresh()'`.

### macOS menu-bar status (SwiftBar, optional)

`bin/devbox-status.30s.sh` is a [SwiftBar](https://github.com/swiftbar/SwiftBar)
plugin showing the same status in the menu bar. Install, then symlink:

```bash
brew install --cask swiftbar
ln -sf ~/Personal/dotfiles/bin/devbox-status.30s.sh \
  ~/Library/Application\ Support/SwiftBar/Plugins/
```

The menu bar shows `⬡ 3/7` (3 attached / 7 total), or `⬡ 🔔1` when a session
needs attention. The dropdown lists each session; "Summarize" runs
`devbox status --summary` for a natural-language recap of what work is active.

## Working without VPN

Everything ssh-based (`devbox status/list/sync/doctor`, Mutagen) works off VPN
once ssh is tunnelled through **WSSH**: a `Match … !exec "nc -z …"` block in
`~/.ssh/config` adds `ProxyCommand wssh proxy %h` only when the host isn't
directly reachable, so on VPN nothing changes. Requirements: WSSH installed
(self-service store) and a live midway AEA session (`mwinit`; the AEA posture
cookie is attached by default).

mosh is the exception — it needs direct UDP, which no ssh tunnel carries.
`devbox` auto-detects: direct route → mosh; otherwise → `ssh -t … tmux` with
the same auto-attach semantics. You keep persistent sessions (tmux lives on
the remote); you lose only mosh's roaming/instant-echo. Force a transport with
`DEVBOX_TRANSPORT=mosh|ssh`. `devbox doctor` reports cert validity and which
transport is active.

## Notes

- **Excluded from sync:** VCS internals, `node_modules/`, `build/` (build trees
  may have machine-specific absolute symlinks), `*.mov`/`*.mp4`, and caches.
  Adjust the `DEVBOX_IGNORES` array in `lib.sh`.
- **Folders synced** are defined by `DEVBOX_SYNCS` in `~/.config/devbox/config`
  (manage with `devbox sync add`/`rm`).
- **mosh UDP** uses ports 60000–61000; the dev host's firewall must allow
  inbound UDP (open by default on these AL2 hosts).

## Development

Config-mutation logic lives in `lib.sh` (`devbox_config_add`/`rm`,
`devbox_syncs_list`) and is covered by tests. Lint and test with:

```bash
./remote-dev/test/run.sh          # shellcheck + bats
```

Requires `brew install shellcheck bats-core` (note: `~/.toolbox/bin/bats` is a
different tool; the runner resolves real bats-core). Install the pre-commit hook
so checks run automatically when `bin/devbox` or `remote-dev/` files are staged.
This honours a global `core.hooksPath` if you have one, and the hook is a no-op
in repos without `remote-dev/test/run.sh`, so it's safe to install globally:

```bash
hooks="$(git config --get core.hooksPath || echo "$(git rev-parse --show-toplevel)/.git/hooks")"
mkdir -p "$hooks"
ln -sf "$(git rev-parse --show-toplevel)/remote-dev/test/pre-commit" "$hooks/pre-commit"
```
