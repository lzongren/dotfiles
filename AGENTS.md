# AGENTS.md

Guidance for coding agents working in this repo.

## Comments and docstrings

**Hard default for a PR diff: add zero new inline comments.** A bug fix almost never
needs one; the code plus a good test says it. Before opening or updating a PR, re-read
every added line and delete each new `#` or `--` comment unless it is one of the narrow
exceptions below AND you can name which exception it is. "It explains what I did" is not
an exception; that is narration, and it belongs in the commit message or PR description.
Ship the diff with no comments rather than with explanatory ones. Leftover narration on
an agent-authored PR is a defect, not a nicety.

Keep a comment only when it records information the code cannot express:

- a cross-tool contract or quirk (how Mutagen, tmux, ssh, mosh, or bats actually behave);
- why the straightforward implementation is unsafe or incorrect;
- an ordering, concurrency, security, or cleanup invariant;
- a stable edge case that a future editor could easily violate.

Do not add:

- narration of the next statement or phase;
- docstrings that restate a name, signature, test assertion, or return value;
- implementation walkthroughs that duplicate the code;
- volatile details: counts, timings, versions, host names, usernames, or network topology;
- historical notes, commented-out code, or TODO/FIXME entries without a linked issue.

In shell, a short `Args:` note on a function is fine: positional parameters have no
names otherwise. Tool directives (`# shellcheck ...`, shebangs) and user-facing help text
are not comments for this rule.

Prefer a precise name, a focused helper, or an executable check (a bats test) over
prose. If a comment is still needed, explain why the constraint exists and link its
authoritative source (upstream docs or a GitHub issue) where possible.

## Public repo

Never put internal hostnames, account IDs, usernames, private URLs, or employer-internal
tool and project names in code, comments, tests, commit messages, or PR descriptions.
Host-specific values live in `~/.config/devbox/config`, outside the repo.
