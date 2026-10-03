# Benchmarks

Pi-Bolt compared with the same Pi release on stock Bun and on Node.js. Every figure comes from the tools in
[`bench/`](../bench), and the raw results are in [`bench/results/`](../bench/results). The charts are drawn from those files by
[`bench/report.py`](../bench/report.py).

- [Results](#results)
- [Setup and method](#setup-and-method)
- [In a real terminal (tmux)](#in-a-real-terminal-tmux)
- [Long answers and large files](#long-answers-and-large-files)
- [Plugins](#plugins)
- [Questions](#questions)
  - [Why is a run-time plugin's loop 1,080 ms on Pi-Bolt and 38 ms on Bun?](#why-is-a-run-time-plugins-loop-1080-ms-on-pi-bolt-and-38-ms-on-bun)
  - [Did Pi-Bolt get slower when it was made production-ready?](#did-pi-bolt-get-slower-when-it-was-made-production-ready)
  - [How was the streaming gap closed?](#how-was-the-streaming-gap-closed)
- [Reproduce](#reproduce)
- [Correctness](#correctness)

## Results

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/bench-speed-dark.svg">
  <img alt="Time: launch to interactive, pi --version, one prompt, and time per prompt in a long session, for Pi-Bolt, Bun and Node" src="images/bench-speed-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/bench-cpu-dark.svg">
  <img alt="CPU time of an interactive session, one prompt, pi --version, and per prompt in a long session" src="images/bench-cpu-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/bench-memory-dark.svg">
  <img alt="Peak memory, own memory in tmux and after a long session, and CPU while replies stream" src="images/bench-memory-light.svg">
</picture>

| Scenario | Metric | Pi-Bolt | Pi-Bolt, JIT on | Bun 1.4.2 | Node 22 |
|---|---|---:|---:|---:|---:|
| `pi --version` | wall | **48 ms** | 51 ms | 78 ms | 226 ms |
| | CPU | **50 ms** | 55 ms | 143 ms | 282 ms |
| `pi -p "<prompt>"`: one prompt, 5 model turns, 4 tool calls | wall | **113 ms** | 118 ms | 167 ms | 405 ms |
| | CPU | **128 ms** | 134 ms | 323 ms | 576 ms |
| Interactive TUI: launch, 5 prompts (25 model turns), `/quit` | time to interactive | **83 ms** | 82 ms | 123 ms | 296 ms |
| | time per model turn | **84 ms** | 83 ms | 116 ms | 244 ms |
| | CPU | **395 ms** | 404 ms | 831 ms | 1,237 ms |
| | peak memory | **155 MB** | 161 MB | 202 MB | 212 MB |
| Long session: 75 prompts, 300 tool calls, about 2.7M tokens | time per prompt, last 25 | **146 ms** | | 188 ms | 247 ms |
| | CPU per prompt, last 25 | **89 ms** | | 144 ms | 213 ms |
| | own memory at the end | **126 MB** | | 289 MB | 474 MB |

Medians: 21 runs of each scenario (after 3 warm-up runs), and 3 long sessions per runtime. The long-session memory is a snapshot
after the last prompt, so it depends on when the garbage collector last ran. Across sessions it was 109–172 MB for Pi-Bolt,
221–327 MB for Bun and 454–493 MB for Node.

## Setup and method

| | |
|---|---|
| Pi | 1.0.0 (`v1.0.0`, a13d35a7) |
| Machine | AMD EPYC 7B13 (Zen 3), Linux 7.0, every run pinned to the same 8 cores |
| **Pi-Bolt** 0.2.0 (0.3.0 measures the same, within noise) | `scripts/build-pi.sh`: compiled ahead of time, JIT off, CPU `native` |
| **Bun 1.4.2** | Pi built with Pi's own `bun build --compile` command, plus `--bytecode` (which makes stock Bun start faster) |
| **Node 22.23.3** | Pi's npm package (`dist/bundle/cli.js`, with Node's compile cache) |

**The model.** A local server ([`bench/fake_model.py`](../bench/fake_model.py)) speaks the OpenAI chat-completions protocol and
streams a scripted conversation: for each prompt, four `read` tool calls on Pi source files, then an answer. There is no network
and no model latency, so the figures measure Pi and its runtime.

**Isolation.**

- Each run gets a fresh Pi home with only that model configured, and an environment cleared of `BUN_*`, `NODE_*` and `PI_*`.
- Runs are interleaved round-robin across builds, so background load affects all of them alike.

**Metrics.**

- **Wall**: elapsed time.
- **CPU**: user plus system time of all threads, from `wait4()` or the scheduler's per-thread statistics.
- **Peak memory**: maximum resident set.
- **Own memory**: private dirty pages (`smaps_rollup`). This is what a process costs beyond shared and file-backed pages, which
  matters for Pi-Bolt: its code and prebuilt heap are file-backed.

**The machine is shared.** It is a cloud VM that other heavy jobs also use. Interleaving keeps comparisons fair, but absolute
figures vary between sessions. Figures from sessions taken under heavy load were discarded and re-run.

## In a real terminal (tmux)

Pi in a 160×48 tmux pane ([`bench/tmux_check.py`](../bench/tmux_check.py)): keys sent with `send-keys`, the screen read back
with `capture-pane`, and the model streaming at human pace, one event every 10 ms.

| | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| time to interactive | **95 ms** | 144 ms | 335 ms |
| keystroke to screen, median | 5.1 ms | 5.0 ms | 5.1 ms |
| 20 KB paste | 5.6 ms | 5.8 ms | 5.1 ms |
| **CPU while 4 replies stream** (6.5 s) | **482 ms** | 531 ms | 618 ms |
| idle CPU at the prompt | 1.6 ms/s | 2.6 ms/s | **0.3 ms/s** |
| own memory, start → end | **32 → 36 MB** | 60 → 90 MB | 60 → 132 MB |
| resize while streaming, Escape to abort, prompt after abort, `/quit`, errors on screen | all ok, none | all ok, none | all ok, none |

Medians of 7 rounds of 4 prompts each, taken while the machine was quiet (load 11–15 on 56 cores; logged in
[`load-during-tmux-and-plugins.txt`](../bench/results/2026-10-02-pi-1.0.0/load-during-tmux-and-plugins.txt)). Keystroke
latency is the terminal's own round trip and is the same everywhere. Pi-Bolt uses 9% less CPU than Bun's warmed-up JIT while
replies stream, and less than half of Bun's private memory. Node uses the least CPU at the idle prompt.

## Long answers and large files

| | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Streaming a 20,000-character answer: CPU | **1.2 s** | 10.3 s | 8.4 s |
| Streaming a 60,000-character answer: CPU | **4.8 s** | 44.3 s | 43.7 s |
| Share of a core while it streams (60,000 characters) | **10%** | 88% | 87% |
| Writing a 50 KB file through a tool call | **0.3 s** | 2.0 s | 2.9 s |
| Writing a 200 KB file through a tool call | **0.9 s** | 29.7 s | 43.5 s |
| Writing a 200 KB file through a tool call: CPU | **0.6 s** | 71.6 s | 44.5 s |

`bench/long_answer.py` streams Markdown answers (headings, lists, code blocks in several languages, tables) into the TUI at 1,200
characters a second, 24 at a time, and measures the CPU Pi uses until the answer has been drawn. `bench/large_write.py` has the
model write a file of TypeScript through the `write` tool, its arguments streaming 16 characters at a time (about one token),
and measures `pi -p` from start to exit. Means of two runs, which differed by at most 5%; pinned to 8 cores. Bun and Node run
Pi 1.0.0 as released (`v1.0.0`): Bun built with `scripts/build-pi.sh --stable --pi <Pi 1.0.0>`, Node from Pi's npm bundle.
Raw data: [`bench/results/2026-10-03-long-answers-large-writes`](../bench/results/2026-10-03-long-answers-large-writes).

Both come from Pi's own code, not from the runtime. Pi draws a message again each time a few more words arrive, with a new
component that lexes the whole Markdown text, renders and wraps every block and highlights every code block, so the cost of each
redraw grows with the length of the answer. Pi-Bolt keeps what it lexed and rendered, and does again only the last two blocks
(where a block ends depends on the line after it); highlighted code is kept by language and text. What is drawn is the same, line
for line and color for color (`bench/e2e_screen.py`). Pi also parses all of a tool call's arguments each time a few more
characters arrive; Pi-Bolt parses them again only once they have grown by an eighth while they stream, and in full when the call
is complete.

## Plugins

The example plugin ([`examples/plugins`](../examples/plugins)): a `/words` command that counts the words of a 16.8 MB file in a
character loop, timed inside Pi with `performance.now()`. See [PLUGINS.md](PLUGINS.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/bench-plugins-dark.svg">
  <img alt="Plugin hot loop and launch time: compiled in vs loaded at run time on Pi-Bolt, Pi-Bolt with JIT on, and Bun" src="images/bench-plugins-light.svg">
</picture>

| How the plugin runs | Launch to interactive | `/words` hot loop |
|---|---:|---:|
| **Compiled in**, Pi-Bolt (default, JIT off) | **86 ms** | **54 ms** |
| Compiled in, Pi-Bolt JIT on | 83 ms | 53 ms |
| Loaded at run time, Pi-Bolt JIT off (interpreted) | 114 ms | 1,087 ms |
| Loaded at run time, Pi-Bolt JIT on | 122 ms | 41 ms |
| Loaded at run time, Bun 1.4.2 | 194 ms | 38 ms |
| *No plugin: Pi-Bolt / Bun* | *79 ms / 127 ms* | |

Medians of 7 sessions, each running `/words` 5 times. The hot-loop figure is the median of runs 2–5.

## Questions

### Why is a run-time plugin's loop 1,080 ms on Pi-Bolt and 38 ms on Bun?

Because that plugin's code is not compiled at all on that build: it runs in JavaScriptCore's bytecode interpreter.

- The default Pi-Bolt executable runs with the **JIT off**. Pi's own code does not need a JIT: all of it was compiled to machine
  code when the executable was built.
- A plugin loaded at **run time** (from `~/.pi/agent/extensions`, a project's `.pi/extensions` or a Pi package) is not part of
  that build. `jiti` turns its TypeScript into JavaScript when Pi starts. With no JIT, JavaScriptCore can then only interpret
  it, and an interpreter runs a tight loop 20–30× slower than compiled code.
- Stock Bun's JIT compiles the loop after a few thousand iterations, which is how it gets to 38 ms.

This is not a regression. The figure is the same in every Pi-Bolt release: it is the cost of loading code at run time into a
runtime with no JIT. There are two ways around it:

| | Plugin hot loop |
|---|---:|
| Compile the plugin in: `scripts/build-pi.sh --plugins` ([PLUGINS.md](PLUGINS.md)) | 54 ms, and 7 ms at launch instead of 35 ms |
| Use the JIT-on build (`pi-bolt-linux-x64-jit`) and keep loading it at run time | 41 ms after warm-up (Bun: 38 ms) |
| Load it at run time on the default (JIT-off) build | 1,087 ms |

### Did Pi-Bolt get slower when it was made production-ready?

No. The release work changed three things:

- a portable runtime, linked against a glibc 2.17 sysroot with ICU built in;
- loop splitting;
- a retrained profile.

The last build before the release work, v0.1.0 and stock Bun were measured together, interleaved, 21 runs each
([raw data](../bench/results/2026-10-02-prerelease-vs-v0.1.0)):

| | Pre-release | v0.1.0 | Bun 1.4.2 |
|---|---:|---:|---:|
| `pi --version`, wall / CPU | 50 / 53 ms | **47 / 50 ms** | 77 / 140 ms |
| `pi -p`, wall / CPU | 113 / 127 ms | **109 / 123 ms** | 161 / 312 ms |
| interactive: time to interactive / CPU / peak memory | 79 ms / 395 ms / 159 MB | **76 ms / 381 ms / 153 MB** | 126 ms / 829 ms / 202 MB |
| long session, time / CPU per prompt (last 25, median of 3) | 157 / 93 ms | **150 / 92 ms** | 215 / 163 ms |

v0.1.0 was as fast or faster on every metric.

What does vary is streaming CPU in tmux. It is the most load-sensitive measurement on this shared machine, and v0.1.0 measured
531 ms in one session and 578 ms in another. That variation is noise. What the follow-up review did find is a real gap: stock
Bun's warmed-up JIT used 5–15% less CPU than v0.1.0 while replies streamed. v0.2.0 closes it, as the next answer explains.

### How was the streaming gap closed?

A profile of the TUI while replies stream showed what was different. Pi-Bolt spent 8% of its CPU calling the native
`String.prototype.charCodeAt`, once per character, from pi-tui's `visibleWidth()`, which measures every line on every frame.
Three engine fixes followed ([patch 0002](../patches/webkit)):

1. **Integer counters boxed as doubles.** `visibleWidth`'s loop counter is updated with `i += ansiCodeLength(...)`, so the
   compiler could not prove it an integer and kept it as a double. Boxed as a double, it missed the int32 fast path of
   `charCodeAt`, and every character went to C. Numbers are now boxed as int32 whenever they are integers, as JavaScriptCore's
   `jsNumber()` does.
2. **Substrings.** `slice()` and `split()` return substrings that `charAt`/`charCodeAt` read without resolving them, so the
   fast path never applied to them. They are now resolved on first use, as `codePointAt` already did.
3. **Faster loops with calls.** The loop-splitting mode that also covers loops calling known functions (policy 5) had been left
   off, because it miscompiled a spread call. The bug was found and fixed: a spread's result arriving through a phi was passed
   as one argument. Policy 5 is now on, and JavaScriptCore's test suite gives the same results with it as without.

| Streaming 4 replies in tmux, CPU (median of 5 rounds) | |
|---|---:|
| v0.1.0 | 531 ms |
| v0.2.0 engine, loop policy 3 | 496 ms |
| **v0.2.0** (policy 5) | **468 ms** |
| Bun 1.4.2, warmed-up JIT | 516 ms |

This was a separate session from the main results, which is why the figures differ a little from the tmux table above
([raw data](../bench/results/2026-10-02-streaming-fix)). pi-tui's `visibleWidth` loop on its own: 25 ms → 6.3 ms (Bun: 2.4 ms).

## Reproduce

```bash
scripts/package-release.sh                      # out/pi-bolt, out/pi-bolt-baseline, out/pi-bolt-jit
scripts/build-pi.sh --stable --out out/pi-stable
scripts/build-pi.sh --plugins examples/plugins/plugins.ts --out out/pi-bolt-plugins
scripts/build-pi.sh --plugins examples/plugins/plugins.ts --jit on --out out/pi-bolt-plugins-jit
bench/run-suite.sh bench/results/my-run --cpus 8-15   # about an hour; then charts and tables from bench/report.py
python3 bench/long_answer.py --cpus 8-15 --build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi --sizes 20000,60000
python3 bench/large_write.py --cpus 8-15 --build pi-bolt=out/pi-bolt/pi --build bun=out/pi-stable/pi --sizes 50,200
```

Each tool also runs on its own, with any builds given as `--build name=command`. See [`bench/README.md`](../bench/README.md).

## Correctness

Speed is only measured on builds that pass the correctness checks:

- `bench/e2e_tools.py`: every Pi tool, with output and files byte-identical to stock Bun's.
- `bench/ui_check.py` and `bench/tmux_check.py`: the TUI.
- `tests/aot/run.sh`: engine tests, including regression tests for the v0.2.0 fixes.
- JavaScriptCore's own stress tests, run with and without AOT compilation: 4,779 of the 4,786 that run behave the same. The 7
  that differ inspect JIT internals that do not exist without a JIT.

See [BUILDING.md](BUILDING.md#tests).
