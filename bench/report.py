#!/usr/bin/env python3
"""Turns benchmark results into the charts and tables of the README and docs/BENCHMARKS.md.

Reads the JSONL files the tools append to (--out) from one results folder:
  benchmark.jsonl  bench/benchmark.py       startup, headless, interactive
  long.jsonl       bench/long_session.py    a long session
  tmux.jsonl       bench/tmux_check.py      Pi in a tmux pane, replies streaming at human pace
  plugins.jsonl    bench/plugin_bench.py    a plugin compiled in vs loaded at run time
  long_answer-*.txt, large_write-*.txt   bench/long_answer.py, bench/large_write.py (their tables, one file per run)
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
    if unit == "s":
        return f"{value:.1f} s"
    if unit == "%":
        return f"{value:.0f}%"
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


def hero(tiles, builds, theme, path, title=None, subtitle=None):
    """The README's headline image: one tile per metric, Pi-Bolt's figure large, the ratio to Bun, and bars for every build.
    tiles: [(title, unit, {build: value}, better)] where better is "faster" or "less". With a title, a heading above the tiles."""
    t = THEME[theme]
    width, pad, gap = 880, 20, 16
    tile_w = (width - 2 * pad - gap * (len(tiles) - 1)) / len(tiles)
    top = 58 if title else 0
    height = 248 + top
    card = "#f6f8fa" if theme == "light" else "#161b22"
    edge = "#d0d7de" if theme == "light" else "#30363d"
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" '
           f'aria-label="{title or "Pi-Bolt compared with Bun and Node"}">',
           f'<style>text{{font-family:{FONT};font-variant-numeric:tabular-nums}}</style>']
    if title:
        out.append(f'<text x="{pad}" y="28" font-size="18" font-weight="600" fill="{t["text"]}">{title}</text>')
        out.append(f'<text x="{pad}" y="50" font-size="13" fill="{t["muted"]}">{subtitle or ""}</text>')
    for i, (name, unit, values, better) in enumerate(tiles):
        x = pad + i * (tile_w + gap)
        y = 12 + top
        out.append(f'<rect x="{x}" y="{y}" width="{tile_w}" height="{height - top - 24}" rx="10" fill="{card}" stroke="{edge}"/>')
        out.append(f'<text x="{x + 16}" y="{y + 30}" font-size="13" font-weight="600" fill="{t["muted"]}">{name}</text>')
        mine, base = values.get(builds[0]), values.get(builds[1])
        blue = color_of(builds[0], 0, theme)
        figure, _, unit_text = fmt(mine, unit).rpartition(" ") if " " in fmt(mine, unit) else (fmt(mine, unit), "", "")
        if unit_text:
            figure += f'<tspan font-size="18" font-weight="600" dx="4">{unit_text}</tspan>'
        out.append(f'<text x="{x + 16}" y="{y + 72}" font-size="34" font-weight="700" fill="{blue}">{figure}</text>')
        if mine and base:
            ratio = base / mine
            word = better if ratio >= 1 else ("slower" if better == "faster" else "more")
            r = ratio if ratio >= 1 else 1 / ratio
            label = f"{r:.1f}× {word} than {LABELS.get(builds[1], builds[1]).split()[0]}" if r < 10 else \
                f"{r:.0f}× {word} than {LABELS.get(builds[1], builds[1]).split()[0]}"
            out.append(f'<text x="{x + 16}" y="{y + 96}" font-size="12.5" font-weight="600" fill="{t["text"]}">{label}</text>')
        most = max(v for v in values.values() if v)
        bar_x, bar_w = x + 16, tile_w - 32
        for j, b in enumerate(builds):
            v = values.get(b)
            yy = y + 126 + j * 34
            out.append(f'<text x="{bar_x}" y="{yy}" font-size="11.5" fill="{t["muted"]}">{LABELS.get(b, b).split()[0]}</text>')
            if not v:
                continue
            out.append(f'<text x="{bar_x + bar_w}" y="{yy}" font-size="11.5" text-anchor="end" fill="{t["text"]}">{fmt(v, unit)}</text>')
            out.append(f'<rect x="{bar_x}" y="{yy + 6}" width="{bar_w}" height="8" rx="4" fill="{edge}" opacity="0.5"/>')
            out.append(f'<rect x="{bar_x}" y="{yy + 6}" width="{max(8, bar_w * v / most):.1f}" height="8" rx="4" fill="{color_of(b, j, theme)}"/>')
    out.append("</svg>")
    path.write_text("\n".join(out) + "\n")


def read_tables(results, pattern):
    """The rows of the plain tables long_answer.py and large_write.py print, from every run's file."""
    rows = []
    for f in sorted(results.glob(pattern)):
        lines = [line.split() for line in f.read_text().splitlines() if line.strip()]
        rows += lines[1:]
    return rows


