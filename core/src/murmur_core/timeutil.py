"""Time helpers. The database stores naive UTC datetimes; the API speaks ISO 8601 with a trailing Z."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BeforeValidator, PlainSerializer

UTC = timezone.utc


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(UTC).replace(tzinfo=None)


def parse_dt(value):
    if value is None or isinstance(value, datetime):
        return to_naive_utc(value) if isinstance(value, datetime) else value
    if isinstance(value, str):
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        return to_naive_utc(datetime.fromisoformat(text))
    raise ValueError("invalid datetime")


def iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    dt = to_naive_utc(dt)
    spec = "seconds" if dt.microsecond == 0 else "milliseconds"
    return dt.isoformat(timespec=spec) + "Z"


UTCDatetime = Annotated[datetime, BeforeValidator(parse_dt), PlainSerializer(iso, return_type=str, when_used="json")]


def get_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("UTC")


def to_local(dt: datetime, tz: ZoneInfo) -> datetime:
    return dt.replace(tzinfo=UTC).astimezone(tz)


def local_to_utc(dt: datetime, tz: ZoneInfo) -> datetime:
    """Interpret a naive datetime as wall-clock time in tz and return naive UTC."""
    if dt.tzinfo is not None:
        return to_naive_utc(dt)
    return dt.replace(tzinfo=tz).astimezone(UTC).replace(tzinfo=None)


def local_day_bounds(day: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    start = local_to_utc(datetime.combine(day, time.min), tz)
    end = local_to_utc(datetime.combine(day + timedelta(days=1), time.min), tz)
    return start, end
