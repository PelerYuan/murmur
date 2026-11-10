from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .timeutil import utcnow


class Base(DeclarativeBase):
    pass


class Room(Base):
    __tablename__ = "rooms"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Recorder(Base):
    __tablename__ = "recorders"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    room_id: Mapped[Optional[int]] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    devices_json: Mapped[str] = mapped_column(Text, default="[]")
    status_json: Mapped[str] = mapped_column(Text, default="{}")
    version: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    room: Mapped[Optional[Room]] = relationship()


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        UniqueConstraint("recorder_id", "sha256", name="uq_chunk_recorder_sha"),
        Index("ix_chunks_status_started", "status", "started_at"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recorder_id: Mapped[Optional[int]] = mapped_column(ForeignKey("recorders.id", ondelete="SET NULL"), nullable=True)
    room_id: Mapped[Optional[int]] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    duration: Mapped[float] = mapped_column(Float)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|processing|done|failed|skipped
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    audio_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    utterance_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Speaker(Base):
    __tablename__ = "speakers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    state: Mapped[str] = mapped_column(String(20), default="unnamed")  # unnamed|named|ignored
    centroid: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    embedding_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SpeakerSample(Base):
    __tablename__ = "speaker_samples"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    speaker_id: Mapped[int] = mapped_column(ForeignKey("speakers.id", ondelete="CASCADE"), index=True)
    storage_key: Mapped[str] = mapped_column(String(300))
    duration: Mapped[float] = mapped_column(Float)
    source_utterance_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Utterance(Base):
    __tablename__ = "utterances"
    __table_args__ = (Index("ix_utt_room_started", "room_id", "started_at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    chunk_id: Mapped[Optional[int]] = mapped_column(ForeignKey("chunks.id", ondelete="SET NULL"), nullable=True, index=True)
    room_id: Mapped[Optional[int]] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ended_at: Mapped[datetime] = mapped_column(DateTime)
    text: Mapped[str] = mapped_column(Text)
    lang: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    speaker_id: Mapped[Optional[int]] = mapped_column(ForeignKey("speakers.id", ondelete="SET NULL"), nullable=True, index=True)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    embedding: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    text_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Summary(Base):
    __tablename__ = "summaries"
    __table_args__ = (UniqueConstraint("level", "range_start", "range_end", "room_id", name="uq_summary_range"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    level: Mapped[str] = mapped_column(String(20))  # incremental|hourly|daily|custom
    range_start: Mapped[datetime] = mapped_column(DateTime, index=True)
    range_end: Mapped[datetime] = mapped_column(DateTime)
    room_id: Mapped[Optional[int]] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    model: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    utterance_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SummaryJob(Base):
    __tablename__ = "summary_jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    level: Mapped[str] = mapped_column(String(20))
    range_start: Mapped[datetime] = mapped_column(DateTime)
    range_end: Mapped[datetime] = mapped_column(DateTime)
    room_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)  # queued|running|done|failed
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    summary_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Todo(Base):
    __tablename__ = "todos"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open|done|dismissed
    assignee_speaker_id: Mapped[Optional[int]] = mapped_column(ForeignKey("speakers.id", ondelete="SET NULL"), nullable=True)
    due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    remind_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reminder_state: Mapped[str] = mapped_column(String(20), default="none")  # none|pending|fired|acked
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # auto|manual
    source_utterance_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    source_excerpt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)


class State(Base):
    """Internal key/value state (scheduler cursors etc.), not user-visible."""

    __tablename__ = "state"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)


class AuthRow(Base):
    __tablename__ = "auth"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class SessionRow(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Event(Base):
    """Cross-process event log backing the SSE stream."""

    __tablename__ = "events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
