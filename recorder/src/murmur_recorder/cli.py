"""``murmur-recorder`` command line."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
from typing import List, Optional

from . import __version__
from .config import Settings

log = logging.getLogger("murmur")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="murmur-recorder", description="Murmur recorder")
    p.add_argument("--version", action="version", version=f"murmur-recorder {__version__}")
    sub = p.add_subparsers(dest="cmd")

    run = sub.add_parser("run", help="capture and upload (default)")
    run.add_argument("--core-url", help="Core base URL (env MURMUR_CORE_URL)")
    run.add_argument("--token", help="recorder token (env MURMUR_TOKEN)")
    run.add_argument("--buffer-dir", help="local chunk buffer directory (env MURMUR_BUFFER_DIR, default ./buffer)")
    run.add_argument("--source", help="'device' (default) or 'file:/path/to.wav' (env MURMUR_SOURCE)")
    run.add_argument("--file-speed", type=float, help="file source speed multiplier (env MURMUR_FILE_SPEED)")
    run.add_argument("--file-start-at", help="file source: ISO time to stamp chunks with (env MURMUR_FILE_START_AT)")
    run.add_argument("--file-loop", action="store_true", default=None, help="loop the file (env MURMUR_FILE_LOOP)")
    run.add_argument("--buffer-max-mb", type=int, help="buffer size cap in MB (env MURMUR_BUFFER_MAX_MB, default 2048)")
    run.add_argument("--heartbeat-interval", type=float, help="seconds between heartbeats (default 10)")
    run.add_argument("--log-level", help="DEBUG, INFO, WARNING (env MURMUR_LOG_LEVEL)")

    dev = sub.add_parser("devices", help="list input devices")
    dev.add_argument("--json", action="store_true", help="machine-readable output")
    return p


def settings_from_args(args: argparse.Namespace) -> Settings:
    s = Settings.from_env()
    for attr in (
        "core_url",
        "token",
        "buffer_dir",
        "source",
        "file_speed",
        "file_start_at",
        "file_loop",
        "buffer_max_mb",
        "heartbeat_interval",
        "log_level",
    ):
        v = getattr(args, attr, None)
        if v is not None:
            setattr(s, attr, v)
    return s


def cmd_devices(args: argparse.Namespace) -> int:
    from .devices import list_input_devices

    try:
        devs = list_input_devices()
    except Exception as e:
        print(f"cannot enumerate audio devices: {type(e).__name__}: {e}", file=sys.stderr)
        if "PortAudio" in str(e) or "portaudio" in str(e).lower():
            print("hint: install libportaudio2 (apt-get install libportaudio2)", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(devs))
        return 0
    if not devs:
        print("no input devices found (is a microphone plugged in / is /dev/snd available?)")
        return 0
    print(f"{'ID':<28} {'CH':>2} {'RATE':>6}  NAME")
    for d in devs:
        mark = " *" if d["is_default"] else ""
        print(f"{d['id']:<28} {d['channels']:>2} {d['default_samplerate']:>6}  {d['name']}{mark}")
    print("(* = system default; use the ID column as `device` in the web UI)")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    from .recorder import Recorder

    s = settings_from_args(args)
    logging.basicConfig(
        level=getattr(logging, s.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        s.validate()
    except ValueError as e:
        log.error("%s", e)
        return 2
    rec = Recorder(s)

    def _stop(signum, frame):  # noqa: ANN001
        log.info("signal %s received, shutting down (flushing in-progress chunk)", signal.Signals(signum).name)
        rec.stop_event.set()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    log.info("murmur-recorder %s starting: core=%s source=%s buffer=%s", __version__, s.core_url, s.source, s.buffer_dir)
    rec.start()
    rec.wait()
    rec.stop()
    left = rec.buffer.count()
    log.info("stopped; %d chunk(s) left in buffer%s", left, " (will upload on next start)" if left else "")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("run", "devices", "-h", "--help", "--version"):
        argv.insert(0, "run")
    args = build_parser().parse_args(argv)
    if args.cmd == "devices":
        return cmd_devices(args)
    return cmd_run(args)


if __name__ == "__main__":
    raise SystemExit(main())
