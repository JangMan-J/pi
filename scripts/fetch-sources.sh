#!/usr/bin/env bash
# Clones oven-sh/WebKit and oven-sh/bun at the commits in sources.json and applies Pi-Bolt's patches on top.
# Usage: scripts/fetch-sources.sh            Sources go to $PIBOLT_WORK (default .work/) as webkit/ and bun/.
source "$(dirname "$0")/lib/common.sh"
need git

fetch() {
	local name="$1" dir="$PIBOLT_WORK/$1"
	local repository commit branch patches
	repository=$(source_field "$name" repository)
	commit=$(source_field "$name" commit)
	branch=$(source_field "$name" branch)
	patches="$PIBOLT_ROOT/$(source_field "$name" patches)"
	if [ -d "$dir/.git" ]; then
		log "$name: already at $dir"
		return
	fi
	log "$name: cloning $repository @ ${commit:0:12}"
	mkdir -p "$PIBOLT_WORK"
	git init -q "$dir"
	git -C "$dir" remote add origin "$repository"
	# A commit by its hash where the server allows it; otherwise the branch it is on.
	if ! git -C "$dir" fetch -q --depth 1 origin "$commit" 2>/dev/null; then
		[ -n "$branch" ] || die "$name: cannot fetch $commit"
		git -C "$dir" fetch -q origin "$branch"
	fi
	git -C "$dir" checkout -q --detach "$commit"
	log "$name: applying $(basename "$patches")"
	git -C "$dir" -c user.name=pi-bolt -c user.email=pi-bolt@localhost am -q "$patches"
}

fetch webkit
fetch bun
log "sources ready in $PIBOLT_WORK"
