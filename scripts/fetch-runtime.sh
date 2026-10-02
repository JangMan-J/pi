#!/usr/bin/env bash
# Downloads the released Pi-Bolt runtime (instead of building it with build-runtime.sh) to $PIBOLT_WORK/runtime/bun.
#
# Usage: scripts/fetch-runtime.sh [--version vX.Y.Z]     (default: the latest release)
# Environment: PIBOLT_DOWNLOAD_BASE (a mirror of the release files)
source "$(dirname "$0")/lib/common.sh"

TAG=latest
while [ $# -gt 0 ]; do
	case "$1" in
	--version) TAG="$2"; shift ;;
	-h | --help) sed -n '2,5p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
need curl
need sha256sum
REPO="https://github.com/opensec-git/Pi-Bolt"
if [ "$TAG" = latest ]; then BASE="$REPO/releases/latest/download"; else BASE="$REPO/releases/download/$TAG"; fi
BASE="${PIBOLT_DOWNLOAD_BASE:-$BASE}"
NAME=pi-bolt-runtime-linux-x64.tar.gz

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
log "downloading $BASE/$NAME"
curl -fL --progress-bar -o "$TMP/$NAME" "$BASE/$NAME"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
(cd "$TMP" && grep " $NAME\$" SHA256SUMS | sha256sum -c --quiet -) || die "checksum mismatch for $NAME"
tar -C "$TMP" -xzf "$TMP/$NAME"
mkdir -p "$PIBOLT_WORK/runtime"
install -m 755 "$TMP/pi-bolt-runtime-linux-x64/bun" "$PIBOLT_WORK/runtime/bun"
log "runtime: $PIBOLT_WORK/runtime/bun (Bun $("$PIBOLT_WORK/runtime/bun" --version))"
