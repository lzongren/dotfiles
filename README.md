# dotfiles

My personal configuration files for various tools and applications.

## Contents

### [Vim/MacVim](vim/)
MacVim/Vim configuration with modern plugins for code completion, linting, and formatting.
- Plugin manager: vim-plug
- Completion: coc.nvim
- Linting/Formatting: ALE with Black for Python
- Multiple language support (Python, Ruby, JavaScript, Scala, etc.)

### [Ghostty](ghostty/)
Terminal emulator configuration.
- Theme: Tomorrow Night Bright (matches MacVim)
- Font: Hack Nerd Font 13pt
- vim-style split navigation, tab switching, shell integration

### [bin](bin/)
Personal scripts for `~/.local/bin`.
- `dev` — open a project workspace with claude, yazi, and lazygit in tmux
- `devbox` — connect to a remote dev host over mosh + tmux (see [remote-dev](remote-dev/))

### [remote-dev](remote-dev/)
Run Claude Code on a remote dev host with local files kept in sync.
- mosh + tmux for a durable, persistent remote session
- Mutagen for two-way file sync (no fragile network mounts)
- Host and folders configured via a gitignored `~/.config/devbox/config`

### [MarkEdit](markedit/)
Extensions for the MarkEdit markdown editor.
- `install.sh` — downloads and installs the latest MarkEdit-preview extension (Mermaid, KaTeX, syntax highlighting)

## Setup

Navigate to each subdirectory for specific setup instructions.

## Quick Links
- [MacVim Setup](vim/README.md)
- [Ghostty Setup](ghostty/README.md)
- [MarkEdit Setup](markedit/README.md)
- [Remote Dev Setup](remote-dev/README.md)
