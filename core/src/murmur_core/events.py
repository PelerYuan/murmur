"""Event log shared between processes; the SSE endpoint tails it."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import Event
from .timeutil import utcnow


def publish(session: Session, type_: str, data: Any) -> None:
    session.add(Event(type=type_, data_json=json.dumps(data, default=str, ensure_ascii=False)))
    session.flush()


def max_id(session: Session) -> int:
    return session.query(func.coalesce(func.max(Event.id), 0)).scalar() or 0


def fetch_after(session: Session, last_id: int, limit: int = 200) -> list[Event]:
    return session.query(Event).filter(Event.id > last_id).order_by(Event.id).limit(limit).all()


def prune(session: Session, older_than_hours: int = 24) -> int:
    cutoff = utcnow() - timedelta(hours=older_than_hours)
    return session.query(Event).filter(Event.created_at < cutoff).delete()
