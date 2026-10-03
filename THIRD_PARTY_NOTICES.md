# Third-party notices

Pi-Bolt's own files (scripts, benchmarks, tests, documentation, examples) are under the [MIT license](LICENSE). Pi-Bolt builds on,
patches and redistributes the following projects, each under its own license.

| Project | Used for | License |
|---|---|---|
| [Pi](https://github.com/earendil-works/pi) (coding agent), © Mario Zechner | The application compiled by Pi-Bolt; the release executables contain it; `bench/fixtures/` holds four of its source files as test input | MIT |
| [Bun](https://github.com/oven-sh/bun), © Oven | The runtime; `patches/bun/` modifies it | MIT (see Bun's `LICENSE.md` for the libraries it links) |
| [WebKit / JavaScriptCore](https://github.com/oven-sh/WebKit) | The JavaScript engine; `patches/webkit/` modifies it | LGPL-2.0 and BSD-2-Clause (per file) |
| [ICU](https://github.com/unicode-org/icu) | Unicode support, linked statically into the Linux release runtime (the macOS runtime uses the system's) | Unicode License v3 |
| [GNU C Library](https://www.gnu.org/software/libc/) / [GCC libstdc++](https://gcc.gnu.org/) (Ubuntu 20.04 sysroot) | Build-time sysroot, so that the executables run on glibc 2.17 and later | LGPL-2.1 / GPL-3.0 with the GCC Runtime Library Exception |

## JavaScriptCore and the LGPL

JavaScriptCore is licensed under the GNU Lesser General Public License (LGPL-2.0), and the release executables link a modified
copy of it. The complete corresponding source is:

- the upstream WebKit commit named in [`sources.json`](sources.json), plus
- the patches in [`patches/webkit/`](patches/webkit),

which [`scripts/fetch-sources.sh`](scripts/fetch-sources.sh) and [`scripts/build-runtime.sh`](scripts/build-runtime.sh) combine and
build exactly as the releases were built ([docs/BUILDING.md](docs/BUILDING.md)). The patches are distributed under the licenses of
the files they modify.
