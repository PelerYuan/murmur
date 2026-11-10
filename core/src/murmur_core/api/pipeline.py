import base64
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, get_runtime, require_user
from ..models import Chunk
from ..runtime import Runtime
from ..schemas import serialize_chunk
from ..services import asr_client, llm_client
from ..timeutil import iso

router = APIRouter(tags=["pipeline"], dependencies=[Depends(require_user)])

STATUSES = ["pending", "processing", "done", "failed", "skipped"]


@router.get("/pipeline/status")
def pipeline_status(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    counts = {s: 0 for s in STATUSES}
    for status, n in db.query(Chunk.status, func.count(Chunk.id)).group_by(Chunk.status).all():
        counts[status] = n
    oldest = db.query(func.min(Chunk.started_at)).filter(Chunk.status.in_(["pending", "processing"])).scalar()
    last_done = db.query(func.max(Chunk.processed_at)).filter(Chunk.status.in_(["done", "skipped"])).scalar()
    errors = [
        {"chunk_id": c.id, "error": c.error, "at": iso(c.processed_at or c.created_at)}
        for c in db.query(Chunk).filter(Chunk.error.is_not(None)).order_by(Chunk.id.desc()).limit(5)
    ]
    cfg = rt.settings.get(db)
    asr_ok = None
    if counts["pending"] or counts["failed"] or errors:
        asr_ok = asr_client.check(cfg.asr, transport=rt.asr_transport)["ok"]
    return {
        "counts": counts,
        "oldest_pending_at": iso(oldest),
        "last_done_at": iso(last_done),
        "asr_ok": asr_ok,
        "llm_configured": llm_client.configured(cfg.llm),
        "errors": errors,
    }


@router.get("/chunks")
def list_chunks(
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    cursor: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Chunk)
    if status:
        q = q.filter(Chunk.status == status)
    if cursor:
        try:
            q = q.filter(Chunk.id < int(base64.urlsafe_b64decode(cursor.encode()).decode()))
        except Exception:
            raise ApiError(422, "bad cursor", "bad_cursor")
    rows = q.order_by(Chunk.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = base64.urlsafe_b64encode(str(rows[-1].id).encode()).decode() if more and rows else None
    return {"items": [serialize_chunk(c) for c in rows], "next_cursor": next_cursor}


@router.post("/chunks/{chunk_id}/retry")
def retry_chunk(chunk_id: int, db: Session = Depends(get_db)):
    chunk = db.get(Chunk, chunk_id)
    if chunk is None:
        raise ApiError(404, "chunk not found", "not_found")
    if chunk.audio_deleted:
        raise ApiError(409, "audio has already been deleted, nothing to retry", "audio_deleted")
    if chunk.status != "failed":
        raise ApiError(409, "only failed chunks can be retried", "bad_state")
    chunk.status, chunk.attempts, chunk.next_attempt_at, chunk.error = "pending", 0, None, None
    return serialize_chunk(chunk)
