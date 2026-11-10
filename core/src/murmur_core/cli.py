from __future__ import annotations

import argparse
import getpass
import logging
import signal
import sys
import threading

from .config import get_config


def _setup_logging(level: str) -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO), format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")


def cmd_serve(args) -> int:
    import uvicorn

    from .app import create_app

    config = get_config()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    _setup_logging(config.log_level)
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level=config.log_level.lower())
    return 0


def cmd_worker(args) -> int:
    """Pipeline + scheduler without the HTTP server (for split deployments)."""
    from .runtime import build_runtime
    from .services.pipeline import PipelineWorker
    from .services.scheduler import Scheduler

    config = get_config()
    _setup_logging(config.log_level)
    rt = build_runtime(config)
    worker, scheduler = PipelineWorker(rt), Scheduler(rt)
    worker.start()
    scheduler.start()
    logging.getLogger("murmur").info("worker running (data dir %s)", config.data_dir.resolve())
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    stop.wait()
    worker.stop()
    scheduler.stop()
    return 0


def cmd_reset_password(args) -> int:
    from .models import AuthRow, SessionRow
    from .runtime import build_runtime
    from .security import hash_password

    rt = build_runtime(get_config())
    password = args.password or getpass.getpass("New password: ")
    if len(password) < 6:
        print("password must be at least 6 characters", file=sys.stderr)
        return 1
    with rt.scope() as s:
        row = s.query(AuthRow).first()
        if row is None:
            s.add(AuthRow(password_hash=hash_password(password)))
        else:
            row.password_hash = hash_password(password)
        s.query(SessionRow).delete()
    print("password updated; all sessions were signed out")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="murmur-core")
    sub = parser.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve", help="run the API (and workers, depending on MURMUR_ROLE)")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.set_defaults(func=cmd_serve)
    sub.add_parser("worker", help="run only the pipeline worker and scheduler").set_defaults(func=cmd_worker)
    rp = sub.add_parser("reset-password", help="set a new web password (use if you forgot it)")
    rp.add_argument("--password")
    rp.set_defaults(func=cmd_reset_password)
    args = parser.parse_args(argv)
    if not args.cmd:
        args = parser.parse_args(["serve"])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
