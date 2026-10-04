#!/usr/bin/env python3
"""A fake OpenAI-compatible model that drives Pi through every core tool, for end-to-end correctness checks (e2e-tools.sh).

One scripted step per model turn: ls, find, grep, write, edit, bash, read, codemode, then a final answer that quotes what the last tool
returned, so a wrong tool result changes the transcript. Usage: fake_model_tools.py PORT."""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STEPS = [
    ("ls", {"path": "."}),
    ("find", {"pattern": "**/*.ts", "path": "fixture"}),
    ("grep", {"pattern": "export (async )?function", "path": "fixture", "limit": 20}),
    ("write", {"path": "out/notes.md", "content": "# Notes\n\nalpha = 1\nbeta = 2\ngamma = 3\n"}),
    ("edit", {"path": "out/notes.md", "edits": [{"oldText": "beta = 2", "newText": "beta = 20"}, {"oldText": "gamma = 3", "newText": "gamma = 30\ndelta = 40"}]}),
    ("bash", {"command": "cd out && sha256sum notes.md && wc -l notes.md && node -e 'console.log(JSON.stringify({sum: [1,2,3].reduce((a,b)=>a+b)}))' 2>/dev/null || echo no-node"}),
    ("read", {"path": "out/notes.md"}),
    # A script in the QuickJS worker (WebAssembly, SharedArrayBuffer and Atomics) that calls a tool back.
    ("codemode", {"code": "const text = await tools.read({ path: 'out/notes.md' });\nlet h = 0;\nfor (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;\n"
                          "return JSON.stringify({ lines: text.split('\\n').filter(Boolean).length, hash: h, sum: [1, 2, 3, 4].reduce((a, b) => a + b) });"}),
]


def chunk(delta=None, finish=None):
    return b"data: " + json.dumps({"id": "fake", "object": "chat.completion.chunk", "model": "fake-model",
                                   "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}).encode() + b"\n\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fake-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        turn, last = 0, ""
        for m in req.get("messages", []):
            if m.get("role") == "user":
                turn = 0
            elif m.get("role") == "tool":
                turn += 1
                content = m.get("content")
                last = content if isinstance(content, str) else json.dumps(content)
        out = [chunk({"role": "assistant", "content": ""}), chunk({"content": f"Step {turn + 1}. "})]
        if turn < len(STEPS):
            name, args = STEPS[turn]
            out.append(chunk({"tool_calls": [{"index": 0, "id": f"call_{turn}", "type": "function",
                                               "function": {"name": name, "arguments": json.dumps(args)}}]}))
            out.append(chunk(finish="tool_calls"))
        else:
            # (Codemode says how long its script ran: how fast a build is, not what it does.)
            quoted = re.sub(r"Wall time [\d.]+ seconds", "Wall time (some) seconds", last)
            out.append(chunk({"content": "Final file:\n" + quoted + "\nDone: tools exercised."}))
            out.append(chunk(finish="stop"))
        out.append(b"data: [DONE]\n\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for piece in out:
            self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18081), Handler).serve_forever()
