# Remote Dev: Claude Code on a cloud desktop

Run Claude Code on a remote dev host (e.g. an Amazon Linux 2 cloud desktop)
while keeping local files in sync. **mosh** gives a durable terminal that
survives sleep and network roaming, **tmux** keeps the session alive on the
remote, and **Mutagen** mirrors folders both ways so CC edits files that stay
in sync on the laptop.

```
devbox  ──mosh──►  tmux 'main'  ──►  claude   (runs on remote)
                                       ▲
Mutagen daemon (laptop) ───────────────┘
  <local folder> ⇄ remote <folder>      edits flow both ways, ~1s
```

## Why these tools

- **mosh over plain SSH** — SSH dies when your IP changes (Wi-Fi→cellular) or
  the laptop sleeps. mosh bootstraps over SSH, then runs over UDP syncing
  *screen state*, so it roams and survives sleep with instant local echo.
- **tmux on top of mosh** — mosh keeps the *connection* alive; tmux keeps the
  *session* alive on the remote (CC keeps running through a full disconnect,
  and `new-session -A` re-attaches). mosh only syncs the visible screen, so
  tmux also restores scrollback.
- **Mutagen, not sshfs** — a network mount *hangs* the remote (and CC) when the
  link drops. Mutagen keeps a real copy on each side and reconciles changes, so
  CC always reads native-speed local files; drops just pause/resume the sync.

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
devbox doctor     # health-check every layer (see below)
devbox --raw      # plain mosh, no tmux
devbox --help     # usage + active host + synced folders
```

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
anything failed. A **remote reboot** kills tmux sessions and pauses Mutagen —
sessions are gone (files are safe on the laptop), and Mutagen auto-reconnects
once the host is back. If a sync shows disconnected long after, `mutagen sync
reset <name>`.

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

## Notes

- **Excluded from sync:** VCS internals, `node_modules/`, `build/` (build trees
  may have machine-specific absolute symlinks), `*.mov`/`*.mp4`, and caches.
  Adjust the `IGNORES` array in `setup-sync.sh`.
- **Folders synced** are defined by `DEVBOX_SYNCS` in `~/.config/devbox/config`.
- **mosh UDP** uses ports 60000–61000; the dev host's firewall must allow
  inbound UDP (open by default on these AL2 hosts).
