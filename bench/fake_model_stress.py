#!/usr/bin/env python3
"""A fake OpenAI-compatible model for stress tests (stress.py). The user's prompt names a scenario, `SCENARIO <name> CWD <dir>`:

  heavy   about twenty turns of large and awkward tool work: megabytes of command output, a 3 MB line, a 1 MB file written
          through a tool call, reads, edits and grep in it, 3,000 files to find and grep through, Unicode and binary files,
          three tool calls at once, failing tools, a command that times out. The final answer is a digest of every tool result
          (with the working directory replaced), so a wrong result anywhere changes it.
  light   two small tool calls and an answer: for long sessions of many prompts
  stream  no tools: a 2 MB answer in some 20,000 small events
  bigargs a 200 KB file written through a tool call whose arguments arrive a few bytes at a time
  drop    half an answer, then the connection is cut
  http500 / http429 / garbage   an error status, or a stream that is not JSON
  sleep   a command that runs for a minute (for interrupting Pi while a tool runs)

Usage: fake_model_stress.py PORT"""

import hashlib
import json
import os
import re
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIG_FILE = "".join(f"line {i:06d} {'abcdefghij' * 9}\n" for i in range(10000))  # about 1 MB
UNICODE = "Grüße 😀 🇮🇳 日本語テキスト العربية עברית é zero​width  sep\n" * 50

HEAVY = [
    [("bash", {"command": "seq 1 300000"})],
    [("bash", {"command": "head -c 3000000 /dev/zero | tr '\\0' x; echo"})],
    [("bash", {"command": "for i in $(seq 1 2000); do echo \"stderr line $i\" >&2; done; exit 3"})],
    [("write", {"path": "big/data.txt", "content": BIG_FILE})],
    [("read", {"path": "big/data.txt"})],
    [("read", {"path": "big/data.txt", "offset": 9990, "limit": 20})],
    [("edit", {"path": "big/data.txt", "edits": [{"oldText": "line 005000 ", "newText": "LINE FIVE THOUSAND "}]})],
    [("grep", {"pattern": "FIVE THOUSAND|line 0099[0-9]{2}", "path": "big", "limit": 50})],
    [("bash", {"command": "mkdir -p tree && cd tree && for d in $(seq 1 30); do mkdir -p d$d; for f in $(seq 1 100); do echo \"needle $d $f\" > d$d/f$f.txt; done; done; echo made"})],
    [("find", {"pattern": "**/*.txt", "path": "tree"})],
    [("grep", {"pattern": "needle 17 ", "path": "tree", "limit": 500})],
    [("ls", {"path": "tree/d1"})],
    [("write", {"path": "uni/text.txt", "content": UNICODE})],
    [("read", {"path": "uni/text.txt"}), ("grep", {"pattern": "日本語", "path": "uni"}), ("bash", {"command": "wc -c uni/text.txt"})],
    [("bash", {"command": "printf '%b' $(for i in $(seq 0 255); do printf '\\\\x%02x' $i; done) > bin.dat; wc -c < bin.dat"})],
    [("read", {"path": "bin.dat"})],
    [("read", {"path": "does/not/exist.txt"})],
    [("edit", {"path": "uni/text.txt", "edits": [{"oldText": "not in the file", "newText": "x"}]})],
    [("no_such_tool", {"x": 1})],
    [("bash", {"command": "sleep 20", "timeout": 1})],
]
LIGHT = [
    [("read", {"path": "fixture/README.md"})],
    [("bash", {"command": "echo light; ls fixture | wc -l"})],
]


