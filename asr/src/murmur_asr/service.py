"""FastAPI application: the HTTP contract from docs/API.md section 1."""
from __future__ import annotations

import asyncio
import hmac
import logging
import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .audio import load_audio
from .config import Settings
from .download_models import ensure_models
from .errors import AsrError, Busy, InvalidAudio, NotReady, PayloadTooLarge, Unauthorized

log = logging.getLogger("murmur_asr")

LANGUAGES = ["zh", "en", "ja", "ko", "yue"]


class BodyLimit:
    """Pure ASGI middleware: abort request bodies that stream past the size limit."""

    def __init__(self, app, limit_bytes: int):
        self.app, self.limit = app, limit_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        total = 0

        async def counted():
            nonlocal total
            msg = await receive()
            if msg["type"] == "http.request":
                total += len(msg.get("body", b""))
                if total > self.limit:
                    raise PayloadTooLarge(f"upload exceeds the {self.limit // (1024 * 1024)} MB limit")
            return msg

        await self.app(scope, counted, send)


class Runtime:
    """Loads models in the background, then serves requests from a bounded worker pool."""

    def __init__(self, settings: Settings, engine_factory: Callable[[Settings], object] | None = None):
        self.s = settings
        self.engine_factory = engine_factory
        self.engines: "queue.Queue" = queue.Queue()
        self.loaded = 0
        self.state = "loading"  # loading | ok | error
        self.error: str | None = None
        self.executor = ThreadPoolExecutor(max_workers=settings.workers, thread_name_prefix="asr")
        self._pending = 0
        self._lock = threading.Lock()
        self.info_engine = None
        self._thread = threading.Thread(target=self._load, name="asr-loader", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _load(self) -> None:
        try:
            t0 = time.perf_counter()
            if self.engine_factory is None:
                import sherpa_onnx

                if self.s.provider == "cuda" and "cuda" not in getattr(sherpa_onnx, "__version__", ""):
                    log.warning("MURMUR_ASR_PROVIDER=cuda but the installed sherpa-onnx (%s) does not look like a CUDA build; "
                                "onnxruntime will silently fall back to CPU. See README 'GPU / CUDA'.",
                                getattr(sherpa_onnx, "__version__", "?"))
                from .pipeline import Engine

                paths = ensure_models(self.s)
                factory = lambda s: Engine(s, paths)  # noqa: E731
            else:
                factory = self.engine_factory
            for i in range(self.s.workers):
                e = factory(self.s)
                self.engines.put(e)
                self.loaded += 1
                if self.info_engine is None:
                    self.info_engine = e
                    self.state = "ok"
                    log.info("first engine ready after %.1fs (backend=%s, provider=%s, threads=%d)",
                             time.perf_counter() - t0, self.s.backend, self.s.provider, self.s.num_threads)
            log.info("all %d engines ready after %.1fs", self.loaded, time.perf_counter() - t0)
        except Exception as e:  # noqa: BLE001
            log.exception("model loading failed")
            self.state, self.error = "error", str(e)

    def check_ready(self) -> None:
        if self.state == "loading":
            raise NotReady("models are still loading")
        if self.state == "error":
            raise NotReady(f"model loading failed: {self.error}")

    def info(self) -> dict:
        e = self.info_engine
        return {
            "name": "murmur-asr", "version": __version__, "asr_model": e.asr_model,
            "embedding_model": "campplus-zh-en", "embedding_dim": e.embedding_dim,
            "languages": LANGUAGES if self.s.backend == "sensevoice" else ["auto"],
            "features": {"speaker_embedding": True, "event_tags": bool(e.recognizer.supports_events)},
        }

    async def run(self, samples, language: str):
        with self._lock:
            if self._pending >= self.s.workers + self.s.max_queue:
                raise Busy("server is busy, retry later")
            self._pending += 1

        def job():
            eng = self.engines.get()
            try:
                return eng.process(samples, language)
            finally:
                self.engines.put(eng)

        try:
            return await asyncio.get_running_loop().run_in_executor(self.executor, job)
        finally:
            with self._lock:
                self._pending -= 1


def _err(status: int, code: str, detail: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"detail": detail, "code": code}, status_code=status, headers=headers)


