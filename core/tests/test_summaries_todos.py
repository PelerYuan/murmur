import json
from datetime import datetime, timedelta

from conftest import VOICE_A, VOICE_B, upload, utt

from murmur_core.models import Summary, SummaryJob, Todo
from murmur_core.services import summarizer, todos as todo_svc
from murmur_core.services.pipeline import PipelineWorker
from murmur_core.services.scheduler import Scheduler
from murmur_core.timeutil import utcnow

LLM = {"llm": {"base_url": "http://llm/v1", "model": "test-model"}}


def seed_day(authed, recorder, rt, asr, base: datetime, lines):
    asr.calls = 0
    asr.responses = [{"utterances": [utt(i * 6, i * 6 + 4, text, emb) for i, (text, emb) in enumerate(lines)]}]
    upload(authed, recorder, base)
    PipelineWorker(rt).run_until_idle()


def test_manual_summary_generation(authed, recorder, rt, asr, llm):
    base = datetime(2026, 11, 11, 3, 0, 0)  # 11:00 in Asia/Shanghai
    seed_day(authed, recorder, rt, asr, base, [("周末去爬山吧", VOICE_A), ("好啊带上帐篷", VOICE_B)])
    authed.put("/api/v1/settings", json=LLM)
    body = {"level": "custom", "start": "2026-11-11T02:00:00Z", "end": "2026-11-11T04:00:00Z"}
    job = authed.post("/api/v1/summaries/generate", json=body)
    assert job.status_code == 202 and job.json()["status"] == "queued"
    assert summarizer.run_next_job(rt) is True
    jobs = authed.get("/api/v1/summary-jobs").json()
    assert jobs[0]["status"] == "done" and jobs[0]["summary_id"]
    summary = authed.get(f"/api/v1/summaries/{jobs[0]['summary_id']}").json()
    assert summary["content"].startswith("## 摘要") and summary["utterance_count"] == 2 and summary["model"] == "test-model"
    assert "11-11" in summary["title"]
    prompt = llm.requests[-1]["messages"][-1]["content"]
    assert "[11:00:" in prompt and "周末去爬山吧" in prompt and "说话人" in prompt  # local time + speaker labels
    # regenerating the same range overwrites instead of duplicating
    authed.post("/api/v1/summaries/generate", json=body)
    summarizer.run_next_job(rt)
    assert len(authed.get("/api/v1/summaries").json()["items"]) == 1


def test_summary_no_content_and_llm_failures(authed, recorder, rt, asr, llm):
    body = {"level": "custom", "start": "2026-11-11T02:00:00Z", "end": "2026-11-11T04:00:00Z"}
    authed.post("/api/v1/summaries/generate", json=body)
    summarizer.run_next_job(rt)
    assert authed.get("/api/v1/summary-jobs").json()[0]["status"] == "failed"  # LLM not configured yet
    authed.put("/api/v1/settings", json=LLM)
    authed.post("/api/v1/summaries/generate", json=body)
    summarizer.run_next_job(rt)
    job = authed.get("/api/v1/summary-jobs").json()[0]
    assert job["status"] == "done" and job["summary_id"] is None and job["error"] == "no_utterances"
    seed_day(authed, recorder, rt, asr, datetime(2026, 11, 11, 3, 0, 0), [("有内容了", VOICE_A)])
    llm.fail = True
    authed.post("/api/v1/summaries/generate", json=body)
    summarizer.run_next_job(rt)
    job = authed.get("/api/v1/summary-jobs").json()[0]
    assert job["status"] == "failed" and "500" in job["error"]
    assert authed.post("/api/v1/summaries/generate", json={**body, "end": body["start"]}).status_code == 422


def test_long_transcript_uses_map_reduce(authed, recorder, rt, asr, llm):
    lines = [(f"这是第{i}句很长的对话内容，用来撑满上下文窗口" * 4, VOICE_A) for i in range(30)]
    seed_day(authed, recorder, rt, asr, datetime(2026, 11, 11, 3, 0, 0), lines)
    authed.put("/api/v1/settings", json={"llm": {**LLM["llm"], "max_input_chars": 2000}})
    authed.post("/api/v1/summaries/generate", json={"level": "daily", "start": "2026-11-10T16:00:00Z", "end": "2026-11-11T16:00:00Z"})
    before = len(llm.requests)
    summarizer.run_next_job(rt)
    assert len(llm.requests) - before >= 3  # several map calls plus the final reduce
    assert "Part" in llm.requests[-1]["messages"][-1]["content"] or "分段" in llm.requests[-1]["messages"][-1]["content"]


