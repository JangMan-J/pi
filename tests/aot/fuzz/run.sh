#!/usr/bin/env bash
# Differential fuzzing of the ahead-of-time compiler: random programs (gen.mjs) aimed at what it specializes (loops and their
# guards, module and closure variables, methods of several classes, arithmetic on edge-case numbers, try/catch, typed arrays,
# arrays, dictionaries, generators, array callbacks, and changes the program makes between calls). Each is compiled ahead of time
# and must print what the same bundle prints as bytecode with the JIT. Failures are kept in $PIBOLT_WORK/fuzz/fail.
#
# Usage: tests/aot/fuzz/run.sh [--mode jit-off|jit-on|baseline|compact] [--from SEED] [--count N] [--jobs N]
# Environment: AOT_BUILD_ENV, extra variables for the compile step, e.g. "BUN_JSC_useAOTVariableNarrowing=0"
source "$(dirname "$0")/../../../scripts/lib/common.sh"
set +e

MODE=jit-off; FROM=1; COUNT=200; JOBS=8
while [ $# -gt 0 ]; do
	case "$1" in
	--mode) MODE="$2"; shift ;;
	--from) FROM="$2"; shift ;;
	--count) COUNT="$2"; shift ;;
	--jobs) JOBS="$2"; shift ;;
	-h | --help) sed -n '2,8p' "$0"; exit 0 ;;
	*) die "unknown option $1" ;;
	esac
	shift
done
case "$MODE" in jit-off | jit-on | baseline | compact) ;; *) die "--mode takes jit-off, jit-on, baseline or compact" ;; esac
BUN="$(runtime_bun)"
OUT="$PIBOLT_WORK/fuzz"
mkdir -p "$OUT/work" "$OUT/fail"
GEN="$(cd "$(dirname "$0")" && pwd)/gen.mjs"
export BUN MODE OUT GEN AOT_BUILD_ENV

one() {
	local seed=$1 w
	w=$(mktemp -d "$OUT/work/s$seed-XXXX") && cd "$w" || return
	"$BUN" "$GEN" "$seed" >p.mjs
	# The reference: the same bundle as bytecode, JIT on. (Bundling rewrites some source text that error messages quote.)
	"$BUN" build --compile --bytecode --format=esm --target=bun-linux-x64 p.mjs --outfile p-bc >/dev/null 2>&1
	if ! BUN_BYTECODE_ORDER_OUT=p.order timeout 60 ./p-bc >ref.txt 2>ref.err; then
		echo "SKIP $seed"; rm -rf "$w"; return
	fi
	local extra=(BUN_AOT_JIT=0)
	[ "$MODE" = jit-on ] && extra=()
	[ "$MODE" = baseline ] && extra=(BUN_AOT_JIT=0 BUN_AOT_CPU=baseline)
	[ "$MODE" = compact ] && extra=(BUN_AOT_JIT=0 BUN_JSC_useAOTInlineFastPathsInLoops=0)
	# shellcheck disable=SC2086 # AOT_BUILD_ENV is a list of words
	env "${extra[@]}" ${AOT_BUILD_ENV:-} BUN_JSC_useAOTLoopSplitting=1 BUN_JSC_aotLoopSplittingPolicy=5 BUN_JSC_useImmutableIntrinsics=1 BUN_JSC_useJIT=0 \
		BUN_STATIC_HEAP=1 BUN_AOT=1 BUN_JSC_omitBytecodeFromStaticHeap=1 \
		timeout 300 "$BUN" build --compile --bytecode --format=esm --target=bun-linux-x64 --bytecode-order=p.order p.mjs --outfile p-aot >build.log 2>&1
	local why=""
	if [ ! -x p-aot ]; then why="the compiler failed (see build.log)"
	else
		BUN_STATIC_HEAP_VERBOSE=1 timeout 60 ./p-aot >aot.txt 2>aot.err; local rc=$?
		if [ $rc -ne 0 ]; then why="exit $rc"
		elif ! grep -q "image registered: true" aot.err; then why="no compiled code"
		elif ! cmp -s ref.txt aot.txt; then why="output differs"
		fi
	fi
	if [ -z "$why" ]; then echo "PASS $seed"; rm -rf "$w"; return; fi
	echo "FAIL $seed: $why ($OUT/fail/s$seed-$MODE)"
	rm -rf "$OUT/fail/s$seed-$MODE" && mv "$w" "$OUT/fail/s$seed-$MODE"
}
export -f one
seq "$FROM" $((FROM + COUNT - 1)) | xargs -P "$JOBS" -I{} bash -c 'one {}' | tee "$OUT/results-$MODE.txt" | grep -v "^PASS"
pass=$(grep -c "^PASS" "$OUT/results-$MODE.txt"); fail=$(grep -c "^FAIL" "$OUT/results-$MODE.txt")
echo "$MODE: $pass passed, $fail failed, $(grep -c "^SKIP" "$OUT/results-$MODE.txt") skipped"
[ "$fail" = 0 ]
