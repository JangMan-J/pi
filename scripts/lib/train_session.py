#!/usr/bin/env python3
"""One training session for a Pi executable built with the Pi-Bolt runtime (no AOT yet): starts the TUI, runs prompts that read
files, renders markdown and code, and quits, while the runtime records which functions run, in which order
(BUN_BYTECODE_ORDER_OUT), and which regular expressions the program builds at run time (BUN_JSC_aotRecordRegExpsPath).
Usage: train_session.py EXE ORDER_OUT REGEXPS_OUT"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench"))
from harness import DONE, MODEL_ARGS, PROMPT, Tty, fake_model, pi_env, pi_home, workdir  # noqa: E402

exe, order, regexps = (os.path.abspath(a) for a in sys.argv[1:4])
for f in (order, regexps):
    if os.path.exists(f):
        os.remove(f)
with fake_model() as port, pi_home(port) as home, workdir() as cwd:
    env = pi_env(home, {"BUN_BYTECODE_ORDER_OUT": order, "BUN_JSC_aotRecordRegExpsPath": regexps})
    tty = Tty([exe, "--no-session", *MODEL_ARGS], env, cwd)
    deadline = time.perf_counter() + 120
    assert tty.wait_for("fake-model", 0, deadline), "the TUI did not start"
    tty.settle(0.2, deadline)
    for _ in range(3):
        start = len(tty.buf)
        tty.send(PROMPT.encode() + b"\r")
        assert tty.wait_for(DONE, start, deadline), "no answer"
        tty.settle(0.2, deadline)
    for command in (b"/hotkeys\r", b"\x1b", b"/session\r", b"\x1b", b"/model\r", b"\x1b"):
        tty.send(command)
        tty.settle(0.3, deadline)
    status, _ = tty.quit()
    assert status == 0, f"the TUI exited with {status}"
print("recorded", order, regexps)
