"""Shared pieces of the Pi-Bolt benchmark and test tools.

A *build* is a name and the command that starts Pi, given as ``name=command`` on the command line, e.g.::

    --build pi-bolt=./dist/pi/pi --build bun=~/.bun/bin/bun ./pi/dist/bun/cli.js --build node="node ./pi/dist/cli.js"

Every run gets its own fake model server (fake_model.py) on a free port and a throwaway Pi home that points at it, so runs are
isolated from the user's Pi configuration and from each other.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
PROMPT = "Read the four fixture files"
DONE = "Done: read all four files."
MODEL_ARGS = ["--model", "fake/fake-model"]
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78]|\x1b[()][A-Z0-9]")


@dataclass
class Build:
    name: str
    argv: list[str]


def parse_builds(specs: list[str]) -> list[Build]:
    builds = []
    for spec in specs:
        if "=" not in spec:
            raise SystemExit(f"--build wants name=command, got {spec!r}")
        name, command = spec.split("=", 1)
        argv = [os.path.expanduser(a) for a in shlex.split(command)]
        # Runs change directory: a relative path to the executable is taken from where the tool was started.
        argv = [os.path.abspath(a) if "/" in a and os.path.exists(a) else a for a in argv]
        if not shutil.which(argv[0]) and not os.access(argv[0], os.X_OK):
            raise SystemExit(f"build {name}: {argv[0]} is not executable")
        builds.append(Build(name, argv))
    warm_page_cache(builds)
    return builds


def warm_page_cache(builds: list[Build]) -> None:
    """Reads every build's files once, so that all are equally in the page cache. The kernel maps neighbouring pages of a file
    that are already cached along with the one that faulted, so a freshly written executable shows up to 10% more resident
    memory than the same executable read from disk; comparing a fresh build with an old one would be unfair either way."""
    for build in builds:
        for path in build.argv:
            if "/" in path and os.path.isfile(path):
                with open(path, "rb") as f:
                    while f.read(1 << 22):
                        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def fake_model(pace_ms: float = 0, script: str = "fake_model.py", log_sizes: str | None = None):
    """Starts a fake OpenAI-compatible model server; yields its port."""
    port = free_port()
    args = [sys.executable, str(HERE / script), str(port)]
    if pace_ms:
        args += ["--pace-ms", str(pace_ms)]
    if log_sizes:
        args += ["--log-sizes", log_sizes]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
            time.sleep(0.05)
        yield port
    finally:
        proc.terminate()
        proc.wait()


@contextlib.contextmanager
def pi_home(port: int):
    """A Pi agent directory with only the fake model configured."""
    home = Path(tempfile.mkdtemp(prefix="pibolt-home-"))
    (home / "models.json").write_text(json.dumps({"providers": {"fake": {
        "baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions", "apiKey": "fake",
        "models": [{"id": "fake-model", "contextWindow": 200000, "maxTokens": 8192}]}}}, indent=2))
    # A changelog seen far in the future: no "what's new" screen on start.
    (home / "settings.json").write_text(json.dumps({"lastChangelogVersion": "9999.0.0", "theme": "dark"}))
    (home / "auth.json").write_text("{}")
    try:
        yield home
    finally:
        shutil.rmtree(home, ignore_errors=True)


@contextlib.contextmanager
def workdir():
    """A scratch project directory holding the fixture files the fake model asks Pi to read."""
    d = Path(tempfile.mkdtemp(prefix="pibolt-work-"))
    shutil.copytree(FIXTURES, d / "fixture")
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def pi_env(home: Path, extra: dict | None = None) -> dict:
    # Nothing from the caller's BUN_* / NODE_* environment: those change what a build does.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BUN_", "NODE_", "PI_"))}
    env.update({"PI_CODING_AGENT_DIR": str(home), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
                "TERM": "xterm-256color"})
    env.update(extra or {})
    return env


def pinned(argv: list[str], cpus: str | None) -> list[str]:
    return ["taskset", "-c", cpus, *argv] if cpus else list(argv)


class Tty:
    """A minimal terminal on a pseudo-terminal: answers the capability queries the TUI sends the way xterm does."""

    def __init__(self, argv, env, cwd, cols=120, rows=40):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.buf = b""

    def pump(self, timeout):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return False
        try:
            data = os.read(self.fd, 1 << 16)
        except OSError:
            return False
        self.buf += data
        if b"\x1b[c" in data:
            os.write(self.fd, b"\x1b[?62;22c")
        if b"\x1b]11;?" in data:
            os.write(self.fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        return True

    def send(self, data: bytes):
        os.write(self.fd, data)

    def wait_for(self, text, since, deadline):
        needle = text.encode()
        scan = since
        while time.perf_counter() < deadline:
            self.pump(0.01)
            if needle in ANSI.sub(b"", self.buf[scan:]):
                return True
            scan = max(since, len(self.buf) - 8192)
        return False

    def settle(self, quiet, deadline):
        """Until the screen has not changed for `quiet` seconds."""
        while time.perf_counter() < deadline:
            if not self.pump(quiet):
                return True
        return False

    def screen_text(self, since=0):
        return re.sub(r"\s+", " ", ANSI.sub(b" ", self.buf[since:]).decode("utf-8", "replace"))

    def quit(self, timeout=10):
        """Sends /quit; returns the exit status, or None if it had to be killed."""
        self.send(b"/quit\r")
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            self.pump(0.02)
            pid, status, ru = os.wait4(self.pid, os.WNOHANG)
            if pid:
                os.close(self.fd)
                return os.waitstatus_to_exitcode(status), ru
        os.kill(self.pid, 9)
        _, status, ru = os.wait4(self.pid, 0)
        os.close(self.fd)
        return None, ru


def cpu_ms(pid: int) -> float:
    """CPU time of every thread of a live process, from schedstat (nanoseconds)."""
    total = 0
    for tid in os.listdir(f"/proc/{pid}/task"):
        with contextlib.suppress(OSError):
            total += int(open(f"/proc/{pid}/task/{tid}/schedstat").read().split()[0])
    return total / 1e6


def memory_mb(pid: int) -> dict:
    """Resident memory, and the process's own (private dirty) memory: what it costs beyond shared, droppable file pages."""
    out = {}
    with contextlib.suppress(OSError):
        for line in open(f"/proc/{pid}/smaps_rollup"):
            key, value = line.split(":", 1)
            if key in ("Rss", "Private_Dirty"):
                out[{"Rss": "rss", "Private_Dirty": "own"}[key]] = round(int(value.split()[0]) / 1024, 1)
    return out


def median(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    mid = len(values) // 2
    return values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
