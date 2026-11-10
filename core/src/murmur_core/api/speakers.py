from typing import Optional

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..deps import ApiError, get_db, get_runtime, require_user
from ..models import Speaker, SpeakerSample, Utterance
from ..runtime import Runtime
from ..schemas import serialize_speaker
from ..services import speakers as svc

router = APIRouter(prefix="/speakers", tags=["speakers"], dependencies=[Depends(require_user)])


def _get(db: Session, speaker_id: int) -> Speaker:
    sp = db.get(Speaker, speaker_id)
    if sp is None:
        raise ApiError(404, "speaker not found", "not_found")
    return sp


def _sample_texts(db: Session, samples: list) -> dict[int, str]:
    ids = [s.source_utterance_id for s in samples if s.source_utterance_id]
    if not ids:
        return {}
    return {uid: text for uid, text in db.query(Utterance.id, Utterance.text).filter(Utterance.id.in_(ids)).all()}


def _out(db: Session, rt: Runtime, sp: Speaker) -> dict:
    lang = rt.settings.get(db).general.ui_language
    samples = db.query(SpeakerSample).filter(SpeakerSample.speaker_id == sp.id).order_by(SpeakerSample.id).all()
    return serialize_speaker(sp, svc.speaker_stats(db, [sp.id]).get(sp.id), samples, lang, _sample_texts(db, samples))


@router.get("")
def list_speakers(state: Optional[str] = Query(None, pattern="^(unnamed|named|ignored)$"), db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    q = db.query(Speaker)
    if state:
        q = q.filter(Speaker.state == state)
    speakers = q.order_by(Speaker.id).all()
    lang = rt.settings.get(db).general.ui_language
    stats = svc.speaker_stats(db, [s.id for s in speakers]) if speakers else {}
    samples: dict[int, list] = {}
    for sample in db.query(SpeakerSample).filter(SpeakerSample.speaker_id.in_([s.id for s in speakers] or [-1])).order_by(SpeakerSample.id):
        samples.setdefault(sample.speaker_id, []).append(sample)
    texts = _sample_texts(db, [s for group in samples.values() for s in group])
    return [serialize_speaker(sp, stats.get(sp.id), samples.get(sp.id, []), lang, texts) for sp in speakers]


@router.get("/{speaker_id}")
def get_speaker(speaker_id: int, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    return _out(db, rt, _get(db, speaker_id))


class SpeakerPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    state: Optional[str] = Field(default=None, pattern="^(unnamed|named|ignored)$")


@router.patch("/{speaker_id}")
def patch_speaker(speaker_id: int, body: SpeakerPatch, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    sp = _get(db, speaker_id)
    fields = body.model_fields_set
    if "name" in fields:
        name = (body.name or "").strip()
        sp.name = name or None
        if name and "state" not in fields and sp.state == "unnamed":
            sp.state = "named"
        if not name and "state" not in fields and sp.state == "named":
            sp.state = "unnamed"
    if "state" in fields and body.state:
        if body.state == "named" and not sp.name:
            raise ApiError(422, "give the speaker a name first", "name_required")
        sp.state = body.state
    if sp.state == "ignored":
        # Ignored voices keep no audio samples around.
        for sample in db.query(SpeakerSample).filter(SpeakerSample.speaker_id == sp.id).all():
            rt.storage.delete(sample.storage_key)
            db.delete(sample)
    db.flush()
    return _out(db, rt, sp)


class MergeIn(BaseModel):
    into_id: int


@router.post("/{speaker_id}/merge")
def merge(speaker_id: int, body: MergeIn, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    src, dst = _get(db, speaker_id), _get(db, body.into_id)
    if src.id == dst.id:
        raise ApiError(422, "cannot merge a speaker into itself", "bad_merge")
    keep = rt.settings.get(db).speakers.sample_count
    merged = svc.merge_speakers(db, src, dst, rt.storage, keep)
    return _out(db, rt, merged)


class SplitIn(BaseModel):
    utterance_ids: list[int] = Field(min_length=1)


@router.post("/{speaker_id}/split", status_code=201)
def split(speaker_id: int, body: SplitIn, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    sp = _get(db, speaker_id)
    owned = db.query(Utterance.id).filter(Utterance.id.in_(body.utterance_ids), Utterance.speaker_id == sp.id).count()
    if owned != len(set(body.utterance_ids)):
        raise ApiError(422, "all utterances must belong to this speaker", "bad_split")
    new = svc.split_speaker(db, sp, body.utterance_ids)
    return _out(db, rt, new)


@router.delete("/{speaker_id}", status_code=204)
def delete(speaker_id: int, delete_utterances: bool = False, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    """`delete_utterances=true` is an addition to the contract: also removes everything this voice said (e.g. the TV)."""
    sp = _get(db, speaker_id)
    svc.delete_speaker(db, sp, rt.storage, delete_utterances)


@router.get("/{speaker_id}/samples/{sample_id}/audio")
def sample_audio(speaker_id: int, sample_id: int, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    sample = db.get(SpeakerSample, sample_id)
    if sample is None or sample.speaker_id != speaker_id:
        raise ApiError(404, "sample not found", "not_found")
    try:
        data = rt.storage.get(sample.storage_key)
    except Exception:
        raise ApiError(404, "sample audio is missing", "not_found")
    return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})
