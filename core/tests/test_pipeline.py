from datetime import datetime, timedelta

from conftest import VOICE_A, VOICE_A2, VOICE_B, VOICE_C, make_wav, upload, utt

from murmur_core.models import Chunk, Speaker, SpeakerSample, Utterance
from murmur_core.services.pipeline import PipelineWorker

T0 = datetime(2026, 11, 11, 8, 0, 0)


def run(rt):
    return PipelineWorker(rt).run_until_idle()


def test_chunk_to_utterances_and_audio_deleted(authed, recorder, rt, asr):
    asr.responses = [
        {
            "language": "zh",
            "duration": 30,
            "utterances": [
                utt(1.0, 4.5, "明天下午三点开会", VOICE_A),
                utt(5.0, 9.0, "好的我会准时到", VOICE_B),
                utt(10.0, 14.0, "那就这么定了", VOICE_A2),
            ],
        }
    ]
    cid = upload(authed, recorder, T0, duration=30).json()["id"]
    assert run(rt) == 1
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.status == "done" and chunk.utterance_count == 3 and chunk.audio_deleted is True
        assert not rt.storage.exists(chunk.storage_key)
        utts = s.query(Utterance).order_by(Utterance.started_at).all()
        assert [u.text for u in utts] == ["明天下午三点开会", "好的我会准时到", "那就这么定了"]
        assert utts[0].started_at == T0 + timedelta(seconds=1)
        assert utts[0].speaker_id == utts[2].speaker_id != utts[1].speaker_id  # A and A2 are the same voice
        assert s.query(Speaker).count() == 2
        assert s.query(SpeakerSample).count() >= 2  # a few clips kept for human review
    items = authed.get("/api/v1/utterances?order=asc").json()["items"]
    assert items[0]["speaker_name"].startswith("说话人")


def test_audio_kept_when_retention_disabled(authed, recorder, rt, asr):
    authed.put("/api/v1/settings", json={"retention": {"delete_audio_after_transcribe": False}})
    asr.responses = [{"utterances": [utt(0, 2, "你好", VOICE_A)]}]
    cid = upload(authed, recorder, T0).json()["id"]
    run(rt)
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.audio_deleted is False and rt.storage.exists(chunk.storage_key)


def test_silence_chunk_is_skipped_and_deleted(authed, recorder, rt, asr):
    asr.responses = [{"utterances": []}]
    cid = upload(authed, recorder, T0).json()["id"]
    run(rt)
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.status == "skipped" and chunk.audio_deleted


def test_filters_drop_music_hallucination_and_low_confidence(authed, recorder, rt, asr):
    asr.responses = [
        {
            "utterances": [
                utt(0, 3, "♪ la la la ♪", VOICE_A, event="music"),
                utt(3, 6, "谢谢观看，请订阅", VOICE_A),
                utt(6, 8, "嗯嗯", VOICE_A),
                utt(8, 10, "模糊的声音", VOICE_A, prob=0.1),
                utt(10, 13, "对对对对对对对对对对对对", VOICE_B),
                utt(13, 17, "这个真的很重要", VOICE_B),
            ]
        }
    ]
    upload(authed, recorder, T0)
    run(rt)
    with rt.scope() as s:
        texts = [u.text for u in s.query(Utterance).order_by(Utterance.started_at)]
    assert texts == ["对对对", "这个真的很重要"]  # runaway repetition is collapsed


def test_filters_can_be_disabled(authed, recorder, rt, asr):
    authed.put("/api/v1/settings", json={"filters": {"drop_non_speech": False, "drop_hallucinations": False}})
    asr.responses = [{"utterances": [utt(0, 3, "music line", VOICE_A, event="music"), utt(3, 6, "谢谢观看", VOICE_A)]}]
    upload(authed, recorder, T0)
    run(rt)
    with rt.scope() as s:
        assert s.query(Utterance).count() == 2


def test_ignored_speaker_utterances_are_dropped(authed, recorder, rt, asr):
    asr.responses = [{"utterances": [utt(0, 4, "新闻联播开始了", VOICE_C), utt(5, 9, "我们来吃饭吧", VOICE_A)]}]
    upload(authed, recorder, T0)
    run(rt)
    with rt.scope() as s:
        tv = s.query(Utterance).filter(Utterance.text.like("新闻%")).one().speaker_id
    authed.patch(f"/api/v1/speakers/{tv}", json={"state": "ignored"})
    asr.calls = 0
    asr.responses = [{"utterances": [utt(0, 4, "天气预报", VOICE_C), utt(5, 9, "明天去公园", VOICE_A)]}]
    upload(authed, recorder, T0 + timedelta(minutes=5))
    run(rt)
    with rt.scope() as s:
        texts = {u.text for u in s.query(Utterance)}
    assert "天气预报" not in texts and "明天去公园" in texts
    listed = authed.get("/api/v1/utterances").json()["items"]  # historical TV lines hidden by default
    assert all(i["speaker_id"] != tv for i in listed)
    assert any(i["speaker_id"] == tv for i in authed.get("/api/v1/utterances?exclude_ignored=false").json()["items"])


