"""To-do extraction from conversation, deduplication, and reminder scheduling."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Optional

from sqlalchemy.orm import Session

from .. import events
from ..models import Speaker, Todo, Utterance
from ..runtime import Runtime
from ..settings_store import AllSettings, read_state, write_state
from ..timeutil import get_tz, iso, local_to_utc, to_local, utcnow
from . import llm_client, prompts
from .speakers import display_name
from .summarizer import split_blocks

log = logging.getLogger(__name__)

CURSOR_KEY = "todo_cursor_utterance_id"
CONTEXT_LINES = 8
DEDUPE_WINDOW_DAYS = 14


def todo_event(t: Todo, names: dict[int, str]) -> dict:
    return {
        "id": t.id,
        "text": t.text,
        "status": t.status,
        "assignee_speaker_id": t.assignee_speaker_id,
        "assignee_name": names.get(t.assignee_speaker_id) if t.assignee_speaker_id else None,
        "due_at": iso(t.due_at),
        "remind_at": iso(t.remind_at),
        "reminder_state": t.reminder_state,
        "confidence": t.confidence,
        "source": t.source,
        "source_utterance_id": t.source_utterance_id,
        "source_excerpt": t.source_excerpt,
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
        "completed_at": iso(t.completed_at),
    }


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())


def _bigrams(text: str) -> set[str]:
    t = _norm(text)
    return {t[i : i + 2] for i in range(len(t) - 1)} or {t}


def similar(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    if na == nb or (min(len(na), len(nb)) >= 6 and (na in nb or nb in na)):
        return True
    if SequenceMatcher(None, na, nb).ratio() >= 0.75:
        return True
    ba, bb = _bigrams(a), _bigrams(b)
    return len(ba & bb) / max(len(ba | bb), 1) >= 0.6


def parse_when(value, tz) -> Optional[datetime]:
    """Parses an LLM-produced timestamp. Naive values are interpreted in the household timezone."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.lower() in ("null", "none", ""):
        return None
    try:
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text.replace(" ", "T", 1) if "T" not in text else text)
    except ValueError:
        return None
    return local_to_utc(dt, tz)


def compute_reminder(due: Optional[datetime], remind: Optional[datetime], before_minutes: int, now: datetime) -> tuple[Optional[datetime], str]:
    when = remind
    if when is None and due is not None:
        when = due - timedelta(minutes=before_minutes)
        if when < now:
            when = due
    if when is None or when < now - timedelta(minutes=1):
        return None, "none"
    return when, "pending"


def extract_new_todos(rt: Runtime, max_utterances: int = 400) -> int:
    """Processes utterances added since the last run. Returns how many to-dos were created."""
    cfg = rt.load_settings()
    if not cfg.todos.enabled or not llm_client.configured(cfg.llm):
        return 0
    tz = get_tz(cfg.general.timezone)
    with rt.scope() as s:
        cursor = read_state(s, CURSOR_KEY, None)
        if cursor is None:  # first run: don't mine the whole history, start from now
            last = s.query(Utterance.id).order_by(Utterance.id.desc()).first()
            write_state(s, CURSOR_KEY, last[0] if last else 0)
            return 0
        new = s.query(Utterance).filter(Utterance.id > cursor).order_by(Utterance.id).limit(max_utterances).all()
        if not new:
            return 0
        context = (
            s.query(Utterance).filter(Utterance.id <= cursor).order_by(Utterance.id.desc()).limit(CONTEXT_LINES).all()
        )[::-1]
        names = {sp.id: display_name(sp, cfg.general.ui_language) for sp in s.query(Speaker).all()}
        name_to_id = {v: k for k, v in names.items()}
        unknown = "未知说话人" if cfg.general.ui_language.startswith("zh") else "Unknown speaker"

        def line(u: Utterance, is_context: bool) -> str:
            local = to_local(u.started_at, tz).strftime("%H:%M")
            who = names.get(u.speaker_id, unknown) if u.speaker_id else unknown
            tag = "context " if is_context else f"{u.id} "
            return f"{tag}[{local}] {who}: {u.text}"

        lines = [line(u, True) for u in context] + [line(u, False) for u in new]
        by_id = {u.id: u for u in new}
        last_id = new[-1].id
        room_name = ""

    now = utcnow()
    values = dict(
        now=to_local(now, tz).strftime("%Y-%m-%d %H:%M (%A) ") + cfg.general.timezone,
        rooms=room_name or "-",
        language=prompts.language_name(cfg.general.output_language),
        start="",
        end="",
        todos="",
    )
    template = cfg.llm.prompts.todos or prompts.default_prompt("todos", cfg.general.output_language)
    created: list[dict] = []
    failed = False
    for block in split_blocks(lines, cfg.llm.max_input_chars):
        try:
            reply = llm_client.chat(
                cfg.llm,
                [
                    {"role": "system", "content": "You extract structured data and reply with JSON only."},
                    {"role": "user", "content": prompts.render(template, transcript=block, **values)},
                ],
                json_mode=True,
                transport=rt.llm_transport,
            )
            data = llm_client.extract_json(reply)
        except llm_client.LlmError as exc:
            log.warning("to-do extraction failed: %s", exc)
            failed = True
            break
        items = data.get("todos", []) if isinstance(data, dict) else data if isinstance(data, list) else []
        created.extend(_store_items(rt, cfg, items, by_id, name_to_id, tz, now))

    if failed and not created:
        return 0  # leave the cursor so the next tick retries the same utterances
    with rt.scope() as s:
        write_state(s, CURSOR_KEY, last_id)
    return len(created)


