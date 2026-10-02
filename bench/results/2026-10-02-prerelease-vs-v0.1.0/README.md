# Pre-release build vs v0.1.0

The question: did making Pi-Bolt production-ready (portable runtime with a glibc 2.17 sysroot and static ICU, loop splitting,
a retrained profile) make it slower? Both builds and stock Bun 1.4.2, interleaved in one session, pinned to the same cores.

- `old-prerelease`: the last build before the release work (dist/pi-1.0-aot-jitoff), runtime linked against the host's glibc and ICU.
- `release`: v0.1.0.
- `bun-stable`: Pi on Bun 1.4.2.

Files: `benchmark.jsonl` (bench/benchmark.py, 21 runs), `long.jsonl` (bench/long_session.py, 3 sessions of 75 prompts),
`tmux.jsonl` (bench/tmux_check.py, 5 rounds). Summary in docs/BENCHMARKS.md.
