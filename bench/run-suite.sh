#!/usr/bin/env bash
# Runs the full benchmark suite behind the README and docs/BENCHMARKS.md, then renders the charts.
#
# Usage: bench/run-suite.sh RESULTS_DIR [--cpus LIST]
# Expects the builds of scripts/package-release.sh in out/ (pi-bolt, pi-bolt-jit), the plugin builds
# (scripts/build-pi.sh --plugins examples/plugins/plugins.ts --out out/pi-bolt-plugins, and --jit on --out out/pi-bolt-plugins-jit),
# the stock-Bun build (scripts/build-pi.sh --stable --out out/pi-stable) and, for Node, a built Pi checkout in $PIBOLT_WORK/pi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(realpath -m "${1:?results directory}")"; shift
CPUS=40-47
[ "${1:-}" = --cpus ] && CPUS="$2"
PI="${PIBOLT_WORK:-$ROOT/.work}/pi"
NODE="node $PI/packages/coding-agent/dist/bundle/cli.js"
mkdir -p "$OUT"
cd "$ROOT"
{
	echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"
	echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), pinned to $CPUS"
	echo "kernel: $(uname -r)"
	echo "pi-bolt: $(cat VERSION), Pi $(out/pi-bolt/pi --version)"
	echo "bun: $(${PIBOLT_STABLE_BUN:-bun} --version)"
	echo "node: $(node --version)"
} >"$OUT/environment.txt"

python3 bench/benchmark.py --runs 21 --warmup 3 --cpus "$CPUS" --out "$OUT/benchmark.jsonl" \
	--build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi --build "node=$NODE" --build pi-bolt-jit=out/pi-bolt-jit/pi --baseline bun
for _ in 1 2 3; do
	python3 bench/long_session.py --prompts 75 --every 25 --cpus "$CPUS" --out "$OUT/long.jsonl" \
		--build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi --build "node=$NODE"
done
python3 bench/tmux_check.py --prompts 4 --rounds 5 --cpus "$CPUS" --out "$OUT/tmux.jsonl" \
	--build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi --build "node=$NODE" >/dev/null
python3 bench/plugin_bench.py --runs 5 --cpus "$CPUS" --out "$OUT/plugins.jsonl" \
	--compiled pi-bolt=out/pi-bolt-plugins/pi --compiled pi-bolt-jit=out/pi-bolt-plugins-jit/pi \
	--runtime pi-bolt=out/pi-bolt/pi --runtime pi-bolt-jit=out/pi-bolt-jit/pi --runtime bun=out/pi-stable/pi \
	--none pi-bolt=out/pi-bolt/pi --none bun=out/pi-stable/pi
python3 bench/report.py "$OUT" --images docs/images --builds pi-bolt,bun,node | tee "$OUT/summary.md"
