<p align="center">
  <a href="https://github.com/opensec-git/Pi-Bolt">
    <img alt="Pi-Bolt logo" src="https://raw.githubusercontent.com/opensec-git/Pi-Bolt/HEAD/docs/images/logo.svg" width="112">
  </a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/pi-bolt"><img alt="npm" src="https://img.shields.io/npm/v/pi-bolt?style=flat-square&color=2a78d6" /></a>
  <a href="https://github.com/opensec-git/Pi-Bolt/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/opensec-git/Pi-Bolt?style=flat-square&color=f0b03a" /></a>
  <a href="https://github.com/opensec-git/Pi-Bolt/blob/HEAD/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1baf7a?style=flat-square" /></a>
</p>

# pi-bolt

[Pi](https://github.com/earendil-works/pi), the coding agent, compiled ahead of time to native code. Pi-Bolt is one executable,
for Linux on x86-64 and macOS on Apple silicon, that is ready in 74 ms and uses less than half the CPU of Pi on Bun, with no JIT.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/opensec-git/Pi-Bolt/HEAD/docs/images/bench-hero-dark.svg">
  <img alt="Pi-Bolt vs Bun 1.4.2 vs Node 22: ready to type 74 / 125 / 299 ms; CPU per session 336 / 823 / 1,205 ms; CPU while streaming 366 / 493 / 580 ms; memory after a long session 140 / 226 / 529 MB" src="https://raw.githubusercontent.com/opensec-git/Pi-Bolt/HEAD/docs/images/bench-hero-light.svg">
</picture>

## Install

```bash
npm install -g pi-bolt
```

With other package managers:

```bash
bun add -g pi-bolt
pnpm add -g pi-bolt
yarn global add pi-bolt
```

Without a package manager:

```bash
curl -fsSL https://pi-bolt.opensec.in/install.sh | sh
```

## Usage

Start Pi-Bolt in the directory where you want it to work:

```bash
cd /path/to/project
pi-bolt
```

Pi-Bolt is Pi. It uses your Pi configuration in `~/.pi/agent`, so your providers, settings, sessions and extensions are
already there. If you are new to Pi, run `/login` inside it to connect a provider, then give it a task. Everything in
[Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs) applies:

```bash
pi-bolt -p "summarize this repository"    # one prompt, print the answer
pi-bolt --help
```

## How the package works

This package does not contain the executable. Its `pi-bolt` command is a small shell script:

1. **On the first run**, it downloads the Pi-Bolt release that matches the package version from
   [GitHub](https://github.com/opensec-git/Pi-Bolt/releases). It verifies the download against the release's SHA-256
   checksums, then keeps it in `~/.pi-bolt/npm/<version>`.
2. **On every run**, it replaces itself with that native executable (`exec`). No Node.js or Bun process stays in between, and
   startup is the same as running the executable directly.

The package has no dependencies and no install scripts, so it works with package managers that block lifecycle scripts, such
as Bun.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PIBOLT_VARIANT` | `x64` on CPUs with AVX2, otherwise `x64-baseline`; `arm64` on macOS | Which build to use: `x64`, `x64-baseline` (any x86-64 CPU), or `x64-jit` (also JIT-compiles plugins loaded at run time); on macOS `arm64` or `arm64-jit` |
| `PIBOLT_HOME` | `~/.pi-bolt` | Where downloaded executables are kept |

## Update and uninstall

```bash
npm update -g pi-bolt       # the next run downloads the new version
npm uninstall -g pi-bolt
rm -rf ~/.pi-bolt/npm       # downloaded executables
```

## Requirements

- Linux on x86-64, glibc 2.17 or later: Ubuntu 20.04+, Debian 11+, Rocky Linux 8+, CentOS 7, Amazon Linux 2 and others.
  Alpine and other musl-based systems are not supported.
- Or macOS 13 or later on Apple silicon (M1 or later).
- `curl` or `wget`, `tar` and `sha256sum` (or, on macOS, `shasum`) for the first run.

## Links

- Source, documentation and benchmarks: [github.com/opensec-git/Pi-Bolt](https://github.com/opensec-git/Pi-Bolt)
- Compiling Pi extensions into the executable: [docs/PLUGINS.md](https://github.com/opensec-git/Pi-Bolt/blob/HEAD/docs/PLUGINS.md)
- Problems: [troubleshooting](https://github.com/opensec-git/Pi-Bolt/blob/HEAD/docs/TROUBLESHOOTING.md) and
  [issues](https://github.com/opensec-git/Pi-Bolt/issues)

Pi-Bolt is a fork of [Pi](https://github.com/earendil-works/pi) by an independent team, not affiliated with Pi's authors.

## License

MIT
