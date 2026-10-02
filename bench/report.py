#!/usr/bin/env python3
"""Turns benchmark results into the charts and tables of the README and docs/BENCHMARKS.md.

Reads the JSONL files the tools append to (--out) from one results folder:
  benchmark.jsonl  bench/benchmark.py       startup, headless, interactive
  long.jsonl       bench/long_session.py    a long session
  tmux.jsonl       bench/tmux_check.py      Pi in a tmux pane, replies streaming at human pace
  plugins.jsonl    bench/plugin_bench.py    a plugin compiled in vs loaded at run time
and writes, for each chart, a light and a dark SVG (for GitHub's <picture> theme switch) to --images, and the tables (Markdown) to
stdout. Figures are medians over runs.

Example: bench/report.py results/2026-10-02 --images docs/images --builds pi-bolt,bun,node
"""

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

LABELS = {"pi-bolt": "Pi-Bolt", "bun": "Bun 1.4.2", "node": "Node 22", "pi-bolt-jit": "Pi-Bolt (JIT on)"}
# Validated categorical slots (light, dark): blue, orange, aqua. Text colors per theme.
SERIES = [("#2a78d6", "#3987e5"), ("#eb6834", "#d95926"), ("#1baf7a", "#199e70"), ("#4a3aa7", "#9085e9")]
THEME = {
    "light": {"text": "#0b0b0b", "muted": "#52514e", "rule": "#d9d8d3"},
    "dark": {"text": "#ffffff", "muted": "#c3c2b7", "rule": "#3a3a37"},
}
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def load(path):
    return [json.loads(line) for line in open(path)] if path.exists() else []


def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def fmt(value, unit):
    if value is None:
        return "–"
    if unit == "ms" and value >= 1000:
        return f"{value:,.0f} ms"
    if unit == "ms" and value < 10:
        return f"{value:.1f} ms"
    return f"{value:,.0f} {unit}"


def color_of(build, i, theme):
    """Each runtime keeps its color in every chart: Pi-Bolt blue, Bun orange, Node aqua, Pi-Bolt with the JIT on violet."""
    for key, slot in (("pi-bolt (jit on)", 3), ("pi-bolt-jit", 3), ("pi-bolt", 0), ("bun", 1), ("node", 2)):
        if build.lower().startswith(key):
            return SERIES[slot][0 if theme == "light" else 1]
    return SERIES[i % len(SERIES)][0 if theme == "light" else 1]


