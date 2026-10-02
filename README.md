<div align="center">

# Pi-Bolt

**The [Pi coding agent](https://github.com/earendil-works/pi), compiled ahead of time to native code.**

One self-contained Linux executable. It is ready in 77 ms and uses less than half the CPU of Pi on stock Bun, without a JIT.

[![Release](https://img.shields.io/github/v/release/opensec-git/Pi-Bolt?label=release&color=2f6feb)](https://github.com/opensec-git/Pi-Bolt/releases/latest)
[![Platform](https://img.shields.io/badge/platform-linux%20x86--64-444)](#requirements)
[![Pi](https://img.shields.io/badge/pi-1.0.0-6f42c1)](https://github.com/earendil-works/pi/releases/tag/v1.0.0)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [Benchmarks](#benchmarks) · [Plugins](#plugins) · [How it works](#how-it-works) · [Build from source](#build-from-source) · [Docs](docs)

</div>

---

Pi-Bolt runs the same Pi you already use. The commands, keys, sessions, settings, extensions and providers are all Pi's. What
differs is how the program is executed. Every function of Pi is compiled to x86-64 machine code at build time and stored in the
executable, together with a prebuilt JavaScript heap. At launch nothing is parsed, interpreted or JIT-compiled: the code and heap
are mapped from the executable, and Pi is ready to run.

|  | Pi-Bolt | Pi on Bun 1.4.2 | Pi on Node 22 |
|---|---:|---:|---:|
| Interactive launch, ready to type | **83 ms** | 123 ms | 296 ms |
| CPU for a 5-prompt session (25 model turns) | **395 ms** | 831 ms | 1,237 ms |
| `pi -p` one prompt, 5 model turns | **113 ms** | 167 ms | 405 ms |
| Per prompt late in a 2.7M-token session | **146 ms** | 188 ms | 247 ms |
| CPU while replies stream (tmux) | **482 ms** | 531 ms | 618 ms |
| Own memory after a 2.7M-token session | **126 MB** | 289 MB | 474 MB |

<sub>Pi 1.0.0 on an AMD EPYC 7B13, 8 pinned cores, a local model server, medians. Methodology, raw data and every figure:
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).</sub>

## Highlights

- **Fast launch.** Pi's code and its initialized heap are part of the executable, so startup skips parsing, bytecode generation
  and module evaluation.
- **Less than half the CPU.** Startup, model turns, tool calls and rendering run as optimized machine code from the first call,
  with no interpreter warm-up and no JIT compiler threads.
- **Less memory.** No JIT code caches or profiling data. The code and the prebuilt heap are mapped from the executable file, so
  pages that are only read cost no memory of the process's own.
- **The real Pi.** Built from the upstream Pi release, unmodified. Its end-to-end tool output is byte-identical to stock Bun's.
- **Plugins at native speed.** Compile your Pi extensions into the executable, and they start and run like Pi's own code
  ([guide](docs/PLUGINS.md)).
- **Portable.** One executable for any x86-64 Linux with glibc 2.17 or later. No runtime, Node or Bun installation needed.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/opensec-git/Pi-Bolt/main/install.sh | bash
```

The installer:

- picks the build for your CPU;
- verifies its SHA-256 checksum;
- installs it to `~/.pi-bolt`;
- links `pi-bolt` into `~/.local/bin`.

Your Pi configuration in `~/.pi/agent` is shared with stock Pi.

To install manually, download a build from the [latest release](https://github.com/opensec-git/Pi-Bolt/releases/latest), check it
against `SHA256SUMS`, unpack it, and run `./pi`:

| Download | For |
|---|---|
| `pi-bolt-linux-x64.tar.gz` | **Recommended.** CPUs with AVX2 (Intel Haswell 2013 and later, AMD Zen and later). |
| `pi-bolt-linux-x64-baseline.tar.gz` | Any x86-64 CPU (Nehalem 2008 and later). |
| `pi-bolt-linux-x64-jit.tar.gz` | Also JIT-compiles code loaded at run time: for heavy use of run-time-loaded plugins. |
| `pi-bolt-runtime-linux-x64.tar.gz` | The Pi-Bolt Bun runtime, for [compiling plugins in](docs/PLUGINS.md) without building it. |

```bash
tar -xzf pi-bolt-linux-x64.tar.gz
./pi-bolt-linux-x64/pi
```

Keep the executable together with the files around it (themes, assets, the HTML export template), as with Pi's own binary.

### Requirements

- Linux on x86-64, glibc 2.17 or later. Tested on Ubuntu 20.04, 22.04 and 24.04, Debian 11 and 12, Rocky Linux 8 and 9,
  CentOS 7 and Amazon Linux 2. musl-based distributions (Alpine) are not supported.
- About 10 GB of virtual address space for the compiled code: reserved, not used. Only matters under a `ulimit -v`; see
  [troubleshooting](docs/TROUBLESHOOTING.md#notices-at-startup).
- macOS, Windows and ARM64 builds are not available yet.

## Usage

Pi-Bolt is Pi. Everything in [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
applies.

```bash
pi-bolt                        # interactive session
pi-bolt -p "summarize README"  # one prompt, print the answer
pi-bolt --help
```

To use it as your `pi`, add `alias pi=pi-bolt` to your shell profile.

## Benchmarks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-speed-dark.svg">
  <img alt="Time: launch to interactive, pi --version, one prompt, and time per prompt in a long session, for Pi-Bolt, Bun and Node" src="docs/images/bench-speed-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-cpu-dark.svg">
  <img alt="CPU time of an interactive session, one prompt, pi --version, and per prompt in a long session" src="docs/images/bench-cpu-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-memory-dark.svg">
  <img alt="Peak memory, own memory in tmux and after a long session, and CPU while replies stream" src="docs/images/bench-memory-light.svg">
</picture>

Every scenario runs fresh processes, interleaved round-robin across runtimes, against a local model server that streams a
scripted conversation. The figures therefore measure Pi and its runtime, not the network or a model.

- **Pi 1.0.0.** Bun 1.4.2 runs Pi built with Pi's own `bun build --compile` command plus `--bytecode`, which makes stock Bun
  faster. Node 22.23 runs Pi's npm package.
- **In a real tmux pane**, keystroke latency is the same on all three (5 ms). Pi-Bolt keeps 2.5× less memory of its own than
  Bun, and uses 9% less CPU while replies stream than Bun's fully warmed-up JIT.

The raw results, the method, and answers to the obvious questions are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md):

- [why a plugin loaded at run time is slow on the default build](docs/BENCHMARKS.md#why-is-a-run-time-plugins-loop-1080-ms-on-pi-bolt-and-38-ms-on-bun);
- [whether the production build got slower](docs/BENCHMARKS.md#did-pi-bolt-get-slower-when-it-was-made-production-ready);
- [how the streaming gap was closed](docs/BENCHMARKS.md#how-was-the-streaming-gap-closed).

Everything is reproducible with [`bench/run-suite.sh`](bench/run-suite.sh).

## Plugins

Pi extensions work in Pi-Bolt unchanged: in `~/.pi/agent/extensions`, in a project's `.pi/extensions`, or as Pi packages. For
the plugins you use every day, compile them into the executable:

```bash
scripts/build-pi.sh --plugins my-plugins/plugins.ts --out out/pi-bolt-plugins
```

A compiled-in plugin adds about 7 ms to startup, where loading it at run time costs 35 ms on Pi-Bolt and 67 ms on Bun, and it
runs as machine code.

On the default build the JIT is off, so a plugin loaded at run time can only be interpreted. Compiling the plugin in, or
using the `-jit` build, avoids that. In the example plugin's hot loop:

| How the plugin runs | Hot loop |
|---|---:|
| Compiled in | **54 ms** |
| Loaded at run time, interpreted (JIT-off build) | 1,087 ms |
| Loaded at run time, JIT-compiled (`-jit` build) | 41 ms (Bun: 38 ms) |

[docs/PLUGINS.md](docs/PLUGINS.md) covers porting, compatibility rules and how to write plugin code the AOT compiler handles
well.

## How it works

```mermaid
flowchart LR
    subgraph build["Build time (scripts/build-pi.sh)"]
        direction TB
        A["Pi 1.0.0 (TypeScript)"] --> B["bun build --compile<br/>bundle + bytecode"]
        P["Training profile<br/>function order + regexps"] --> C
        B --> C["AOT compiler<br/>JSC bytecode → B3 → x86-64"]
        B --> H["Static heap<br/>Pi's modules, evaluated"]
    end
    C --> E["One executable:<br/>runtime + code image + heap"]
    H --> E
    E --> R["Launch: map code + heap,<br/>run main()"]
```

1. **Bun bundles Pi** into one program and compiles it to JavaScriptCore bytecode, as Bun's `--compile --bytecode` does.
2. **The ahead-of-time compiler** turns every function's bytecode into optimized x86-64 machine code, through the same B3 back end
   as JavaScriptCore's top-tier JIT. It infers types from the program itself, guards its assumptions, and keeps generic slow paths
   for what it cannot prove. Regular expressions are compiled to machine code too.
3. **The static heap** is a snapshot of the JavaScript heap after Pi's modules have been loaded and evaluated. It is stored in
   the executable and mapped at launch, not rebuilt.
4. **A training profile**, recorded once per Pi version, orders the code so that startup touches as few pages as possible.

The compiler comes from [oven-sh/WebKit#743](https://github.com/oven-sh/WebKit/pull/743), which targets ARM64. Pi-Bolt ports it
to x86-64 and adds runtime and code-generation work on top. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build from source

```bash
git clone https://github.com/opensec-git/Pi-Bolt.git && cd Pi-Bolt
scripts/fetch-sources.sh           # WebKit + Bun at the pinned commits, with Pi-Bolt's patches
scripts/toolchain/make-sysroot.sh  # glibc 2.17-compatible sysroot with static ICU (for portable executables)
scripts/build-runtime.sh           # the Pi-Bolt Bun runtime: WebKit and Bun from source
scripts/fetch-pi.sh                # Pi 1.0.0, built
scripts/build-pi.sh                # out/pi-bolt/pi
```

To skip the runtime build, `scripts/fetch-runtime.sh` downloads the released runtime instead; then building Pi takes about a
minute. Requirements, options and the test suite are in [docs/BUILDING.md](docs/BUILDING.md).

## Repository layout

```
patches/        Pi-Bolt's changes to WebKit (JavaScriptCore) and Bun, against the commits in sources.json
scripts/        fetch, build, train and package; scripts/lib holds shared helpers
profiles/       training profiles per Pi version (function order, regular expressions)
examples/       an example plugin manifest and extension
bench/          benchmark and end-to-end test tools, with a scripted local model server
tests/aot/      correctness tests for the ahead-of-time engine
docs/           architecture, building, benchmarks, plugins, troubleshooting
```

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the executable is built and what happens at launch |
| [BUILDING.md](docs/BUILDING.md) | Building the runtime and Pi from source; tests |
| [BENCHMARKS.md](docs/BENCHMARKS.md) | Methodology, full results, how to reproduce them |
| [PLUGINS.md](docs/PLUGINS.md) | Porting Pi plugins and writing them for AOT |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Diagnostics, environment variables, known limitations |

## Acknowledgements

- [Pi](https://github.com/earendil-works/pi) by Mario Zechner and contributors: the coding agent itself.
- [Bun](https://github.com/oven-sh/bun) by Oven, and the JavaScriptCore ahead-of-time compiler in
  [oven-sh/WebKit](https://github.com/oven-sh/WebKit/pull/743) that Pi-Bolt builds on.
- [WebKit](https://webkit.org) and JavaScriptCore.

Pi-Bolt is an independent project and is not affiliated with Pi's authors or with Oven.

## License

Pi-Bolt's scripts, tools and documentation are [MIT](LICENSE) licensed. The patches and the release executables include
third-party software under its own licenses (Bun: MIT; JavaScriptCore: LGPL-2.0 and BSD; ICU: Unicode License; Pi: MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