def create_app(settings: Settings | None = None, engine_factory=None) -> FastAPI:
    settings = settings or Settings.from_env()
    rt = Runtime(settings, engine_factory)

    @asynccontextmanager
    async def lifespan(_app):
        rt.start()
        yield
        rt.executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="murmur-asr", version=__version__, lifespan=lifespan)
    app.add_middleware(BodyLimit, limit_bytes=settings.max_upload_mb * 1024 * 1024 + 64 * 1024)
    app.state.runtime = rt

    @app.exception_handler(AsrError)
    async def _asr(_r: Request, e: AsrError):
        return _err(e.status, e.code, e.detail, {"Retry-After": "5"} if e.status == 503 else None)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_r: Request, e: StarletteHTTPException):
        code = {401: "unauthorized", 404: "not_found", 405: "method_not_allowed"}.get(e.status_code, "http_error")
        return _err(e.status_code, code, str(e.detail))

    @app.exception_handler(RequestValidationError)
    async def _val(_r: Request, e: RequestValidationError):
        return _err(422, "invalid_request", "; ".join(str(x.get("msg")) for x in e.errors()))

    @app.exception_handler(Exception)
    async def _any(_r: Request, e: Exception):
        log.exception("unhandled error")
        return _err(500, "internal_error", f"{type(e).__name__}: {e}")

    def auth(request: Request) -> None:
        key = settings.api_key
        if not key:
            return
        h = request.headers.get("authorization", "")
        tok = h[7:].strip() if h.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(tok.encode(), key.encode()):
            raise Unauthorized("missing or invalid bearer token")

    @app.get("/health")
    async def health():
        if rt.state == "ok":
            return {"status": "ok"}
        return JSONResponse({"status": rt.state, "detail": rt.error or "models are loading"}, status_code=503)

    @app.get("/v1/info")
    async def info(request: Request):
        auth(request)
        rt.check_ready()
        return rt.info()

    @app.post("/v1/process")
    async def process(request: Request):
        auth(request)
        rid = uuid.uuid4().hex[:8]
        rt.check_ready()
        cl = request.headers.get("content-length")
        limit = settings.max_upload_mb * 1024 * 1024
        if cl and cl.isdigit() and int(cl) > limit + 64 * 1024:
            raise PayloadTooLarge(f"upload exceeds the {settings.max_upload_mb} MB limit")
        ctype = request.headers.get("content-type", "")
        if not ctype.lower().startswith("multipart/form-data"):
            raise InvalidAudio("expected multipart/form-data with a 'file' field")
        try:
            form = await request.form()
        except AsrError:
            raise
        except Exception as e:  # noqa: BLE001 - malformed multipart
            raise InvalidAudio(f"cannot parse multipart body: {e}") from e
        up = form.get("file")
        if up is None or isinstance(up, str):
            raise InvalidAudio("missing 'file' field (multipart upload)")
        data = await up.read()
        await form.close()
        if len(data) > limit:
            raise PayloadTooLarge(f"upload exceeds the {settings.max_upload_mb} MB limit")
        language = str(form.get("language") or "auto").strip().lower()
        t0 = time.perf_counter()
        samples = await asyncio.get_running_loop().run_in_executor(None, load_audio, data, settings.max_audio_seconds)
        if len(samples) == 0:
            res = {"language": "unknown", "duration": 0.0, "processing_time": 0.0, "utterances": []}
            log.info("req=%s audio=0.0s took=0.00s rtf=- utts=0 (empty audio)", rid)
            return res
        result = await rt.run(samples, language)
        took = time.perf_counter() - t0
        dur = result.duration
        log.info("req=%s audio=%.1fs took=%.2fs infer=%.2fs rtf=%.3f utts=%d lang=%s", rid, dur, took,
                 result.processing_time, took / max(dur, 1e-6), len(result.utterances), result.language)
        return result.to_dict()

    return app
