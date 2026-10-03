#!/usr/bin/env python3
"""Pauses of the TUI: the longest stretch in which Pi writes nothing to the terminal while it should be drawing (a spinner
turns, a tool call's arguments stream in). A pause is the program busy with one thing; nothing typed is taken up during it.
Reports, for each step, the CPU, the 99th percentile and the longest gap between two writes, and where in the step it was.

Example: bench/pauses.py --build pi-bolt=./out/pi-bolt/pi --steps write:50,write:200,write:400
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ANSI, MODEL_ARGS, Tty, cpu_ms, fake_model, memory_mb, parse_builds, pi_env, pi_home, pinned, workdir


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command (repeatable)")
    ap.add_argument("--steps", default="write:50,write:200,write:400", help="scenarios of fake_model_stress.py, in one session")
    ap.add_argument("--pace-ms", type=float, default=2, help="between chunks")
    ap.add_argument("--cpus", help="pin Pi to these CPUs (taskset list)")
    a = ap.parse_args()
    print(f"{'build':12} {'step':10} {'wall s':>7} {'cpu s':>6} {'gap p99 ms':>10} {'longest ms':>10} {'at':>5} {'own MB':>7}")
    for build in parse_builds(a.build):
        with fake_model(pace_ms=a.pace_ms, script="fake_model_stress.py") as port, pi_home(port) as home, workdir() as cwd:
            tty = Tty(pinned([*build.argv, "--no-session", *MODEL_ARGS], a.cpus), pi_env(home), cwd, cols=160, rows=48)
            if not tty.wait_for("fake-model", 0, time.perf_counter() + 60):
                sys.exit(f"{build.name}: the TUI did not start")
            tty.settle(0.5, time.perf_counter() + 5)
            for answer, step in enumerate(a.steps.split(","), 1):
                start, cpu, began = len(tty.buf), cpu_ms(tty.pid), time.perf_counter()
                tty.send(f"SCENARIO {step} CWD {cwd}".encode() + b"\r")
                marker = (f"Done: md, answer {answer}." if step.startswith("md:") else f"Done: {step}.").encode()
                gaps, last, deadline = [], began, began + 1800
                while time.perf_counter() < deadline:
                    if tty.pump(0.002):
                        now = time.perf_counter()
                        gaps.append(((now - last) * 1000, now - began))
                        last = now
                        if marker in ANSI.sub(b"", tty.buf[max(start, len(tty.buf) - 8192):]):
                            break
                wall = time.perf_counter() - began
                longest, at = max(gaps)
                ordered = sorted(gap for gap, _ in gaps)
                print(f"{build.name:12} {step:10} {wall:7.1f} {(cpu_ms(tty.pid) - cpu) / 1000:6.2f} {ordered[int(len(ordered) * 0.99) - 1]:10.0f} "
                      f"{longest:10.0f} {100 * at / wall:4.0f}% {memory_mb(tty.pid).get('own', 0):7.0f}", flush=True)
                tty.settle(0.3, time.perf_counter() + 3)
            tty.quit()


if __name__ == "__main__":
    main()
