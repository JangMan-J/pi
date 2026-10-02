#!/usr/bin/env bash
# Correctness tests for the ahead-of-time engine. Each program is compiled ahead of time twice (JIT on, JIT off: the two kinds of
# Pi build) and must print exactly what a stock Bun prints running its source.
#
# Usage: tests/aot/run.sh [test.mjs...]      (default: every test)
# Environment: PIBOLT_BUN (the Pi-Bolt runtime), PIBOLT_STABLE_BUN (the reference; default `bun`),
#              AOT_BUILD_ENV (extra variables for the compile step, e.g. "BUN_JSC_useAOTLoopSplitting=0")
source "$(dirname "$0")/../../scripts/lib/common.sh"
set +e

BUN="$(runtime_bun)"
STABLE="${PIBOLT_STABLE_BUN:-bun}"
need "$STABLE"
cd "$(dirname "$0")" || exit 1
OUT="$PIBOLT_WORK/tests/aot"
mkdir -p "$OUT"

tests=("$@")
[ ${#tests[@]} -eq 0 ] && tests=(liveness.mjs mapset.mjs realms.mjs workers.mjs spread-loops.mjs number-encoding.mjs helper-calls.mjs)
status=0
for t in "${tests[@]}"; do
	name=${t%.mjs}
	extra=()
	[ "$name" = realms ] && extra=(realms-mod.mjs)
	"$STABLE" "$t" >"$OUT/$name.expected" 2>&1
	# A plain bytecode build, run once, records the order functions are first called in: the AOT build lays code out by it.
	"$BUN" build --compile --bytecode --format=esm --target=bun-linux-x64 "$t" "${extra[@]}" --outfile "$OUT/$name-bytecode" >/dev/null 2>&1
	rm -f "$OUT/$name.order"
	BUN_BYTECODE_ORDER_OUT="$OUT/$name.order" "$OUT/$name-bytecode" >/dev/null 2>&1
	for mode in jit-on jit-off; do
		# shellcheck disable=SC2046,SC2086 # AOT_BUILD_ENV and the JIT setting are lists of words
		env BUN_JSC_useAOTLoopSplitting=1 BUN_JSC_aotLoopSplittingPolicy=5 ${AOT_BUILD_ENV:-} $([ $mode = jit-off ] && echo BUN_AOT_JIT=0) BUN_JSC_useJIT=0 BUN_STATIC_HEAP=1 BUN_AOT=1 \
			BUN_JSC_omitBytecodeFromStaticHeap=1 \
			"$BUN" build --compile --bytecode --format=esm --target=bun-linux-x64 --bytecode-order="$OUT/$name.order" \
			"$t" "${extra[@]}" --outfile "$OUT/$name-$mode" >/dev/null 2>&1
		BUN_STATIC_HEAP_VERBOSE=1 "$OUT/$name-$mode" >"$OUT/$name.$mode" 2>"$OUT/$name.$mode.err"
		used=$(grep -c "image registered: true" "$OUT/$name.$mode.err")
		expected=$(cat "$OUT/$name.expected")
		actual=$(cat "$OUT/$name.$mode")
		# The realms test also prints memory figures, which differ by design: compare the first column only.
		if [ "$name" = realms ]; then
			expected=$(cut -d' ' -f1 <<<"$expected")
			actual=$(cut -d' ' -f1 <<<"$actual")
		fi
		if [ "$used" = 1 ] && [ "$expected" = "$actual" ]; then
			echo "PASS $name ($mode)"
		else
			echo "FAIL $name ($mode): compiled code used: $([ "$used" = 1 ] && echo yes || echo no)"
			diff <(echo "$expected") <(echo "$actual") | head -5
			status=1
		fi
	done
done
exit $status
