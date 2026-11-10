"""Chunk transcription pipeline: claim a chunk, transcribe, filter, assign speakers, store, then delete audio."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from datetime import timedelta
from typing import Optional

from sqlalchemy import update

from .. import events
from ..models import Chunk, Utterance
from ..runtime import Runtime
from ..timeutil import iso, utcnow
from . import asr_client, speakers as speaker_svc
from .filters import apply_filters

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
BACKOFF_SECONDS = [15, 60, 240, 900, 1800]
STALE_PROCESSING_MINUTES = 15

# Speaker assignment mutates shared centroids; serialize it across worker threads in this process.
_speaker_lock = threading.Lock()


def claim_next_chunk(rt: Runtime) -> Optional[int]:
    """Atomically move the oldest due pending chunk to 'processing'. Returns its id."""
    with rt.scope() as s:
        now = utcnow()
        candidate = (
            s.query(Chunk.id)
            .filter(Chunk.status == "pending", (Chunk.next_attempt_at.is_(None)) | (Chunk.next_attempt_at <= now))
            .order_by(Chunk.started_at)
            .first()
        )
        if candidate is None:
            return None
        res = s.execute(
            update(Chunk)
            .where(Chunk.id == candidate[0], Chunk.status == "pending")
            .values(status="processing", attempts=Chunk.attempts + 1, error=None, next_attempt_at=now)
        )
        if res.rowcount != 1:
            return None
        return candidate[0]


def recover_stale(rt: Runtime) -> int:
    """Chunks stuck in 'processing' (crashed worker) go back to pending."""
    with rt.scope() as s:
        cutoff = utcnow() - timedelta(minutes=STALE_PROCESSING_MINUTES)
        res = s.execute(
            update(Chunk)
            .where(Chunk.status == "processing", Chunk.next_attempt_at < cutoff)  # next_attempt_at doubles as claim time
            .values(status="pending")
        )
        return res.rowcount or 0


def process_chunk(rt: Runtime, chunk_id: int) -> str:
    """Runs one claimed chunk to completion. Returns the final status."""
    cfg = rt.load_settings()
    with rt.scope() as s:
        chunk = s.get(Chunk, chunk_id)
        key, expected_sha, started_at, room_id, attempts = chunk.storage_key, chunk.sha256, chunk.started_at, chunk.room_id, chunk.attempts

    try:
        wav = rt.storage.get(key)
    except Exception as exc:
        return _fail(rt, chunk_id, f"audio missing from storage: {exc}", permanent=True)
    if hashlib.sha256(wav).hexdigest() != expected_sha:
        return _fail(rt, chunk_id, "audio failed integrity check (sha256 mismatch)", permanent=True)

    t0 = time.monotonic()
    try:
        result = asr_client.transcribe(cfg.asr, wav, transport=rt.asr_transport)
    except asr_client.AsrError as exc:
        return _fail(rt, chunk_id, str(exc), permanent=not exc.retryable, attempts=attempts)
    except Exception as exc:  # never let one bad chunk kill the worker
        log.exception("unexpected error transcribing chunk %s", chunk_id)
        return _fail(rt, chunk_id, f"unexpected error: {exc}", attempts=attempts)
    asr_seconds = time.monotonic() - t0

    kept, dropped = apply_filters(result.utterances, cfg.filters)

    with _speaker_lock, rt.scope() as s:
        matcher = speaker_svc.SpeakerMatcher(s, cfg.speakers)
        stored: list[Utterance] = []
        ignored = 0
        touched: dict[int, list[tuple[Utterance, float, float]]] = {}
        for raw in sorted(kept, key=lambda u: u.start):
            duration = max(raw.end - raw.start, 0.0)
            speaker, emb = matcher.assign(raw.embedding, duration)
            if speaker is not None and speaker.state == "ignored":
                ignored += 1
                continue
            utt = Utterance(
                chunk_id=chunk_id,
                room_id=room_id,
                started_at=started_at + timedelta(seconds=raw.start),
                ended_at=started_at + timedelta(seconds=raw.end),
                text=raw.text,
                lang=raw.lang,
                speaker_id=speaker.id if speaker else None,
                confidence=raw.speech_prob,
                embedding=speaker_svc.pack(emb) if emb is not None else None,
            )
            s.add(utt)
            stored.append(utt)
            if speaker is not None:
                touched.setdefault(speaker.id, []).append((utt, raw.start, raw.end))
        s.flush()
        for speaker_id, items in touched.items():
            speaker = s.get(speaker_svc.Speaker, speaker_id)
            for utt, start, end in sorted(items, key=lambda i: i[2] - i[1], reverse=True):
                if speaker_svc.maybe_add_sample(s, rt.storage, cfg.speakers, speaker, utt, wav, start, end):
                    pass
        chunk = s.get(Chunk, chunk_id)
        chunk.utterance_count = len(stored)
        chunk.status = "done" if stored else "skipped"
        chunk.processed_at = utcnow()
        chunk.error = None
        if stored:
            events.publish(s, "utterances.new", {"count": len(stored), "chunk_id": chunk_id})
        count = len(stored)
        status = chunk.status

    log.info(
        "chunk %s: %s utterances kept (dropped %s, ignored %s) asr=%.1fs", chunk_id, count, sum(dropped.values()), ignored, asr_seconds
    )

    if cfg.retention.delete_audio_after_transcribe:
        _delete_audio(rt, chunk_id, key, expected_count=count)
    return status


def _delete_audio(rt: Runtime, chunk_id: int, key: str, expected_count: int) -> None:
    """Delete the raw audio only once the results are verifiably committed."""
    with rt.scope() as s:
        chunk = s.get(Chunk, chunk_id)
        stored = s.query(Utterance).filter(Utterance.chunk_id == chunk_id).count()
        if chunk is None or chunk.status not in ("done", "skipped") or stored != expected_count:
            log.warning("chunk %s: not deleting audio, committed state does not match", chunk_id)
            return
        try:
            rt.storage.delete(key)
        except Exception:
            log.exception("chunk %s: failed to delete audio %s", chunk_id, key)
            return
        chunk.audio_deleted = True


def _fail(rt: Runtime, chunk_id: int, message: str, permanent: bool = False, attempts: int = 0) -> str:
    with rt.scope() as s:
        chunk = s.get(Chunk, chunk_id)
        chunk.error = message[:1000]
        if permanent or chunk.attempts >= MAX_ATTEMPTS:
            chunk.status = "failed"
            chunk.processed_at = utcnow()
            log.error("chunk %s failed: %s", chunk_id, message)
        else:
            delay = BACKOFF_SECONDS[min(chunk.attempts - 1, len(BACKOFF_SECONDS) - 1)]
            chunk.status = "pending"
            chunk.next_attempt_at = utcnow() + timedelta(seconds=delay)
            log.warning("chunk %s attempt %s failed (%s); retry in %ss", chunk_id, chunk.attempts, message, delay)
        return chunk.status


class PipelineWorker:
    """Pool of threads that drain pending chunks."""

    def __init__(self, rt: Runtime, idle_sleep: float = 1.0):
        self.rt = rt
        self.idle_sleep = idle_sleep
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self, concurrency: Optional[int] = None) -> None:
        recover_stale(self.rt)
        n = concurrency or self.rt.load_settings().asr.concurrency
        for i in range(n):
            t = threading.Thread(target=self._loop, name=f"pipeline-{i}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                chunk_id = claim_next_chunk(self.rt)
            except Exception:
                log.exception("claiming chunk failed")
                self._stop.wait(self.idle_sleep * 3)
                continue
            if chunk_id is None:
                self._stop.wait(self.idle_sleep)
                continue
            try:
                process_chunk(self.rt, chunk_id)
            except Exception:
                log.exception("chunk %s crashed", chunk_id)
                try:
                    _fail(self.rt, chunk_id, "internal error, see server log")
                except Exception:
                    log.exception("could not record failure for chunk %s", chunk_id)

    def run_until_idle(self, timeout: float = 60.0) -> int:
        """Synchronous helper for tests/CLI: process everything that is due, then return the count."""
        done = 0
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            chunk_id = claim_next_chunk(self.rt)
            if chunk_id is None:
                break
            process_chunk(self.rt, chunk_id)
            done += 1
        return done