def chunk(delta=None, finish=None):
    return b"data: " + json.dumps({"id": "fake", "object": "chat.completion.chunk", "model": "fake-model",
                                   "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}).encode() + b"\n\n"


def tool_calls(turn, calls):
    out = []
    for k, (name, args) in enumerate(calls):
        text = json.dumps(args)
        out.append(chunk({"tool_calls": [{"index": k, "id": f"call_{turn}_{k}", "type": "function", "function": {"name": name, "arguments": ""}}]}))
        # The arguments in pieces, as models send them.
        step = 4096 if len(text) > 65536 else 97
        for i in range(0, len(text), step):
            out.append(chunk({"tool_calls": [{"index": k, "function": {"arguments": text[i:i + step]}}]}))
    out.append(chunk(finish="tool_calls"))
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fake-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream(self, pieces, cut_after=None):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for n, piece in enumerate(pieces):
            if cut_after is not None and n == cut_after:
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        scenario, cwd, turn, results = "light", "", 0, []
        for m in req.get("messages", []):
            content = m.get("content")
            text = content if isinstance(content, str) else json.dumps(content)
            if m.get("role") == "user" and "SCENARIO " in text:
                words = text[text.index("SCENARIO "):].split()
                scenario = words[1]
                cwd = words[3] if len(words) > 3 and words[2] == "CWD" else ""
                turn, results = 0, []
            elif m.get("role") == "assistant" and m.get("tool_calls"):
                turn += 1
            elif m.get("role") == "tool":
                text = text.replace(cwd, "<CWD>") if cwd else text
                # Where Pi saves the whole of a truncated output: a new temporary name every time.
                results.append(re.sub(r"/tmp/[^\s\"')\]]+", "<TMP>", text))

        if scenario in ("http500", "http429"):
            body = json.dumps({"error": {"message": "fake failure", "type": "server_error"}}).encode()
            self.send_response(500 if scenario == "http500" else 429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if scenario == "http429":
                self.send_header("Retry-After", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if scenario == "garbage":
            return self.stream([b"data: {not json\n\n", b"data: [[[\n\n", b"data: [DONE]\n\n"])

        head = [chunk({"role": "assistant", "content": ""}), chunk({"content": f"Turn {turn + 1}. "})]
        steps = {"heavy": HEAVY, "light": LIGHT, "seq": [[("bash", {"command": "seq 1 300000"})]], "sleep": [[("bash", {"command": "sleep 60; echo slept"})]],
                 "bigargs": [[("write", {"path": "args/big.txt", "content": "0123456789abcdef" * 12800})], [("bash", {"command": "sha256sum args/big.txt"})]]}.get(scenario, [])
        if turn < len(steps):
            calls = steps[turn]
            if scenario == "bigargs":
                text = json.dumps(calls[0][1])
                pieces = [chunk({"tool_calls": [{"index": 0, "id": f"call_{turn}_0", "type": "function", "function": {"name": calls[0][0], "arguments": ""}}]})]
                pieces += [chunk({"tool_calls": [{"index": 0, "function": {"arguments": text[i:i + 7]}}]}) for i in range(0, len(text), 7)]
                pieces.append(chunk(finish="tool_calls"))
            else:
                pieces = tool_calls(turn, calls)
            return self.stream(head + pieces + [b"data: [DONE]\n\n"])

        if scenario in ("stream", "drop"):
            body = "".join(f"Paragraph {i}: {'lorem ipsum dolor sit amet ' * 3}\n" for i in range(25000))[:2_000_000]
            pieces = head + [chunk({"content": body[i:i + 100]}) for i in range(0, len(body), 100)]
            pieces += [chunk({"content": f"\nDigest: {hashlib.sha256(body.encode()).hexdigest()[:16]}. Done: {scenario}."}), chunk(finish="stop"), b"data: [DONE]\n\n"]
            return self.stream(pieces, cut_after=len(pieces) // 2 if scenario == "drop" else None)

        digest = hashlib.sha256("\x00".join(results).encode()).hexdigest()[:16]
        # And what Pi sent: system prompt, tool definitions, the conversation (without what changes from run to run).
        sent = json.dumps(req, sort_keys=True, ensure_ascii=False)
        if cwd:
            sent = sent.replace(cwd, "<CWD>").replace(json.dumps(cwd)[1:-1], "<CWD>")
        sent = re.sub(r"/tmp/[^\s\"')\]\\]+", "<TMP>", sent)
        sent = re.sub(r"/[^\s\"']+/(README\.md|docs|examples|CHANGELOG\.md)\b", r"<PI>/\1", sent)  # Where Pi is installed.
        sent = re.sub(r"\d{4}-\d\d-\d\d[T ]?[\d:.]*Z?|\b\d{1,2}:\d\d(:\d\d)?( ?[AP]M)?|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? [A-Z][a-z]+ \d{1,2},? \d{4}", "<DATE>", sent)
        sent_digest = hashlib.sha256(sent.encode()).hexdigest()[:16]
        if os.environ.get("STRESS_DUMP_DIR"):
            with open(os.path.join(os.environ["STRESS_DUMP_DIR"], f"{scenario}-sent-{sent_digest}.json"), "w") as f:
                f.write(sent)
        if os.environ.get("STRESS_DUMP_DIR"):
            with open(os.path.join(os.environ["STRESS_DUMP_DIR"], f"{scenario}-{digest}.json"), "w") as f:
                json.dump(results, f, indent=1, ensure_ascii=False)
        sizes = sum(len(r) for r in results)
        self.stream(head + [chunk({"content": f"{len(results)} tool results, {sizes} characters, digest {digest}, sent {sent_digest}. Done: {scenario}."}),
                            chunk(finish="stop"), b"data: [DONE]\n\n"])


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18082), Handler)
    server.daemon_threads = True
    server.request_queue_size = 256
    server.serve_forever()