def test_named_speaker_recognised_later(authed, recorder, rt, asr):
    asr.responses = [{"utterances": [utt(0, 4, "我是小明", VOICE_A)]}]
    upload(authed, recorder, T0)
    run(rt)
    sid = authed.get("/api/v1/speakers").json()[0]["id"]
    r = authed.patch(f"/api/v1/speakers/{sid}", json={"name": "小明"}).json()
    assert r["state"] == "named" and r["display_name"] == "小明"
    asr.calls = 0
    asr.responses = [{"utterances": [utt(0, 4, "今天天气不错", VOICE_A2)]}]
    upload(authed, recorder, T0 + timedelta(hours=1))
    run(rt)
    last = authed.get("/api/v1/utterances").json()["items"][0]
    assert last["speaker_id"] == sid and last["speaker_name"] == "小明"
    assert len(authed.get("/api/v1/speakers").json()) == 1


def test_short_utterances_do_not_spawn_speakers(authed, recorder, rt, asr):
    asr.responses = [{"utterances": [utt(0, 0.9, "嗯对", VOICE_B)]}]
    upload(authed, recorder, T0)
    run(rt)
    assert authed.get("/api/v1/speakers").json() == []
    assert authed.get("/api/v1/utterances").json()["items"][0]["speaker_id"] is None


def test_retry_with_backoff_then_success(authed, recorder, rt, asr):
    asr.fail_status = 503
    cid = upload(authed, recorder, T0).json()["id"]
    assert run(rt) == 1
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.status == "pending" and chunk.attempts == 1 and chunk.next_attempt_at > datetime.utcnow()
        assert "503" in chunk.error
        assert rt.storage.exists(chunk.storage_key)  # never delete audio on failure
        chunk.next_attempt_at = None
    asr.fail_status = None
    asr.responses = [{"utterances": [utt(0, 3, "终于好了", VOICE_A)]}]
    assert run(rt) == 1
    with rt.scope() as s:
        assert s.get(Chunk, cid).status == "done"


def test_permanent_failure_after_max_attempts_and_manual_retry(authed, recorder, rt, asr):
    asr.fail_status = 500
    cid = upload(authed, recorder, T0).json()["id"]
    for _ in range(5):
        with rt.scope() as s:
            s.query(Chunk).update({Chunk.next_attempt_at: None})
        run(rt)
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.status == "failed" and chunk.attempts == 5 and rt.storage.exists(chunk.storage_key)
    status = authed.get("/api/v1/pipeline/status").json()
    assert status["counts"]["failed"] == 1 and status["errors"][0]["chunk_id"] == cid
    asr.fail_status = None
    asr.responses = [{"utterances": [utt(0, 3, "重试成功", VOICE_A)]}]
    assert authed.post(f"/api/v1/chunks/{cid}/retry").status_code == 200
    run(rt)
    assert authed.get(f"/api/v1/chunks?status=done").json()["items"][0]["id"] == cid
    assert authed.post(f"/api/v1/chunks/{cid}/retry").status_code == 409  # not failed any more


def test_corrupt_audio_in_storage_fails_permanently(authed, recorder, rt, asr):
    cid = upload(authed, recorder, T0).json()["id"]
    with rt.scope() as s:
        key = s.get(Chunk, cid).storage_key
    rt.storage.put(key, b"tampered")
    run(rt)
    with rt.scope() as s:
        chunk = s.get(Chunk, cid)
        assert chunk.status == "failed" and "integrity" in chunk.error


def test_chunks_processed_in_time_order(authed, recorder, rt, asr):
    asr.responses = [{"utterances": [utt(0, 3, "第二段", VOICE_B)]}, {"utterances": [utt(0, 3, "第一段", VOICE_A)]}]
    late = upload(authed, recorder, T0 + timedelta(minutes=10)).json()["id"]
    early = upload(authed, recorder, T0).json()["id"]
    run(rt)
    with rt.scope() as s:
        assert s.get(Chunk, early).processed_at <= s.get(Chunk, late).processed_at


def test_openai_compatible_stt_mode(authed, recorder, rt):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audio/transcriptions"
        return httpx.Response(
            200,
            json={"language": "english", "duration": 6.0, "segments": [{"start": 0.0, "end": 2.5, "text": " Hello there.", "no_speech_prob": 0.01}]},
        )

    rt.asr_transport = httpx.MockTransport(handler)
    authed.put("/api/v1/settings", json={"asr": {"mode": "openai", "base_url": "http://stt:9000", "model": "whisper-1"}})
    upload(authed, recorder, T0)
    run(rt)
    item = authed.get("/api/v1/utterances").json()["items"][0]
    assert item["text"] == "Hello there." and item["speaker_id"] is None


def test_stale_processing_chunks_are_recovered(authed, recorder, rt, asr):
    from murmur_core.services.pipeline import claim_next_chunk, recover_stale

    cid = upload(authed, recorder, T0).json()["id"]
    assert claim_next_chunk(rt) == cid
    assert recover_stale(rt) == 0  # fresh claim is left alone
    with rt.scope() as s:
        s.get(Chunk, cid).next_attempt_at = datetime.utcnow() - timedelta(hours=1)
    assert recover_stale(rt) == 1
    with rt.scope() as s:
        assert s.get(Chunk, cid).status == "pending"