def _store_items(rt: Runtime, cfg: AllSettings, items: list, by_id: dict[int, Utterance], name_to_id: dict[str, int], tz, now: datetime) -> list[dict]:
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        try:
            confidence = float(item.get("confidence", 0.7))
        except (TypeError, ValueError):
            confidence = 0.7
        if confidence < cfg.todos.min_confidence:
            continue
        due = parse_when(item.get("due"), tz)
        remind = parse_when(item.get("remind"), tz)
        ref = item.get("ref")
        try:
            ref = int(ref)
        except (TypeError, ValueError):
            ref = None
        source = by_id.get(ref)
        assignee = name_to_id.get(str(item.get("assignee") or "").strip())
        with rt.scope() as s:
            if _is_duplicate(s, text, assignee, due, now):
                continue
            remind_at, state = compute_reminder(due, remind, cfg.todos.default_remind_before_minutes, now)
            todo = Todo(
                text=text,
                assignee_speaker_id=assignee,
                due_at=due,
                remind_at=remind_at,
                reminder_state=state,
                confidence=confidence,
                source="auto",
                source_utterance_id=source.id if source else None,
                source_excerpt=source.text[:300] if source else None,
            )
            s.add(todo)
            s.flush()
            names = {sp.id: display_name(sp, cfg.general.ui_language) for sp in s.query(Speaker).all()}
            payload = todo_event(todo, names)
            events.publish(s, "todo.created", payload)
            out.append(payload)
    return out


def _is_duplicate(session: Session, text: str, assignee: Optional[int], due: Optional[datetime], now: datetime) -> bool:
    cutoff = now - timedelta(days=DEDUPE_WINDOW_DAYS)
    recent = session.query(Todo).filter(Todo.created_at >= cutoff, Todo.status != "dismissed").all()
    for existing in recent:
        if similar(text, existing.text):
            if existing.due_at is None and due is not None and existing.status == "open":
                existing.due_at = due  # a later mention added the missing time
            return True
    return False


def fire_due_reminders(rt: Runtime) -> int:
    """Flips pending reminders whose time has come to 'fired' and announces them."""
    cfg = rt.load_settings()
    with rt.scope() as s:
        due = s.query(Todo).filter(Todo.status == "open", Todo.reminder_state == "pending", Todo.remind_at <= utcnow()).all()
        if not due:
            return 0
        names = {sp.id: display_name(sp, cfg.general.ui_language) for sp in s.query(Speaker).all()}
        for todo in due:
            todo.reminder_state = "fired"
            s.flush()
            events.publish(s, "reminder.due", todo_event(todo, names))
        return len(due)
