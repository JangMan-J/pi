# Benchmark and end-to-end test tools

Every tool takes the builds to compare as `--build name=command`. The command can be an executable (`out/pi-bolt/pi`) or a
command line (`"node .work/pi/packages/coding-agent/dist/bundle/cli.js"`). Each run gets its own scripted model server and a
throwaway Pi home, so runs are isolated from your Pi configuration and from each other.

| Tool | What it does |
|---|---|
| `benchmark.py` | Startup (`--version`), headless (`-p`) and interactive (TUI on a pseudo-terminal) scenarios. Fresh processes, interleaved round-robin. Reports wall, CPU and peak memory. |
| `long_session.py` | One interactive process, many prompts (default 40; 75 makes about 2.7M tokens). Reports time and CPU per prompt, memory and request size as the session grows. |
| `tmux_check.py` | Pi in a real tmux pane against a model streaming at human pace: time to interactive, keystroke latency, paste, streaming CPU and frames, resize, Escape to abort, idle CPU, memory. |
| `ui_check.py` | Functional check of the TUI: trust prompt, commands, `/hotkeys`, `/session`, `!` bash, a model turn with tool calls, `/model`, `/quit`. Exit status 1 on any failure. |
| `e2e_tools.py` | Drives every core Pi tool through a scripted model. The transcript and files must be byte-identical to a reference build's. |
| `plugin_bench.py` | A Pi extension compiled into the executable vs loaded at run time: launch time and the plugin's hot loop. |
| `run-suite.sh` | Runs all of the benchmarks above into one results folder, then `report.py`: what the README and docs/BENCHMARKS.md show. |
| `report.py` | Draws the charts (light and dark SVG) and prints the tables, from a results folder. |
| `fake_model.py`, `fake_model_tools.py` | The scripted OpenAI-compatible model servers the tools start. |
| `harness.py` | Shared pieces: build parsing, model server, Pi home, pseudo-terminal, CPU and memory readings. |
| `fixtures/` | Four Pi source files (MIT, from Pi) that the scripted model asks Pi to read. |

`results/` holds the published runs: the raw JSONL of each tool, with a note on what was compared.

Requires Python 3.9+; `tmux_check.py` also needs tmux. Pin runs to idle cores with `--cpus` for stable figures. See
[docs/BENCHMARKS.md](../docs/BENCHMARKS.md) for methodology and results.
