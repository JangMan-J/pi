#!/usr/bin/env bash
# Builds the Pi-Bolt runtime: Bun on the patched WebKit (JavaScriptCore with the ahead-of-time compiler), LTO, release flags.
# With a sysroot (scripts/toolchain/make-sysroot.sh) the result needs only glibc 2.17 and carries its own ICU, like official Bun.
# Usage: scripts/build-runtime.sh [--native]   --native: link against the host's libc and ICU instead (faster to set up,
#        but the binary only runs on systems like this one).
# Needs: the sources (scripts/fetch-sources.sh), clang/LLVM, cmake, ninja, rust (cargo), bun. A long build: WebKit and Bun from
# source, with LTO.
source "$(dirname "$0")/lib/common.sh"
need bun; need cmake; need cargo

NATIVE=
[ "${1:-}" = --native ] && NATIVE=1
WEBKIT="$PIBOLT_WORK/webkit"; BUN_SRC="$PIBOLT_WORK/bun"
[ -d "$WEBKIT/.git" ] && [ -d "$BUN_SRC/.git" ] || die "sources missing: run scripts/fetch-sources.sh first"

SYSROOT="${LINUX_GLIBC_SYSROOT:-$PIBOLT_ROOT/.toolchain/sysroot-glibc}"
if [ -z "$NATIVE" ]; then
	[ -f "$SYSROOT/usr/lib/libicuuc.a" ] || die "no sysroot at $SYSROOT: run scripts/toolchain/make-sysroot.sh (or pass --native)"
	export LINUX_GLIBC_SYSROOT="$SYSROOT"
fi

BUILD_DIR="build/pibolt-release"
log "building the runtime in $BUN_SRC/$BUILD_DIR (WebKit from $WEBKIT)"
(cd "$BUN_SRC" && BUN_WEBKIT_PATH="$WEBKIT" bun scripts/build.ts --profile=release-local --lto=on --build-dir="$BUILD_DIR")

mkdir -p "$PIBOLT_WORK/runtime"
cp "$BUN_SRC/$BUILD_DIR/bun" "$PIBOLT_WORK/runtime/bun"
cp "$BUN_SRC/$BUILD_DIR/bun-profile" "$PIBOLT_WORK/runtime/bun-profile" 2>/dev/null || true
log "runtime: $PIBOLT_WORK/runtime/bun ($("$PIBOLT_WORK/runtime/bun" --version))"
