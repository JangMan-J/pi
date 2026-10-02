#!/usr/bin/env bash
# Clones Pi at the version in sources.json (or --tag) and builds it (npm ci && npm run build), for scripts/build-pi.sh.
# Usage: scripts/fetch-pi.sh [--tag vX.Y.Z] [--dir DIR]        Needs git and Node.js 22.19+ with npm.
source "$(dirname "$0")/lib/common.sh"
need git; need npm
TAG="$(source_field pi tag)"; DIR="$PIBOLT_WORK/pi"
while [ $# -gt 0 ]; do
	case "$1" in
	--tag) TAG="$2"; shift ;;
	--dir) DIR="$2"; shift ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
if [ ! -d "$DIR/.git" ]; then
	log "cloning Pi $TAG"
	git clone -q --depth 1 --branch "$TAG" "$(source_field pi repository)" "$DIR"
fi
log "building Pi in $DIR"
(cd "$DIR" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
log "Pi $(node -p "require('$DIR/packages/coding-agent/package.json').version") ready in $DIR"
