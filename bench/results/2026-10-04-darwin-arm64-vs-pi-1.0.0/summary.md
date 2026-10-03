### Time

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 48 ms | 64 ms | 188 ms |
| pi --version | 20 ms | 32 ms | 147 ms |
| pi -p: one prompt, 4 tool calls | 45 ms | 67 ms | 214 ms |
| Time per prompt, 4.2M-token session | 212 ms | 279 ms | 342 ms |

### CPU

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 149 ms | 368 ms | 544 ms |
| pi -p: one prompt | 42 ms | 134 ms | 276 ms |
| pi --version | 17 ms | 56 ms | 157 ms |
| Per prompt, 4.2M-token session | 71 ms | 156 ms | 259 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Peak memory, interactive session | 136 MB | 198 MB | 238 MB |
| Own memory, tmux session | 32 MB | 66 MB | 81 MB |
| Own memory, end of 4.2M-token session | 54 MB | 100 MB | 2,517 MB |
| Streaming replies (tmux), CPU | 724 ms | 880 ms | 952 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 43 ms | 44 ms |
| Pi-Bolt (JIT on), compiled in | 44 ms | 43 ms |
| Pi-Bolt, run time | 52 ms | 482 ms |
| Pi-Bolt (JIT on), run time | 54 ms | 39 ms |
| Bun 1.4.2, run time | 78 ms | 39 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 5
