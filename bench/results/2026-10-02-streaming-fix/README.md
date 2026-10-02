# The streaming fix (v0.2.0)

Pi in a tmux pane, replies streamed at human pace, CPU while 4 replies stream (bench/tmux_check.py, 5 rounds, interleaved):

- `release`: v0.1.0.
- `fix-p3`: the v0.2.0 engine (int32 encoding of integral doubles, resolved substrings), loop splitting policy 3.
- `fix-p5`: the same with loop splitting policy 5 (the v0.2.0 default, after fixing its spread miscompile).
- `bun`: Pi on Bun 1.4.2.
