### Time

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 46 ms | 65 ms | 190 ms |
| pi --version | 19 ms | 32 ms | 152 ms |
| pi -p: one prompt, 4 tool calls | 46 ms | 71 ms | 230 ms |
| Time per prompt, 4.2M-token session | 216 ms | 280 ms | 342 ms |

### CPU

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 148 ms | 370 ms | 550 ms |
| pi -p: one prompt | 44 ms | 144 ms | 298 ms |
| pi --version | 16 ms | 57 ms | 161 ms |
| Per prompt, 4.2M-token session | 72 ms | 156 ms | 258 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Peak memory, interactive session | 136 MB | 198 MB | 234 MB |
| Own memory, tmux session | 30 MB | 67 MB | 94 MB |
| Own memory, end of 4.2M-token session | 52 MB | 98 MB | 2,450 MB |
| Streaming replies (tmux), CPU | 670 ms | 856 ms | 900 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 38 ms | 44 ms |
| Pi-Bolt (JIT on), compiled in | 38 ms | 44 ms |
| Pi-Bolt, run time | 49 ms | 485 ms |
| Pi-Bolt (JIT on), run time | 50 ms | 39 ms |
| Bun 1.4.2, run time | 77 ms | 40 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 5
