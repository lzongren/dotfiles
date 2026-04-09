# Ghostty

[Ghostty](https://ghostty.org) terminal configuration.

## Installation

```bash
brew install --cask ghostty
```

## Setup

Ghostty reads its config from `~/.config/ghostty/config` on macOS.

```bash
mkdir -p ~/.config/ghostty
ln -sf ~/Workspace/dotfiles/ghostty/config ~/.config/ghostty/config
```

Reload config at any time from inside Ghostty: **Cmd+Shift+R**

## Font

Uses [Hack Nerd Font](https://www.nerdfonts.com/font-downloads) — same as the MacVim setup.

```bash
brew install --cask font-hack-nerd-font
```

## Theme

**Tomorrow Night Bright** — matches the MacVim color scheme. Ships built-in with Ghostty.

## Keybindings

| Key | Action |
|---|---|
| `Cmd+T` | New tab |
| `Cmd+W` | Close tab/split |
| `Cmd+D` | Split right |
| `Cmd+Shift+D` | Split down |
| `Cmd+Shift+H/J/K/L` | Navigate splits (vim-style) |
| `Cmd+1-9` | Jump to tab N |
| `Cmd+Shift+R` | Reload config |
| `Cmd+=/-` | Increase/decrease font size |
| `Cmd+0` | Reset font size |
