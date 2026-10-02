#!/usr/bin/env bash
# Publishes install.sh to the gh-pages branch, which GitHub Pages serves at https://pi-bolt.opensec.in/install.sh.
# Usage: scripts/publish-installer.sh [REMOTE]     (default remote: origin). Adds a commit to gh-pages; never rewrites it.
source "$(dirname "$0")/lib/common.sh"
need git
REMOTE="${1:-origin}"
WORKTREE="$(mktemp -d)"
trap 'git -C "$PIBOLT_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true' EXIT
git -C "$PIBOLT_ROOT" fetch -q "$REMOTE" gh-pages
git -C "$PIBOLT_ROOT" worktree add -q --detach "$WORKTREE" FETCH_HEAD
cp "$PIBOLT_ROOT/install.sh" "$WORKTREE/install.sh"
if git -C "$WORKTREE" diff --quiet -- install.sh; then
	log "gh-pages already has this install.sh"
	exit 0
fi
git -C "$WORKTREE" add install.sh
git -C "$WORKTREE" commit -q -m "chore(pages): update install.sh"
git -C "$WORKTREE" push -q "$REMOTE" HEAD:gh-pages
log "published install.sh to $REMOTE gh-pages"
