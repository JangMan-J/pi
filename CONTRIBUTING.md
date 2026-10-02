# Contributing

Thank you for helping make Pi-Bolt better. Bug reports, benchmarks on other hardware, and fixes are all welcome.

## Reporting bugs

Follow [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#reporting-a-problem). The most useful detail is whether the problem
also happens with `BUN_AOT=0`, and with stock Pi.

## Changes

| Area | Where | Check with |
|---|---|---|
| Build scripts, tools, docs | `scripts/`, `bench/`, `docs/` | `shellcheck -x scripts/*.sh`, and a build |
| The engine (JavaScriptCore AOT compiler, runtime) | `.work/webkit`, then regenerate `patches/webkit/` | `tests/aot/run.sh`, `bench/e2e_tools.py`, `bench/ui_check.py` |
| The executable format | `.work/bun`, then regenerate `patches/bun/` | the same |
| A new Pi version | `sources.json`, `scripts/train-profile.sh` | all of the above, and `bench/benchmark.py` against stock Bun |

[docs/BUILDING.md](docs/BUILDING.md) describes the setup and how to regenerate the patches.

A change that affects performance should come with before/after figures from the `bench/` tools, run on the same machine,
interleaved, with `--cpus`. A change to generated code should come with a test in `tests/aot/` that fails without it.

## Style

- Shell: `bash`, `set -euo pipefail` (via `scripts/lib/common.sh`), clean under `shellcheck -S warning`.
- Python: standard library only, Python 3.9+.
- Engine code: WebKit's style.
