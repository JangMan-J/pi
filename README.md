<p align="center">
  <a href="https://github.com/opensec-git/Pi-Bolt">
    <img alt="Pi-Bolt logo" src="docs/images/logo.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://github.com/opensec-git/Pi-Bolt/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/opensec-git/Pi-Bolt?style=flat-square&color=2a78d6" /></a>
  <a href="https://www.npmjs.com/package/pi-bolt"><img alt="npm" src="https://img.shields.io/npm/v/pi-bolt?style=flat-square&logo=npm&logoColor=white&color=2a78d6" /></a>
  <a href="https://github.com/earendil-works/pi/releases/tag/v1.0.0"><img alt="Pi 1.0.0" src="https://img.shields.io/badge/pi-1.0.0-f0b03a?style=flat-square" /></a>
  <a href="#requirements"><img alt="Linux x86-64" src="https://img.shields.io/badge/linux-x86--64-444?style=flat-square&logo=linux&logoColor=white" /></a>
  <a href="#requirements"><img alt="macOS Apple silicon" src="https://img.shields.io/badge/macOS-Apple%20silicon-444?style=flat-square&logo=apple&logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1baf7a?style=flat-square" /></a>
</p>

> Pi-Bolt is a fork of [Pi](https://github.com/earendil-works/pi) by an independent team, not affiliated with Pi's authors
> or with Oven. This repository is Pi 1.0.0 with its full history, plus Pi-Bolt's compiler patches, build scripts and
> benchmarks.

# Pi-Bolt

Pi-Bolt is the [Pi](https://github.com/earendil-works/pi) coding agent compiled ahead of time to native code. It is one
executable, for Linux on x86-64 and macOS on Apple silicon, that starts two to three times sooner than Pi on Bun and uses about
a third of its CPU over a session, with no JIT.

It runs the Pi you already use: the commands, keys, sessions, settings, extensions and providers are all Pi's. What differs is
how Pi is executed. Every function is compiled to machine code (x86-64 or ARM64) when the executable is built, and stored in it
together with a prebuilt JavaScript heap, so at launch nothing is parsed, interpreted or JIT-compiled.

* **[Getting started](#getting-started)**: install a release; there is nothing to compile
* **[Benchmarks](docs/BENCHMARKS.md)**: Pi-Bolt vs Pi on Bun and on Node, with method and raw data
* **[Plugins](docs/PLUGINS.md)**: compile your Pi extensions in, and they run as machine code too
* **[The fork](#the-fork)**: what Pi-Bolt adds to Pi's tree, and what it leaves alone

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-hero-dark.svg">
  <img alt="Pi-Bolt vs Bun 1.4.2 vs Node 22: ready to type 45 / 128 / 303 ms; CPU per session 303 / 844 / 1,242 ms; CPU while streaming 320 / 524 / 605 ms; memory after a long session 201 / 241 / 601 MB" src="docs/images/bench-hero-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-long-dark.svg">
  <img alt="Long answers and large files, Pi-Bolt vs Bun 1.4.2 vs Node 22: CPU streaming a 20,000-character answer 1.0 / 10.4 / 8.4 s; a 60,000-character answer 3.8 / 43.1 / 43.7 s; share of a core while streaming 8 / 85 / 87%; writing a 200 KB file through a tool call 0.8 / 27.8 / 44.3 s" src="docs/images/bench-long-light.svg">
</picture>

<sub>Pi 1.0.0 compiled by Pi-Bolt, against the same release on stock Bun 1.4.2 and on Node 22, measured on one Linux server (AMD
EPYC 7B13). Medians of interleaved runs; lower is better. Times on other machines differ; the ratios are what carries over. macOS
figures and the method are under [Benchmarks](#benchmarks).</sub>

## Getting started

Install the latest release:

```bash
curl -fsSL https://pi-bolt.opensec.in/install.sh | sh
```

The installer:

- picks the build for your CPU;
- downloads it from the npm registry's CDN, or from GitHub if that fails (`PIBOLT_SOURCE=github` to use GitHub only);
- checks its SHA-256 checksum against the GitHub release;
- verifies the release's signature, with OpenSSL 3 or later;
- installs it to `~/.pi-bolt`;
- links the `pi-bolt` command into `~/.local/bin`;
- offers to install OpenSec's two optional [extensions](#extensions).

Run it again to reinstall or uninstall. Pi-Bolt is self-contained: it needs neither Node.js nor Bun. Extensions are installed
with npm where it is installed, and otherwise with the package manager built into Pi-Bolt.

Or use a package manager:

```bash
npm install -g pi-bolt
```

```bash
bun add -g pi-bolt
```

The package's first run downloads the native executable. After that, `pi-bolt` starts it directly, with no Node.js or Bun in
between.

Start it where you want it to work:

```bash
cd /path/to/project
pi-bolt
```

Pi-Bolt shares your Pi configuration in `~/.pi/agent`, so your providers, settings and sessions are already there. If you are
new to Pi, run `/login` inside it to connect a provider, then give it a task. To use it as your `pi`, add `alias pi=pi-bolt` to
your shell profile. Everything in [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
applies.

You can also download a build from the [latest release](https://github.com/opensec-git/Pi-Bolt/releases/latest), check it
against `SHA256SUMS`, unpack it, and run `./pi` in the unpacked folder:

| Download | For |
|---|---|
| `pi-bolt-linux-x64.tar.xz` | **Linux.** CPUs with AVX2: Intel Haswell (2013) and later, AMD Zen and later |
| `pi-bolt-linux-x64-baseline.tar.xz` | Linux, any x86-64 CPU |
| `pi-bolt-darwin-arm64.tar.xz` | **macOS.** Macs with Apple silicon (M1 and later) |

Each build is also there as a `.tar.gz`, about 60% bigger, for systems without `xz`. The release also has builds with the JIT on
(`-jit`), for heavy use of plugins loaded at run time, and the Pi-Bolt runtime, to [compile plugins in](docs/PLUGINS.md). Most
people need neither: the installer and npm install the standard build. `pi-bolt --version` prints the Pi
version and, in brackets, the Pi-Bolt version and build; `pi-bolt update` installs the latest release.

### Extensions

Pi extensions and Pi packages work in Pi-Bolt as they do in Pi: install them with `pi-bolt install npm:<package>` or
`pi-bolt install git:<repository>`. The installer offers two that OpenSec maintains for Pi-Bolt, prebuilt for Bun so that
they load without being transpiled:

| Package | What it does |
|---|---|
| [`opensec-pi-subagents`](https://www.npmjs.com/package/opensec-pi-subagents) | Specialized agents in separate sessions that inherit the parent's model and thinking level; parallel workflows and scheduled jobs |
| [`opensec-pi-todo`](https://www.npmjs.com/package/opensec-pi-todo) | A todo list for the model, shown as a live panel above the editor |

Both are under the Apache License 2.0. To install them without the installer:

```bash
pi-bolt install npm:opensec-pi-subagents
pi-bolt install npm:opensec-pi-todo
```

`PIBOLT_EXTENSIONS=yes` (or `no`) answers the installer's question in advance, for scripted installs.

### Requirements

- Linux on x86-64 with glibc 2.17 or later. Tested on Ubuntu 20.04, 22.04 and 24.04, Debian 11 and 12, Rocky Linux 8 and 9,
  CentOS 7 and Amazon Linux 2. musl-based distributions such as Alpine are not supported.
- macOS 13 (Ventura) or later on a Mac with Apple silicon (M1 or later). Intel Macs are not supported. Install with the installer
  or npm: a build downloaded with a browser is quarantined, and macOS refuses to run it (see
  [Troubleshooting](docs/TROUBLESHOOTING.md#macos)).
- Windows and Linux on ARM64 are not available yet.

## Benchmarks

The same Pi 1.0.0 run three ways: compiled by Pi-Bolt, as released on stock Bun 1.4.2, and from its npm package on Node. Every
figure is a median of fresh processes, interleaved across the runtimes; lower is better everywhere.

**These are measurements, not guarantees.** Each table comes from one machine: an AMD EPYC 7B13 server for Linux and an M5
MacBook Air for macOS. On other hardware the milliseconds will differ, and so can the load, the terminal and the disk. What
carries over is the comparison, because every run interleaves the runtimes on the same machine: Pi-Bolt starts two to three
times sooner than Pi on Bun and uses about a third of its CPU over an interactive session.

**Linux x86-64** (AMD EPYC 7B13)

| | Pi-Bolt | Pi on Bun 1.4.2 | Pi on Node 22 |
|---|---:|---:|---:|
| Ready to type | **45 ms** | 128 ms | 303 ms |
| `pi --version` | **14 ms** | 82 ms | 228 ms |
| One prompt (`pi -p`), CPU | **81 ms** | 329 ms | 572 ms |
| Interactive session, CPU | **303 ms** | 844 ms | 1,242 ms |
| Streaming a 60,000-character answer, CPU | **3.8 s** | 43.1 s | 43.7 s |
| Writing a 200 KB file through a tool call | **0.8 s** | 27.8 s | 44.3 s |
| Memory of a session in tmux | **27 MB** | 89 MB | 132 MB |
| A tool turn with a real model, CPU | **0.20 s** | 0.49 s | 0.77 s |

**macOS on Apple silicon** (M5 MacBook Air)

| | Pi-Bolt | Pi on Bun 1.4.2 | Pi on Node 26 |
|---|---:|---:|---:|
| Ready to type | **31 ms** | 63 ms | 193 ms |
| `pi --version` | **12 ms** | 33 ms | 157 ms |
| One prompt (`pi -p`), CPU | **32 ms** | 138 ms | 290 ms |
| Interactive session, CPU | **126 ms** | 363 ms | 544 ms |
| Streaming a 60,000-character answer, CPU | **6.9 s** | 25.3 s | 24.0 s |
| Writing a 200 KB file through a tool call | **0.3 s** | 12.0 s | 14.2 s |
| Memory after a 4.2M-token session | **64 MB** | 95 MB | 1,890 MB |
| Five prompts with a real model, CPU | **4.3–5.6 s** | 8.9–11.5 s | 8.0–10.1 s |

With a real model the user waits the same on every runtime, because the model sets the pace; Pi-Bolt does the waiting with less
than half the CPU. Most rows run against a local model server that streams a scripted conversation, so they measure Pi and its
runtime, not the network or a model. The last row of each table uses a hosted model over the internet
([With a real model](docs/BENCHMARKS.md#with-a-real-model)). Bun runs Pi 1.0.0 as released, built with Pi's own
`bun build --compile` plus `--bytecode`; Node runs Pi's npm package. [macOS on Apple silicon](docs/BENCHMARKS.md#macos-on-apple-silicon)
has the Mac's charts and caveats.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-speed-dark.svg">
  <img alt="Time on Linux, Pi-Bolt vs Bun 1.4.2 vs Node 22: ready to type 45 / 128 / 303 ms; pi --version 14 / 82 / 228 ms; one prompt 79 / 172 / 404 ms; time per prompt in a 4.2M-token session 562 / 704 / 965 ms" src="docs/images/bench-speed-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-cpu-dark.svg">
  <img alt="CPU time on Linux, Pi-Bolt vs Bun 1.4.2 vs Node 22: interactive session 303 / 844 / 1,242 ms; one prompt 81 / 329 / 572 ms; pi --version 15 / 145 / 287 ms; per prompt in a 4.2M-token session 301 / 507 / 823 ms" src="docs/images/bench-cpu-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-memory-dark.svg">
  <img alt="Memory and streaming on Linux, Pi-Bolt vs Bun 1.4.2 vs Node 22: peak memory 147 / 204 / 214 MB; own memory in tmux 27 / 89 / 132 MB; own memory after a 4.2M-token session 201 / 241 / 601 MB; CPU while replies stream 320 / 524 / 605 ms" src="docs/images/bench-memory-light.svg">
</picture>

### Long answers and large files

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-long-dark.svg">
  <img alt="Long answers and large files, Pi-Bolt vs Bun 1.4.2 vs Node 22: CPU streaming a 20,000-character answer 1.0 / 10.4 / 8.4 s; a 60,000-character answer 3.8 / 43.1 / 43.7 s; share of a core while streaming 8 / 85 / 87%; writing a 200 KB file through a tool call 0.8 / 27.8 / 44.3 s" src="docs/images/bench-long-light.svg">
</picture>

Pi renders an answer again each time a few more words arrive, and re-reads a tool call's arguments each time a few more
characters arrive. On Pi as released the cost of each grows with what has arrived so far, so a long answer keeps a core busy
and a large file takes half a minute before the tool runs. Pi-Bolt renders again only the end of an answer, and re-reads
arguments only as they grow by an eighth. Answers stream at
1,200 characters a second, tool-call arguments 16 characters at a time; Bun and Node run Pi 1.0.0 as released.

In fullscreen mode Pi also writes every row of the screen again when an answer grows by a line. Pi-Bolt scrolls the rows that
only moved: for a 20,000-character answer it writes 0.5 MB to the terminal where Pi writes 3.6 MB, and a tmux server between
Pi and the screen uses a quarter of the CPU. Written through a tool call in the TUI, a 200 KB file stops Pi as released for
most of a minute while its arguments arrive; Pi-Bolt never pauses for more than 0.1 s.

[docs/BENCHMARKS.md](docs/BENCHMARKS.md) has every figure, the method, and the raw data. It also answers
[why run-time plugins are slow on the default build](docs/BENCHMARKS.md#why-is-a-run-time-plugins-loop-1080-ms-on-pi-bolt-and-38-ms-on-bun)
and [how the streaming CPU gap was closed](docs/BENCHMARKS.md#how-was-the-streaming-gap-closed). To reproduce everything, run
[`bench/run-suite.sh`](bench/run-suite.sh).

## Plugins

Pi extensions work in Pi-Bolt unchanged: in `~/.pi/agent/extensions`, in a project's `.pi/extensions`, or as Pi packages. For
the ones you use every day, compile them into the executable:

```bash
scripts/build-pi.sh --plugins my-plugins/plugins.ts --out out/pi-bolt-plugins
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/bench-plugins-dark.svg">
  <img alt="A plugin's hot loop: 50 ms compiled in, 1,119 ms loaded at run time on the JIT-off build, 42 ms on the JIT-on build, 38 ms on Bun" src="docs/images/bench-plugins-light.svg">
</picture>

The default build has no JIT. A plugin loaded at run time is therefore interpreted, and a plugin compiled in runs as machine code.
[docs/PLUGINS.md](docs/PLUGINS.md) covers porting, compatibility, and writing plugin code the compiler handles well.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/how-it-works-dark.svg">
  <img alt="Build time: Pi is bundled and compiled to bytecode by bun build, then every function is compiled to x86-64 machine code by the AOT compiler, guided by a training profile. The result is one executable holding the Bun runtime, a prebuilt heap and the machine code. At launch, pi maps the code and heap from the file and runs main()." src="docs/images/how-it-works-light.svg">
</picture>

1. **Bun bundles Pi** and compiles it to JavaScriptCore bytecode.
2. **The ahead-of-time compiler** turns every function into optimized machine code (x86-64 or ARM64), through B3, the back end of
   JavaScriptCore's top-tier JIT. It infers types from the program, guards its assumptions, and keeps generic paths for what it
   cannot prove.
3. **The prebuilt heap** is Pi's modules, already loaded and evaluated. It is stored in the executable and mapped at launch.
4. **A training profile**, recorded once per Pi version, orders the code so that startup touches as few pages as possible.

The compiler comes from [oven-sh/WebKit#743](https://github.com/oven-sh/WebKit/pull/743), which targets ARM64. Pi-Bolt ports it
to x86-64, brings it to macOS, and adds its own code-generation and runtime work. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The fork

The `packages/` tree is Pi at [v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0) with Pi-Bolt's changes on
top, each a separate commit after Pi's "Release v1.0.0":
- how the terminal is drawn while answers stream;
- less work at startup;
- installing packages without npm;
- messages that name the `pi-bolt` command.

The commands, settings, sessions and extension API are Pi's. Pi-Bolt adds:

| | |
|---|---|
| `patches/` | its changes to WebKit (JavaScriptCore's ahead-of-time compiler) and Bun, against the commits in `sources.json` |
| `scripts/` | `prepare-pi.sh`, `build-runtime.sh`, `build-pi.sh` and the rest, next to Pi's own scripts |
| `profiles/` | training profiles per Pi version |
| `bench/`, `tests/aot/` | benchmarks with their published results, and engine tests |
| `docs/`, `examples/`, `install.sh` | documentation, an example plugin, the installer |

It also replaces Pi's README, CONTRIBUTING and SECURITY files with its own, and leaves out Pi's GitHub automation.
For Pi itself, see [earendil-works/pi](https://github.com/earendil-works/pi) and its
[README](packages/coding-agent/README.md).

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | What the executable contains, how it is built, what happens at launch |
| [Building](docs/BUILDING.md) | Building the runtime and Pi from source, training profiles, tests |
| [Benchmarks](docs/BENCHMARKS.md) | Method, results, raw data, and questions |
| [Plugins](docs/PLUGINS.md) | Porting Pi extensions, compatibility, writing them for AOT |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Diagnostics, environment variables, known limitations |
| [Releasing](docs/RELEASING.md) | The release pipeline, the self-hosted runner, signing, following Pi's releases |

## Development

Build everything from source:

```bash
git clone https://github.com/opensec-git/Pi-Bolt.git
cd Pi-Bolt
scripts/fetch-sources.sh            # WebKit and Bun at the pinned commits, with Pi-Bolt's patches
scripts/toolchain/make-sysroot.sh   # glibc 2.17 sysroot with static ICU, for portable executables (Linux only)
scripts/build-runtime.sh            # the Pi-Bolt Bun runtime
scripts/prepare-pi.sh               # builds the Pi in this repository (1.0.0)
scripts/build-pi.sh                 # out/pi-bolt/pi
```

To skip building the runtime, run `scripts/fetch-runtime.sh` instead of the first three commands. It downloads the released
runtime, and building Pi then takes about a minute.

Before submitting changes, run:

```bash
tests/aot/run.sh                                                        # engine tests
python3 bench/e2e_tools.py --reference bun=out/pi-stable/pi --build pi-bolt=out/pi-bolt/pi
python3 bench/ui_check.py --project . --build pi-bolt=out/pi-bolt/pi
```

[docs/BUILDING.md](docs/BUILDING.md) has the requirements, every option, and how to regenerate the patches.


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT. The release executables include third-party software under its own licenses: Bun (MIT), JavaScriptCore (LGPL-2.0 and
BSD), ICU (Unicode License) and Pi (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<p align="center">
  Built on <a href="https://github.com/earendil-works/pi">Pi</a> by Mario Zechner and contributors,
  and <a href="https://github.com/oven-sh/bun">Bun</a> by Oven.
</p>
