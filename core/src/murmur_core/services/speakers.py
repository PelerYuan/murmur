"""Speaker identity: matching embeddings to known voices, clustering new ones, merge/split, audio samples."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Speaker, SpeakerSample, Utterance
from ..settings_store import Speakers as SpeakerSettings
from ..storage import Storage
from ..timeutil import utcnow
from ..wavutil import WavError, cut_wav

log = logging.getLogger(__name__)

CENTROID_WEIGHT_CAP = 50  # keeps centroids adaptive instead of freezing after many utterances
MIN_NEW_SPEAKER_SECONDS = 1.5  # shorter utterances are matched but never found a new speaker
RECOMPUTE_LIMIT = 300

PALETTE = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
    "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#a855f7",
]


def color_for(speaker_id: int) -> str:
    return PALETTE[speaker_id % len(PALETTE)]


def display_name(speaker: Speaker, language: str = "zh") -> str:
    if speaker.name:
        return speaker.name
    return f"说话人 {speaker.id}" if language.startswith("zh") else f"Speaker {speaker.id}"


def pack(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype="<f4").tobytes()


def unpack(blob: Optional[bytes]) -> Optional[np.ndarray]:
    if not blob:
        return None
    return np.frombuffer(blob, dtype="<f4").copy()


def normalize(vec) -> Optional[np.ndarray]:
    v = np.asarray(vec, dtype=np.float32)
    n = float(np.linalg.norm(v))
    if n < 1e-9 or not np.isfinite(n):
        return None
    return v / n


@dataclass
class _Candidate:
    speaker_id: int
    state: str
    centroid: np.ndarray
    count: int


class SpeakerMatcher:
    """Assigns utterance embeddings to speakers inside one DB transaction.

    Keeps the centroid table in memory while a chunk is processed so utterances from the same new
    voice in one chunk converge on one new speaker instead of creating several.
    """

    def __init__(self, session: Session, cfg: SpeakerSettings):
        self.session = session
        self.cfg = cfg
        self.candidates: dict[int, _Candidate] = {}
        for sp in session.query(Speaker).filter(Speaker.centroid.is_not(None)).all():
            vec = unpack(sp.centroid)
            if vec is not None:
                self.candidates[sp.id] = _Candidate(sp.id, sp.state, vec, sp.embedding_count)

    def _threshold(self, state: str) -> float:
        return self.cfg.cluster_threshold if state == "unnamed" else self.cfg.match_threshold

    def assign(self, embedding: Optional[list[float]], duration: float) -> tuple[Optional[Speaker], Optional[np.ndarray]]:
        """Returns (speaker or None, normalized embedding)."""
        emb = normalize(embedding) if embedding else None
        if emb is None:
            return None, None
        best_id, best_score, best_loose = None, -1.0, -1.0
        loose_id = None
        for cand in self.candidates.values():
            if cand.centroid.shape != emb.shape:
                continue  # embeddings from a different model: not comparable
            score = float(np.dot(cand.centroid, emb))
            thr = self._threshold(cand.state)
            if score >= thr and score > best_score:
                best_id, best_score = cand.speaker_id, score
            if score > best_loose:
                best_loose, loose_id = score, cand.speaker_id
        if best_id is None and duration < MIN_NEW_SPEAKER_SECONDS and loose_id is not None:
            # Short utterance: accept a slightly weaker match rather than minting a new speaker.
            thr = self._threshold(self.candidates[loose_id].state) - 0.1
            if best_loose >= thr:
                best_id = loose_id
        if best_id is not None:
            speaker = self.session.get(Speaker, best_id)
            self._update(speaker, emb)
            return speaker, emb
        if duration < MIN_NEW_SPEAKER_SECONDS or duration < self.cfg.min_utterance_seconds:
            return None, emb
        speaker = Speaker(state="unnamed", centroid=pack(emb), embedding_count=1)
        self.session.add(speaker)
        self.session.flush()
        self.candidates[speaker.id] = _Candidate(speaker.id, "unnamed", emb, 1)
        return speaker, emb

    def _update(self, speaker: Speaker, emb: np.ndarray) -> None:
        cand = self.candidates[speaker.id]
        weight = min(cand.count, CENTROID_WEIGHT_CAP)
        merged = normalize(cand.centroid * weight + emb) if weight else emb
        cand.centroid = merged if merged is not None else cand.centroid
        cand.count += 1
        speaker.centroid = pack(cand.centroid)
        speaker.embedding_count = cand.count


def recompute_centroid(session: Session, speaker: Speaker) -> None:
    rows = (
        session.query(Utterance.embedding)
        .filter(Utterance.speaker_id == speaker.id, Utterance.embedding.is_not(None))
        .order_by(Utterance.started_at.desc())
        .limit(RECOMPUTE_LIMIT)
        .all()
    )
    vecs = [normalize(unpack(r[0])) for r in rows]
    vecs = [v for v in vecs if v is not None]
    if vecs:
        dims = {v.shape for v in vecs}
        target = max(dims, key=lambda d: sum(1 for v in vecs if v.shape == d))
        vecs = [v for v in vecs if v.shape == target]
        speaker.centroid = pack(normalize(np.mean(vecs, axis=0)))
        speaker.embedding_count = len(vecs)
    speaker.updated_at = utcnow()


def merge_speakers(session: Session, src: Speaker, dst: Speaker, storage: Storage, keep_samples: int) -> Speaker:
    if src.id == dst.id:
        return dst
    session.query(Utterance).filter(Utterance.speaker_id == src.id).update({Utterance.speaker_id: dst.id})
    session.query(SpeakerSample).filter(SpeakerSample.speaker_id == src.id).update({SpeakerSample.speaker_id: dst.id})
    session.flush()
    if not dst.name and src.name:
        dst.name, dst.state = src.name, "named" if src.state != "ignored" else "ignored"
    elif dst.state == "unnamed" and src.state == "ignored":
        dst.state = "ignored"
    src_vec, dst_vec = unpack(src.centroid), unpack(dst.centroid)
    recompute_centroid(session, dst)
    if dst.centroid is None or (dst.embedding_count == 0):
        # No stored per-utterance embeddings (purged): fall back to a weighted centroid blend.
        if src_vec is not None and dst_vec is not None and src_vec.shape == dst_vec.shape:
            blended = normalize(src_vec * max(src.embedding_count, 1) + dst_vec * max(dst.embedding_count, 1))
            if blended is not None:
                dst.centroid = pack(blended)
        elif src_vec is not None and dst_vec is None:
            dst.centroid = src.centroid
        dst.embedding_count = (src.embedding_count or 0) + (dst.embedding_count or 0)
    trim_samples(session, dst.id, storage, max(keep_samples * 2, 1))
    session.query(Speaker).filter(Speaker.id == src.id).delete()
    session.flush()
    return dst


def split_speaker(session: Session, speaker: Speaker, utterance_ids: list[int]) -> Speaker:
    new = Speaker(state="unnamed")
    session.add(new)
    session.flush()
    session.query(Utterance).filter(Utterance.id.in_(utterance_ids), Utterance.speaker_id == speaker.id).update(
        {Utterance.speaker_id: new.id}, synchronize_session=False
    )
    session.query(SpeakerSample).filter(
        SpeakerSample.speaker_id == speaker.id, SpeakerSample.source_utterance_id.in_(utterance_ids)
    ).update({SpeakerSample.speaker_id: new.id}, synchronize_session=False)
    session.flush()
    recompute_centroid(session, new)
    recompute_centroid(session, speaker)
    return new


def delete_speaker(session: Session, speaker: Speaker, storage: Storage, delete_utterances: bool = False) -> None:
    for sample in session.query(SpeakerSample).filter(SpeakerSample.speaker_id == speaker.id).all():
        storage.delete(sample.storage_key)
    session.query(SpeakerSample).filter(SpeakerSample.speaker_id == speaker.id).delete()
    if delete_utterances:
        session.query(Utterance).filter(Utterance.speaker_id == speaker.id).delete()
    else:
        session.query(Utterance).filter(Utterance.speaker_id == speaker.id).update({Utterance.speaker_id: None})
    session.query(Speaker).filter(Speaker.id == speaker.id).delete()
    session.flush()


def trim_samples(session: Session, speaker_id: int, storage: Storage, keep: int) -> None:
    samples = (
        session.query(SpeakerSample).filter(SpeakerSample.speaker_id == speaker_id).order_by(SpeakerSample.created_at.desc()).all()
    )
    for sample in samples[keep:]:
        storage.delete(sample.storage_key)
        session.delete(sample)
    session.flush()


def maybe_add_sample(
    session: Session,
    storage: Storage,
    cfg: SpeakerSettings,
    speaker: Speaker,
    utterance: Utterance,
    wav: bytes,
    start: float,
    end: float,
    min_gap_seconds: float = 300.0,
) -> bool:
    """Keeps a few short clips per speaker so a human can listen and judge who is who.

    Samples are spread over time (one per 5 minutes at most) so they cover the voice in different conditions.
    """
    if cfg.sample_count <= 0 or speaker.state == "ignored":
        return False
    existing = session.query(SpeakerSample).filter(SpeakerSample.speaker_id == speaker.id).all()
    if len(existing) >= cfg.sample_count:
        return False
    length = min(end - start, cfg.sample_seconds)
    if length < 1.5:
        return False
    for sample in existing:
        src = session.get(Utterance, sample.source_utterance_id) if sample.source_utterance_id else None
        if src is not None and abs((src.started_at - utterance.started_at).total_seconds()) < min_gap_seconds:
            return False
    try:
        clip = cut_wav(wav, start, start + length)
    except WavError:
        return False
    key = f"samples/{speaker.id}/{uuid.uuid4().hex}.wav"
    storage.put(key, clip)
    session.add(SpeakerSample(speaker_id=speaker.id, storage_key=key, duration=length, source_utterance_id=utterance.id))
    session.flush()
    return True


def speaker_stats(session: Session, speaker_ids: Optional[list[int]] = None) -> dict[int, dict]:
    q = session.query(
        Utterance.speaker_id,
        func.count(Utterance.id),
        func.coalesce(func.sum((func.julianday(Utterance.ended_at) - func.julianday(Utterance.started_at)) * 86400.0), 0.0)
        if session.bind.dialect.name == "sqlite"
        else func.count(Utterance.id) * 0.0,
        func.min(Utterance.started_at),
        func.max(Utterance.started_at),
    ).filter(Utterance.speaker_id.is_not(None))
    if speaker_ids is not None:
        q = q.filter(Utterance.speaker_id.in_(speaker_ids))
    out = {}
    for sid, count, seconds, first, last in q.group_by(Utterance.speaker_id).all():
        out[sid] = {"utterance_count": count, "total_seconds": round(float(seconds or 0.0), 1), "first_seen": first, "last_seen": last}
    return out
