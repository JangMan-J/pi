#!/usr/bin/env bash
# Rebuild this fork's integration branch `next` from `main` plus the branches listed in `branches`.
#
#   .fork/sync.sh                      fetch upstream, fast-forward main, rebase, rebuild next, run focused checks
#   .fork/sync.sh --upstream-rev REV   use REV (a fetched commit or tag) instead of upstream/main
#   .fork/sync.sh --offline            do not fetch; equivalent to --upstream-rev upstream/main as already fetched
#   .fork/sync.sh --no-check           skip .fork/check.sh
#   .fork/sync.sh --push               after a successful rebuild, push main, next, the branches and the
#                                      pre-sync tags with --force-with-lease
#
# Layout: `next` starts at the first branch in `branches` and merges each following branch with
# --no-ff, in file order. Every branch is rebased onto main first. Signed pre-sync tags record the
# tips before anything moves. The script refuses to run on a dirty working tree.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
cd "$repo"

upstream_rev="upstream/main"
fetch=1
check=1
push=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--upstream-rev) upstream_rev="$2"; shift 2 ;;
		--offline|--no-fetch) fetch=0; shift ;;
		--no-check) check=0; shift ;;
		--push) push=1; shift ;;
		-h|--help) sed -n '2,14p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

mapfile -t branches < <(grep -vE '^\s*(#|$)' "$here/branches")
[[ ${#branches[@]} -ge 1 ]] || { echo "no branches listed in $here/branches" >&2; exit 2; }

if [[ -n "$(git status --porcelain)" ]]; then
	echo "working tree is not clean; commit or stash first" >&2
	exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for ref in main next "${branches[@]}"; do
	git rev-parse -q --verify "refs/heads/$ref" >/dev/null || { echo "missing local branch $ref" >&2; exit 1; }
	git tag -m "state before sync $stamp" "pre-sync/$stamp/${ref//\//-}" "$ref"
done
echo "tagged current tips under pre-sync/$stamp/"

if [[ $fetch -eq 1 ]]; then
	git fetch --prune upstream
	git fetch --prune origin
fi

git checkout -q main
git merge --ff-only "$upstream_rev"
echo "main -> $(git rev-parse --short HEAD)"

for b in "${branches[@]}"; do
	git checkout -q "$b"
	if ! git rebase -q main; then
		echo "rebase of $b onto main failed; resolve in the rebase, then re-run with --offline" >&2
		exit 1
	fi
	echo "  $b -> $(git rev-parse --short HEAD) ($(git rev-list --count main..HEAD) commits)"
done

git checkout -q -B next "${branches[0]}"
for b in "${branches[@]:1}"; do
	git merge --no-ff --no-edit -m "Merge branch '$b' into next" "$b" >/dev/null
done
echo "next -> $(git rev-parse --short HEAD)"

if [[ $check -eq 1 ]]; then
	"$here/check.sh" focused
fi

if [[ $push -eq 1 ]]; then
	git push --force-with-lease origin main next "${branches[@]}"
	git push origin "refs/tags/pre-sync/$stamp/*"
	echo "pushed main, next, ${#branches[@]} branches and pre-sync/$stamp tags"
fi
