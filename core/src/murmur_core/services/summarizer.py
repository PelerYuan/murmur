"""Builds readable transcripts and turns them into summaries via the configured LLM."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from .. import events
from ..models import Room, Speaker, Summary, SummaryJob, Todo, Utterance
from ..runtime import Runtime
from ..settings_store import AllSettings
from ..timeutil import get_tz, iso, to_local, utcnow
from . import llm_client, prompts
from .speakers import display_name

log = logging.getLogger(__name__)

LEVEL_LABELS_ZH = {"incremental": "增量摘要", "hourly": "小时摘要", "daily": "日报", "custom": "自定义摘要"}
LEVEL_LABELS_EN = {"incremental": "Update", "hourly": "Hourly summary", "daily": "Daily digest", "custom": "Summary"}


class NothingToSummarize(Exception):
    pass


def speaker_names(session: Session, language: str) -> dict[int, str]:
    return {sp.id: display_name(sp, language) for sp in session.query(Speaker).all()}


def format_transcript(session: Session, utterances: list[Utterance], cfg: AllSettings) -> str:
    tz = get_tz(cfg.general.timezone)
    names = speaker_names(session, cfg.general.ui_language)
    rooms = {r.id: r.name for r in session.query(Room).all()}
    multi_room = len({u.room_id for u in utterances}) > 1
    unknown = "未知说话人" if cfg.general.ui_language.startswith("zh") else "Unknown speaker"
    lines = []
    prev_day = None
    for u in utterances:
        local = to_local(u.started_at, tz)
        stamp = local.strftime("%H:%M:%S")
        if prev_day is None or local.date() != prev_day:
            stamp = local.strftime("%Y-%m-%d %H:%M:%S")
            prev_day = local.date()
        where = f" {rooms.get(u.room_id, '')}" if multi_room and u.room_id in rooms else ""
        who = names.get(u.speaker_id, unknown) if u.speaker_id else unknown
        lines.append(f"[{stamp}{where}] {who}: {u.text}")
    return "\n".join(lines)


def split_blocks(lines: list[str], max_chars: int) -> list[str]:
    blocks, current, size = [], [], 0
    for line in lines:
        if current and size + len(line) + 1 > max_chars:
            blocks.append("\n".join(current))
            current, size = [], 0
        while len(line) > max_chars:  # pathological single line
            blocks.append(line[:max_chars])
            line = line[max_chars:]
        current.append(line)
        size += len(line) + 1
    if current:
        blocks.append("\n".join(current))
    return blocks


def _range_label(start: datetime, end: datetime, tz) -> tuple[str, str]:
    return to_local(start, tz).strftime("%Y-%m-%d %H:%M"), to_local(end, tz).strftime("%Y-%m-%d %H:%M")


def make_title(level: str, start: datetime, end: datetime, cfg: AllSettings) -> str:
    tz = get_tz(cfg.general.timezone)
    zh = cfg.general.ui_language.startswith("zh")
    label = (LEVEL_LABELS_ZH if zh else LEVEL_LABELS_EN)[level]
    s, e = to_local(start, tz), to_local(end, tz)
    if level == "daily":
        return f"{s.strftime('%Y-%m-%d')} {label}"
    if s.date() == e.date() or (e - s).days == 0:
        return f"{s.strftime('%m-%d %H:%M')}–{e.strftime('%H:%M')} {label}"
    return f"{s.strftime('%m-%d %H:%M')} – {e.strftime('%m-%d %H:%M')} {label}"


def _chat(cfg: AllSettings, prompt: str, rt: Runtime) -> str:
    return llm_client.chat(
        cfg.llm,
        [
            {"role": "system", "content": "You are a precise, faithful summarizer. Never invent facts."},
            {"role": "user", "content": prompt},
        ],
        transport=rt.llm_transport,
    )


def generate_summary(rt: Runtime, level: str, start: datetime, end: datetime, room_id: Optional[int] = None) -> Optional[int]:
    """Generate (or regenerate) the summary for a range. Returns the summary id, or None if there was no content."""
    cfg = rt.load_settings()
    if not llm_client.configured(cfg.llm):
        raise llm_client.LlmNotConfigured("LLM is not configured: set base URL and model in Settings")
    tz = get_tz(cfg.general.timezone)
    lang = cfg.general.output_language

    with rt.scope() as s:
        q = s.query(Utterance).filter(Utterance.started_at >= start, Utterance.started_at < end)
        if room_id is not None:
            q = q.filter(Utterance.room_id == room_id)
        utterances = q.order_by(Utterance.started_at, Utterance.id).all()
        if not utterances:
            return None
        transcript = format_transcript(s, utterances, cfg)
        room_names = sorted({r.name for r in s.query(Room).filter(Room.id.in_({u.room_id for u in utterances if u.room_id})).all()})
        todos_text = ""
        if level == "daily":
            todos = s.query(Todo).filter(Todo.created_at >= start, Todo.created_at < end, Todo.status != "dismissed").all()
            todos_text = "\n".join(f"- {t.text}" for t in todos) or ("（无）" if lang.startswith("zh") else "(none)")
        count = len(utterances)

    start_s, end_s = _range_label(start, end, tz)
    values = dict(
        start=start_s,
        end=end_s,
        rooms=", ".join(room_names) or ("未指定" if lang.startswith("zh") else "unspecified"),
        language=prompts.language_name(lang),
        todos=todos_text,
    )
    kind = "daily" if level == "daily" else "summary"
    template = getattr(cfg.llm.prompts, kind) or prompts.default_prompt(kind, lang)

    blocks = split_blocks(transcript.split("\n"), cfg.llm.max_input_chars)
    if len(blocks) == 1:
        content = _chat(cfg, prompts.render(template, transcript=blocks[0], **values), rt)
    else:
        log.info("summary %s %s-%s: map-reduce over %d blocks", level, start_s, end_s, len(blocks))
        partials = []
        for i, block in enumerate(blocks, 1):
            part_values = dict(values)
            partials.append(f"### Part {i}/{len(blocks)}\n" + _chat(cfg, prompts.render(template, transcript=block, **part_values), rt))
        reduce_template = prompts.default_prompt("reduce", lang)
        merged_input = "\n\n".join(partials)
        content = _chat(cfg, prompts.render(reduce_template, transcript=merged_input, **values), rt)

    content = content.strip()
    if not content:
        raise llm_client.LlmError("LLM returned an empty summary")

    with rt.scope() as s:
        existing = (
            s.query(Summary)
            .filter(Summary.level == level, Summary.range_start == start, Summary.range_end == end, Summary.room_id.is_(None) if room_id is None else Summary.room_id == room_id)
            .first()
        )
        title = make_title(level, start, end, cfg)
        if existing is None:
            existing = Summary(level=level, range_start=start, range_end=end, room_id=room_id, title=title, content=content)
            s.add(existing)
        existing.title, existing.content = title, content
        existing.model, existing.utterance_count, existing.created_at = cfg.llm.model, count, utcnow()
        s.flush()
        events.publish(s, "summary.created", summary_event(existing))
        return existing.id


def summary_event(sm: Summary) -> dict:
    return {
        "id": sm.id,
        "level": sm.level,
        "range_start": iso(sm.range_start),
        "range_end": iso(sm.range_end),
        "room_id": sm.room_id,
        "title": sm.title,
        "content": sm.content,
        "model": sm.model,
        "utterance_count": sm.utterance_count,
        "created_at": iso(sm.created_at),
    }


def enqueue_job(session: Session, level: str, start: datetime, end: datetime, room_id: Optional[int] = None) -> SummaryJob:
    existing = (
        session.query(SummaryJob)
        .filter(
            SummaryJob.level == level,
            SummaryJob.range_start == start,
            SummaryJob.range_end == end,
            SummaryJob.status.in_(["queued", "running"]),
        )
        .first()
    )
    if existing and existing.room_id == room_id:
        return existing
    job = SummaryJob(level=level, range_start=start, range_end=end, room_id=room_id)
    session.add(job)
    session.flush()
    return job


def run_next_job(rt: Runtime) -> bool:
    """Runs one queued summary job. Returns True if a job was processed."""
    with rt.scope() as s:
        job = s.query(SummaryJob).filter(SummaryJob.status == "queued").order_by(SummaryJob.id).first()
        if job is None:
            return False
        job.status = "running"
        job_id, level, start, end, room_id = job.id, job.level, job.range_start, job.range_end, job.room_id
    try:
        summary_id = generate_summary(rt, level, start, end, room_id)
        status, error = "done", None
        if summary_id is None:
            error = "no_utterances"
    except llm_client.LlmError as exc:
        summary_id, status, error = None, "failed", str(exc)
        log.warning("summary job %s failed: %s", job_id, exc)
    except Exception as exc:
        log.exception("summary job %s crashed", job_id)
        summary_id, status, error = None, "failed", f"internal error: {exc}"
    with rt.scope() as s:
        job = s.get(SummaryJob, job_id)
        job.status, job.error, job.summary_id, job.finished_at = status, error, summary_id, utcnow()
    return True
