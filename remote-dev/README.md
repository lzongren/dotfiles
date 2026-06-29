# Remote Dev: Claude Code on a cloud desktop

Run Claude Code on a remote cloud desktop (`zongrenl-dev`, Amazon Linux 2)
while keeping laptop files in sync. **mosh** gives a durable terminal that
survives sleep and network roaming, **tmux** keeps the session alive on the
remote, and **Mutagen** mirrors folders both ways so CC edits files that stay
in sync on the laptop.

```
devbox  ──mosh──►  tmux 'main'  ──►  claude   (runs on remote)
                                       ▲
Mutagen daemon (laptop) ───────────────┘
  ~/Documents/ATX ⇄ remote ~/ATX        edits flow both ways, ~1s
  ~/Documents/IDF ⇄ remote ~/IDF
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

## Setup

Two scripts, run from the laptop:

```bash
./remote-dev/setup-remote.sh      # provisions the remote (builds mosh + tmux)
./remote-dev/setup-sync.sh        # installs Mutagen + creates the file syncs
```

Then add the connector alias / put `bin/` on PATH and connect:

```bash
devbox            # mosh + auto-attach tmux session 'main'
devbox scratch    # a differently-named session
devbox list       # show running sessions without connecting
devbox --raw      # plain mosh, no tmux
```

Each session name is independent and persists on the remote. Closing the tab
only drops the local connection — `devbox <name>` re-attaches. Forgot what's
running? `devbox list`.

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

Typical flow: `devbox` to land on the remote, then `dev ~/ATX/some-project`.

## Daily use

- **Connect:** `devbox`. Close the laptop or change networks — reconnect with
  `devbox` and you're back in the same tmux session.
- **Files:** edit in `~/Documents/{ATX,IDF}` on the laptop or `~/{ATX,IDF}` on
  the remote; Mutagen syncs within ~1s. The daemon auto-starts at login and
  runs whether or not you're connected via `devbox`.
- **Sync status:** `mutagen sync list` (state, conflicts), `mutagen sync
  monitor atx` (live). Conflicts (same file edited both sides) are flagged,
  never auto-resolved — fix the file, then `mutagen sync flush atx`.

## Notes

- **Excluded from sync:** VCS internals, `node_modules/`, `build/` (Brazil
  build trees have machine-specific absolute symlinks), `*.mov`/`*.mp4`, and
  caches. Adjust the `IGNORES` array in `setup-sync.sh`.
- **Folders synced** are defined in the `SYNCS` array in `setup-sync.sh`.
- **mosh UDP** uses ports 60000–61000; the dev desktop's firewall must allow
  inbound UDP (open by default on these AL2 hosts).
