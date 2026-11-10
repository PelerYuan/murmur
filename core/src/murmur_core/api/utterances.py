import base64
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, get_runtime, require_user
from ..models import Speaker, Utterance
from ..runtime import Runtime
from ..schemas import serialize_utterance
from ..services import speakers as speaker_svc
from ..timeutil import iso, parse_dt

router = APIRouter(prefix="/utterances", tags=["utterances"], dependencies=[Depends(require_user)])


def _names(db: Session, language: str) -> dict[int, str]:
    return {sp.id: speaker_svc.display_name(sp, language) for sp in db.query(Speaker).all()}


def _encode(u: Utterance) -> str:
    return base64.urlsafe_b64encode(f"{iso(u.started_at)}|{u.id}".encode()).decode()


def _decode(cursor: str) -> tuple[datetime, int]:
    try:
        ts, _, uid = base64.urlsafe_b64decode(cursor.encode()).decode().partition("|")
        return parse_dt(ts), int(uid)
    except Exception:
        raise ApiError(422, "bad cursor", "bad_cursor")


def _parse(value: Optional[str], name: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return parse_dt(value)
    except ValueError:
        raise ApiError(422, f"{name} must be ISO 8601", "bad_time")


@router.get("/days")
def utterance_days(
    from_: str = Query(..., alias="from"),
    to: str = Query(...),
    db: Session = Depends(get_db),
    rt: Runtime = Depends(get_runtime),
):
    """Local dates (per the configured timezone) that have conversation, with counts. For calendar dot markers."""
    from sqlalchemy import func

    from ..timeutil import get_tz, to_local

    tz = get_tz(rt.settings.get(db).general.timezone)
    start, end = _parse(from_, "from"), _parse(to, "to")
    rows = db.query(Utterance.started_at).filter(Utterance.started_at >= start, Utterance.started_at < end).all()
    days: dict[str, int] = {}
    for (ts,) in rows:
        key = to_local(ts, tz).date().isoformat()
        days[key] = days.get(key, 0) + 1
    return [{"date": d, "count": n} for d, n in sorted(days.items())]


@router.get("/{utterance_id}")
def get_utterance(utterance_id: int, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    utt = db.get(Utterance, utterance_id)
    if utt is None:
        raise ApiError(404, "utterance not found", "not_found")
    return serialize_utterance(utt, _names(db, rt.settings.get(db).general.ui_language))


@router.get("")
def list_utterances(
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    room_id: Optional[int] = None,
    speaker_id: Optional[int] = None,
    q: Optional[str] = None,
    exclude_ignored: bool = True,
    around: Optional[int] = None,
    window: int = Query(300, ge=10, le=3600),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=500),
    cursor: Optional[str] = None,
    db: Session = Depends(get_db),
    rt: Runtime = Depends(get_runtime),
):
    """`order=asc` is an addition to the contract for chronological reading of one day."""
    query = db.query(Utterance)
    start, end = _parse(from_, "from"), _parse(to, "to")
    if around is not None:  # conversation context: everything within `window` seconds of one utterance
        centre = db.get(Utterance, around)
        if centre is None:
            raise ApiError(404, "utterance not found", "not_found")
        start, end = centre.started_at - timedelta(seconds=window), centre.started_at + timedelta(seconds=window)
        order = "asc"
    if start:
        query = query.filter(Utterance.started_at >= start)
    if end:
        query = query.filter(Utterance.started_at < end)
    if room_id is not None:
        query = query.filter(Utterance.room_id == room_id)
    if exclude_ignored:
        ignored = [sid for (sid,) in db.query(Speaker.id).filter(Speaker.state == "ignored")]
        if ignored:
            query = query.filter(or_(Utterance.speaker_id.is_(None), Utterance.speaker_id.notin_(ignored)))
    if speaker_id is not None:
        query = query.filter(Utterance.speaker_id == speaker_id)
    if q and q.strip():
        term = q.strip()
        if db.bind.dialect.name == "sqlite" and len(term) >= 3:
            phrase = '"' + term.replace('"', '""') + '"'
            ids = [r[0] for r in db.execute(text("SELECT rowid FROM utterances_fts WHERE utterances_fts MATCH :q"), {"q": phrase})]
            query = query.filter(Utterance.id.in_(ids))
        else:  # trigram FTS needs >= 3 characters; short queries fall back to a substring scan
            like = "%" + term.replace("%", r"\%").replace("_", r"\_") + "%"
            query = query.filter(Utterance.text.ilike(like, escape="\\"))
    if cursor:
        ts, uid = _decode(cursor)
        if order == "desc":
            query = query.filter(or_(Utterance.started_at < ts, and_(Utterance.started_at == ts, Utterance.id < uid)))
        else:
            query = query.filter(or_(Utterance.started_at > ts, and_(Utterance.started_at == ts, Utterance.id > uid)))
    if order == "desc":
        query = query.order_by(Utterance.started_at.desc(), Utterance.id.desc())
    else:
        query = query.order_by(Utterance.started_at, Utterance.id)
    rows = query.limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    names = _names(db, rt.settings.get(db).general.ui_language)
    return {"items": [serialize_utterance(u, names) for u in rows], "next_cursor": _encode(rows[-1]) if more and rows else None}


class UtterancePatch(BaseModel):
    speaker_id: Optional[int] = None
    text: Optional[str] = Field(default=None, min_length=1)


@router.patch("/{utterance_id}")
def patch_utterance(utterance_id: int, body: UtterancePatch, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    utt = db.get(Utterance, utterance_id)
    if utt is None:
        raise ApiError(404, "utterance not found", "not_found")
    fields = body.model_fields_set
    if "text" in fields and body.text is not None and body.text.strip() != utt.text:
        utt.text = body.text.strip()
        utt.text_edited = True
    if "speaker_id" in fields and body.speaker_id != utt.speaker_id:
        old_id = utt.speaker_id
        if body.speaker_id is not None and db.get(Speaker, body.speaker_id) is None:
            raise ApiError(422, "speaker does not exist", "bad_speaker")
        utt.speaker_id = body.speaker_id
        db.flush()
        for sid in {old_id, body.speaker_id}:
            if sid is not None:
                sp = db.get(Speaker, sid)
                if sp:
                    speaker_svc.recompute_centroid(db, sp)
    db.flush()
    return serialize_utterance(utt, _names(db, rt.settings.get(db).general.ui_language))


@router.delete("/{utterance_id}", status_code=204)
def delete_utterance(utterance_id: int, db: Session = Depends(get_db)):
    utt = db.get(Utterance, utterance_id)
    if utt is None:
        raise ApiError(404, "utterance not found", "not_found")
    sid = utt.speaker_id
    db.delete(utt)
    db.flush()
    if sid is not None:
        sp = db.get(Speaker, sid)
        if sp:
            speaker_svc.recompute_centroid(db, sp)