def chart(title, subtitle, panels, builds, theme, path):
    """panels: [(name, unit, {build: value})]. Horizontal bars, one panel per metric, two panels per row."""
    t = THEME[theme]
    panels = [p if len(p) == 4 else (*p, "time" if p[1] == "ms" and "CPU" not in title and "CPU" not in p[0] else "amount") for p in panels]
    panels = [p for p in panels if any(v is not None for v in p[2].values())]
    width, pad = 880, 20
    # The label column fits the longest label (about 7 px a character at 12 px); long labels get one panel per row.
    label_w = max(96, 7 * max(len(LABELS.get(b, b)) for b in builds) + 14)
    columns = 2 if label_w <= 150 else 1
    col_w = (width - pad * (columns + 1)) // columns
    row_h, bar_h = 24, 14
    panel_h = 34 + row_h * len(builds) + 12
    rows = (len(panels) + columns - 1) // columns
    height = 70 + rows * panel_h
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" '
           f'aria-label="{title}: {subtitle}">',
           f'<style>text{{font-family:{FONT};font-variant-numeric:tabular-nums}}</style>',
           f'<text x="{pad}" y="28" font-size="18" font-weight="600" fill="{t["text"]}">{title}</text>',
           f'<text x="{pad}" y="50" font-size="13" fill="{t["muted"]}">{subtitle}</text>']
    for p, (name, unit, values, kind) in enumerate(panels):
        x0 = pad + (p % columns) * (col_w + pad)
        y0 = 70 + (p // columns) * panel_h
        out.append(f'<text x="{x0}" y="{y0 + 16}" font-size="13" font-weight="600" fill="{t["text"]}">{name}</text>')
        top = max(v for v in values.values() if v is not None)
        bar_w = col_w - label_w - 110
        base = values.get(builds[1]) if len(builds) > 1 else None  # what Pi-Bolt is compared with
        for i, b in enumerate(builds):
            v = values.get(b)
            y = y0 + 30 + i * row_h
            color = color_of(b, i, theme)
            out.append(f'<text x="{x0 + label_w - 8}" y="{y + 11}" font-size="12" text-anchor="end" fill="{t["muted"]}">{LABELS.get(b, b)}</text>')
            if v is None:
                continue
            w = max(2, bar_w * v / top)
            # Rounded at the data end, square at the baseline.
            out.append(f'<path d="M{x0 + label_w},{y} h{w - 4} a4,4 0 0 1 4,4 v{bar_h - 8} a4,4 0 0 1 -4,4 h{-(w - 4)} z" fill="{color}"/>')
            note = ""
            if i == 0 and base and v and kind != "none":
                # Compared with the second build. Time is "faster"/"slower"; CPU and memory are "less"/"more".
                better, worse = ("faster", "slower") if kind == "time" else ("less", "more")
                if base / v >= 1.05:
                    note = f' <tspan fill="{t["muted"]}">{base / v:.1f}× {better}</tspan>'
                elif v / base >= 1.05:
                    note = f' <tspan fill="{t["muted"]}">{v / base:.2f}× {worse}</tspan>'

            out.append(f'<text x="{x0 + label_w + w + 6}" y="{y + 11}" font-size="12" fill="{t["text"]}">{fmt(v, unit)}{note}</text>')
        out.append(f'<line x1="{x0 + label_w}" y1="{y0 + 26}" x2="{x0 + label_w}" y2="{y0 + 30 + len(builds) * row_h - 6}" stroke="{t["rule"]}"/>')
    out.append("</svg>")
    path.write_text("\n".join(out) + "\n")


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] + ["---:"] * (len(header) - 1)) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results", type=Path)
    ap.add_argument("--images", type=Path, required=True)
    ap.add_argument("--builds", default="pi-bolt,bun,node", help="builds to show, in order (the first is compared with the second)")
    a = ap.parse_args()
    builds = a.builds.split(",")
    a.images.mkdir(parents=True, exist_ok=True)

    bench = defaultdict(list)
    for r in load(a.results / "benchmark.jsonl"):
        if r.get("ok"):
            bench[(r["build"], r["scenario"])].append(r)
    def b(build, scenario, key):
        return med(r.get(key) for r in bench[(build, scenario)])

    long_rows = defaultdict(list)
    for r in load(a.results / "long.jsonl"):
        if "error" not in r:
            long_rows[r["build"]].append(r)
    last_prompt = max((r["prompt"] for rs in long_rows.values() for r in rs), default=None)
    def lg(build, key):
        return med(r[key] for r in long_rows[build] if r["prompt"] == last_prompt)

    tmux = defaultdict(list)
    for r in load(a.results / "tmux.jsonl"):
        tmux[r["build"]].append(r)
    def tm(build, key):
        return med(r[key] if not isinstance(r[key], dict) else None for r in tmux[build]) if key in (tmux[build][0] if tmux[build] else {}) else None
    def tm_own(build):
        return med(r["memory_at_end"]["own"] for r in tmux[build]) if tmux[build] else None

    def vals(fn):
        return {x: fn(x) for x in builds}

    speed = [
        ("Launch to interactive (TUI)", "ms", vals(lambda x: b(x, "interactive", "tti_ms"))),
        ("pi --version", "ms", vals(lambda x: b(x, "startup", "wall_ms"))),
        ("pi -p: one prompt, 4 tool calls", "ms", vals(lambda x: b(x, "headless", "wall_ms"))),
        ("Time per prompt, 2.7M-token session", "ms", vals(lambda x: lg(x, "ms_per_prompt"))),
    ]
    cpu = [
        ("Interactive session: 5 prompts", "ms", vals(lambda x: b(x, "interactive", "cpu_ms"))),
        ("pi -p: one prompt", "ms", vals(lambda x: b(x, "headless", "cpu_ms"))),
        ("pi --version", "ms", vals(lambda x: b(x, "startup", "cpu_ms"))),
        ("Per prompt, 2.7M-token session", "ms", vals(lambda x: lg(x, "cpu_ms_per_prompt"))),
    ]
    memory = [
        ("Peak memory, interactive session", "MB", vals(lambda x: b(x, "interactive", "peak_mb"))),
        ("Own memory, tmux session", "MB", vals(tm_own)),
        ("Own memory, end of 2.7M-token session", "MB", vals(lambda x: lg(x, "own_mb"))),
        ("Streaming replies (tmux), CPU", "ms", vals(lambda x: tm(x, "prompt_cpu_ms")), "amount"),
    ]
    for name, title, subtitle, panels in [
        ("speed", "Time", "Wall-clock time, lower is better. Ratios compare Pi-Bolt with Bun. Pi 1.0.0, medians.", speed),
        ("cpu", "CPU time", "All threads, lower is better. Ratios compare Pi-Bolt with Bun. Pi 1.0.0, medians.", cpu),
        ("memory", "Memory and streaming", "Lower is better. Own memory = private dirty pages. Ratios compare Pi-Bolt with Bun.", memory),
    ]:
        for theme in ("light", "dark"):
            chart(title, subtitle, panels, builds, theme, a.images / f"bench-{name}-{theme}.svg")

    plugins = defaultdict(list)
    for r in load(a.results / "plugins.jsonl"):
        plugins[(r["build"], r["plugin"])].append(r)
    if plugins:
        configs = [k for k in plugins if k[1] != "none"]
        names = {k: f"{LABELS.get(k[0], k[0])}, {'compiled in' if k[1] == 'compiled' else 'run time'}" for k in configs}
        panels = [
            ("Hot loop in the plugin (/words)", "ms", {names[k]: med(med(r["loop_ms"][1:]) for r in plugins[k]) for k in configs}, "none"),
            ("Launch to interactive", "ms", {names[k]: med(r["launch_ms"] for r in plugins[k]) for k in configs}, "none"),
        ]
        order = [names[k] for k in configs]
        for theme in ("light", "dark"):
            chart("Plugins", "A Pi extension compiled into the executable vs loaded at run time. Lower is better.", panels, order, theme,
                  a.images / f"bench-plugins-{theme}.svg")

    # Tables.
    def row(name, unit, values, *_):
        return [name] + [fmt(values.get(x), unit) for x in builds]
    header = ["", *[LABELS.get(x, x) for x in builds]]
    print("### Time\n\n" + table(header, [row(*p) for p in speed]))
    print("\n### CPU\n\n" + table(header, [row(*p) for p in cpu]))
    print("\n### Memory and streaming\n\n" + table(header, [row(*p) for p in memory]))
    if plugins:
        print("\n### Plugins\n\n" + table(["", "launch", "hot loop"], [[names[k], fmt(med(r["launch_ms"] for r in plugins[k]), "ms"),
              fmt(med(med(r["loop_ms"][1:]) for r in plugins[k]), "ms")] for k in configs]))
    counts = {s: len(bench[(builds[0], s)]) for s in ("startup", "headless", "interactive")}
    print(f"\nruns: {counts}, long sessions: {len({(r['build'], r.get('exit')) for rs in long_rows.values() for r in rs})}, "
          f"tmux rounds: {len(tmux.get(builds[0], []))}")


if __name__ == "__main__":
    main()
