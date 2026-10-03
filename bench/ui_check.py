#!/usr/bin/env python3
"""Functional check of the Pi TUI: trust prompt, commands, project extensions and prompt templates, bash, the model selector and
/quit, driven through a pseudo-terminal. Run it in a Pi checkout (--project), whose .pi/ folder holds extensions, prompt templates
and skills, so that they are loaded once the folder is trusted.

Example: bench/ui_check.py --project ./pi --build pi-bolt=./out/pi/pi --build bun=./out/pi-stable/pi
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import DONE, MODEL_ARGS, Tty, fake_model, parse_builds, pi_env, pi_home


def run(build, project):
    results = []
    with fake_model() as port, pi_home(port) as home:
        t0 = time.perf_counter()
        tty = Tty([*build.argv, "--no-session", *MODEL_ARGS], pi_env(home), project)

        def step(name, keys, expect_any, timeout=15, settle=0.15):
            start = len(tty.buf)
            ts = time.perf_counter()
            if keys:
                tty.send(keys)
            ok = False
            while not ok and time.perf_counter() < ts + timeout:
                ok = any(tty.wait_for(e, start, time.perf_counter() + 0.05) for e in expect_any)
            ms = (time.perf_counter() - ts) * 1000
            tty.settle(settle, time.perf_counter() + 3)
            results.append((name, ok, ms, "" if ok else tty.screen_text(start)[-300:]))

        step("trust prompt", None, ["Trust project folder?"], 30)
        step("TUI ready with project extensions", b"\r", ["fake-model"], 30)
        results.append(("launch to ready", True, (time.perf_counter() - t0) * 1000, ""))
        step("/ lists commands", b"/", ["settings"], 10)
        tty.send(b"\x1b"); tty.settle(0.2, time.perf_counter() + 2)
        tty.send(b"\x15"); tty.settle(0.2, time.perf_counter() + 2)
        step("/hotkeys", b"/hotkeys\r", ["Run bash command", "Navigation"], 10)
        tty.send(b"\x1b"); tty.settle(0.2, time.perf_counter() + 2)
        step("/session", b"/session\r", ["Session"], 10)
        step("! bash command", b"!echo pi-bolt-ok-$((6*7))\r", ["pi-bolt-ok-42"], 15)
        step("keystroke echo", b"zqxjkvbw", ["zqxjkvbw"], 5, 0.05)
        tty.send(b"\x15"); tty.settle(0.2, time.perf_counter() + 2)
        step("model turn with 4 tool calls", b"Read the four fixture files\r", [DONE + " (prompt "], 30)
        step("/model selector opens", b"/model\r", ["fake-model"], 10)
        tty.send(b"\x1b"); tty.settle(0.3, time.perf_counter() + 2)
        status, _ = tty.quit()
        results.append(("/quit exits cleanly", status == 0, 0, ""))
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command that starts Pi (repeatable)")
    ap.add_argument("--project", required=True, help="a Pi checkout (or any folder with a .pi/ directory)")
    a = ap.parse_args()
    project = str(Path(a.project).resolve())
    all_results = {b.name: run(b, project) for b in parse_builds(a.build)}
    names = [r[0] for r in next(iter(all_results.values()))]
    print("step".ljust(40) + "".join(n.rjust(20) for n in all_results))
    failed = False
    for i, step in enumerate(names):
        cells = []
        for rs in all_results.values():
            _, ok, ms, _ = rs[i]
            failed |= not ok
            cells.append(((("ok " if ok else "FAIL ") + (f"{ms:.0f} ms" if ms else ""))).rjust(20))
        print(step.ljust(40) + "".join(cells))
    for name, rs in all_results.items():
        for step, ok, _, screen in rs:
            if not ok:
                print(f"\n[{name}] {step} failed; screen: {screen}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
