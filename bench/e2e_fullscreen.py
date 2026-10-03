#!/usr/bin/env python3
"""End-to-end check of the fullscreen TUI's drawing: Pi scrolls the rows of the screen that only moved instead of drawing them
again (packages/tui: findMovedRows), and what the terminal shows must be what it shows when every row is drawn. A long
Markdown answer streams in, then the transcript is paged up and down and the window resized; after each step the screen (text
and colors) with scrolling is compared with the screen without (PI_TUI_SCROLL_ROWS=0), in tmux and, if installed, in zmx
(libghostty's terminal). With --docker, Pi and the terminals run in a container.

Example: bench/e2e_fullscreen.py --build pi-bolt=./out/pi-bolt/pi
         bench/e2e_fullscreen.py --build pi-bolt=./out/pi-bolt/pi --docker debian-with-tmux --docker-command "sudo -n docker"
"""

import argparse
import contextlib
import fcntl
import os
import pty
import re
import select
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import MODEL_ARGS, fake_model, parse_builds, pi_env, pi_home, workdir

TRAINING = Path(__file__).resolve().parent.parent / "scripts" / "lib" / "training.md"
PAGE_UP, PAGE_DOWN = "\x1b[5~", "\x1b[6~"
STEPS = [("page up", PAGE_UP), ("page up", PAGE_UP), ("page up", PAGE_UP), ("page down", PAGE_DOWN), ("page up", PAGE_UP),
         ("page down", PAGE_DOWN), ("page down", PAGE_DOWN), ("page down", PAGE_DOWN)]


class Host:
    """Where the terminals run: this machine, or a Docker container (--docker) that sees /tmp and the build."""

    def __init__(self, docker, image, builds):
        self.container = None
        if image:
            self.docker = shlex.split(docker)
            self.container = f"pibolt-fullscreen-{os.getpid()}"
            mounts = ["-v", "/tmp:/tmp"]
            for path in {os.path.dirname(build.argv[0]) for build in builds} | ({os.path.dirname(os.path.realpath(shutil.which("zmx")))} if shutil.which("zmx") else set()):
                mounts += ["-v", f"{path}:{path}:ro"]
            subprocess.run([*self.docker, "run", "-d", "--rm", "--name", self.container, "--network", "host", *mounts, image, "sleep", "infinity"],
                           check=True, capture_output=True)

    def argv(self, command, env=None, cwd=None, tty=False):
        """`command` as it is run on the host: in the container, through `docker exec`."""
        if not self.container:
            return command
        options = ["-it"] if tty else []
        for key, value in (env or {}).items():
            options += ["-e", f"{key}={value}"]
        if cwd:
            options += ["-w", str(cwd)]
        return [*self.docker, "exec", *options, self.container, *command]

    def has(self, tool):
        if not self.container:
            return shutil.which(tool) is not None
        tool = os.path.realpath(shutil.which(tool)) if shutil.which(tool) else tool
        return subprocess.run(self.argv(["sh", "-c", f"command -v {shlex.quote(tool)}"]), capture_output=True).returncode == 0

    def close(self):
        if self.container:
            subprocess.run([*self.docker, "rm", "-f", self.container], capture_output=True)


class Tmux:
    name = "tmux"

    def __init__(self, host, command, env, cwd, width):
        self.host = host
        self.socket = f"pibolt-fullscreen-{os.getpid()}"
        variables = []
        for key, value in env.items():
            variables += ["-e", f"{key}={value}"]
        self.run("-f", "/dev/null", "new-session", "-d", "-x", str(width), "-y", "50", "-c", str(cwd), *variables, command)

    def run(self, *args):
        return subprocess.run(self.host.argv(["tmux", "-L", self.socket, *args]), capture_output=True, text=True, errors="replace")

    def screen(self):
        return self.run("capture-pane", "-p", "-e").stdout

    def send(self, text):
        self.run("send-keys", "-l", text)

    def resize(self, width):
        self.run("resize-window", "-x", str(width), "-y", "50")

    def close(self):
        self.run("kill-server")


