#!/usr/bin/env bash
# Builds Pi as a single executable with every function compiled ahead of time.
#
# Usage: scripts/build-pi.sh [options]
#   --pi DIR          a built Pi tree (scripts/prepare-pi.sh). Default: this repository, which is a fork of Pi
#   --out DIR         where to put the executable and its assets. Default: out/pi-bolt
#   --jit on|off      run with the JIT on (code that is not compiled ahead of time, such as extensions loaded at run time, gets
#                     JIT-compiled) or off (least memory; the default)
#   --cpu native|baseline
#                     native: code for this CPU's instruction set (AVX2 class); on a CPU without it the executable falls back to
#                     bytecode. baseline: code for any x86-64 CPU Bun runs on (Nehalem). Default: native
#   --profile DIR     the training profile (bytecode order + regular expressions). Default: profiles/pi-<version> if there is one
#   --plugins FILE    compile Pi extensions into the executable: FILE is a manifest module whose default export is the list of
#                     extension factories (see docs/PLUGINS.md and examples/plugins/plugins.ts). Its folder is built along with it.
#   --plugin-worker PATH
#                     a worker script a plugin starts, relative to the manifest's folder (repeatable)
#   --keep-bytecode   keep the bytecode in the prebuilt heap (by default it is left out, which is what lets the compiler inline
#                     Pi's own functions, and saves memory)
#   --stable          build with a stock Bun instead (PIBOLT_STABLE_BUN, default `bun`): the comparison build, no AOT
# Environment: PIBOLT_BUN (the Pi-Bolt runtime; default $PIBOLT_WORK/runtime/bun)
source "$(dirname "$0")/lib/common.sh"

PI_DIR="$PIBOLT_PI"; OUT=""; JIT=off; CPU=native; PROFILE=""; PLUGINS=""; PLUGIN_WORKERS=(); KEEP_BYTECODE=""; STABLE=""
while [ $# -gt 0 ]; do
	case "$1" in
	--pi) PI_DIR="$2"; shift ;;
	--out) OUT="$2"; shift ;;
	--jit) JIT="$2"; shift ;;
	--cpu) CPU="$2"; shift ;;
	--profile) PROFILE="$2"; shift ;;
	--plugins) PLUGINS="$2"; shift ;;
	--plugin-worker) PLUGIN_WORKERS+=("$2"); shift ;;
	--keep-bytecode) KEEP_BYTECODE=1 ;;
	--stable) STABLE=1 ;;
	-h | --help) sed -n '2,26p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
[ "$JIT" = on ] || [ "$JIT" = off ] || die "--jit takes on or off"
[ "$CPU" = native ] || [ "$CPU" = baseline ] || die "--cpu takes native or baseline"

AGENT="$(pi_agent_dir "$PI_DIR")"
VERSION="$(pi_version "$AGENT")"
OUT="$(realpath -m "${OUT:-$PIBOLT_ROOT/out/pi-bolt}")"
PROFILE="$(realpath -m "${PROFILE:-$PIBOLT_ROOT/profiles/pi-$VERSION}")"

ENTRY=""
if [ -n "$PLUGINS" ]; then
	trap 'rm -rf "$AGENT/.pibolt-plugins"' EXIT
	ENTRY="$(stage_plugins "$AGENT" "$PLUGINS")"
fi
mapfile -t ENTRIES < <(pi_entries "$AGENT" "$ENTRY")
# Workers a plugin starts (new Worker(new URL("./worker.ts", import.meta.url))) are entry points of their own.
for worker in "${PLUGIN_WORKERS[@]}"; do
	[ -n "$PLUGINS" ] || die "--plugin-worker needs --plugins"
	[ -f "$(dirname "$PLUGINS")/$worker" ] || die "--plugin-worker: $(dirname "$PLUGINS")/$worker not found"
	ENTRIES+=("./.pibolt-plugins/src/$worker")
done

