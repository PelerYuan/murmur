"""Endpoints used by the recorder process (Bearer recorder token)."""

import hashlib
import json
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, get_runtime, require_recorder
from ..models import Chunk, Recorder
from ..runtime import Runtime
from ..schemas import recorder_config
from ..timeutil import iso, parse_dt, utcnow
from ..wavutil import WavError, read_wav, wav_duration

router = APIRouter(prefix="/recorder", tags=["recorder"])


class Heartbeat(BaseModel):
    version: Optional[str] = None
    devices: list[dict] = Field(default_factory=list)
    status: dict = Field(default_factory=dict)


@router.post("/heartbeat")
def heartbeat(body: Heartbeat, rec: Recorder = Depends(require_recorder), db: Session = Depends(get_db)):
    rec.last_seen = utcnow()
    rec.version = body.version
    rec.devices_json = json.dumps(body.devices[:64])
    rec.status_json = json.dumps(body.status)
    return {"recorder_id": rec.id, "server_time": iso(utcnow()), "config": recorder_config(rec)}


@router.post("/chunks")
async def upload_chunk(
    response: Response,
    file: UploadFile = File(...),
    started_at: str = Form(...),
    duration: float = Form(...),
    sha256: str = Form(...),
    rec: Recorder = Depends(require_recorder),
    db: Session = Depends(get_db),
    rt: Runtime = Depends(get_runtime),
):
    data = await file.read()
    max_bytes = rt.config.max_upload_mb * 1024 * 1024
    if len(data) > max_bytes:
        raise ApiError(413, "chunk too large", "too_large")
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha256.lower():
        raise ApiError(422, "sha256 does not match the uploaded content", "checksum_mismatch")
    existing = db.query(Chunk).filter(Chunk.recorder_id == rec.id, Chunk.sha256 == actual).first()
    if existing is not None:
        response.status_code = 200
        return {"id": existing.id, "duplicate": True}
    try:
        samples, rate, channels = read_wav(data)
        real_duration = wav_duration(data)
    except WavError as exc:
        raise ApiError(400, str(exc), "bad_audio")
    if rate != 16000 or channels != 1:
        raise ApiError(400, f"expected 16 kHz mono WAV, got {rate} Hz / {channels} ch", "bad_audio")
    try:
        started = parse_dt(started_at)
    except ValueError:
        raise ApiError(422, "started_at must be ISO 8601", "bad_time")
    key = f"audio/{rec.id}/{started:%Y%m%d}/{uuid.uuid4().hex}.wav"
    rt.storage.put(key, data)
    chunk = Chunk(
        recorder_id=rec.id,
        room_id=rec.room_id,
        started_at=started,
        duration=real_duration if real_duration > 0 else duration,
        sha256=actual,
        storage_key=key,
        status="pending",
    )
    db.add(chunk)
    try:
        db.flush()
    except Exception:
        rt.storage.delete(key)
        raise
    response.status_code = 201
    return {"id": chunk.id, "duplicate": False}