class Zmx:
    """A zmx session with a client attached on a pseudo-terminal of the wanted size, in a socket directory of its own."""
    name = "zmx"

    def __init__(self, host, command, env, cwd, width):
        self.host = host
        self.session = f"pibolt-{os.getpid()}"
        self.zmx = os.path.realpath(shutil.which("zmx"))
        self.runtime = tempfile.mkdtemp(prefix="zx.", dir="/tmp")  # (A socket path has to be short.)
        os.chmod(self.runtime, 0o777)
        self.env = {"XDG_RUNTIME_DIR": self.runtime, **env}
        argv = host.argv([self.zmx, "attach", self.session, "sh", "-c", "exec " + command], self.env, cwd, tty=True)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, {**os.environ, **self.env})
        self.resize(width)
        self.reading = True
        threading.Thread(target=self.drain, daemon=True).start()

    def drain(self):
        while self.reading:
            ready, _, _ = select.select([self.fd], [], [], 0.2)
            if ready:
                try:
                    if not os.read(self.fd, 1 << 16):
                        return
                except OSError:
                    return

    def run(self, *args):
        return subprocess.run(self.host.argv([self.zmx, *args], self.env), env={**os.environ, **self.env}, capture_output=True, text=True, errors="replace")

    def screen(self):
        return self.run("history", self.session, "--vt").stdout

    def send(self, text):
        os.write(self.fd, text.encode())

    def resize(self, width):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, width, 0, 0))

    def close(self):
        self.reading = False
        self.run("kill", self.session, "--force")
        with contextlib.suppress(OSError):
            os.kill(self.pid, 9)
        with contextlib.suppress(OSError):
            os.waitpid(self.pid, 0)
        subprocess.run(self.host.argv(["rm", "-rf", self.runtime]), capture_output=True)
        shutil.rmtree(self.runtime, ignore_errors=True)


def screens(host, terminal_class, build, width, pace_ms, scroll):
    """The screen after the answer and after each step."""
    with fake_model(pace_ms=pace_ms, script="fake_model_stress.py") as port, pi_home(port) as home, workdir() as cwd:
        env = {key: value for key, value in pi_env(home).items() if key.startswith("PI_") or key == "TERM"}
        if not scroll:
            env["PI_TUI_SCROLL_ROWS"] = "0"
        command = " ".join(shlex.quote(x) for x in [*build.argv, "--no-session", *MODEL_ARGS])
        if host.container:
            # The container's user is another one.
            for path in (home, cwd):
                subprocess.run(["chmod", "-R", "a+rwX", str(path)])
            env["HOME"] = "/tmp"
        terminal = terminal_class(host, command, env, cwd, width)
        try:
            deadline = time.time() + 60
            while time.time() < deadline and "fake-model" not in terminal.screen():
                time.sleep(0.2)
            terminal.send(f"SCENARIO mdfile:{TRAINING} CWD /work")
            terminal.send("\r")
            deadline = time.time() + 900
            while time.time() < deadline and "Done: mdfile, answer 1." not in terminal.screen():
                time.sleep(0.5)
            time.sleep(1.5)
            shown = [("the answer", terminal.screen())]
            for name, keys in STEPS:
                terminal.send(keys)
                time.sleep(0.7)
                shown.append((name, terminal.screen()))
            terminal.resize(width - 20)
            time.sleep(1.5)
            shown.append(("resized", terminal.screen()))
            terminal.send(PAGE_UP)
            time.sleep(0.7)
            shown.append(("page up, resized", terminal.screen()))
            terminal.send("/quit\r")
            time.sleep(0.5)
        finally:
            terminal.close()
    # The working directory is in the footer, with a name of its own each time.
    return [(name, re.sub(r"(?:/tmp|~)/pibolt-work-\w+", "<work>", text)) for name, text in shown]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command to check (repeatable)")
    ap.add_argument("--widths", default="120,80", help="terminal widths to check at")
    ap.add_argument("--pace-ms", type=float, default=1, help="between chunks of 24 characters")
    ap.add_argument("--docker", metavar="IMAGE", help="run Pi and the terminals in a container of this image (it needs tmux)")
    ap.add_argument("--docker-command", default="docker", help='how to run docker (e.g. "sudo -n docker")')
    a = ap.parse_args()
    builds = parse_builds(a.build)
    host = Host(a.docker_command, a.docker, builds)
    try:
        status = check(host, builds, a)
    finally:
        host.close()
    sys.exit(status)


def check(host, builds, a):
    terminals = [Tmux] + ([Zmx] if host.has("zmx") else [])
    where = " in Docker" if host.container else ""
    status = 0
    for build in builds:
        for terminal in terminals:
            for width in [int(w) for w in a.widths.split(",")]:
                expected = screens(host, terminal, build, width, a.pace_ms, scroll=False)
                actual = screens(host, terminal, build, width, a.pace_ms, scroll=True)
                if "Done: mdfile, answer 1." not in expected[0][1]:
                    print(f"FAIL {build.name} did not finish in {terminal.name}{where} at width {width}", flush=True)
                    status = 1
                    continue
                moved = len({text for _, text in expected})
                differing = [name for (name, e), (_, s) in zip(expected, actual) if e != s]
                if not differing and moved > 3:
                    print(f"PASS {build.name} in {terminal.name}{where}, {width} columns: {len(expected)} screens ({moved} different ones), the same", flush=True)
                    continue
                status = 1
                print(f"FAIL {build.name} in {terminal.name}{where}, {width} columns: differ after {differing or 'nothing, but the screen did not move'}", flush=True)
    return status


if __name__ == "__main__":
    main()
