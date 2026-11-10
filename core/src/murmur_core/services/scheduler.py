"""Background scheduler: summary triggers, to-do extraction, reminders, maintenance."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func

from .. import events
from ..models import Chunk, Event, SessionRow, Speaker, SpeakerSample, SummaryJob, Summary, Utterance
from ..runtime import Runtime
from ..settings_store import AllSettings, read_state, write_state
from ..timeutil import get_tz, local_day_bounds, local_to_utc, to_local, utcnow
from . import llm_client, summarizer, todos as todo_svc
from .pipeline import recover_stale

log = logging.getLogger(__name__)

TICK_SECONDS = 20
MAINTENANCE_EVERY = timedelta(hours=1)


def safe_horizon(rt: Runtime, now: Optional[datetime] = None) -> datetime:
    """Don't summarize beyond audio that is still waiting to be transcribed."""
    with rt.scope() as s:
        oldest = s.query(func.min(Chunk.started_at)).filter(Chunk.status.in_(["pending", "processing"])).scalar()
    now = now or utcnow()
    return min(now, oldest) if oldest else now


class Scheduler:
    def __init__(self, rt: Runtime):
        self.rt = rt
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._last_todo_run: Optional[datetime] = None
        self._last_maintenance: Optional[datetime] = None

    def start(self) -> None:
        for name, target in (("scheduler", self._tick_loop), ("summary-jobs", self._job_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=5)

    def _job_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if summarizer.run_next_job(self.rt):
                    continue
            except Exception:
                log.exception("summary job loop")
            self._stop.wait(3)

    def _tick_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("scheduler tick failed")
            self._stop.wait(TICK_SECONDS)

    # ---- one scheduler pass (also called directly by tests) ----
    def tick(self, now: Optional[datetime] = None) -> None:
        now = now or utcnow()
        cfg = self.rt.load_settings()
        todo_svc.fire_due_reminders(self.rt)
        self._status_events()
        if llm_client.configured(cfg.llm):
            self._schedule_summaries(cfg, now)
            if cfg.todos.enabled and (
                self._last_todo_run is None or now - self._last_todo_run >= timedelta(minutes=cfg.todos.every_minutes)
            ):
                self._last_todo_run = now
                try:
                    todo_svc.extract_new_todos(self.rt)
                except Exception:
                    log.exception("to-do extraction")
        if self._last_maintenance is None or now - self._last_maintenance >= MAINTENANCE_EVERY:
            self._last_maintenance = now
            maintenance(self.rt, cfg, now)

    def _status_events(self) -> None:
        """Announce recorder online/offline flips so the UI updates without polling."""
        from ..api.recorders import recorder_online
        from ..models import Recorder

        with self.rt.scope() as s:
            for rec in s.query(Recorder).all():
                online = recorder_online(rec)
                key = f"recorder_online_{rec.id}"
                prev = read_state(s, key, None)
                if prev is None or prev != online:
                    write_state(s, key, online)
                    if prev is not None:
                        import json

                        status = json.loads(rec.status_json or "{}")
                        events.publish(s, "recorder.status", {"id": rec.id, "online": online, "state": status.get("state")})

    def _schedule_summaries(self, cfg: AllSettings, now: datetime) -> None:
        tz = get_tz(cfg.general.timezone)
        horizon = safe_horizon(self.rt, now)
        sch = cfg.schedule
        with self.rt.scope() as s:
            if sch.incremental.enabled or sch.idle.enabled:
                self._incremental(s, cfg, now, horizon)
            if sch.hourly.enabled:
                self._hourly(s, tz, now, horizon)
            if sch.daily.enabled:
                self._daily(s, cfg, tz, now, horizon)

    def _incremental(self, s, cfg: AllSettings, now: datetime, horizon: datetime) -> None:
        cursor_raw = read_state(s, "incremental_cursor", None)
        if cursor_raw is None:
            first = s.query(func.min(Utterance.started_at)).scalar()
            if first is None:
                return
            cursor = max(first, now - timedelta(hours=24))
        else:
            cursor = datetime.fromisoformat(cursor_raw)
        if horizon <= cursor:
            return
        count, last_at = (
            s.query(func.count(Utterance.id), func.max(Utterance.ended_at))
            .filter(Utterance.started_at >= cursor, Utterance.started_at < horizon)
            .one()
        )
        if not count:
            return
        due_by_interval = (
            cfg.schedule.incremental.enabled
            and horizon - cursor >= timedelta(minutes=cfg.schedule.incremental.every_minutes)
            and count >= cfg.schedule.incremental.min_utterances
        )
        due_by_idle = cfg.schedule.idle.enabled and last_at is not None and now - last_at >= timedelta(minutes=cfg.schedule.idle.idle_minutes)
        if due_by_interval or due_by_idle:
            summarizer.enqueue_job(s, "incremental", cursor, horizon)
            write_state(s, "incremental_cursor", horizon.isoformat())
        elif cursor_raw is None:
            write_state(s, "incremental_cursor", cursor.isoformat())

    def _hourly(self, s, tz, now: datetime, horizon: datetime) -> None:
        local_now = to_local(now, tz)
        top = local_now.replace(minute=0, second=0, microsecond=0)
        for back in range(1, 25):  # the last 24 completed local hours
            start_local = top - timedelta(hours=back)
            start, end = local_to_utc(start_local.replace(tzinfo=None), tz), local_to_utc(top.replace(tzinfo=None) - timedelta(hours=back - 1), tz)
            if end > horizon:
                continue
            if s.query(Summary).filter(Summary.level == "hourly", Summary.range_start == start, Summary.range_end == end).first():
                continue
            if s.query(SummaryJob).filter(SummaryJob.level == "hourly", SummaryJob.range_start == start, SummaryJob.status.in_(["queued", "running", "done"])).first():
                continue
            if s.query(func.count(Utterance.id)).filter(Utterance.started_at >= start, Utterance.started_at < end).scalar():
                summarizer.enqueue_job(s, "hourly", start, end)

    def _daily(self, s, cfg: AllSettings, tz, now: datetime, horizon: datetime) -> None:
        local_now = to_local(now, tz)
        hh, mm = (int(x) for x in cfg.schedule.daily.time.split(":"))
        if (local_now.hour, local_now.minute) < (hh, mm):
            return
        # Morning digests (before noon) cover yesterday; evening ones cover today.
        target = local_now.date() if hh >= 12 else local_now.date() - timedelta(days=1)
        key = f"daily_done_{target.isoformat()}"
        if read_state(s, key, False):
            return
        start, end = local_day_bounds(target, tz)
        if s.query(func.count(Utterance.id)).filter(Utterance.started_at >= start, Utterance.started_at < end).scalar():
            summarizer.enqueue_job(s, "daily", start, end)
        write_state(s, key, True)


def maintenance(rt: Runtime, cfg: AllSettings, now: datetime) -> None:
    """Housekeeping: retention, stale rows, tiny junk speakers."""
    recover_stale(rt)
    with rt.scope() as s:
        events.prune(s)
        s.query(SessionRow).filter(SessionRow.expires_at < now).delete()
        if cfg.retention.utterance_embedding_days:
            cutoff = now - timedelta(days=cfg.retention.utterance_embedding_days)
            s.query(Utterance).filter(Utterance.started_at < cutoff, Utterance.embedding.is_not(None)).update({Utterance.embedding: None})
        # Failed chunks keep their audio for inspection, but not forever.
        if cfg.retention.failed_audio_days:
            cutoff = now - timedelta(days=cfg.retention.failed_audio_days)
            old = s.query(Chunk).filter(Chunk.status == "failed", Chunk.audio_deleted.is_(False), Chunk.created_at < cutoff).all()
            for chunk in old:
                try:
                    rt.storage.delete(chunk.storage_key)
                    chunk.audio_deleted = True
                except Exception:
                    log.exception("could not delete audio of failed chunk %s", chunk.id)
        # Clusters that never grew: 1-2 stray utterances older than 2 days that nobody named.
        stale = now - timedelta(days=2)
        tiny = (
            s.query(Speaker.id)
            .outerjoin(Utterance, Utterance.speaker_id == Speaker.id)
            .filter(Speaker.state == "unnamed", Speaker.created_at < stale)
            .group_by(Speaker.id)
            .having(func.count(Utterance.id) < 3)
            .all()
        )
        if tiny:
            from .speakers import delete_speaker

            for (sid,) in tiny:
                sp = s.get(Speaker, sid)
                if sp:
                    delete_speaker(s, sp, rt.storage)
            log.info("maintenance: removed %d tiny unnamed speaker clusters", len(tiny))
