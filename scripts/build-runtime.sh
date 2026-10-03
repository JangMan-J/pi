#!/usr/bin/env bash
# Builds the Pi-Bolt runtime: Bun on the patched WebKit (JavaScriptCore with the ahead-of-time compiler), LTO, release flags.
# With a sysroot (scripts/toolchain/make-sysroot.sh) the result needs only glibc 2.17 and carries its own ICU, like official Bun.
# Usage: scripts/build-runtime.sh [--native] [--lto on|off] [-jN]
#   --native     link against the host's libc and ICU instead (faster to set up, but the binary only runs on systems like
#                this one). On macOS there is no sysroot: the build uses Xcode's SDK, for macOS 13 and later.
#   --lto off    no link-time optimization: a faster build that needs less memory, for working on the engine
#   -jN          jobs at once (default: Bun's build, one per core)
# Needs: the sources (scripts/fetch-sources.sh), clang/LLVM, cmake, ninja, rust (cargo), bun. A long build: WebKit and Bun from
# source, with LTO.
source "$(dirname "$0")/lib/common.sh"
need bun; need cmake; need cargo

NATIVE=; LTO=on; JOBS=()
while [ $# -gt 0 ]; do
	case "$1" in
	--native) NATIVE=1 ;;
	--lto) LTO="$2"; shift ;;
	-j*) JOBS=("$1") ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
[ "$PIBOLT_OS" = darwin ] && NATIVE=1
WEBKIT="$PIBOLT_WORK/webkit"; BUN_SRC="$PIBOLT_WORK/bun"
[ -d "$WEBKIT/.git" ] && [ -d "$BUN_SRC/.git" ] || die "sources missing: run scripts/fetch-sources.sh first"

SYSROOT="${LINUX_GLIBC_SYSROOT:-$PIBOLT_ROOT/.toolchain/sysroot-glibc}"
if [ -z "$NATIVE" ]; then
	[ -f "$SYSROOT/usr/lib/libicuuc.a" ] || die "no sysroot at $SYSROOT: run scripts/toolchain/make-sysroot.sh (or pass --native)"
	export LINUX_GLIBC_SYSROOT="$SYSROOT"
fi

BUILD_DIR="build/pibolt-release"; [ "$LTO" = off ] && BUILD_DIR="build/pibolt-release-nolto"
EXTRA=()
# Bun's own floor for macOS. Without it, a local build targets the SDK's version (this machine's macOS).
[ "$PIBOLT_OS" = darwin ] && EXTRA+=(--osx-deployment-target=13.0)
log "building the runtime in $BUN_SRC/$BUILD_DIR (WebKit from $WEBKIT)"
(cd "$BUN_SRC" && BUN_WEBKIT_PATH="$WEBKIT" bun scripts/build.ts --profile=release-local --lto="$LTO" --build-dir="$BUILD_DIR" "${EXTRA[@]}" "${JOBS[@]}")

mkdir -p "$PIBOLT_WORK/runtime"
cp "$BUN_SRC/$BUILD_DIR/bun" "$PIBOLT_WORK/runtime/bun"
cp "$BUN_SRC/$BUILD_DIR/bun-profile" "$PIBOLT_WORK/runtime/bun-profile" 2>/dev/null || true
log "runtime: $PIBOLT_WORK/runtime/bun ($("$PIBOLT_WORK/runtime/bun" --version))"
