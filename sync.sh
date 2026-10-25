#!/usr/bin/env bash
# Keep this fork's integration branch `next` consistent with `main` and the branches in `branches`.
#
#   .fork/sync.sh --status             show where main, every branch and next stand; exit 1 if next is stale
#   .fork/sync.sh --align              reset main, the branches and next to origin when nothing local would be lost
#   .fork/sync.sh --rebuild-only       rebuild next from the current branch tips (no fetch, no rebase)
#   .fork/sync.sh                      fetch upstream, fast-forward main, rebase every branch, rebuild next
#   .fork/sync.sh --upstream-rev REV   like the full sync but fast-forward main to REV instead of upstream/main
#   .fork/sync.sh --offline            full sync without fetching
#   .fork/sync.sh --no-check           skip .fork/check.sh focused after the rebuild
#   .fork/sync.sh --push               push main, next, the branches and the pre-sync tags with --force-with-lease
#
# Layout: `next` starts at the first branch in `branches` and merges each following branch with
# --no-ff, in file order. Nothing is ever committed directly on `next`; the rebuild refuses if it
# finds such commits (cherry-pick them onto the owning branch first). Signed pre-sync tags record
# every tip before anything moves. The script refuses to run on a dirty working tree.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
cd "$repo"

mode="full"
upstream_rev="upstream/main"
fetch=1
check=1
push=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--status) mode="status"; shift ;;
		--rebuild-only) mode="rebuild"; shift ;;
		--align) mode="align"; shift ;;
		--upstream-rev) upstream_rev="$2"; shift 2 ;;
		--offline|--no-fetch) fetch=0; shift ;;
		--no-check) check=0; shift ;;
		--push) push=1; shift ;;
		-h|--help) sed -n '2,16p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

