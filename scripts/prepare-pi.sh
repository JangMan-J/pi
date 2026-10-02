#!/usr/bin/env bash
# Builds Pi for scripts/build-pi.sh. Pi-Bolt is a fork of Pi: by default this is the Pi of this repository, built in place
# (npm ci && npm run build). With --tag, it clones another Pi release from upstream and builds that instead.
# Usage: scripts/prepare-pi.sh [--tag vX.Y.Z [--dir DIR]]        Needs Node.js 22.19+ with npm (and git for --tag).
source "$(dirname "$0")/lib/common.sh"
need npm
TAG=""; DIR=""
while [ $# -gt 0 ]; do
	case "$1" in
	--tag) TAG="$2"; shift ;;
	--dir) DIR="$2"; shift ;;
	-h | --help) sed -n '2,4p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
if [ -n "$TAG" ]; then
	need git
	DIR="${DIR:-$PIBOLT_WORK/pi-${TAG#v}}"
	if [ ! -d "$DIR/.git" ]; then
		log "cloning Pi $TAG from $(source_field pi upstream)"
		git clone -q --depth 1 --branch "$TAG" "$(source_field pi upstream)" "$DIR"
	fi
else
	DIR="$PIBOLT_PI"
fi
log "building Pi in $DIR"
(cd "$DIR" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run build >/dev/null)
log "Pi $(pi_version "$(pi_agent_dir "$DIR")") ready in $DIR"
