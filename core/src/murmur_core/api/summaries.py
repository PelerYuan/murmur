import base64
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, require_user
from ..models import Room, Summary, SummaryJob
from ..schemas import serialize_job, serialize_summary
from ..services import summarizer
from ..timeutil import UTCDatetime, parse_dt

router = APIRouter(tags=["summaries"], dependencies=[Depends(require_user)])


@router.get("/summaries")
def list_summaries(
    level: Optional[str] = Query(None, pattern="^(incremental|hourly|daily|custom)$"),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    room_id: Optional[int] = None,
    limit: int = Query(50, ge=1, le=500),
    cursor: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Summary)
    try:
        if level:
            q = q.filter(Summary.level == level)
        if from_:
            q = q.filter(Summary.range_start >= parse_dt(from_))
        if to:
            q = q.filter(Summary.range_start < parse_dt(to))
        if cursor:
            offset = int(base64.urlsafe_b64decode(cursor.encode()).decode())
        else:
            offset = 0
    except ValueError:
        raise ApiError(422, "bad filter", "bad_request")
    if room_id is not None:
        q = q.filter(Summary.room_id == room_id)
    rows = q.order_by(Summary.range_start.desc(), Summary.id.desc()).offset(offset).limit(limit + 1).all()
    more = len(rows) > limit
    next_cursor = base64.urlsafe_b64encode(str(offset + limit).encode()).decode() if more else None
    return {"items": [serialize_summary(s) for s in rows[:limit]], "next_cursor": next_cursor}


@router.get("/summaries/{summary_id}")
def get_summary(summary_id: int, db: Session = Depends(get_db)):
    sm = db.get(Summary, summary_id)
    if sm is None:
        raise ApiError(404, "summary not found", "not_found")
    return serialize_summary(sm)


@router.delete("/summaries/{summary_id}", status_code=204)
def delete_summary(summary_id: int, db: Session = Depends(get_db)):
    sm = db.get(Summary, summary_id)
    if sm is None:
        raise ApiError(404, "summary not found", "not_found")
    db.delete(sm)


class GenerateIn(BaseModel):
    level: str = "custom"
    start: UTCDatetime
    end: UTCDatetime
    room_id: Optional[int] = None


@router.post("/summaries/generate", status_code=202)
def generate(body: GenerateIn, db: Session = Depends(get_db)):
    if body.level not in ("incremental", "hourly", "daily", "custom"):
        raise ApiError(422, "invalid level", "bad_level")
    if body.end <= body.start:
        raise ApiError(422, "end must be after start", "bad_range")
    if body.room_id is not None and db.get(Room, body.room_id) is None:
        raise ApiError(422, "room does not exist", "bad_room")
    job = summarizer.enqueue_job(db, body.level, body.start, body.end, body.room_id)
    return serialize_job(job)


@router.get("/summary-jobs")
def list_jobs(status: Optional[str] = None, limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    q = db.query(SummaryJob)
    if status:
        q = q.filter(SummaryJob.status == status)
    return [serialize_job(j) for j in q.order_by(SummaryJob.id.desc()).limit(limit)]
