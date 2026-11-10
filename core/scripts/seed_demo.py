"""Fill a Murmur data dir with realistic demo data (for UI development and screenshots).

    MURMUR_DATA_DIR=/tmp/murmur-demo python scripts/seed_demo.py [--password demo1234]

Creates rooms, a recorder, named/unnamed/ignored speakers with audio samples, several days of conversation,
summaries, to-dos (one with a reminder already due) and a failed chunk.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from datetime import timedelta

import numpy as np

from murmur_core.config import get_config
from murmur_core.models import (
    AuthRow, Chunk, Recorder, Room, Speaker, SpeakerSample, Summary, Todo, Utterance,
)
from murmur_core.runtime import build_runtime
from murmur_core.security import hash_password, hash_token
from murmur_core.services import speakers as sp_svc
from murmur_core.timeutil import get_tz, local_day_bounds, to_local, utcnow
from murmur_core.wavutil import write_wav

SCRIPT = [
    ("Mia", "早上好，今天要把设计稿发给客户。"),
    ("Leo", "好的，我下午三点前把图标导出来。"),
    ("Mia", "对了，记得明天上午十点跟供应商开会。"),
    ("Leo", "OK，我已经订好会议室了。"),
    ("Mia", "周末想去山里走走，你们有兴趣吗？"),
    ("Leo", "可以啊，不过要看天气，周六可能会下雨。"),
    ("Sam", "I'll send the invoice to the accounting team by Friday."),
    ("Mia", "Thanks Sam, also remind me to call the plumber tomorrow."),
    ("Leo", "这个 bug 我昨晚复现了，是缓存没有失效导致的。"),
    ("Mia", "那就先加个版本号，下周再重构。"),
    ("Sam", "Lunch? There's a new ramen place around the corner."),
    ("Leo", "好主意，十二点半出发。"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--password", default="demo1234")
    ap.add_argument("--days", type=int, default=3)
    args = ap.parse_args()
    rng = random.Random(7)
    rt = build_runtime(get_config())
    cfg = rt.load_settings()
    tz = get_tz(cfg.general.timezone)
    now = utcnow()
    with rt.scope() as s:
        if s.query(AuthRow).first():
            raise SystemExit("data dir already initialised; use an empty MURMUR_DATA_DIR")
        s.add(AuthRow(password_hash=hash_password(args.password)))
        living, studio = Room(name="客厅"), Room(name="工作室")
        s.add_all([living, studio])
        s.flush()
        rec = Recorder(name="客厅麦克风", room_id=living.id, token_hash=hash_token("mrm_demo"), last_seen=now,
                       version="0.1.0", status_json=json.dumps({"state": "recording", "level_db": -38.0, "active_device": "hw:1,0"}),
                       devices_json=json.dumps([{"id": "hw:1,0", "name": "USB Camera Mic", "channels": 1, "default_samplerate": 48000, "is_default": False},
                                                {"id": "default", "name": "System default", "channels": 2, "default_samplerate": 44100, "is_default": True}]),
                       config_json=json.dumps({"device": "hw:1,0"}))
        s.add(rec)
        s.add(Recorder(name="工作室麦克风", room_id=studio.id, token_hash=hash_token("mrm_demo2"), last_seen=now - timedelta(hours=3),
                       status_json=json.dumps({"state": "error", "error": "device not found"})))
        voices = {}
        for name, state in (("Mia", "named"), ("Leo", "named"), ("Sam", "unnamed"), ("TV", "ignored")):
            v = np.zeros(16); v[len(voices)] = 1.0
            sp = Speaker(name=name if state != "unnamed" else None, state=state, centroid=sp_svc.pack(v), embedding_count=20)
            s.add(sp); s.flush(); voices[name] = sp
        voices["Sam"].name = None
        s.flush()
        rate, utt_ids = 16000, []
        for back in range(args.days - 1, -1, -1):
            day = (to_local(now, tz) - timedelta(days=back)).date()
            start, _ = local_day_bounds(day, tz)
            t = start + (timedelta(minutes=rng.randint(1, 20)) if back == 0 else timedelta(hours=8, minutes=rng.randint(0, 30)))
            for i in range(rng.randint(24, 36)):
                who, text = SCRIPT[i % len(SCRIPT)]
                t += timedelta(seconds=rng.choice([6, 9, 14, 25, 70, 400, 1500]))
                if t > now:
                    break
                dur = 2 + len(text) / 8
                u = Utterance(room_id=living.id, started_at=t, ended_at=t + timedelta(seconds=dur), text=text,
                              lang="en" if text.isascii() else "zh", speaker_id=voices[who].id, confidence=0.9,
                              embedding=sp_svc.pack(np.eye(16)[list(voices).index(who)]))
                s.add(u); s.flush(); utt_ids.append(u.id)
                if i < 6 and back <= 1 and who in ("Mia", "Leo"):
                    tone = (np.sin(2 * np.pi * (180 + 40 * list(voices).index(who)) * np.arange(rate * 3) / rate) * 6000).astype("<i2")
                    key = f"samples/{voices[who].id}/demo{u.id}.wav"
                    rt.storage.put(key, write_wav(tone, rate))
                    s.add(SpeakerSample(speaker_id=voices[who].id, storage_key=key, duration=3.0, source_utterance_id=u.id))
        today_start, today_end = local_day_bounds(to_local(now, tz).date(), tz)
        s.add(Summary(level="daily", range_start=today_start - timedelta(days=1), range_end=today_start, title="昨天 日报", model="demo",
                      content="## 今日概览\n昨天主要围绕**设计稿交付**和供应商会议展开。\n\n## 决定与约定\n- Leo 下午三点前导出图标\n- 周六山里徒步，视天气而定\n\n## 待跟进\n- 明天上午十点供应商会议", utterance_count=30))
        s.add(Summary(level="incremental", range_start=now - timedelta(hours=1), range_end=now, title="最近一小时 增量摘要", model="demo",
                      content="- Sam 提醒周五前把发票发给财务\n- 午餐计划：街角新开的拉面店，十二点半出发", utterance_count=8))
        s.add(Todo(text="周五前把发票发给财务", status="open", assignee_speaker_id=voices["Sam"].id, due_at=now + timedelta(days=2), source="auto", confidence=0.9,
                   source_excerpt="I'll send the invoice to the accounting team by Friday.", reminder_state="pending", remind_at=now + timedelta(days=2) - timedelta(minutes=10)))
        s.add(Todo(text="明天上午十点和供应商开会", status="open", assignee_speaker_id=voices["Mia"].id, due_at=now + timedelta(hours=20), remind_at=now - timedelta(minutes=2),
                   reminder_state="fired", source="auto", confidence=0.85, source_excerpt="记得明天上午十点跟供应商开会。"))
        s.add(Todo(text="给水管工打电话", status="open", source="auto", confidence=0.7, source_excerpt="remind me to call the plumber tomorrow."))
        s.add(Todo(text="导出设计稿图标", status="done", assignee_speaker_id=voices["Leo"].id, source="auto", confidence=0.9, completed_at=now - timedelta(hours=2)))
        s.add(Todo(text="买牛奶", status="open", source="manual"))
        bad = b"\x00" * 100
        s.add(Chunk(recorder_id=rec.id, room_id=living.id, started_at=now - timedelta(hours=5), duration=30, sha256=hashlib.sha256(bad).hexdigest(),
                    storage_key="audio/demo/failed.wav", status="failed", attempts=5, error="ASR request failed: connection refused", processed_at=now))
    print(f"seeded; log in with password: {args.password}")


if __name__ == "__main__":
    main()
