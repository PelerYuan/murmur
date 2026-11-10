from __future__ import annotations

import json
from typing import Iterator, Optional

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from .models import Recorder, SessionRow
from .runtime import Runtime
from .security import hash_token
from .timeutil import utcnow

SESSION_COOKIE = "murmur_session"


class ApiError(HTTPException):
    def __init__(self, status: int, detail: str, code: str = "error", headers: Optional[dict] = None):
        super().__init__(status_code=status, detail=detail, headers=headers)
        self.code = code


def get_runtime(request: Request) -> Runtime:
    return request.app.state.runtime


def get_db(rt: Runtime = Depends(get_runtime)) -> Iterator[Session]:
    session = rt.sessions()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _session_valid(db: Session, token: Optional[str]) -> bool:
    if not token:
        return False
    row = db.get(SessionRow, hash_token(token))
    return row is not None and row.expires_at > utcnow()


def require_user(request: Request, db: Session = Depends(get_db)) -> None:
    if not _session_valid(db, request.cookies.get(SESSION_COOKIE)):
        raise ApiError(401, "not authenticated", "unauthenticated")


def require_recorder(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> Recorder:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ApiError(401, "missing recorder token", "unauthenticated")
    token = authorization[7:].strip()
    rec = db.query(Recorder).filter(Recorder.token_hash == hash_token(token)).first()
    if rec is None:
        raise ApiError(401, "invalid recorder token", "unauthenticated")
    return rec


def json_loads(text: Optional[str], default):
    try:
        return json.loads(text) if text else default
    except json.JSONDecodeError:
        return default
