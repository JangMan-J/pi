#!/usr/bin/env python3
"""Drives the Pi sessions that the macOS runtime's linker order file is made from (scripts/build-runtime.sh): Pi started, a
headless prompt, and a session in the TUI on a pseudo-terminal, each against the local fake model.

Usage: bench/orderfile_session.py PI   (PI: the executable, or what starts it under the tracer)
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark import headless, interactive, startup
from harness import Build, fake_model, pi_env, pi_home, workdir


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    build = Build("pi", [os.path.abspath(sys.argv[1]) if "/" in sys.argv[1] else sys.argv[1]])
    with fake_model() as port, pi_home(port) as home, workdir() as cwd:
        env = pi_env(home)
        for name, run in [("startup", startup), ("headless", headless), ("interactive", interactive)]:
            result = run(build, env, cwd, None)
            if not result.get("ok"):
                raise SystemExit(f"{name}: the session did not complete ({result})")


if __name__ == "__main__":
    main()
