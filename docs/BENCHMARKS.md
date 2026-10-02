# Benchmarks

All figures compare the same Pi release on three runtimes, with the tools in [`bench/`](../bench). The commands to reproduce each
table are given below it.

- [Setup](#setup)
- [Startup, headless and interactive](#startup-headless-and-interactive)
- [A long session](#a-long-session)
- [In a real terminal (tmux)](#in-a-real-terminal-tmux)
- [JIT on vs JIT off](#jit-on-vs-jit-off)
- [CPU targets](#cpu-targets)
- [Plugins](#plugins)
- [Correctness](#correctness)

## Setup

| | |
|---|---|
| Pi | 1.0.0 (`v1.0.0`, a13d35a7) |
| Machine | AMD EPYC 7B13 (Zen 3), Linux 7.0, every run pinned to the same 8 cores |
| **Pi-Bolt** | `scripts/build-pi.sh`: AOT, JIT off, CPU `native` |
| **Bun 1.4.2** | Pi built with Pi's own `bun build --compile` command, plus `--bytecode` (cached bytecode: faster startup for stock Bun) |
| **Node 22.23.3** | Pi's npm package (`dist/bundle/cli.js`, with Node's compile cache) |

**The model** is a local server (`bench/fake_model.py`) speaking the OpenAI chat-completions protocol. It streams a scripted
conversation: for each prompt, four `read` tool calls on Pi source files, then an answer. There is no network and no model
latency, so the figures measure Pi and its runtime.

**Isolation.**

- Each run gets a fresh Pi home directory with only that model configured, and the environment is cleared of `BUN_*`, `NODE_*` and
  `PI_*` variables.
- Runs are interleaved round-robin across builds, so background load affects all builds alike.
- Figures are medians.

**Metrics.**

- **Wall**: elapsed time.
- **CPU**: user plus system time of all threads, from `wait4()` or the scheduler's per-thread statistics.
- **Peak memory**: maximum resident set.
- **Own memory**: private dirty pages (`smaps_rollup`): what the process costs beyond shared and file-backed pages.

## Startup, headless and interactive

15 runs per build and scenario, after 2 warm-up runs.

| Scenario | Metric | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---|---:|---:|---:|
| `pi --version` | wall | **47 ms** | 79 ms | 222 ms |
| | CPU | **50 ms** | 142 ms | 280 ms |
| | peak memory | 98 MB | 93 MB | 94 MB |
| `pi -p "<prompt>"`: one prompt, 5 model turns, 4 tool calls | wall | **112 ms** | 164 ms | 406 ms |
| | CPU | **128 ms** | 312 ms | 575 ms |
| | peak memory | **126 MB** | 132 MB | 123 MB |
| Interactive TUI: launch, 5 prompts (25 model turns, 20 tool calls), `/quit` | time to interactive | **77 ms** | 123 ms | 305 ms |
| | time per model turn | **84 ms** | 113 ms | 249 ms |
| | wall | **683 ms** | 784 ms | 1,197 ms |
| | CPU | **378 ms** | 827 ms | 1,235 ms |
| | peak memory | **155 MB** | 202 MB | 210 MB |

```bash
python3 bench/benchmark.py --runs 15 --warmup 2 --cpus 40-47 \
  --build pi-bolt=out/pi-bolt/pi \
  --build node="node .work/pi/packages/coding-agent/dist/bundle/cli.js" \
  --build bun=out/pi-stable/pi
```

## A long session

One interactive process runs 75 prompts: 375 model turns and 300 tool calls. The conversation grows to 10–11 MB, about 2.7
million tokens, and Pi sends it to the model on every turn. Figures are for the last 25 prompts, where the conversation is
largest. Median of 3 sessions.

| | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| time per prompt | **154 ms** | 232 ms | 249 ms |
| CPU per prompt | **96 ms** | 179 ms | 213 ms |
| own memory at the end | **179 MB** | 214 MB | 444 MB |

The memory figure is a snapshot after the last prompt, so it varies with the garbage collector's timing. Across the three
sessions: Pi-Bolt 150–206 MB, Bun 201–279 MB, Node 434–486 MB.

```bash
python3 bench/long_session.py --prompts 75 --every 25 --cpus 40-47 --build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi
```

## In a real terminal (tmux)

Pi in a 160×48 tmux pane, driven with `send-keys` and read back with `capture-pane`. The model streams at a human pace, one
event every 10 ms. Medians of 3 rounds of 4 prompts each.

| | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| time to interactive | **95 ms** | 143 ms | 341 ms |
| keystroke to screen, median | 5.0 ms | 5.0 ms | 5.1 ms |
| 20 KB paste | 5.6 ms | 5.7 ms | 5.7 ms |
| CPU while 4 replies stream (6.5 s) | 560 ms | **483 ms** | 579 ms |
| idle CPU at the prompt | 1.7 ms/s | 2.5 ms/s | **0.2 ms/s** |
| own memory, start → end | **32 → 35 MB** | 60 → 94 MB | 59 → 130 MB |
| resize while streaming, Escape to abort, prompt after abort, `/quit` | ok | ok | ok |

While a reply streams, Pi-Bolt uses 5–15% more CPU than Bun across runs. That is the cost of having no type feedback. In a long,
steady phase, a fully warmed-up JIT specializes on the types it actually sees. Over whole sessions, launch and tool calls
included, Pi-Bolt still uses less than half of Bun's CPU (tables above).

```bash
python3 bench/tmux_check.py --prompts 4 --rounds 3 --cpus 40-47 --build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi
```

## JIT on vs JIT off

Pi-Bolt can also be built with the JIT available for code loaded at run time (`--jit on`). Pi's own code runs from AOT machine
code either way, so the figures barely differ:

| | JIT off | JIT on |
|---|---:|---:|
| `pi --version` wall / CPU | 47 / 50 ms | 49 / 53 ms |
| `pi -p` wall / CPU | 112 / 128 ms | 116 / 131 ms |
| interactive CPU / peak memory | 378 ms / 155 MB | 388 ms / 157 MB |

## CPU targets

`native` code (AVX2 class) vs `baseline` code (any x86-64), 15 runs:

| | native | baseline |
|---|---:|---:|
| `pi --version` wall | 47 ms | 47 ms |
| `pi -p` wall / CPU | 112 / 126 ms | 111 / 127 ms |
| interactive time per turn / CPU | 82 / 382 ms | 85 / 395 ms |

## Plugins

See [PLUGINS.md](PLUGINS.md#short-answer): a plugin compiled into the executable vs loaded at run time, on each build.

## Correctness

Speed is measured only on builds that pass the correctness checks:

- `bench/e2e_tools.py`: every Pi tool, byte-identical output and files compared with stock Bun.
- `bench/ui_check.py` and `bench/tmux_check.py`: the TUI.
- `tests/aot/run.sh`: engine tests.
- JavaScriptCore's own stress tests, run with and without AOT compilation: 4,779 of 4,786 behave the same. The 7 that differ
  inspect JIT internals.

See [BUILDING.md](BUILDING.md#tests).
