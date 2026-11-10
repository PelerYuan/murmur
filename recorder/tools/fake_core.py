#!/usr/bin/env python3
"""Tiny mock of Murmur Core's recorder endpoints, for demos and tests.

    python tools/fake_core.py --port 8000 --out ./received [--config config.json] [--token SECRET]

* accepts any Bearer token (unless --token is given, then only that one -> else 401)
* POST /api/v1/recorder/heartbeat  -> {"recorder_id":1,"server_time":...,"config":{...}}
  The config is re-read from --config (JSON file) on every heartbeat, so you can edit it live
  (e.g. change "device" or set "enabled": false).
* POST /api/v1/recorder/chunks     -> stores WAVs in --out, idempotent by sha256 (201, then 200 duplicate)
* GET  /_state                     -> heartbeats / chunks seen (JSON)
* POST /_admin/fail?mode=down|ok   -> make every recorder request fail with 503 (simulate outage)
Pure standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import threading
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

DEFAULT_CONFIG = {
    "enabled": True,
    "device": None,
    "gain_db": 0.0,
    "vad_aggressiveness": 2,
    "min_speech_ms": 300,
    "end_silence_ms": 1200,
    "max_chunk_seconds": 60,
    "pre_roll_ms": 300,
}


def parse_multipart(content_type: str, body: bytes) -> Dict[str, Any]:
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    out: Dict[str, Any] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        out[name] = payload if part.get_filename() else payload.decode("utf-8", "replace")
    return out


class FakeCore:
    def __init__(self, out_dir: Optional[Path] = None, config: Optional[Dict[str, Any]] = None,
                 config_file: Optional[Path] = None, required_token: Optional[str] = None) -> None:
        self.out_dir = Path(out_dir) if out_dir else None
        if self.out_dir:
            self.out_dir.mkdir(parents=True, exist_ok=True)
        self.config = dict(DEFAULT_CONFIG, **(config or {}))
        self.config_file = config_file
        self.required_token = required_token
        self.fail_all = False
        self.lock = threading.Lock()
        self.heartbeats: List[Dict[str, Any]] = []
        self.chunks: List[Dict[str, Any]] = []  # accepted (unique) chunks
        self.chunk_posts: List[Dict[str, Any]] = []  # every POST incl. duplicates
        self.by_sha: Dict[str, int] = {}
        self.tokens_seen: List[str] = []
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # -- logic ---------------------------------------------------------
    def current_config(self) -> Dict[str, Any]:
        cfg = dict(self.config)
        if self.config_file and Path(self.config_file).exists():
            try:
                cfg.update(json.loads(Path(self.config_file).read_text()))
            except ValueError:
                pass
        return cfg

    def handle(self, method: str, path: str, headers, body: bytes):
        """Return (status, json-able)."""
        url = urlparse(path)
        if url.path == "/_state":
            with self.lock:
                return 200, {"heartbeats": len(self.heartbeats), "chunks": len(self.chunks),
                             "last_heartbeat": self.heartbeats[-1] if self.heartbeats else None}
        if url.path == "/_admin/fail" and method == "POST":
            self.fail_all = parse_qs(url.query).get("mode", ["down"])[0] == "down"
            return 200, {"fail_all": self.fail_all}
        if url.path == "/healthz":
            return 200, {"status": "ok"}
        if not url.path.startswith("/api/v1/recorder/"):
            return 404, {"detail": "not found", "code": "not_found"}
        if self.fail_all:
            return 503, {"detail": "simulated outage", "code": "unavailable"}
        auth = headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if not token or (self.required_token and token != self.required_token):
            return 401, {"detail": "invalid recorder token", "code": "invalid_token"}
        with self.lock:
            self.tokens_seen.append(token)
        if url.path.endswith("/heartbeat") and method == "POST":
            try:
                hb = json.loads(body)
            except ValueError:
                return 400, {"detail": "bad json", "code": "bad_request"}
            with self.lock:
                self.heartbeats.append(hb)
            return 200, {"recorder_id": 1, "server_time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                         "config": self.current_config()}
        if url.path.endswith("/chunks") and method == "POST":
            form = parse_multipart(headers.get("Content-Type", ""), body)
            data, sha = form.get("file"), form.get("sha256")
            if not isinstance(data, bytes) or not sha or "started_at" not in form or "duration" not in form:
                return 422, {"detail": "missing field", "code": "validation_error"}
            if hashlib.sha256(data).hexdigest() != sha:
                return 422, {"detail": "sha256 mismatch", "code": "sha256_mismatch"}
            with self.lock:
                self.chunk_posts.append({"sha256": sha})
                if (token, sha) in self.by_sha:
                    return 200, {"id": self.by_sha[(token, sha)], "duplicate": True}
                cid = len(self.chunks) + 1
                self.by_sha[(token, sha)] = cid
                rec = {"id": cid, "started_at": form["started_at"], "duration": float(form["duration"]),
                       "sha256": sha, "size": len(data), "token": token}
                if self.out_dir:
                    name = f"{cid:06d}_{form['started_at'].replace(':', '')}.wav"
                    (self.out_dir / name).write_bytes(data)
                    rec["file"] = name
                self.chunks.append(rec)
            return 201, {"id": cid, "duplicate": False}
        return 404, {"detail": "not found", "code": "not_found"}

    # -- server --------------------------------------------------------
    def make_server(self, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
        core = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _do(self, method: str) -> None:
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                status, obj = core.handle(method, self.path, self.headers, body)
                out = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.send_header("Connection", "close")  # no lingering keep-alive after stop()
                self.close_connection = True
                self.end_headers()
                self.wfile.write(out)

            def do_GET(self): self._do("GET")  # noqa: E704
            def do_POST(self): self._do("POST")  # noqa: E704
            def log_message(self, fmt, *args): pass  # noqa: E704

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        return Server((host, port), H)

    def start(self, host: str = "127.0.0.1", port: int = 0) -> int:
        self._httpd = self.make_server(host, port)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self._httpd.server_address[1]

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--out", default="./received", help="directory to store received chunks")
    ap.add_argument("--config", help="JSON file with config overrides, re-read on every heartbeat")
    ap.add_argument("--token", help="only accept this token (default: any)")
    a = ap.parse_args()
    core = FakeCore(Path(a.out), config_file=Path(a.config) if a.config else None, required_token=a.token)
    httpd = core.make_server(a.host, a.port)
    print(f"fake core on http://{a.host}:{a.port}  chunks -> {a.out}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