def long_hero(results, images, builds):
    """Long answers and large files: CPU of streaming an answer, the share of a core it keeps, and the time to write a file."""
    answers, writes = read_tables(results, "long_answer-*.txt"), read_tables(results, "large_write-*.txt")
    if not answers or not writes:
        return
    def mean(values):
        values = list(values)
        return statistics.mean(values) if values else None
    def answer_cpu(build, chars):
        return mean(float(r[3]) for r in answers if r[0] == build and r[1] == chars)
    def answer_share(build, chars):
        # CPU over wall-clock time, so the figure is that of the two runs together.
        rs = [r for r in answers if r[0] == build and r[1] == chars]
        return 100 * sum(float(r[3]) for r in rs) / sum(float(r[2]) for r in rs) if rs else None
    def write_wall(build, size):
        return mean(float(r[3]) for r in writes if r[0] == build and r[1] == size)
    def vals(fn, *args):
        return {x: fn(x, *args) for x in builds}
    tiles = [
        ("CPU, 20,000-char answer", "s", vals(answer_cpu, "20000"), "less"),
        ("CPU, 60,000-char answer", "s", vals(answer_cpu, "60000"), "less"),
        ("Share of a core, streaming", "%", vals(answer_share, "60000"), "less"),
        ("Writing a 200 KB file", "s", vals(write_wall, "200"), "faster"),
    ]
    for theme in ("light", "dark"):
        hero(tiles, builds, theme, images / f"bench-long-{theme}.svg", "Long answers and large files",
             "Answers streamed at 1,200 characters a second; a file written through a tool call. Lower is better.")


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
    # The versions the results were taken with, where the run says (environment.txt): "bun: 1.4.2", "node: v26.10.0".
    env = a.results / "environment.txt"
    if env.exists():
        for line in env.read_text().splitlines():
            key, _, value = line.partition(": ")
            if key == "bun" and value:
                LABELS["bun"] = f"Bun {value.strip()}"
            elif key == "node" and value:
                LABELS["node"] = f"Node {value.strip().lstrip('v').split('.')[0]}"

    long_hero(a.results, a.images, builds)
    if not (a.results / "benchmark.jsonl").exists():
        return

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
    # How large the conversation is at the end of the long session, for the labels ("4.2M-token session").
    tokens = med(r.get("tokens_m") for rs in long_rows.values() for r in rs if r["prompt"] == last_prompt)
    session = f"{tokens:.1f}M-token session" if tokens else "long session"

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
        (f"Time per prompt, {session}", "ms", vals(lambda x: lg(x, "ms_per_prompt"))),
    ]
    cpu = [
        ("Interactive session: 5 prompts", "ms", vals(lambda x: b(x, "interactive", "cpu_ms"))),
        ("pi -p: one prompt", "ms", vals(lambda x: b(x, "headless", "cpu_ms"))),
        ("pi --version", "ms", vals(lambda x: b(x, "startup", "cpu_ms"))),
        (f"Per prompt, {session}", "ms", vals(lambda x: lg(x, "cpu_ms_per_prompt"))),
    ]
    memory = [
        ("Peak memory, interactive session", "MB", vals(lambda x: b(x, "interactive", "peak_mb"))),
        ("Own memory, tmux session", "MB", vals(tm_own)),
        (f"Own memory, end of {session}", "MB", vals(lambda x: lg(x, "own_mb"))),
        ("Streaming replies (tmux), CPU", "ms", vals(lambda x: tm(x, "prompt_cpu_ms")), "amount"),
    ]
    for name, title, subtitle, panels in [
        ("speed", "Time", "Wall-clock time, lower is better. Ratios compare Pi-Bolt with Bun. Pi 1.0.0, medians.", speed),
        ("cpu", "CPU time", "All threads, lower is better. Ratios compare Pi-Bolt with Bun. Pi 1.0.0, medians.", cpu),
        ("memory", "Memory and streaming", "Lower is better. Own memory = private dirty pages. Ratios compare Pi-Bolt with Bun.", memory),
    ]:
        for theme in ("light", "dark"):
            chart(title, subtitle, panels, builds, theme, a.images / f"bench-{name}-{theme}.svg")

    tiles = [
        ("Ready to type", "ms", vals(lambda x: b(x, "interactive", "tti_ms")), "faster"),
        ("CPU per session", "ms", vals(lambda x: b(x, "interactive", "cpu_ms")), "less"),
        ("CPU while streaming", "ms", vals(lambda x: tm(x, "prompt_cpu_ms")), "less"),
        ("Memory, long session", "MB", vals(lambda x: lg(x, "own_mb")), "less"),
    ]
    for theme in ("light", "dark"):
        hero(tiles, builds, theme, a.images / f"bench-hero-{theme}.svg")

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
