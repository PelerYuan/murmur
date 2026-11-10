#!/usr/bin/env python3
"""Tiny OpenAI-compatible chat server for trying Murmur without a real LLM (stdlib only).

    python scripts/mock_llm.py --port 8200      # then set LLM base URL to http://127.0.0.1:8200/v1

Summaries just quote the transcript lines it received; to-do extraction returns one to-do for any line that
contains "记得" or "remember to". Good enough to see the whole pipeline move; not a substitute for a real model.
"""
import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def reply(body: dict) -> str:
    prompt = body["messages"][-1]["content"]
    if "pong" in prompt:
        return "pong"
    lines = [l.strip() for l in prompt.splitlines() if re.search(r"\[\d{1,2}:\d{2}", l)]
    if body.get("response_format"):
        todos = []
        for l in lines:
            m = re.match(r"^(\d+) \[", l)  # "<id> [HH:MM] who: text"; context lines start with "context"
            hit = re.search(r"(记得|remember to)(.+)", l)
            if m and hit:
                todos.append({"text": (hit.group(1) + hit.group(2)).strip()[:80], "assignee": None, "due": None,
                              "remind": None, "ref": int(m.group(1)), "confidence": 0.8})
        return json.dumps({"todos": todos[:5]}, ensure_ascii=False)
    quoted = "\n".join(f"- {l[:100]}" for l in lines[:8]) or "- （没有可摘要的内容）"
    return f"## 摘要（mock LLM）\n{quoted}"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        out = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply(body)}}]}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8200)
    a = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