mapfile -t branches < <(grep -vE '^\s*(#|$)' "$here/branches")
[[ ${#branches[@]} -ge 1 ]] || { echo "no branches listed in $here/branches" >&2; exit 2; }

short() { git rev-parse --short "$1"; }
count() { git rev-list --count "$@"; }
is_ancestor() { git merge-base --is-ancestor "$1" "$2"; }

stray_on_next() {
	local excludes=(^main)
	for b in "${branches[@]}"; do excludes+=("^$b"); done
	count --no-merges next "${excludes[@]}"
}

missing_from_next() {
	local missing=()
	for b in "${branches[@]}"; do is_ancestor "$b" next || missing+=("$b"); done
	is_ancestor main next || missing+=("main")
	printf '%s\n' "${missing[@]:-}"
}

status() {
	local rc=0 current
	current="$(git branch --show-current || echo '(detached)')"
	echo "fork status ($repo)"
	if git rev-parse -q --verify upstream/main >/dev/null; then
		printf '  %-30s %s  upstream/main has %s commit(s) main lacks\n' main "$(short main)" "$(count main..upstream/main)"
	else
		printf '  %-30s %s  (no upstream remote fetched)\n' main "$(short main)"
	fi
	for b in "${branches[@]}"; do
		local rel="no origin ref"
		if git rev-parse -q --verify "origin/$b" >/dev/null; then
			rel="ahead $(count "origin/$b..$b") behind $(count "$b..origin/$b") vs origin"
		fi
		local based="on main"
		is_ancestor main "$b" || { based="NOT rebased onto main"; rc=1; }
		printf '  %-30s %s  %s; %s\n' "$b" "$(short "$b")" "$rel" "$based"
	done
	local stray missing
	stray="$(stray_on_next)"
	missing="$(missing_from_next)"
	local verdict="current"
	if [[ -n "$missing" ]]; then verdict="STALE: missing $(echo "$missing" | tr '\n' ' ')"; rc=1; fi
	if [[ "$stray" -gt 0 ]]; then verdict="$verdict; STRAY: $stray commit(s) on next belong on a branch"; rc=1; fi
	printf '  %-30s %s  %s\n' next "$(short next)" "$verdict"
	if [[ -n "$(git status --porcelain)" ]]; then echo "  working tree: DIRTY"; else echo "  working tree: clean"; fi
	case "$current" in
		next|main) echo "  you are on $current: do not commit here, switch to the owning branch (see .fork/AGENTS.md)" ;;
		*) echo "  you are on $current" ;;
	esac
	return $rc
}

require_clean() {
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "working tree is not clean; commit or stash first" >&2
		exit 1
	fi
}

tag_tips() {
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	for ref in "$@"; do
		git rev-parse -q --verify "refs/heads/$ref" >/dev/null || { echo "missing local branch $ref" >&2; exit 1; }
		git tag -m "state before sync $stamp" "pre-sync/$stamp/${ref//\//-}" "$ref"
	done
	echo "tagged current tips under pre-sync/$stamp/"
}

rebuild_next() {
	local stray
	stray="$(stray_on_next)"
	if [[ "$stray" -gt 0 ]]; then
		echo "next has $stray commit(s) that are on no branch; cherry-pick them onto the owning branch, then re-run:" >&2
		git log --no-merges --format='  %h %s' next ^main "${branches[@]/#/^}" >&2
		exit 1
	fi
	git checkout -q -B next "${branches[0]}"
	for b in "${branches[@]:1}"; do
		git merge --no-ff --no-edit -m "Merge branch '$b' into next" "$b" >/dev/null
	done
	echo "next -> $(short next)"
}

align_refs() {
	local rc=0 ref local_sha wt
	git fetch -q --prune origin
	git fetch -q origin '+refs/tags/*:refs/tags/*' 2>/dev/null || true
	for ref in main "${branches[@]}" next; do
		if ! git rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then
			echo "  $ref: no origin/$ref, skipped"; continue
		fi
		if ! git rev-parse -q --verify "refs/heads/$ref" >/dev/null; then
			git branch -q --track "$ref" "origin/$ref"; echo "  $ref: created at $(short "origin/$ref")"; continue
		fi
		local_sha="$(git rev-parse "$ref")"
		if [[ "$local_sha" == "$(git rev-parse "origin/$ref")" ]]; then echo "  $ref: already at origin"; continue; fi
		# Safe only when the local tip is reachable from something origin has: its branch, another branch, or a tag.
		if ! git merge-base --is-ancestor "$local_sha" "origin/$ref" \
			&& [[ -z "$(git for-each-ref --contains "$local_sha" refs/remotes/origin refs/tags)" ]]; then
			echo "  $ref: local $(short "$ref") is on no origin branch or tag; push or tag it first, skipped" >&2
			rc=1; continue
		fi
		wt="$(git worktree list --porcelain | awk -v b="refs/heads/$ref" '$1=="worktree"{w=$2} $1=="branch"&&$2==b{print w}')"
		if [[ -n "$wt" && "$wt" != "$repo" ]]; then
			if [[ -n "$(git -C "$wt" status --porcelain)" ]]; then echo "  $ref: checked out with changes at $wt, skipped" >&2; rc=1; continue; fi
			git -C "$wt" reset -q --hard "origin/$ref"
		elif [[ "$wt" == "$repo" ]]; then
			git reset -q --hard "origin/$ref"
		else
			git branch -q -f "$ref" "origin/$ref"
		fi
		echo "  $ref: $(short "$local_sha") -> $(short "origin/$ref")"
	done
	return $rc
}

push_all() {
	git push --force-with-lease origin main next "${branches[@]}"
	git push origin "refs/tags/pre-sync/$stamp/*"
	echo "pushed main, next, ${#branches[@]} branches and pre-sync/$stamp tags"
}

case "$mode" in
	status)
		status
		;;
	align)
		require_clean
		align_refs
		;;
	rebuild)
		require_clean
		if [[ -z "$(missing_from_next)" && "$(stray_on_next)" -eq 0 ]]; then
			echo "next $(short next) already contains every branch tip; nothing to rebuild"
		else
			stray="$(stray_on_next)"
			if [[ "$stray" -gt 0 ]]; then
				echo "next has $stray commit(s) that are on no branch; cherry-pick them onto the owning branch, then re-run:" >&2
				git log --no-merges --format='  %h %s' next ^main "${branches[@]/#/^}" >&2
				exit 1
			fi
			tag_tips next
			rebuild_next
		fi
		[[ $check -eq 0 ]] || "$here/check.sh" focused
		[[ $push -eq 0 ]] || { stamp="${stamp:-$(date -u +%Y%m%dT%H%M%SZ)}"; git push --force-with-lease origin next "${branches[@]}"; echo "pushed next and ${#branches[@]} branches"; }
		;;
	full)
		require_clean
		tag_tips main next "${branches[@]}"
		if [[ $fetch -eq 1 ]]; then
			git fetch --prune upstream
			git fetch --prune origin
		fi
		git checkout -q main
		git merge --ff-only "$upstream_rev"
		echo "main -> $(short main)"
		for b in "${branches[@]}"; do
			git checkout -q "$b"
			if ! git rebase -q main; then
				echo "rebase of $b onto main failed; resolve it, 'git rebase --continue', then re-run with --offline" >&2
				exit 1
			fi
			echo "  $b -> $(short "$b") ($(count main..HEAD) commits)"
		done
		rebuild_next
		[[ $check -eq 0 ]] || "$here/check.sh" focused
		[[ $push -eq 0 ]] || push_all
		;;
esac
