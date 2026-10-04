### Time

|  | Pi-Bolt | Bun Pi 1.0.0 on Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Launch to interactive (TUI) | 31 ms | 63 ms | 193 ms |
| pi --version | 12 ms | 33 ms | 157 ms |
| pi -p: one prompt, 4 tool calls | 37 ms | 69 ms | 225 ms |
| Time per prompt, 4.2M-token session | 209 ms | 280 ms | 349 ms |

### CPU

|  | Pi-Bolt | Bun Pi 1.0.0 on Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Interactive session: 5 prompts | 126 ms | 363 ms | 544 ms |
| pi -p: one prompt | 32 ms | 138 ms | 290 ms |
| pi --version | 7.7 ms | 58 ms | 166 ms |
| Per prompt, 4.2M-token session | 70 ms | 158 ms | 265 ms |

### Memory and streaming

|  | Pi-Bolt | Bun Pi 1.0.0 on Bun 1.4.2 | Node 26 |
|---|---:|---:|---:|
| Peak memory, interactive session | 106 MB | 206 MB | 240 MB |
| Own memory, tmux session | 30 MB | 85 MB | 161 MB |
| Own memory, end of 4.2M-token session | 64 MB | 95 MB | 1,890 MB |
| Streaming replies (tmux), CPU | 555 ms | 629 ms | 898 ms |

runs: {'startup': 21, 'headless': 21, 'interactive': 21}, long sessions: 3, tmux rounds: 5
