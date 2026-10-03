#!/usr/bin/env python3
"""Long answers in the TUI: the CPU it takes to stream a Markdown answer (headings, lists, code blocks, tables) of each size, at
the pace of a fast model. Each chunk makes the TUI render the message again, so what a chunk costs must not grow with the
length of the answer.

Example: bench/long_answer.py --build pi-bolt=./out/pi-bolt/pi --build bun=./out/pi-stable/pi
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import MODEL_ARGS, Tty, cpu_ms, fake_model, memory_mb, parse_builds, pi_env, pi_home, pinned, workdir


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command (repeatable)")
    ap.add_argument("--sizes", default="5000,20000,60000", help="characters in each answer")
    ap.add_argument("--pace-ms", type=float, default=20, help="between chunks of 24 characters (20: 1,200 characters a second)")
    ap.add_argument("--cpus", help="pin Pi to these CPUs (taskset list)")
    a = ap.parse_args()
    sizes = [int(size) for size in a.sizes.split(",")]
    print(f"{'build':12} {'characters':>10} {'wall s':>8} {'cpu s':>8} {'of a core':>10} {'own MB':>7}")
    for build in parse_builds(a.build):
        with fake_model(pace_ms=a.pace_ms, script="fake_model_stress.py") as port, pi_home(port) as home, workdir() as cwd:
            tty = Tty(pinned([*build.argv, "--no-session", *MODEL_ARGS], a.cpus), pi_env(home), cwd, cols=160, rows=48)
            if not tty.wait_for("fake-model", 0, time.perf_counter() + 60):
                sys.exit(f"{build.name}: the TUI did not start")
            tty.settle(0.5, time.perf_counter() + 5)
            for answer, size in enumerate(sizes, 1):
                start, cpu, began = len(tty.buf), cpu_ms(tty.pid), time.perf_counter()
                tty.send(f"SCENARIO md:{size} CWD {cwd}".encode() + b"\r")
                if not tty.wait_for(f"Done: md, answer {answer}.", start, time.perf_counter() + 1800):
                    sys.exit(f"{build.name}: no answer of {size} characters")
                wall = time.perf_counter() - began
                tty.settle(0.3, time.perf_counter() + 5)
                used = (cpu_ms(tty.pid) - cpu) / 1000
                print(f"{build.name:12} {size:10} {wall:8.1f} {used:8.2f} {100 * used / wall:9.0f}% {memory_mb(tty.pid).get('own', 0):7.0f}", flush=True)
            tty.quit()


if __name__ == "__main__":
    main()
