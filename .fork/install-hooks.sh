#!/usr/bin/env bash
# Install the fork's git hooks in the common git hooks directory and unset core.hooksPath
# so every branch and worktree uses .fork/pre-commit and .fork/pre-push instead of main's .husky/.
#
#   .fork/install-hooks.sh     run from any worktree of the fork checkout; safe to re-run
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"

mkdir -p "$common/hooks"
install -m 755 "$here/pre-commit" "$common/hooks/pre-commit"
install -m 755 "$here/pre-push" "$common/hooks/pre-push"
git -C "$here" config --unset-all core.hooksPath 2>/dev/null || true

# Remove any legacy worktree .husky/pre-push copy left by earlier versions of this script.
git -C "$here" worktree list --porcelain | awk '$1 == "worktree" { print substr($0, 10) }' | while IFS= read -r wt; do
	rm -f "$wt/.husky/pre-push"
done

echo "installed $common/hooks/{pre-commit,pre-push} (core.hooksPath unset)"
