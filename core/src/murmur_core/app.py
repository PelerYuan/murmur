from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import __version__
from .api import auth, dashboard, pipeline, recorder_device, recorders, settings, speakers, summaries, todos, utterances
from .config import Config, get_config
from .deps import ApiError
from .runtime import Runtime, build_runtime
from .services.pipeline import PipelineWorker
from .services.scheduler import Scheduler

log = logging.getLogger("murmur")


def create_app(config: Optional[Config] = None, runtime: Optional[Runtime] = None, start_background: Optional[bool] = None) -> FastAPI:
    config = config or get_config()
    rt = runtime or build_runtime(config)
    run_background = (config.role in ("all", "worker")) if start_background is None else start_background

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        worker = scheduler = None
        if run_background:
            worker, scheduler = PipelineWorker(rt), Scheduler(rt)
            worker.start()
            scheduler.start()
            log.info("background workers started (role=%s)", config.role)
        try:
            yield
        finally:
            if worker:
                worker.stop()
            if scheduler:
                scheduler.stop()

    app = FastAPI(title="Murmur", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.runtime = rt

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        code = getattr(exc, "code", None) or {401: "unauthenticated", 404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "error")
        return JSONResponse({"detail": exc.detail, "code": code}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        return JSONResponse({"detail": f"{loc}: {first.get('msg', 'invalid request')}".strip(": "), "code": "validation_error"}, status_code=422)

    @app.exception_handler(ValidationError)
    async def model_error(_: Request, exc: ValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", []))
        return JSONResponse({"detail": f"{loc}: {first.get('msg', 'invalid value')}", "code": "validation_error"}, status_code=422)

    api = APIRouter(prefix="/api/v1")
    for module in (
        auth,
        recorders,
        recorder_device,
        settings,
        pipeline,
        utterances,
        speakers,
        summaries,
        todos,
        dashboard,
    ):
        api.include_router(module.router)
    app.include_router(api)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    _mount_web(app, config.resolve_web_dir())
    return app


def _mount_web(app: FastAPI, web_dir: Optional[Path]) -> None:
    if web_dir is None:
        @app.get("/", include_in_schema=False)
        def placeholder():
            return JSONResponse({"name": "Murmur", "detail": "web UI is not built; the API is at /api/docs"})

        return

    assets = web_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")
    index = web_dir / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "not found")
        candidate = (web_dir / path).resolve()
        if path and web_dir.resolve() in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
