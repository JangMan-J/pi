# Troubleshooting

- [Is the compiled code being used?](#is-the-compiled-code-being-used)
- [Notices at startup](#notices-at-startup)
- [Environment variables](#environment-variables)
- [Common problems](#common-problems)
- [Reporting a problem](#reporting-a-problem)

## Is the compiled code being used?

```bash
BUN_STATIC_HEAP_VERBOSE=1 pi-bolt --version
```

```
[aot] image of 42467328 bytes mapped, 35635200 of them code
[static heap] 94109736 bytes in executable, mapped: true
[aot] image registered: true
1.0.0
```

`image registered: true` means Pi runs its ahead-of-time compiled code. Without the variable, a healthy executable prints nothing
extra.

## Notices at startup

When the compiled code cannot be used, the executable prints one line on stderr, then runs Pi from its bytecode. That is correct,
but slower to start, and uses more CPU:

```
bun: the executable's ahead-of-time compiled code is not used (<reason>); running from bytecode
```

| Reason | Cause | What to do |
|---|---|---|
| `the address space for it is not available` | An address-space limit (`ulimit -v`, `RLIMIT_AS`, or `vm.overcommit_memory=2`) leaves no room for the fixed regions the code expects. | The compiled code needs about 10 GB of *virtual* address space. It is reserved, not used, so it costs no memory. Raise or remove the limit. Below it, Pi still works from bytecode, down to about 1.5 GB. |
| `this CPU lacks an instruction set the code was compiled for` | A `linux-x64` build on a CPU without AVX2. | Use the `linux-x64-baseline` build (`PIBOLT_VARIANT=x64-baseline` with the installer). |
| `the image is not one for this engine`, `the image could not be mapped executable`, `the prebuilt heap could not be mapped` | A damaged executable, or a system that forbids executable file mappings. | Re-download the release and check `SHA256SUMS`. Report it if it persists. |

One failure is fatal instead: `the executable's ahead-of-time code image was rejected by the engine; run with BUN_AOT=0 to use
the bytecode instead`. It should not happen with release builds. Run with `BUN_AOT=0` and report it.

## Environment variables

These are read by the executable at run time.

| Variable | Effect |
|---|---|
| `BUN_AOT=0` | Ignore the compiled code and static heap; run from bytecode. Use it to tell whether a problem is specific to the AOT code. |
| `BUN_STATIC_HEAP_VERBOSE=1` | Report how the static heap and code image were mapped. |
| `PI_TIMING=1` | Pi's own startup timings, including each extension's factory. |

Pi's own variables (`PI_CODING_AGENT_DIR`, `PI_OFFLINE`, ...) work as documented by Pi.

Build-time variables (`BUN_STATIC_HEAP`, `BUN_AOT`, `BUN_AOT_JIT`, `BUN_AOT_CPU`, `BUN_JSC_*`) are set by `scripts/build-pi.sh`.
See [ARCHITECTURE.md](ARCHITECTURE.md#build-pipeline).

## Common problems

**`pi-bolt: command not found` after installing.** `~/.local/bin` is not on your `PATH`. Add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

**`GLIBC_2.xx not found` or `No such file or directory` when starting.** The system is musl-based (Alpine), or older than
glibc 2.17. Pi-Bolt needs glibc 2.17 or later.

**A theme, the HTML export or image tools are missing.** The executable was moved away from the files around it. Keep the whole
folder together, and link or alias the executable instead of copying it.

**A plugin works with stock Pi but not when compiled in.** See the [compatibility checklist](PLUGINS.md#compatibility-checklist):
usually a dynamic import, or a file read from next to the plugin's source.

**A run-time plugin is slow.** On the default build, plugins loaded at run time are interpreted. Compile them in
([PLUGINS.md](PLUGINS.md)) or use the `linux-x64-jit` build.

**Startup is slower than expected.** Check that the compiled code is used (above). Check `PI_TIMING=1` for slow extension
factories. A cold page cache (the first start after boot or install) adds the time to read the executable from disk.

## Reporting a problem

Please [open an issue](https://github.com/opensec-git/Pi-Bolt/issues/new) with:

- the output of `BUN_STATIC_HEAP_VERBOSE=1 pi-bolt --version`;
- your distribution, `ldd --version | head -1`, and the CPU model (`grep -m1 "model name" /proc/cpuinfo`);
- whether the problem also happens with `BUN_AOT=0 pi-bolt`, and with stock Pi.

If it only happens with the compiled code, it is a Pi-Bolt bug. If it also happens with stock Pi, report it to
[Pi](https://github.com/earendil-works/pi/issues).

### A crash

When Pi-Bolt crashes it prints "Pi-Bolt has crashed", some lines about the system, and a link that starts with
`https://pi-bolt.opensec.in/crash/`. The link holds an encoded stack trace and nothing else: no file names, paths or data of
yours. Please include it in the issue, with what you were doing. Pi-Bolt's maintainers decode it against the symbols of that
release. (In Pi-Bolt 0.3.0 and earlier the message named Bun and the link went to bun.report, which cannot decode Pi-Bolt
traces: report those here too.)
