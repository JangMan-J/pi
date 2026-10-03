#!/usr/bin/env bash
# Crash tests that need a built Pi (Pi's own ahead-of-time compiled code under an extension), not just the engine.
#
# Usage: tests/pi/run.sh [PI]     (default: out/pi-bolt/pi)
# Each test runs several times: the crashes they guard against depended on when the collector ran.
cd "$(dirname "$0")" || exit 1
PI="${1:-../../out/pi-bolt/pi}"
[ -x "$PI" ] || { echo "no Pi executable at $PI (scripts/build-pi.sh)"; exit 1; }
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
status=0
run() {
	local name=$1 runs=$2; shift 2
	local failed=0 out
	for _ in $(seq "$runs"); do
		out=$(env -i HOME="$home" PATH=/usr/bin:/bin PI_CODING_AGENT_DIR="$home/agent" DO_NOT_TRACK=1 BUN_ENABLE_CRASH_REPORTING=0 \
			"$@" "$PI" -ne -e "./$name.js" --offline --no-session -p hi 2>&1 </dev/null)
		[ $? -eq 0 ] && grep -q "^$name: " <<<"$out" || { failed=$((failed + 1)); last=$out; }
	done
	if [ "$failed" = 0 ]; then
		echo "PASS $name ($runs runs${*:+, $*})"
	else
		echo "FAIL $name: $failed of $runs runs${*:+ ($*)}"
		grep -m3 -i "segmentation\|panic\|error" <<<"$last" | sed 's/^/   /'
		status=1
	fi
}
run gc-end-stacks 5
run gc-end-stacks 5 BUN_JSC_collectContinuously=1
exit $status
