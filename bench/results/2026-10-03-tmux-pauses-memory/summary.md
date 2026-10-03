### In tmux, pauses, memory: 0.5.2 against 0.5.1

Two runs of each tool (one of the memory and long-session ones); the figures below are the means.

| | 0.5.1 | 0.5.2 |
|---|---:|---:|
| A 20,000-character answer in tmux, a client attached: Pi writes | 3,573 KB | 528 KB |
| tmux sends its client | 1,444 KB | 282 KB |
| CPU of the tmux server | 0.65 s | 0.16 s |
| CPU of Pi | 1.27 s | 1.09 s |
| A 50 KB file written through a tool call, in tmux: CPU of Pi | 5.5 s | 4.4 s |
| Longest pause of the TUI, 200 KB file written | 0.81 s | 0.08 s |
| Longest pause, 400 KB file | 1.34 s | 0.08 s |
| CPU, 200 KB file written (TUI) | 6.2 s | 3.9 s |
| CPU, 20,000-character answer (TUI on a pseudo-terminal) | 1.33 s | 1.03 s |
| CPU, 60,000-character answer | 5.0 s | 4.0 s |
| Own memory after a 60,000-character answer | 75 MB | 38 MB |
| Own memory after four 60,000-character answers | 159 MB | 72 MB |
| the same, idle for 15 s | 112 MB | 34 MB |
| CPU per prompt, 75th prompt of a session (16.9 MB request) | 322 ms | 300 ms |

Tools: `bench/tmux_load.py`, `bench/pauses.py`, `bench/long_answer.py --sizes 20000,60000`, `bench/long_session.py --prompts 75`,
all with `--cpus 40-47`. Answers stream at 1,200 characters a second; a file's content 16 characters every 2 ms (20 ms in tmux).
Own memory is private dirty memory (`/proc/PID/smaps_rollup`); after four answers: `bench/long_answer.py --sizes 60000,60000,60000,60000`
at 2 ms a chunk, read at the end and 15 s later.
