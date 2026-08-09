# shellcheck shell=bash
# Shared version discovery for commands in the dotfiles-tools release suite.

dotfiles_tools_resolve_path() {
  local source_path="$1" source_dir target
  while [ -L "$source_path" ]; do
    source_dir="$(cd -P "$(dirname "$source_path")" && pwd)" || return 1
    target="$(readlink "$source_path")" || return 1
    case "$target" in
      /*) source_path="$target" ;;
      *) source_path="$source_dir/$target" ;;
    esac
  done
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)" || return 1
  printf '%s/%s\n' "$source_dir" "$(basename "$source_path")"
}

dotfiles_tools_metadata_value() {
  local key="$1" metadata_file="$2"
  sed -n "s/^${key}=//p" "$metadata_file" | head -1
}

dotfiles_tools_print_version() {
  local command_name="$1" script_path="$2"
  local resolved_path bin_dir suite_root metadata_file version commit tag dirty short_commit

  resolved_path="$(dotfiles_tools_resolve_path "$script_path")" || {
    printf '%s unknown\n' "$command_name"
    return 0
  }
  bin_dir="$(dirname "$resolved_path")"
  suite_root="$(cd "$bin_dir/.." 2>/dev/null && pwd)" || suite_root=""
  metadata_file="$suite_root/release.env"

  if [ -n "$suite_root" ] && [ -f "$metadata_file" ]; then
    version="$(dotfiles_tools_metadata_value DOTFILES_TOOLS_RELEASE_VERSION "$metadata_file")"
    commit="$(dotfiles_tools_metadata_value DOTFILES_TOOLS_RELEASE_COMMIT "$metadata_file")"
    [ -n "$version" ] || version="unknown"
    [ -n "$commit" ] || commit="unknown"
    short_commit="$(printf '%.12s' "$commit")"
    printf '%s %s (commit %s)\n' "$command_name" "$version" "$short_commit"
    return 0
  fi

  version=""
  [ -n "$suite_root" ] && [ -f "$suite_root/VERSION" ] && version="$(tr -d '[:space:]' <"$suite_root/VERSION")"
  [ -n "$version" ] || version="unknown"
  commit="unknown"
  dirty=""
  if [ -n "$suite_root" ] && command -v git >/dev/null 2>&1 && git -C "$suite_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    commit="$(git -C "$suite_root" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
    [ -z "$(git -C "$suite_root" status --porcelain --untracked-files=normal 2>/dev/null)" ] || dirty=".dirty"
  fi
  tag="${version}-dev+g${commit}${dirty}"
  printf '%s %s\n' "$command_name" "$tag"
}
