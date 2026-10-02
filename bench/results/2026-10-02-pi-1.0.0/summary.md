### Time

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 83 ms | 123 ms | 296 ms |
| pi --version | 47 ms | 78 ms | 226 ms |
| pi -p: one prompt, 4 tool calls | 113 ms | 167 ms | 405 ms |
| Time per prompt, 2.7M-token session | 146 ms | 188 ms | 247 ms |

### CPU

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 395 ms | 831 ms | 1,237 ms |
| pi -p: one prompt | 128 ms | 323 ms | 576 ms |
| pi --version | 50 ms | 143 ms | 282 ms |
| Per prompt, 2.7M-token session | 89 ms | 144 ms | 213 ms |

### Memory and streaming

|  | Pi-Bolt | Bun 1.4.2 | Node 22 |
|---|---:|---:|---:|
| Peak memory, interactive session | 155 MB | 201 MB | 212 MB |
| Own memory, tmux session | 36 MB | 90 MB | 132 MB |
| Own memory, end of 2.7M-token session | 126 MB | 289 MB | 474 MB |
| Streaming replies (tmux), CPU | 482 ms | 531 ms | 618 ms |

### Plugins

|  | launch | hot loop |
|---|---:|---:|
| Pi-Bolt, compiled in | 86 ms | 54 ms |
| Pi-Bolt (JIT on), compiled in | 83 ms | 53 ms |
| Pi-Bolt, run time | 114 ms | 1,087 ms |
| Pi-Bolt (JIT on), run time | 122 ms | 41 ms |
| Bun 1.4.2, run time | 194 ms | 38 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 7