def test_custom_prompt_template_is_used(authed, recorder, rt, asr, llm):
    seed_day(authed, recorder, rt, asr, datetime(2026, 11, 11, 3, 0, 0), [("你好", VOICE_A)])
    authed.put("/api/v1/settings", json={"llm": {**LLM["llm"], "prompts": {"summary": "一句话总结：\n{transcript}\n(范围 {start})"}}})
    authed.post("/api/v1/summaries/generate", json={"level": "custom", "start": "2026-11-11T02:00:00Z", "end": "2026-11-11T04:00:00Z"})
    summarizer.run_next_job(rt)
    assert llm.requests[-1]["messages"][-1]["content"].startswith("一句话总结：")
    defaults = authed.get("/api/v1/settings/defaults").json()
    assert "{transcript}" in defaults["prompts"]["summary"] and "{todos}" in defaults["prompts"]["daily"]


# ---------------- to-dos ----------------


def test_todo_extraction_creates_dedupes_and_schedules_reminders(authed, recorder, rt, asr, llm):
    authed.put("/api/v1/settings", json=LLM)
    assert todo_svc.extract_new_todos(rt) == 0  # first run only sets the cursor
    base = utcnow().replace(microsecond=0) - timedelta(minutes=30)
    seed_day(authed, recorder, rt, asr, base, [("记得明天下午三点开会", VOICE_A), ("好的，周五前发报告", VOICE_B)])
    first_utt = authed.get("/api/v1/utterances?order=asc").json()["items"][0]
    due = (utcnow() + timedelta(days=1)).replace(microsecond=0)
    llm.todos_reply = {
        "todos": [
            {"text": "明天下午三点开会", "assignee": None, "due": due.isoformat() + "Z", "remind": None, "ref": first_utt["id"], "confidence": 0.9},
            {"text": "不确定的事", "due": None, "confidence": 0.2},
            {"text": "", "confidence": 0.9},
        ]
    }
    assert todo_svc.extract_new_todos(rt) == 1
    todos = authed.get("/api/v1/todos").json()
    assert len(todos) == 1
    t = todos[0]
    assert t["source"] == "auto" and t["source_excerpt"] == "记得明天下午三点开会" and t["source_utterance_id"] == first_utt["id"]
    assert t["reminder_state"] == "pending" and t["remind_at"] == (due - timedelta(minutes=10)).isoformat() + "Z"
    # same todo mentioned again → deduplicated, no new utterances → nothing to do
    seed_day(authed, recorder, rt, asr, base + timedelta(minutes=10), [("别忘了明天下午三点的会议", VOICE_A)])
    llm.todos_reply = {"todos": [{"text": "明天下午三点开会", "due": None, "confidence": 0.9}]}
    assert todo_svc.extract_new_todos(rt) == 0
    assert len(authed.get("/api/v1/todos").json()) == 1


def test_todo_extraction_names_assignee_and_survives_llm_errors(authed, recorder, rt, asr, llm):
    authed.put("/api/v1/settings", json=LLM)
    todo_svc.extract_new_todos(rt)
    base = utcnow() - timedelta(minutes=30)
    seed_day(authed, recorder, rt, asr, base, [("我来订餐厅", VOICE_A)])
    sid = authed.get("/api/v1/speakers").json()[0]["id"]
    authed.patch(f"/api/v1/speakers/{sid}", json={"name": "小明"})
    llm.fail = True
    assert todo_svc.extract_new_todos(rt) == 0
    llm.fail = False  # cursor was kept, so the same utterance is retried
    llm.todos_reply = {"todos": [{"text": "订餐厅", "assignee": "小明", "due": None, "confidence": 0.8}]}
    assert todo_svc.extract_new_todos(rt) == 1
    assert authed.get("/api/v1/todos").json()[0]["assignee_name"] == "小明"
    llm.todos_reply = "not json at all"
    # garbage replies are tolerated
    seed_day(authed, recorder, rt, asr, base + timedelta(minutes=20), [("再来一句", VOICE_A)])
    assert todo_svc.extract_new_todos(rt) == 0


def test_todo_crud_and_reminder_flow(authed, rt):
    created = authed.post("/api/v1/todos", json={"text": "买牛奶"}).json()
    assert created["source"] == "manual" and created["reminder_state"] == "none"
    soon = (utcnow() - timedelta(seconds=5)).isoformat() + "Z"
    t = authed.post("/api/v1/todos", json={"text": "喝水", "remind_at": soon}).json()
    assert t["reminder_state"] == "pending"
    assert authed.get("/api/v1/reminders/due").json()[0]["id"] == t["id"]
    assert todo_svc.fire_due_reminders(rt) == 1
    assert authed.get("/api/v1/todos?status=open").json()[0]["reminder_state"] in ("none", "fired", "pending")
    snoozed = authed.post(f"/api/v1/todos/{t['id']}/snooze", json={"minutes": 10}).json()
    assert snoozed["reminder_state"] == "pending" and authed.get("/api/v1/reminders/due").json() == []
    acked = authed.post(f"/api/v1/todos/{t['id']}/ack-reminder").json()
    assert acked["reminder_state"] == "acked" and acked["status"] == "open"
    done = authed.patch(f"/api/v1/todos/{created['id']}", json={"status": "done"}).json()
    assert done["status"] == "done" and done["completed_at"]
    reopened = authed.patch(f"/api/v1/todos/{created['id']}", json={"status": "open"}).json()
    assert reopened["completed_at"] is None
    ordered = [x["text"] for x in authed.get("/api/v1/todos").json()]
    assert set(ordered) == {"买牛奶", "喝水"}
    assert authed.delete(f"/api/v1/todos/{t['id']}").status_code == 204
    assert authed.patch("/api/v1/todos/999", json={"status": "done"}).status_code == 404


