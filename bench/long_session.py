#!/usr/bin/env python3
"""A long interactive session: N prompts (each 5 model turns with 4 file reads) in one Pi process. Every few prompts it reports the
time per prompt, CPU per prompt, memory, and how large the conversation sent to the model has grown, to expose slowdowns and
growth that short runs hide.

Example (300 tool calls, a context well past a million tokens):
  bench/long_session.py --prompts 75 --every 25 --build pi-bolt=./out/pi/pi --build bun=./out/pi-stable/pi
"""

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import DONE, MODEL_ARGS, PROMPT, Tty, cpu_ms, fake_model, memory_mb, parse_builds, pi_env, pi_home, pinned, workdir


def session(build, prompts, every, cpus):
    sizes = tempfile.NamedTemporaryFile(prefix="pibolt-sizes-", delete=False).name
    rows = []
    with fake_model(log_sizes=sizes) as port, pi_home(port) as home, workdir() as cwd:
        tty = Tty(pinned([*build.argv, "--no-session", *MODEL_ARGS], cpus), pi_env(home), cwd)
        deadline = time.perf_counter() + 7200
        if not tty.wait_for("fake-model", 0, deadline):
            return [{"error": "never became interactive"}], None
        tty.settle(0.1, deadline)
        t_block, c_block = time.perf_counter(), cpu_ms(tty.pid)
        for i in range(1, prompts + 1):
            start = len(tty.buf)
            tty.send(PROMPT.encode() + b"\r")
            if not tty.wait_for(DONE, start, deadline):
                rows.append({"prompt": i, "error": "no answer"})
                break
            tty.settle(0.03, deadline)
            if i % every == 0:
                now, c = time.perf_counter(), cpu_ms(tty.pid)
                m = memory_mb(tty.pid)
                last = int(open(sizes).read().split()[-1])
                rows.append({"prompt": i, "ms_per_prompt": round((now - t_block) * 1000 / every, 1),
                             "cpu_ms_per_prompt": round((c - c_block) / every, 1), "rss_mb": m.get("rss"), "own_mb": m.get("own"),
                             "request_mb": round(last / 1e6, 2), "tokens_m": round(last / 4e6, 2)})
                t_block, c_block = now, c
        status, _ = tty.quit()
    os.unlink(sizes)
    return rows, status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="append", required=True, help="name=command that starts Pi (repeatable)")
    ap.add_argument("--prompts", type=int, default=40)
    ap.add_argument("--every", type=int, default=10)
    ap.add_argument("--cpus", help="pin Pi to these cores (taskset list)")
    ap.add_argument("--out", help="append the results to this JSONL file")
    a = ap.parse_args()
    for build in parse_builds(a.build):
        rows, status = session(build, a.prompts, a.every, a.cpus)
        print(f"== {build.name} (exit {status})")
        for row in rows:
            if "error" in row:
                print(f"   {row.get('prompt', '')}: {row['error']}")
                continue
            print(f"   {row['prompt']:4d}: {row['ms_per_prompt']:7.1f} ms/prompt   cpu {row['cpu_ms_per_prompt']:7.1f} ms/prompt   "
                  f"memory {row['rss_mb']} MB (own {row['own_mb']} MB)   request {row['request_mb']:5.1f} MB (~{row['tokens_m']:.1f}M tokens)")
        if a.out:
            with open(a.out, "a") as f:
                for row in rows:
                    f.write(json.dumps({"build": build.name, "exit": status, **row}) + "\n")


if __name__ == "__main__":
    main()
