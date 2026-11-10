import asyncio
import json
import shutil
import time
from typing import Optional

from fastapi import APIRouter, Depends, Header, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import __version__, events
from ..deps import SESSION_COOKIE, ApiError, _session_valid, get_db, get_runtime, json_loads, require_user
from ..models import Chunk, Recorder, Speaker, Summary, Todo, Utterance
from ..runtime import Runtime
from ..schemas import serialize_summary
from ..services.speakers import color_for, display_name
from ..timeutil import get_tz, iso, local_day_bounds, to_local, utcnow
from .recorders import recorder_online

router = APIRouter(tags=["dashboard"])
_STARTED = time.monotonic()


@router.get("/dashboard", dependencies=[Depends(require_user)])
def dashboard(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    cfg = rt.settings.get(db)
    tz = get_tz(cfg.general.timezone)
    today = to_local(utcnow(), tz).date()
    start, end = local_day_bounds(today, tz)
    base = db.query(Utterance).filter(Utterance.started_at >= start, Utterance.started_at < end)
    count = base.count()
    seconds = 0.0
    by_speaker = []
    names = {sp.id: sp for sp in db.query(Speaker).all()}
    rows = (
        db.query(Utterance.speaker_id, Utterance.started_at, Utterance.ended_at)
        .filter(Utterance.started_at >= start, Utterance.started_at < end)
        .all()
    )
    agg: dict[Optional[int], list] = {}
    for sid, a, b in rows:
        slot = agg.setdefault(sid, [0.0, 0])
        d = max((b - a).total_seconds(), 0.0)
        slot[0] += d
        slot[1] += 1
        seconds += d
    for sid, (secs, n) in sorted(agg.items(), key=lambda kv: -kv[1][0]):
        sp = names.get(sid) if sid else None
        by_speaker.append(
            {
                "speaker_id": sid,
                "display_name": display_name(sp, cfg.general.ui_language) if sp else ("未知说话人" if cfg.general.ui_language.startswith("zh") else "Unknown"),
                "color": color_for(sid) if sid else "#9ca3af",
                "seconds": round(secs, 1),
                "utterances": n,
            }
        )
    latest = db.query(Summary).order_by(Summary.created_at.desc()).first()
    pending = db.query(func.count(Chunk.id)).filter(Chunk.status.in_(["pending", "processing"])).scalar()
    failed = db.query(func.count(Chunk.id)).filter(Chunk.status == "failed").scalar()
    return {
        "date": today.isoformat(),
        "today": {"utterance_count": count, "speech_seconds": round(seconds, 1), "by_speaker": by_speaker},
        "open_todos": db.query(func.count(Todo.id)).filter(Todo.status == "open").scalar(),
        "due_reminders": db.query(func.count(Todo.id))
        .filter(Todo.status == "open", Todo.reminder_state.in_(["pending", "fired"]), Todo.remind_at <= utcnow())
        .scalar(),
        "latest_summary": serialize_summary(latest) if latest else None,
        "recorders": [
            {"id": r.id, "name": r.name, "online": recorder_online(r), "state": json_loads(r.status_json, {}).get("state")}
            for r in db.query(Recorder).order_by(Recorder.id)
        ],
        "pipeline": {"pending": pending, "failed": failed},
    }


@router.get("/system/info", dependencies=[Depends(require_user)])
def system_info(rt: Runtime = Depends(get_runtime)):
    usage = shutil.disk_usage(rt.config.data_dir)
    return {
        "version": __version__,
        "role": rt.config.role,
        "data_dir": str(rt.config.data_dir.resolve()),
        "db_path": rt.config.db_url if not rt.config.db_url.startswith("sqlite") else rt.config.db_url.replace("sqlite:///", ""),
        "uptime_seconds": int(time.monotonic() - _STARTED),
        "disk_free_bytes": usage.free,
    }


@router.get("/events")
async def event_stream(request: Request, last_event_id: Optional[str] = Header(default=None), rt: Runtime = Depends(get_runtime)):
    def check_auth() -> bool:
        with rt.scope() as s:
            return _session_valid(s, request.cookies.get(SESSION_COOKIE))

    if not await run_in_threadpool(check_auth):
        raise ApiError(401, "not authenticated", "unauthenticated")

    def initial_cursor() -> int:
        if last_event_id and last_event_id.isdigit():
            return int(last_event_id)
        with rt.scope() as s:
            return events.max_id(s)

    def fetch(after: int):
        with rt.scope() as s:
            return [(e.id, e.type, e.data_json) for e in events.fetch_after(s, after)]

    cursor = await run_in_threadpool(initial_cursor)

    async def gen():
        nonlocal cursor
        last_ping = time.monotonic()
        yield "retry: 3000\n\n"
        while True:
            if await request.is_disconnected():
                return
            rows = await run_in_threadpool(fetch, cursor)
            for eid, etype, data in rows:
                cursor = eid
                yield f"id: {eid}\nevent: {etype}\ndata: {data}\n\n"
            if time.monotonic() - last_ping >= 25:
                last_ping = time.monotonic()
                yield f"event: ping\ndata: {{}}\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
