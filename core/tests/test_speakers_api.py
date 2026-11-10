from datetime import datetime, timedelta

from conftest import VOICE_A, VOICE_B, VOICE_C, upload, utt

from murmur_core.models import Speaker, SpeakerSample, Utterance
from murmur_core.services.pipeline import PipelineWorker

T0 = datetime(2026, 11, 11, 8, 0, 0)


def seed(authed, recorder, rt, asr, plan):
    """plan: list of (minutes_offset, [utterances]) → one chunk each."""
    asr.calls = 0
    asr.responses = [{"utterances": items} for _, items in plan]
    for minutes, _ in plan:
        upload(authed, recorder, T0 + timedelta(minutes=minutes))
    PipelineWorker(rt).run_until_idle()


def two_voices(authed, recorder, rt, asr):
    seed(
        authed,
        recorder,
        rt,
        asr,
        [
            (0, [utt(0, 4, "我是第一个人", VOICE_A), utt(5, 9, "我是第二个人", VOICE_B)]),
            (10, [utt(0, 4, "第一个人又说话了", VOICE_A), utt(5, 9, "第二个人也是", VOICE_B)]),
        ],
    )
    return authed.get("/api/v1/speakers").json()


def test_speaker_listing_stats_and_samples(authed, recorder, rt, asr):
    speakers = two_voices(authed, recorder, rt, asr)
    assert len(speakers) == 2
    a = speakers[0]
    assert a["utterance_count"] == 2 and a["total_seconds"] == 8.0 and a["state"] == "unnamed"
    assert a["color"].startswith("#") and a["display_name"].startswith("说话人")
    assert len(a["samples"]) == 2  # chunks are 10 minutes apart, so both clear the 5-minute spacing rule
    assert a["samples"][0]["text"]
    audio = authed.get(f"/api/v1/speakers/{a['id']}/samples/{a['samples'][0]['id']}/audio")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav" and audio.content[:4] == b"RIFF"


def test_naming_unnaming_and_state_rules(authed, recorder, rt, asr):
    sid = two_voices(authed, recorder, rt, asr)[0]["id"]
    assert authed.patch(f"/api/v1/speakers/{sid}", json={"state": "named"}).status_code == 422  # needs a name first
    assert authed.patch(f"/api/v1/speakers/{sid}", json={"name": "小红"}).json()["state"] == "named"
    assert authed.patch(f"/api/v1/speakers/{sid}", json={"name": ""}).json()["state"] == "unnamed"
    r = authed.patch(f"/api/v1/speakers/{sid}", json={"state": "ignored"}).json()
    assert r["state"] == "ignored" and r["samples"] == []  # samples are discarded for ignored voices
    assert authed.get("/api/v1/speakers?state=ignored").json()[0]["id"] == sid


def test_merge_moves_everything_and_keeps_name(authed, recorder, rt, asr):
    a, b = two_voices(authed, recorder, rt, asr)
    authed.patch(f"/api/v1/speakers/{b['id']}", json={"name": "老王"})
    merged = authed.post(f"/api/v1/speakers/{a['id']}/merge", json={"into_id": b["id"]}).json()
    assert merged["id"] == b["id"] and merged["utterance_count"] == 4 and merged["name"] == "老王"
    assert [s["id"] for s in authed.get("/api/v1/speakers").json()] == [b["id"]]
    assert authed.get(f"/api/v1/speakers/{a['id']}").status_code == 404
    assert authed.post(f"/api/v1/speakers/{b['id']}/merge", json={"into_id": b["id"]}).status_code == 422
    # the merged voice now matches both voices: a later VOICE_A utterance joins it
    seed(authed, recorder, rt, asr, [(20, [utt(0, 4, "合并之后", VOICE_A)])])
    assert authed.get("/api/v1/utterances").json()["items"][0]["speaker_id"] == b["id"]


def test_merge_into_unnamed_inherits_name(authed, recorder, rt, asr):
    a, b = two_voices(authed, recorder, rt, asr)
    authed.patch(f"/api/v1/speakers/{a['id']}", json={"name": "小李"})
    merged = authed.post(f"/api/v1/speakers/{a['id']}/merge", json={"into_id": b["id"]}).json()
    assert merged["name"] == "小李" and merged["state"] == "named"


