#!/usr/bin/env bash
# Builds and packages a release: the Pi executables for each target, the runtime, and SHA256SUMS, in dist/<version>/.
#
# Usage: scripts/package-release.sh [--pi DIR] [--no-build]
#   --pi DIR      the built Pi tree (default: this repository)
#   --no-build    package the builds already in out/ instead of building them
# Archives (the names stay the same from release to release, so that releases/latest/download/<name> always works):
#   pi-bolt-linux-x64.tar.gz           JIT off, code for AVX2-class CPUs (falls back to bytecode on others)
#   pi-bolt-linux-x64-baseline.tar.gz  JIT off, code for any x86-64 CPU
#   pi-bolt-linux-x64-jit.tar.gz       JIT on, for code loaded at run time
#   pi-bolt-runtime-linux-x64.tar.gz   the Pi-Bolt Bun runtime, to build Pi with plugins (docs/PLUGINS.md)
source "$(dirname "$0")/lib/common.sh"

PI_DIR="$PIBOLT_PI"; BUILD=1
while [ $# -gt 0 ]; do
	case "$1" in
	--pi) PI_DIR="$2"; shift ;;
	--no-build) BUILD="" ;;
	-h | --help) sed -n '2,13p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
need sha256sum
VERSION="$(cat "$PIBOLT_ROOT/VERSION")"
DIST="$PIBOLT_ROOT/dist/$VERSION"
PI_ROOT="$(realpath "$PI_DIR")"
TARGETS=("linux-x64:pi-bolt:" "linux-x64-baseline:pi-bolt-baseline:--cpu baseline" "linux-x64-jit:pi-bolt-jit:--jit on")

if [ -n "$BUILD" ]; then
	for target in "${TARGETS[@]}"; do
		IFS=: read -r _ out options <<<"$target"
		# shellcheck disable=SC2086 # options is a list of words
		"$PIBOLT_ROOT/scripts/build-pi.sh" --pi "$PI_DIR" --out "$PIBOLT_ROOT/out/$out" $options
	done
fi

rm -rf "$DIST" && mkdir -p "$DIST"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
notices() {
	cp "$PIBOLT_ROOT/LICENSE" "$1/LICENSE"
	cp "$PIBOLT_ROOT/THIRD_PARTY_NOTICES.md" "$1/"
	[ -f "$PI_ROOT/LICENSE" ] && cp "$PI_ROOT/LICENSE" "$1/LICENSE.pi"
	return 0
}

for target in "${TARGETS[@]}"; do
	IFS=: read -r name out _ <<<"$target"
	build="$PIBOLT_ROOT/out/$out"
	[ -x "$build/pi" ] || die "$build/pi not found: build it, or run without --no-build"
	BUN_STATIC_HEAP_VERBOSE=1 "$build/pi" --version 2>&1 | grep -q "image registered: true" || die "$build/pi does not use its compiled code"
	dir="$STAGE/pi-bolt-$name"
	cp -R "$build" "$dir"
	notices "$dir"
	log "pi-bolt-$name.tar.gz (Pi $("$build/pi" --version))"
	tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$DIST/pi-bolt-$name.tar.gz" "pi-bolt-$name"
done

runtime="$(runtime_bun)"
dir="$STAGE/pi-bolt-runtime-linux-x64"
mkdir -p "$dir" && cp "$runtime" "$dir/bun" && notices "$dir"
log "pi-bolt-runtime-linux-x64.tar.gz (Bun $("$runtime" --version))"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$DIST/pi-bolt-runtime-linux-x64.tar.gz" pi-bolt-runtime-linux-x64

(cd "$DIST" && sha256sum -- *.tar.gz >SHA256SUMS)
log "release $VERSION in $DIST:"
(cd "$DIST" && ls -lh -- * | awk '{print "    " $5 "  " $9}')
