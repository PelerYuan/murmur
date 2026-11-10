"""Request models and serializers. Serializers return plain dicts with ISO-8601 'Z' timestamps."""

from __future__ import annotations

import json
from typing import Optional

from pydantic import BaseModel, Field

from .deps import json_loads
from .models import Chunk, Recorder, Speaker, Summary, SummaryJob, Utterance
from .services.speakers import color_for, display_name
from .timeutil import iso


class RecorderConfig(BaseModel):
    enabled: bool = True
    device: Optional[str] = None
    gain_db: float = Field(0.0, ge=-30, le=60)
    vad_aggressiveness: int = Field(2, ge=0, le=3)
    min_speech_ms: int = Field(300, ge=50, le=10000)
    end_silence_ms: int = Field(1200, ge=200, le=10000)
    max_chunk_seconds: int = Field(60, ge=10, le=600)
    pre_roll_ms: int = Field(300, ge=0, le=2000)


def recorder_config(rec: Recorder) -> dict:
    return RecorderConfig.model_validate(json_loads(rec.config_json, {})).model_dump()


def serialize_recorder(rec: Recorder) -> dict:
    from .api.recorders import recorder_online

    return {
        "id": rec.id,
        "name": rec.name,
        "room_id": rec.room_id,
        "created_at": iso(rec.created_at),
        "last_seen": iso(rec.last_seen),
        "online": recorder_online(rec),
        "version": rec.version,
        "devices": json_loads(rec.devices_json, []),
        "status": json_loads(rec.status_json, {}),
        "config": recorder_config(rec),
    }


def serialize_chunk(c: Chunk) -> dict:
    return {
        "id": c.id,
        "recorder_id": c.recorder_id,
        "room_id": c.room_id,
        "started_at": iso(c.started_at),
        "duration": c.duration,
        "status": c.status,
        "attempts": c.attempts,
        "error": c.error,
        "utterance_count": c.utterance_count,
        "audio_deleted": c.audio_deleted,
    }


def serialize_utterance(u: Utterance, names: dict[int, str]) -> dict:
    return {
        "id": u.id,
        "chunk_id": u.chunk_id,
        "room_id": u.room_id,
        "started_at": iso(u.started_at),
        "ended_at": iso(u.ended_at),
        "text": u.text,
        "lang": u.lang,
        "speaker_id": u.speaker_id,
        "speaker_name": names.get(u.speaker_id) if u.speaker_id else None,
        "confidence": u.confidence,
        "text_edited": bool(u.text_edited),
    }


def serialize_speaker(sp: Speaker, stats: Optional[dict], samples: list, language: str, sample_texts: Optional[dict] = None) -> dict:
    stats = stats or {}
    sample_texts = sample_texts or {}
    return {
        "id": sp.id,
        "name": sp.name,
        "display_name": display_name(sp, language),
        "state": sp.state,
        "color": color_for(sp.id),
        "utterance_count": stats.get("utterance_count", 0),
        "total_seconds": stats.get("total_seconds", 0.0),
        "first_seen": iso(stats.get("first_seen")),
        "last_seen": iso(stats.get("last_seen")),
        "samples": [{"id": s.id, "duration": s.duration, "text": sample_texts.get(s.source_utterance_id)} for s in samples],
    }


def serialize_summary(sm: Summary) -> dict:
    from .services.summarizer import summary_event

    return summary_event(sm)


def serialize_job(job: SummaryJob) -> dict:
    return {
        "id": job.id,
        "level": job.level,
        "range_start": iso(job.range_start),
        "range_end": iso(job.range_end),
        "room_id": job.room_id,
        "status": job.status,
        "error": job.error,
        "summary_id": job.summary_id,
    }
