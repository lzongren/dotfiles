# Versioned dotfiles tools

`dev`, `devbox`, `sessions`, and their support files share one SemVer release
train. A single suite version prevents a copied `devbox` from silently loading
an incompatible `remote-dev/lib.sh`.

## Install the same release on each machine

Bootstrap the installer from the exact tag you intend to install. Downloading
to a file keeps the bootstrap inspectable instead of piping network content
directly into a shell:

```bash
version=0.1.0
curl -fsSLo /tmp/dotfiles-tools \
  "https://raw.githubusercontent.com/lzongren/dotfiles/tools-v${version}/bin/dotfiles-tools"
chmod +x /tmp/dotfiles-tools
/tmp/dotfiles-tools install "$version"
```

The installer downloads `dotfiles-tools-X.Y.Z.tar.gz` and `SHA256SUMS` from
the matching GitHub Release, rejects mismatched metadata or checksums, verifies
the package's per-file checksums, and installs it under:

```text
~/.local/opt/dotfiles-tools/releases/X.Y.Z/
~/.local/opt/dotfiles-tools/current -> releases/X.Y.Z
~/.local/bin/devbox -> ../opt/dotfiles-tools/current/bin/devbox
```

Existing files in `~/.local/bin` are never replaced implicitly. Pass `--force`
to preserve each conflicting file with a `.before-dotfiles-tools-TIMESTAMP`
suffix before installing the managed link.

## Identify, update, verify, and roll back

```bash
devbox --version
dotfiles-tools status
dotfiles-tools latest
dotfiles-tools verify
dotfiles-tools update
dotfiles-tools rollback
dotfiles-tools list
```

Source-checkout commands identify themselves as `X.Y.Z-dev+gCOMMIT` and append
`.dirty` when tracked or untracked files differ. Release commands report the
immutable suite version and full release commit metadata packaged by CI.

## Publish a release

SemVer applies to the suite: breaking command/configuration changes increment
the major version, backward-compatible features the minor version, and fixes
the patch version.

One-time repository setup is part of the release trust boundary:

- Enable **immutable releases** in the repository's Releases settings before
  tagging. GitHub's workflow token cannot read this administration-only
  setting, so verify it from an authenticated administrator session as shown
  below; GitHub enforces immutability when the release is published.
- Protect `main` with all four PR checks: `lint-and-test (ubuntu-latest)`,
  `lint-and-test (macos-latest)`, `Release package (ubuntu-latest)`, and
  `Release package (macos-latest)`.

Verify the immutable-release setting with:

```bash
gh api -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/lzongren/dotfiles/immutable-releases --jq .enabled
```

1. Update `VERSION` in a PR and ensure the `CI` and `Release package` checks
   pass on both Ubuntu and macOS.
2. Merge the PR to `main`.
3. Tag that exact main commit and push the tag:

   ```bash
   version="$(tr -d '[:space:]' < VERSION)"
   git tag -a "tools-v${version}" -m "dotfiles-tools ${version}"
   git push origin "tools-v${version}"
   ```

The tag-triggered workflow refuses a tag that differs from `VERSION`, refuses
a commit outside `origin/main`, reruns the strict test suite, builds and smoke
tests the release archive, and then creates the GitHub Release with generated
notes, the versioned archive, manifest, and checksums.

If a tag-triggered run fails before it publishes a release, fix the workflow on
`main` and retry that existing tag without deleting or moving it:

```bash
gh workflow run release.yml --ref main -f tag="tools-v${version}"
```
