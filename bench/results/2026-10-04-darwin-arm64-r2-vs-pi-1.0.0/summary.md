### Time

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 30 ms | 63 ms | 192 ms |
| pi --version | 12 ms | 32 ms | 159 ms |
| pi -p: one prompt, 4 tool calls | 38 ms | 69 ms | 227 ms |
| Time per prompt, 4.2M-token session | 213 ms | 284 ms | 353 ms |

### CPU

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 128 ms | 367 ms | 555 ms |
| pi -p: one prompt | 33 ms | 136 ms | 291 ms |
| pi --version | 7.7 ms | 55 ms | 168 ms |
| Per prompt, 4.2M-token session | 70 ms | 156 ms | 271 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Peak memory, interactive session | 106 MB | 199 MB | 240 MB |
| Own memory, tmux session | 23 MB | 66 MB | 156 MB |
| Own memory, end of 4.2M-token session | 48 MB | 95 MB | 2,302 MB |
| Streaming replies (tmux), CPU | 543 ms | 752 ms | 864 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 43 ms | 43 ms |
| Pi-Bolt (JIT on), compiled in | 46 ms | 42 ms |
| Pi-Bolt, run time | 40 ms | 483 ms |
| Pi-Bolt (JIT on), run time | 43 ms | 38 ms |
| Bun 1.4.2, run time | 87 ms | 37 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 5