def test_split_creates_new_speaker_from_chosen_utterances(authed, recorder, rt, asr):
    seed(
        authed,
        recorder,
        rt,
        asr,
        [(0, [utt(0, 4, "甲说一", VOICE_A), utt(5, 9, "甲说二", VOICE_A), utt(10, 14, "甲说三", VOICE_A)])],
    )
    sid = authed.get("/api/v1/speakers").json()[0]["id"]
    ids = [u["id"] for u in authed.get("/api/v1/utterances?order=asc").json()["items"]]
    assert authed.post(f"/api/v1/speakers/{sid}/split", json={"utterance_ids": [999]}).status_code == 422
    new = authed.post(f"/api/v1/speakers/{sid}/split", json={"utterance_ids": ids[:2]})
    assert new.status_code == 201
    assert new.json()["utterance_count"] == 2 and authed.get(f"/api/v1/speakers/{sid}").json()["utterance_count"] == 1


def test_reassign_single_utterance_and_edit_text(authed, recorder, rt, asr):
    a, b = two_voices(authed, recorder, rt, asr)
    first = authed.get("/api/v1/utterances?speaker_id=%d&order=asc" % a["id"]).json()["items"][0]
    moved = authed.patch(f"/api/v1/utterances/{first['id']}", json={"speaker_id": b["id"], "text": "改过的文字"}).json()
    assert moved["speaker_id"] == b["id"] and moved["text"] == "改过的文字" and moved["text_edited"] is True
    assert authed.get(f"/api/v1/speakers/{b['id']}").json()["utterance_count"] == 3
    assert authed.patch(f"/api/v1/utterances/{first['id']}", json={"speaker_id": 999}).status_code == 422
    assert authed.get(f"/api/v1/utterances/{first['id']}").json()["text"] == "改过的文字"
    assert authed.delete(f"/api/v1/utterances/{first['id']}").status_code == 204


def test_delete_speaker_variants(authed, recorder, rt, asr):
    a, b = two_voices(authed, recorder, rt, asr)
    assert authed.delete(f"/api/v1/speakers/{a['id']}").status_code == 204
    with rt.scope() as s:
        assert s.query(Utterance).filter(Utterance.speaker_id.is_(None)).count() == 2  # kept, now unattributed
        assert s.query(SpeakerSample).filter(SpeakerSample.speaker_id == a["id"]).count() == 0
    assert authed.delete(f"/api/v1/speakers/{b['id']}?delete_utterances=true").status_code == 204
    with rt.scope() as s:
        assert s.query(Utterance).count() == 2


def test_utterance_search_pagination_and_days(authed, recorder, rt, asr):
    seed(
        authed,
        recorder,
        rt,
        asr,
        [
            (0, [utt(i * 5, i * 5 + 3, text, VOICE_A) for i, text in enumerate(["今天去公园散步", "明天下午开会讨论预算", "周末一起吃火锅", "预算要再看看"])]),
        ],
    )
    hits = authed.get("/api/v1/utterances?q=预算").json()["items"]  # 2-char query → LIKE fallback
    assert {h["text"] for h in hits} == {"明天下午开会讨论预算", "预算要再看看"}
    assert len(authed.get("/api/v1/utterances?q=讨论预算").json()["items"]) == 1  # ≥3 chars → FTS trigram
    assert authed.get("/api/v1/utterances?q=nothing-matches").json()["items"] == []
    page1 = authed.get("/api/v1/utterances?limit=3&order=asc").json()
    page2 = authed.get(f"/api/v1/utterances?limit=3&order=asc&cursor={page1['next_cursor']}").json()
    assert [i["text"] for i in page1["items"]] + [i["text"] for i in page2["items"]] == ["今天去公园散步", "明天下午开会讨论预算", "周末一起吃火锅", "预算要再看看"]
    assert page2["next_cursor"] is None
    around = authed.get(f"/api/v1/utterances?around={page1['items'][1]['id']}&window=60").json()["items"]
    assert len(around) == 4
    days = authed.get("/api/v1/utterances/days?from=2026-11-10T00:00:00Z&to=2026-11-13T00:00:00Z").json()
    assert days == [{"date": "2026-11-11", "count": 4}]
