from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, json_loads, require_user
from ..models import Recorder, Room
from ..schemas import RecorderConfig, serialize_recorder
from ..security import hash_token, new_token
from ..timeutil import iso, utcnow

router = APIRouter(tags=["rooms & recorders"], dependencies=[Depends(require_user)])

ONLINE_WINDOW = timedelta(seconds=30)


def recorder_online(rec: Recorder) -> bool:
    return rec.last_seen is not None and utcnow() - rec.last_seen <= ONLINE_WINDOW


def _room(r: Room) -> dict:
    return {"id": r.id, "name": r.name, "created_at": iso(r.created_at)}


class RoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class RoomPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)


@router.get("/rooms")
def list_rooms(db: Session = Depends(get_db)):
    return [_room(r) for r in db.query(Room).order_by(Room.id)]


@router.post("/rooms", status_code=201)
def create_room(body: RoomIn, db: Session = Depends(get_db)):
    room = Room(name=body.name.strip())
    db.add(room)
    db.flush()
    return _room(room)


@router.patch("/rooms/{room_id}")
def patch_room(room_id: int, body: RoomPatch, db: Session = Depends(get_db)):
    room = db.get(Room, room_id)
    if room is None:
        raise ApiError(404, "room not found", "not_found")
    if body.name is not None:
        room.name = body.name.strip()
    return _room(room)


@router.delete("/rooms/{room_id}", status_code=204)
def delete_room(room_id: int, db: Session = Depends(get_db)):
    room = db.get(Room, room_id)
    if room is None:
        raise ApiError(404, "room not found", "not_found")
    db.delete(room)


class RecorderIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    room_id: Optional[int] = None


class RecorderPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    room_id: Optional[int] = None
    config: Optional[dict] = None
    model_config = {"extra": "forbid"}


def _check_room(db: Session, room_id: Optional[int]) -> None:
    if room_id is not None and db.get(Room, room_id) is None:
        raise ApiError(422, "room does not exist", "bad_room")


@router.get("/recorders")
def list_recorders(db: Session = Depends(get_db)):
    return [serialize_recorder(r) for r in db.query(Recorder).order_by(Recorder.id)]


@router.post("/recorders", status_code=201)
def create_recorder(body: RecorderIn, db: Session = Depends(get_db)):
    _check_room(db, body.room_id)
    token = new_token("mrm_")
    rec = Recorder(name=body.name.strip(), room_id=body.room_id, token_hash=hash_token(token))
    db.add(rec)
    db.flush()
    out = serialize_recorder(rec)
    out["token"] = token
    return out


@router.patch("/recorders/{recorder_id}")
def patch_recorder(recorder_id: int, body: RecorderPatch, db: Session = Depends(get_db)):
    import json

    rec = db.get(Recorder, recorder_id)
    if rec is None:
        raise ApiError(404, "recorder not found", "not_found")
    fields = body.model_fields_set
    if "name" in fields and body.name:
        rec.name = body.name.strip()
    if "room_id" in fields:
        _check_room(db, body.room_id)
        rec.room_id = body.room_id
    if body.config is not None:
        merged = {**json_loads(rec.config_json, {}), **body.config}
        rec.config_json = RecorderConfig.model_validate(merged).model_dump_json()
    return serialize_recorder(rec)


@router.post("/recorders/{recorder_id}/rotate-token")
def rotate_token(recorder_id: int, db: Session = Depends(get_db)):
    rec = db.get(Recorder, recorder_id)
    if rec is None:
        raise ApiError(404, "recorder not found", "not_found")
    token = new_token("mrm_")
    rec.token_hash = hash_token(token)
    return {"token": token}


@router.delete("/recorders/{recorder_id}", status_code=204)
def delete_recorder(recorder_id: int, db: Session = Depends(get_db)):
    rec = db.get(Recorder, recorder_id)
    if rec is None:
        raise ApiError(404, "recorder not found", "not_found")
    db.delete(rec)
