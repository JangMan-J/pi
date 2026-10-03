### Long answers and large files

Means of two runs (they differed by at most 5%).

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Streaming a 20,000-character answer: CPU | 1.2 s | 10.3 s | 8.4 s |
| Streaming a 60,000-character answer: CPU | 4.8 s | 44.3 s | 43.7 s |
| Share of a core while it streams (60,000 characters) | 10% | 88% | 87% |
| Writing a 50 KB file through a tool call | 0.3 s | 2.0 s | 2.9 s |
| Writing a 200 KB file through a tool call | 0.9 s | 29.7 s | 43.5 s |
| Writing a 200 KB file through a tool call: CPU | 0.6 s | 71.6 s | 44.5 s |

Answers stream at 1,200 characters a second (24 every 20 ms); tool-call arguments 16 characters at a time. Bun and Node run
Pi 1.0.0 as released (`v1.0.0`): Bun as `scripts/build-pi.sh --stable --pi <Pi 1.0.0>`, Node as Pi's npm bundle.
Tools: `bench/long_answer.py`, `bench/large_write.py`, pinned to 8 cores (40-47).
