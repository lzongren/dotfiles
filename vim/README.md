# MacVim Setup

This directory contains the configuration files for MacVim/Vim.

## Quick Setup

### 1. Install MacVim
```bash
brew install macvim
brew install --cask macvim-app
```

### 2. Install vim-plug (Plugin Manager)
```bash
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
```

### 3. Create .vim Directory and Copy Config Files
```bash
mkdir -p ~/.vim/plugged

# Copy configuration files
cp vim/vimrc ~/.vim/vimrc
cp vim/gvimrc ~/.vim/gvimrc

# Create symbolic link
ln -s ~/.vim/vimrc ~/.vimrc
```

### 4. Install Required Font
```bash
brew tap homebrew/cask-fonts
brew install --cask font-hack-nerd-font
```

### 5. Install Python Tools (for ALE/Black formatter)
```bash
brew install pyenv
pip install black
```

### 6. Install Plugins
Open MacVim or vim and run:
```vim
:PlugInstall
```

### 7. Install coc.nvim Extensions (Optional)
```vim
:CocInstall coc-json coc-tsserver coc-python
```

## Configuration Overview

### Key Plugins
- **vim-plug**: Plugin manager
- **coc.nvim**: Intelligent code completion
- **ALE**: Asynchronous linting and formatting (with Black for Python)
- **NERDTree**: File explorer
- **CtrlP**: Fuzzy file finder
- **vim-airline**: Status line
- **vim-fugitive**: Git integration
- **vim-gitgutter**: Git diff in gutter
- **Tagbar**: Code structure browser

### Custom Key Mappings
- `Enter`: Add new line without entering insert mode
- `Backspace`: Delete character in normal mode
- `Ctrl+C`: Copy (yank)
- `Ctrl+V`: Paste
- `;`: Clear search highlight
- `Ctrl+A`: Select all
- `Cmd+N`: New tab (MacVim)
- `Cmd+W`: Close tab (MacVim)
- `Cmd+1-9`: Switch to tab 1-9 (MacVim)
- `Cmd+Enter`: Toggle fullscreen (MacVim)
- `Cmd+J/K`: Move lines up/down (MacVim)
- `F8`: Toggle TagBar

### Python-Specific Settings
- **Black formatter**: Auto-formats Python code on save
- **Line length**: 88 characters (Black default)
- **Linters**: flake8, pylint, pycodestyle (configured for 88 char lines)

### GUI Settings
- **Font**: Hack Nerd Font, size 12
- **Color scheme**: Tomorrow-Night-Bright
- **Line spacing**: 2
- **Anti-aliasing**: Enabled

## Troubleshooting

**If plugins don't install:**
```vim
:PlugClean
:PlugInstall
```

**If coc.nvim doesn't work:**
```bash
brew install node
# Then in vim
:CocUpdate
```

**If Black formatter doesn't work:**
```bash
which black
# Update the path in vimrc line 153 if needed
```

## Files
- `vimrc`: Main Vim configuration
- `gvimrc`: GUI-specific configuration (MacVim)