stage_assets() {
	local dir="$1" root
	root="$(realpath "$PI_DIR")"
	cp "$AGENT/package.json" "$AGENT/README.md" "$AGENT/CHANGELOG.md" "$dir/"
	mkdir -p "$dir/theme" "$dir/assets" "$dir/export-html/vendor" "$dir/native/linux/prebuilds"
	cp "$AGENT"/src/modes/interactive/theme/*.json "$dir/theme/"
	cp "$AGENT"/src/modes/interactive/assets/* "$dir/assets/"
	cp "$AGENT/src/core/export-html/template.html" "$dir/export-html/"
	[ -f "$AGENT/src/core/export-html/template.css" ] && cp "$AGENT/src/core/export-html/template.css" "$AGENT/src/core/export-html/template.js" "$dir/export-html/"
	cp "$AGENT"/src/core/export-html/vendor/*.js "$dir/export-html/vendor/" 2>/dev/null || true
	cp "$root/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" "$dir/"
	cp -R "$root/packages/tui/native/linux/prebuilds/linux-x64" "$dir/native/linux/prebuilds/"
}

rm -rf "$OUT" && mkdir -p "$OUT"
if [ -n "$STABLE" ]; then
	BUN="${PIBOLT_STABLE_BUN:-bun}"
	need "$BUN"
	log "Pi $VERSION with stock Bun $("$BUN" --version) (bytecode, no AOT) -> $OUT"
	(cd "$AGENT" && "$BUN" build --compile --no-compile-autoload-bunfig --target=bun-linux-x64 --bytecode --format=esm \
		"${ENTRIES[@]}" --outfile "$OUT/pi" >/dev/null)
	stage_assets "$OUT"
	log "done: $OUT/pi"
	exit 0
fi

BUN="$(runtime_bun)"
ORDER_ARGS=(); REGEXPS=""
if [ -f "$PROFILE/bytecode.order" ]; then
	ORDER_ARGS=(--bytecode-order="$PROFILE/bytecode.order")
	[ -f "$PROFILE/regexps.txt" ] && REGEXPS="$PROFILE/regexps.txt"
else
	warn "no training profile at $PROFILE: building without one (run scripts/train-profile.sh for the fastest startup)"
fi

log "Pi $VERSION, ahead of time: JIT $JIT, CPU $CPU, $([ -n "$KEEP_BYTECODE" ] && echo "bytecode kept" || echo "bytecode left out")$([ -n "$PLUGINS" ] && echo ", plugins from $PLUGINS") -> $OUT"
(
	cd "$AGENT" || exit 1
	export BUN_JSC_useJIT=0 BUN_STATIC_HEAP=1 BUN_AOT=1
	[ "$JIT" = off ] && export BUN_AOT_JIT=0
	[ "$CPU" = baseline ] && export BUN_AOT_CPU=baseline
	[ -z "$KEEP_BYTECODE" ] && export BUN_JSC_omitBytecodeFromStaticHeap=1
	# Loops get a fast copy, without slow paths, that exits to a generic copy when a check fails: hot loops (string scanning,
	# number crunching, in Pi and in plugins) run several times faster. Policy 5 also splits loops whose calls the fast copy
	# does away with or that index arrays (pi-tui's text measuring: 2x), for about 6 MB of code. BUN_JSC_useAOTLoopSplitting=0
	# turns it off; BUN_JSC_aotLoopSplittingPolicy=3 limits it to loops that make no calls.
	export BUN_JSC_useAOTLoopSplitting="${BUN_JSC_useAOTLoopSplitting:-1}"
	export BUN_JSC_aotLoopSplittingPolicy="${BUN_JSC_aotLoopSplittingPolicy:-5}"
	[ -n "$REGEXPS" ] && export BUN_JSC_aotRegExpsPath="$REGEXPS"
	"$BUN" build --compile --no-compile-autoload-bunfig --target=bun-linux-x64 --bytecode --format=esm "${ORDER_ARGS[@]}" \
		--compile-exec-argv=--smol "${ENTRIES[@]}" --outfile "$OUT/pi" 2>&1 | grep -v "^AOT: " | tail -3
)
stage_assets "$OUT"

check=$(BUN_STATIC_HEAP_VERBOSE=1 "$OUT/pi" --version 2>&1)
grep -q "image registered: true" <<<"$check" || die "the executable does not use its compiled code:"$'\n'"$check"
log "done: $OUT/pi ($(du -h "$OUT/pi" | cut -f1), Pi $(tail -1 <<<"$check"))"