def test_reminder_events_reach_sse_log(authed, rt):
    t = authed.post("/api/v1/todos", json={"text": "提醒我", "remind_at": (utcnow() - timedelta(seconds=1)).isoformat() + "Z"}).json()
    todo_svc.fire_due_reminders(rt)
    from murmur_core import events

    with rt.scope() as s:
        types = [e.type for e in events.fetch_after(s, 0)]
    assert "reminder.due" in types and "todo.created" in types


# ---------------- scheduler ----------------


def test_scheduler_incremental_daily_and_idle(authed, recorder, rt, asr, llm):
    authed.put("/api/v1/settings", json={**LLM, "schedule": {"incremental": {"every_minutes": 30, "min_utterances": 2}, "daily": {"time": "23:30"}}, "todos": {"enabled": False}})
    base = datetime(2026, 11, 11, 1, 0, 0)
    seed_day(authed, recorder, rt, asr, base, [(f"第{i}句话", VOICE_A) for i in range(4)])
    sch = Scheduler(rt)
    sch.tick(now=base + timedelta(minutes=5))  # first tick only records the cursor
    assert authed.get("/api/v1/summary-jobs").json() == []
    sch.tick(now=base + timedelta(minutes=45))
    jobs = authed.get("/api/v1/summary-jobs").json()
    assert [j["level"] for j in jobs] == ["incremental"]
    sch.tick(now=base + timedelta(minutes=50))  # cursor advanced: nothing new to summarise
    assert len(authed.get("/api/v1/summary-jobs").json()) == 1
    # daily: 23:30 Shanghai = 15:30 UTC
    sch.tick(now=datetime(2026, 11, 11, 15, 31, 0))
    levels = sorted(j["level"] for j in authed.get("/api/v1/summary-jobs").json())
    assert "daily" in levels
    sch.tick(now=datetime(2026, 11, 11, 15, 40, 0))
    assert sorted(j["level"] for j in authed.get("/api/v1/summary-jobs").json()).count("daily") == 1  # once per day
    while summarizer.run_next_job(rt):
        pass
    assert {s["level"] for s in authed.get("/api/v1/summaries").json()["items"]} == {"incremental", "daily"}


def test_scheduler_idle_trigger_and_pending_horizon(authed, recorder, rt, asr, llm):
    authed.put(
        "/api/v1/settings",
        json={**LLM, "schedule": {"incremental": {"enabled": False}, "idle": {"enabled": True, "idle_minutes": 10}, "daily": {"enabled": False}}, "todos": {"enabled": False}},
    )
    base = utcnow().replace(microsecond=0) - timedelta(minutes=40)
    seed_day(authed, recorder, rt, asr, base, [("聊了一会儿", VOICE_A), ("然后停下来", VOICE_B)])
    sch = Scheduler(rt)
    sch.tick()
    assert [j["level"] for j in authed.get("/api/v1/summary-jobs").json()] == ["incremental"]
    # audio still waiting for transcription holds the horizon back so nothing is summarised prematurely
    upload(authed, recorder, base + timedelta(minutes=5))
    from murmur_core.services.scheduler import safe_horizon

    assert safe_horizon(rt) <= base + timedelta(minutes=5)


def test_hourly_summaries_and_maintenance(authed, recorder, rt, asr, llm):
    from murmur_core.services.scheduler import maintenance
    from murmur_core.models import Chunk, Speaker, Utterance

    authed.put("/api/v1/settings", json={**LLM, "schedule": {"incremental": {"enabled": False}, "hourly": {"enabled": True}, "daily": {"enabled": False}}, "todos": {"enabled": False}})
    base = datetime(2026, 11, 11, 1, 5, 0)  # 09:05 local
    seed_day(authed, recorder, rt, asr, base, [("上午的话", VOICE_A)])
    sch = Scheduler(rt)
    sch.tick(now=datetime(2026, 11, 11, 4, 0, 0))
    jobs = authed.get("/api/v1/summary-jobs").json()
    assert [j["level"] for j in jobs] == ["hourly"] and jobs[0]["range_start"] == "2026-11-11T01:00:00Z"
    # maintenance: old embeddings purged, tiny stale speakers removed
    cfg = rt.load_settings()
    with rt.scope() as s:
        sp = Speaker(state="unnamed", created_at=utcnow() - timedelta(days=5))
        s.add(sp)
    maintenance(rt, cfg, utcnow() + timedelta(days=60))
    with rt.scope() as s:
        assert s.query(Utterance).filter(Utterance.embedding.is_not(None)).count() == 0
        assert s.query(Speaker).count() == 0
