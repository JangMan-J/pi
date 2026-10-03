### Time

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 74 ms | 125 ms | 299 ms |
| pi --version | 45 ms | 78 ms | 223 ms |
| pi -p: one prompt, 4 tool calls | 108 ms | 171 ms | 403 ms |
| Time per prompt, 4.2M-token session | 539 ms | 693 ms | 946 ms |

### CPU

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 336 ms | 823 ms | 1,205 ms |
| pi -p: one prompt | 118 ms | 329 ms | 573 ms |
| pi --version | 48 ms | 139 ms | 278 ms |
| Per prompt, 4.2M-token session | 299 ms | 500 ms | 808 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Peak memory, interactive session | 159 MB | 204 MB | 212 MB |
| Own memory, tmux session | 33 MB | 85 MB | 133 MB |
| Own memory, end of 4.2M-token session | 140 MB | 226 MB | 529 MB |
| Streaming replies (tmux), CPU | 366 ms | 493 ms | 580 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 78 ms | 50 ms |
| Pi-Bolt (JIT on), compiled in | 76 ms | 49 ms |
| Pi-Bolt, run time | 109 ms | 1,105 ms |
| Pi-Bolt (JIT on), run time | 109 ms | 38 ms |
| Bun 1.4.2, run time | 194 ms | 38 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 5
