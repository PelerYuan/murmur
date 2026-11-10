from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import case
from sqlalchemy.orm import Session

from .. import events
from ..deps import ApiError, get_db, get_runtime, require_user
from ..models import Speaker, Todo
from ..runtime import Runtime
from ..services.speakers import display_name
from ..services.todos import compute_reminder, todo_event
from ..timeutil import UTCDatetime, utcnow

router = APIRouter(tags=["todos"], dependencies=[Depends(require_user)])


def _names(db: Session, rt: Runtime) -> dict[int, str]:
    lang = rt.settings.get(db).general.ui_language
    return {sp.id: display_name(sp, lang) for sp in db.query(Speaker).all()}


def _get(db: Session, todo_id: int) -> Todo:
    todo = db.get(Todo, todo_id)
    if todo is None:
        raise ApiError(404, "to-do not found", "not_found")
    return todo


@router.get("/todos")
def list_todos(
    status: Optional[str] = Query(None, pattern="^(open|done|dismissed)$"),
    assignee_id: Optional[int] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    rt: Runtime = Depends(get_runtime),
):
    query = db.query(Todo)
    if status:
        query = query.filter(Todo.status == status)
    if assignee_id is not None:
        query = query.filter(Todo.assignee_speaker_id == assignee_id)
    if q and q.strip():
        query = query.filter(Todo.text.ilike("%" + q.strip().replace("%", r"\%") + "%", escape="\\"))
    open_first = case((Todo.status == "open", 0), else_=1)
    no_due_last = case((Todo.due_at.is_(None), 1), else_=0)
    rows = query.order_by(open_first, no_due_last, Todo.due_at, Todo.id.desc()).limit(1000).all()
    names = _names(db, rt)
    return [todo_event(t, names) for t in rows]


class TodoIn(BaseModel):
    text: str = Field(min_length=1)
    assignee_speaker_id: Optional[int] = None
    due_at: Optional[UTCDatetime] = None
    remind_at: Optional[UTCDatetime] = None
    source_utterance_id: Optional[int] = None


@router.post("/todos", status_code=201)
def create_todo(body: TodoIn, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    if body.assignee_speaker_id is not None and db.get(Speaker, body.assignee_speaker_id) is None:
        raise ApiError(422, "speaker does not exist", "bad_speaker")
    cfg = rt.settings.get(db)
    remind_at, state = compute_reminder(body.due_at, body.remind_at, cfg.todos.default_remind_before_minutes, utcnow()) if body.remind_at else (None, "none")
    from ..models import Utterance

    source = db.get(Utterance, body.source_utterance_id) if body.source_utterance_id else None
    todo = Todo(
        text=body.text.strip(),
        assignee_speaker_id=body.assignee_speaker_id,
        due_at=body.due_at,
        remind_at=remind_at,
        reminder_state=state,
        source="manual",
        source_utterance_id=source.id if source else None,
        source_excerpt=source.text[:300] if source else None,
    )
    db.add(todo)
    db.flush()
    payload = todo_event(todo, _names(db, rt))
    events.publish(db, "todo.created", payload)
    return payload


class TodoPatch(BaseModel):
    text: Optional[str] = Field(default=None, min_length=1)
    status: Optional[str] = Field(default=None, pattern="^(open|done|dismissed)$")
    assignee_speaker_id: Optional[int] = None
    due_at: Optional[UTCDatetime] = None
    remind_at: Optional[UTCDatetime] = None


@router.patch("/todos/{todo_id}")
def patch_todo(todo_id: int, body: TodoPatch, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    todo = _get(db, todo_id)
    fields = body.model_fields_set
    if "text" in fields and body.text:
        todo.text = body.text.strip()
    if "assignee_speaker_id" in fields:
        if body.assignee_speaker_id is not None and db.get(Speaker, body.assignee_speaker_id) is None:
            raise ApiError(422, "speaker does not exist", "bad_speaker")
        todo.assignee_speaker_id = body.assignee_speaker_id
    if "due_at" in fields:
        todo.due_at = body.due_at
    if "remind_at" in fields:
        todo.remind_at = body.remind_at
        todo.reminder_state = "pending" if body.remind_at else "none"
    if "status" in fields and body.status:
        todo.status = body.status
        todo.completed_at = utcnow() if body.status == "done" else None
        if body.status != "open" and todo.reminder_state in ("pending", "fired"):
            todo.reminder_state = "acked"
        if body.status == "open" and todo.remind_at and todo.reminder_state == "acked":
            todo.reminder_state = "pending" if todo.remind_at > utcnow() else "acked"
    db.flush()
    payload = todo_event(todo, _names(db, rt))
    events.publish(db, "todo.updated", payload)
    return payload


@router.delete("/todos/{todo_id}", status_code=204)
def delete_todo(todo_id: int, db: Session = Depends(get_db)):
    db.delete(_get(db, todo_id))


@router.get("/reminders/due")
def reminders_due(db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    rows = (
        db.query(Todo)
        .filter(Todo.status == "open", Todo.reminder_state.in_(["pending", "fired"]), Todo.remind_at <= utcnow())
        .order_by(Todo.remind_at)
        .all()
    )
    names = _names(db, rt)
    return [todo_event(t, names) for t in rows]


@router.post("/todos/{todo_id}/ack-reminder")
def ack_reminder(todo_id: int, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    todo = _get(db, todo_id)
    todo.reminder_state = "acked"
    db.flush()
    payload = todo_event(todo, _names(db, rt))
    events.publish(db, "todo.updated", payload)
    return payload


class SnoozeIn(BaseModel):
    minutes: int = Field(10, ge=1, le=10080)


@router.post("/todos/{todo_id}/snooze")
def snooze(todo_id: int, body: SnoozeIn, db: Session = Depends(get_db), rt: Runtime = Depends(get_runtime)):
    todo = _get(db, todo_id)
    todo.remind_at = utcnow() + timedelta(minutes=body.minutes)
    todo.reminder_state = "pending"
    db.flush()
    payload = todo_event(todo, _names(db, rt))
    events.publish(db, "todo.updated", payload)
    return payload
