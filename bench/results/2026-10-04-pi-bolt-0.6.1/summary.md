### Time

|  | Pi-Bolt | Bun 1.0.0 on stock Bun 1.4.2 | Node 22 | Node 24 |
|---|---:|---:|---:|---:|
| Launch to interactive (TUI) | 45 ms | 128 ms | 303 ms | 306 ms |
| pi --version | 14 ms | 82 ms | 228 ms | 228 ms |
| pi -p: one prompt, 4 tool calls | 79 ms | 172 ms | 404 ms | 400 ms |
| Time per prompt, 4.2M-token session | 562 ms | 704 ms | 965 ms | 912 ms |

### CPU

|  | Pi-Bolt | Bun 1.0.0 on stock Bun 1.4.2 | Node 22 | Node 24 |
|---|---:|---:|---:|---:|
| Interactive session: 5 prompts | 303 ms | 844 ms | 1,242 ms | 1,233 ms |
| pi -p: one prompt | 81 ms | 329 ms | 571 ms | 592 ms |
| pi --version | 15 ms | 145 ms | 287 ms | 293 ms |
| Per prompt, 4.2M-token session | 301 ms | 507 ms | 823 ms | 760 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.0.0 on stock Bun 1.4.2 | Node 22 | Node 24 |
|---|---:|---:|---:|---:|
| Peak memory, interactive session | 147 MB | 204 MB | 214 MB | 235 MB |
| Own memory, tmux session | 27 MB | 89 MB | 132 MB | 209 MB |
| Own memory, end of 4.2M-token session | 201 MB | 241 MB | 601 MB | 613 MB |
| Streaming replies (tmux), CPU | 320 ms | 524 ms | 605 ms | 530 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 46 ms | 50 ms |
| Pi-Bolt (JIT on), compiled in | 45 ms | 53 ms |
| Pi-Bolt, run time | 75 ms | 1,119 ms |
| Pi-Bolt (JIT on), run time | 79 ms | 42 ms |
| Bun 1.0.0 on stock Bun 1.4.2, run time | 195 ms | 38 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 4, tmux rounds: 5
