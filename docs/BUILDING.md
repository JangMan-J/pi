# Building Pi-Bolt

Pi-Bolt is built in two stages:

1. **The runtime**: Bun on a patched JavaScriptCore with the ahead-of-time compiler. Build it once, or download it from a release.
2. **Pi**: compiled with that runtime into a single executable. This takes about a minute, and it is where plugins are added.

- [Quick start: release runtime](#quick-start-release-runtime)
- [Building the runtime](#building-the-runtime)
- [Building Pi](#building-pi)
- [Training profiles](#training-profiles)
- [Packaging a release](#packaging-a-release)
- [Tests](#tests)
- [Where things go](#where-things-go)

## Quick start: release runtime

Needs git, Node.js 22.19 or later with npm (to build Pi), Python 3, and rsync (for plugins).

```bash
git clone https://github.com/opensec-git/Pi-Bolt.git && cd Pi-Bolt
scripts/fetch-runtime.sh     # the Pi-Bolt runtime from the latest release -> .work/runtime/bun
scripts/fetch-pi.sh          # Pi at the version in sources.json, cloned and built -> .work/pi
scripts/build-pi.sh          # -> out/pi-bolt/pi
out/pi-bolt/pi --version
```

## Building the runtime

### Requirements

| Tool | Version | Notes |
|---|---|---|
| Linux x86-64 | | 32 GB of RAM or more; about 40 GB of disk |
| clang / LLVM | 23.1 | the version Bun's build pins (`scripts/build/ci-images/spec.ts` in Bun) |
| CMake | 3.30 | |
| Ninja | | |
| Rust | stable | `cargo` on `PATH` |
| Bun | 1.4.2 | runs Bun's build script |
| Docker | | only for the portable sysroot (`make-sysroot.sh`) |

### Steps

```bash
scripts/fetch-sources.sh            # oven-sh/WebKit and oven-sh/bun at the pinned commits, with patches/ applied
scripts/toolchain/make-sysroot.sh   # Ubuntu 20.04 sysroot + gcc-13 libstdc++ + static ICU 78.3 -> .toolchain/sysroot-glibc
scripts/build-runtime.sh            # release build with LTO -> .work/runtime/bun
```

`fetch-sources.sh` reads [`sources.json`](../sources.json):

- the upstream repositories and commits: WebKit from the `claude/sound-types-aot` branch of
  [oven-sh/WebKit#743](https://github.com/oven-sh/WebKit/pull/743), and Bun from `main`;
- the patch series in [`patches/`](../patches), applied with `git am`.

The sysroot is what makes the executables portable. Linked against it, they need only glibc 2.17, and they carry their own
ICU, like official Bun builds.

`scripts/build-runtime.sh --native` skips the sysroot and links against the host's libc and ICU. That is faster to set up, but
the result runs only on systems like the build machine.

### Working on the engine

The checkouts in `.work/webkit` and `.work/bun` are ordinary git repositories. The patches are their commits on top of the
pinned upstream commits. After changing the engine, rebuild with `scripts/build-runtime.sh`, then regenerate the patches:

```bash
git -C .work/webkit format-patch -o "$PWD/patches/webkit" <pinned-commit>..HEAD
git -C .work/bun format-patch -o "$PWD/patches/bun" <pinned-commit>..HEAD
```

## Building Pi

```bash
scripts/build-pi.sh [options]
```

| Option | Default | |
|---|---|---|
| `--pi DIR` | `.work/pi` | A Pi checkout that has been built (`npm ci && npm run build`). |
| `--out DIR` | `out/pi-bolt` | Where the executable and its asset files go. |
| `--jit on\|off` | `off` | `on` also JIT-compiles code loaded at run time, such as run-time plugins. |
| `--cpu native\|baseline` | `native` | `native`: code for the build machine's instruction set (AVX2 class); on a CPU without it, the executable runs from bytecode. `baseline`: any x86-64 CPU. |
| `--profile DIR` | `profiles/pi-<version>` | Training profile ([below](#training-profiles)). |
| `--plugins FILE` | | Compile plugins in ([PLUGINS.md](PLUGINS.md)). |
| `--plugin-worker PATH` | | A worker script a plugin starts. Repeatable. |
| `--keep-bytecode` | | Keep bytecode in the prebuilt heap. By default it is left out, which saves memory and lets the compiler inline across Pi's functions. |
| `--stable` | | Build with a stock Bun (`PIBOLT_STABLE_BUN`, default `bun`) instead, as a comparison. |

The executable has to stay next to the files `build-pi.sh` puts beside it: Pi's themes, assets, HTML export template, the
photon WASM module and the native terminal helpers.

The script checks the result: the executable must report `image registered: true`, meaning it runs its compiled code.

### Building another Pi version

```bash
scripts/fetch-pi.sh --tag v1.0.1 --dir .work/pi-1.0.1
scripts/train-profile.sh --pi .work/pi-1.0.1        # records profiles/pi-1.0.1
scripts/build-pi.sh --pi .work/pi-1.0.1 --out out/pi-bolt-1.0.1
```

A build without a profile works, with somewhat slower startup. `build-pi.sh` warns when there is none.

## Training profiles

A profile ([`profiles/pi-1.0.0`](../profiles/pi-1.0.0)) has two files, recorded by running a plain bytecode build of Pi through a
scripted interactive session (`scripts/lib/train_session.py`):

| File | What it holds | What it is used for |
|---|---|---|
| `bytecode.order` | The functions that ran, in the order they first ran | Laying out code and heap so that startup touches as few pages as possible |
| `regexps.txt` | Regular expressions the program built from strings at run time | Compiling them ahead of time, like regular-expression literals |

```bash
scripts/train-profile.sh [--pi DIR] [--plugins FILE] [--out DIR]
```

## Packaging a release

```bash
scripts/package-release.sh [--pi DIR] [--no-build]
```

This builds the three Pi targets (`linux-x64`, `linux-x64-baseline`, `linux-x64-jit`) and checks that each uses its compiled code.
It writes them, the runtime and `SHA256SUMS` to `dist/<VERSION>/`. Each archive includes the license notices.

## Tests

| Command | What it checks |
|---|---|
| `tests/aot/run.sh` | Engine correctness. Programs that stress values held in registers across slow paths, `Map`/`Set` fast paths, realms and workers are compiled ahead of time (JIT on and off). Their output must equal stock Bun's. |
| `python3 bench/e2e_tools.py --reference bun=out/pi-stable/pi --build pi-bolt=out/pi-bolt/pi` | Every Pi tool (`ls`, `find`, `grep`, `write`, `edit`, `bash`, `read`) driven by a scripted model. The transcript and resulting files must be byte-identical to the reference build's. |
| `python3 bench/ui_check.py --project .work/pi --build pi-bolt=out/pi-bolt/pi` | The TUI on a pseudo-terminal: trust prompt, `/` commands, `/hotkeys`, `/session`, `!` bash, a model turn with tool calls, `/model`, `/quit`. |
| `python3 bench/tmux_check.py --build pi-bolt=out/pi-bolt/pi` | Pi in a real tmux pane: keystroke latency, paste, streaming, resize, Escape to abort, idle CPU, memory. |

`out/pi-stable/pi` is the stock-Bun comparison build: `scripts/build-pi.sh --stable --out out/pi-stable`.

The engine itself was also checked against JavaScriptCore's own test suite, `JSTests/stress`. Each test runs with and without
ahead-of-time compilation, and the outputs are compared. 4,779 of the 4,786 tests that run behave the same. The 7 that differ
inspect engine internals that do not exist without a JIT, such as tier-up and reoptimization counters and sampling-profiler frames.

## Where things go

| Path | Contents | In git |
|---|---|---|
| `.work/` (`PIBOLT_WORK`) | sources, the runtime, Pi checkouts, test output | no |
| `.toolchain/` | the sysroot | no |
| `out/` | Pi builds | no |
| `dist/` | release archives | no |
