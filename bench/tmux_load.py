#!/usr/bin/env python3
"""What Pi costs the terminal multiplexer it runs in: Pi in a tmux pane (160x48) with a client attached, while a long Markdown
answer streams in and while a file is written through a tool call. Everything Pi writes, tmux parses and draws again for its
client, so the bytes Pi writes are CPU for tmux and traffic for whatever carries the client (ssh, docker exec).

For each build and step it reports the CPU of Pi, the CPU of the tmux server, the bytes Pi wrote to the pane, the bytes tmux
sent to the client, and Pi's own memory at the end.

Example: bench/tmux_load.py --build pi-bolt=./out/pi-bolt/pi --build bun=./out/pi-stable/pi
"""

import argparse
import fcntl
import os
import pty
import select
import shlex
import struct
import subprocess
import sys
import termios
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ANSI, MACOS, MODEL_ARGS, cpu_ms, fake_model, memory_mb, parse_builds, pi_env, pi_home, workdir


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command (repeatable)")
    ap.add_argument("--steps", default="md:20000,write:50", help="scenarios of fake_model_stress.py, in one session")
    ap.add_argument("--pace-ms", type=float, default=20, help="between chunks (20: 1,200 characters of answer a second)")
    ap.add_argument("--cpus", help="pin Pi to these CPUs (taskset list)")
    a = ap.parse_args()
    socket = f"pibolt-load-{os.getpid()}"

    def tmux(*args):
        return subprocess.run(["tmux", "-L", socket, *args], capture_output=True, text=True)

    print(f"{'build':14} {'step':10} {'wall s':>7} {'pi cpu s':>9} {'tmux cpu s':>10} {'pi wrote KB':>11} {'to client KB':>12} {'own MB':>7}")
    for build in parse_builds(a.build):
        with fake_model(pace_ms=a.pace_ms, script="fake_model_stress.py") as port, pi_home(port) as home, workdir() as cwd:
            out = Path(f"/tmp/{socket}.out")
            env = pi_env(home, {"TERM": "tmux-256color"})
            command = "exec env -i " + " ".join(shlex.quote(f"{k}={v}") for k, v in env.items() if not k.startswith("TMUX"))
            command += (f" taskset -c {a.cpus} " if a.cpus and not MACOS else " ") + " ".join(shlex.quote(x) for x in [*build.argv, "--no-session", *MODEL_ARGS])
            tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "160", "-y", "48", "-c", str(cwd), command)
            tmux("pipe-pane", "-t", "s", "-o", f"cat >> {out}")
            pid = int(tmux("display", "-p", "-t", "s", "#{pane_pid}").stdout.strip())
            server = int(tmux("display", "-p", "#{pid}").stdout.strip())
            # A client attached on a pseudo-terminal whose output is counted and thrown away.
            client, fd = pty.fork()
            if client == 0:
                os.environ["TERM"] = "xterm-256color"
                os.execvp("tmux", ["tmux", "-L", socket, "attach", "-t", "s"])
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 49, 160, 0, 0))
            received = [0]
            reading = [True]

            def drain():
                while reading[0]:
                    ready, _, _ = select.select([fd], [], [], 0.1)
                    if ready:
                        try:
                            received[0] += len(os.read(fd, 1 << 16))
                        except OSError:
                            return

            threading.Thread(target=drain, daemon=True).start()

            def wait(text, since, timeout=900):
                end = time.perf_counter() + timeout
                while time.perf_counter() < end:
                    if out.exists():
                        with open(out, "rb") as f:
                            f.seek(since)
                            if text.encode() in ANSI.sub(b"", f.read()):
                                return True
                    time.sleep(0.05)
                return False

            try:
                if not wait("fake-model", 0, 30):
                    sys.exit(f"{build.name}: the TUI did not start")
                time.sleep(0.5)
                for answer, step in enumerate(a.steps.split(","), 1):
                    since, began = out.stat().st_size, time.perf_counter()
                    pi_cpu, server_cpu, to_client = cpu_ms(pid), cpu_ms(server), received[0]
                    tmux("send-keys", "-t", "s", "-l", f"SCENARIO {step} CWD {cwd}")
                    tmux("send-keys", "-t", "s", "Enter")
                    ended = wait(f"Done: md, answer {answer}." if step.startswith("md:") else f"Done: {step}.", since)
                    wall = time.perf_counter() - began
                    time.sleep(0.3)
                    print(f"{build.name:14} {step:10} {wall:7.1f} {(cpu_ms(pid) - pi_cpu) / 1000:9.2f} {(cpu_ms(server) - server_cpu) / 1000:10.2f} "
                          f"{(out.stat().st_size - since) / 1024:11.0f} {(received[0] - to_client) / 1024:12.0f} {memory_mb(pid).get('own', 0):7.0f}"
                          f"{'' if ended else '  NOT FINISHED'}", flush=True)
            finally:
                reading[0] = False
                tmux("kill-server")
                out.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
