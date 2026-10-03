#!/usr/bin/env python3
"""End-to-end correctness: drives every core Pi tool (ls, find, grep, write, edit, bash, read) through a scripted model
(fake_model_tools.py) in a fresh copy of the fixtures, and checks that each build's transcript and the files it leaves behind
are byte for byte those of the reference build.

Example: bench/e2e_tools.py --reference bun=./out/pi-stable/pi --build pi-bolt=./out/pi/pi
"""

import argparse
import filecmp
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import FIXTURES, MODEL_ARGS, fake_model, parse_builds, pi_env, pi_home

# The tools fake_model_tools.py calls (codemode is not active unless asked for).
TOOLS = "ls,find,grep,write,edit,bash,read,codemode"


def run(build, port, root):
    work = root / build.name / "work"
    work.mkdir(parents=True)
    shutil.copytree(FIXTURES, work / "fixture")
    with pi_home(port) as home:
        p = subprocess.run([*build.argv, "-p", "--no-session", *MODEL_ARGS, "--tools", TOOLS, "Exercise the tools"], cwd=work, env=pi_env(home, {"TERM": "dumb"}),
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    (root / build.name / "transcript.txt").write_bytes(p.stdout + f"\nexit {p.returncode}\n".encode())
    return root / build.name


def same_tree(a: Path, b: Path) -> list[str]:
    cmp = filecmp.dircmp(a, b)
    diffs = [f"{a.name}: only in {a}: {x}" for x in cmp.left_only] + [f"only in {b}: {x}" for x in cmp.right_only]
    diffs += [f"differs: {x}" for x in cmp.diff_files if not filecmp.cmp(a / x, b / x, shallow=False)]
    for sub in cmp.common_dirs:
        diffs += same_tree(a / sub, b / sub)
    return diffs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reference", required=True, help="name=command of the build whose output is taken as correct")
    ap.add_argument("--build", action="append", required=True, help="name=command to check (repeatable)")
    a = ap.parse_args()
    reference = parse_builds([a.reference])[0]
    root = Path(tempfile.mkdtemp(prefix="pibolt-e2e-"))
    status = 0
    with fake_model(script="fake_model_tools.py") as port:
        ref = run(reference, port, root)
        if b"Done: tools exercised" not in (ref / "transcript.txt").read_bytes():
            print("the reference run did not finish:\n" + (ref / "transcript.txt").read_text()[-500:])
            sys.exit(2)
        for build in parse_builds(a.build):
            diffs = same_tree(ref, run(build, port, root))
            print(("PASS " if not diffs else "FAIL ") + build.name)
            for d in diffs:
                print("   " + d)
            status |= bool(diffs)
    if not status:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"outputs kept in {root}")
    sys.exit(status)


if __name__ == "__main__":
    main()
