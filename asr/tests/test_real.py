"""Contract tests against the real pipeline: real models, real audio, real HTTP app (marker: heavy).

Needs the models (downloaded automatically into MURMUR_ASR_MODEL_DIR on first run) and, for the
composite-room tests, the shared test data in /home/peler/murmur-testdata (see scripts/build_testdata.py).
"""
import itertools
import json
import threading
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from conftest import TESTDATA, tone, wav_bytes
from murmur_asr.config import Settings
from murmur_asr.service import create_app

pytestmark = pytest.mark.heavy

SV = TESTDATA / "sherpa" / "sensevoice_test_wavs"
need_sherpa = pytest.mark.skipif(not SV.exists(), reason="sherpa sample wavs missing in testdata dir")
need_rooms = pytest.mark.skipif(not (TESTDATA / "room_family_zh.wav").exists(), reason="composite rooms missing")


def _wait(c, n=600):
    for _ in range(n):
        if c.get("/health").status_code == 200:
            return
        time.sleep(0.1)
    raise AssertionError("service did not become healthy")


@pytest.fixture(scope="module")
def client():
    s = Settings.from_env()
    s.workers, s.max_upload_mb = 2, 50
    with TestClient(create_app(s)) as c:
        _wait(c)
        yield c


def post(c, data, **fields):
    r = c.post("/v1/process", files={"file": ("a.wav", data, "audio/wav")}, data=fields)
    return r


def post_file(c, path, **fields):
    return post(c, open(path, "rb").read(), **fields)


def check_shape(j, info):
    assert set(j) >= {"language", "duration", "processing_time", "utterances"}
    prev = -1
    for u in j["utterances"]:
        assert set(u) == {"start", "end", "text", "lang", "event", "speech_prob", "embedding"}
        assert 0 <= u["start"] < u["end"] <= j["duration"] + 0.05
        assert u["start"] >= prev
        prev = u["start"]
        assert u["event"] in ("speech", "music", "noise", "laughter", "applause", "other")
        assert 0 <= u["speech_prob"] <= 1
        assert u["end"] - u["start"] <= 25.5
        if u["embedding"] is not None:
            assert len(u["embedding"]) == info["embedding_dim"] and all(isinstance(x, float) for x in u["embedding"])


def test_info(client):
    i = client.get("/v1/info").json()
    assert i["asr_model"] == "sensevoice-small-int8" and i["embedding_dim"] == 192
    assert i["features"] == {"speaker_embedding": True, "event_tags": True}
    assert i["languages"] == ["zh", "en", "ja", "ko", "yue"]


@need_sherpa
@pytest.mark.parametrize("lang,needle", [("zh", "开放时间"), ("en", "tribal chieftain"), ("ja", "弁当"), ("ko", "생각"),
                                         ("yue", "表达唔到")])
def test_sherpa_samples(client, lang, needle):
    info = client.get("/v1/info").json()
    j = post_file(client, SV / f"{lang}.wav").json()
    check_shape(j, info)
    text = " ".join(u["text"] for u in j["utterances"]).replace(" ", "") if lang != "en" else " ".join(u["text"] for u in j["utterances"]).lower()
    assert needle.replace(" ", "") in text.replace(" ", "") if lang != "en" else needle in text
    assert j["language"] == lang
    assert j["utterances"][0]["lang"] == lang and j["utterances"][0]["event"] == "speech"
    assert j["utterances"][0]["embedding"] is not None


@need_sherpa
def test_language_hint_is_accepted(client):
    j = post_file(client, SV / "zh.wav", language="zh").json()
    assert "开放时间" in j["utterances"][0]["text"]


@need_sherpa
def test_stereo_44k_float_input_gives_same_transcript(client):
    x, sr = sf.read(SV / "zh.wav", dtype="float32")
    from murmur_asr.audio import resample

    y = resample(x, sr, 44100)
    data = wav_bytes(np.stack([y, y * 0.9], axis=1), sr=44100, subtype="float32")
    j = post(client, data).json()
    assert "开放时间" in "".join(u["text"] for u in j["utterances"])
    assert abs(j["duration"] - len(x) / sr) < 0.01


def test_silence_and_noise_give_no_utterances(client):
    assert post(client, wav_bytes(np.zeros(16000 * 10, np.float32))).json()["utterances"] == []
    rng = np.random.default_rng(0)
    noise = (0.003 * rng.standard_normal(16000 * 10)).astype(np.float32)
    j = post(client, wav_bytes(noise)).json()
    assert j["utterances"] == [] and j["duration"] == 10.0
    j = post(client, wav_bytes(tone(5.0, 1000, amp=0.3))).json()  # a steady beep is not speech
    assert all(u["event"] != "speech" or not u["text"] for u in j["utterances"])


def test_errors_with_real_service(client):
    assert post(client, b"junk").status_code == 400
    assert post(client, b"").status_code == 400


@need_rooms
def test_family_room_turns_and_embeddings(client):
    info = client.get("/v1/info").json()
    meta = json.loads((TESTDATA / "room_family_zh.json").read_text())
    j = post_file(client, TESTDATA / "room_family_zh.wav").json()
    check_shape(j, info)
    assert j["language"] == "zh"
    turns = [e for e in meta["timeline"] if e["kind"] == "speech"]
    # every true turn is covered by at least one utterance with text
    for t in turns:
        cov = [u for u in j["utterances"] if min(u["end"], t["end"]) - max(u["start"], t["start"]) > 0.4 * (t["end"] - t["start"])]
        assert cov, f"turn {t} not found"
    # embeddings separate speakers: same-speaker pairs score far above different-speaker pairs
    items = []
    for u in j["utterances"]:
        best = max(turns, key=lambda t: min(u["end"], t["end"]) - max(u["start"], t["start"]))
        ov = min(u["end"], best["end"]) - max(u["start"], best["start"])
        if u["embedding"] and ov > 0.8 * (u["end"] - u["start"]):
            items.append((best["speaker"], np.array(u["embedding"])))
    cos = lambda a, b: float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))  # noqa: E731
    same = [cos(a, b) for (s1, a), (s2, b) in itertools.combinations(items, 2) if s1 == s2]
    diff = [cos(a, b) for (s1, a), (s2, b) in itertools.combinations(items, 2) if s1 != s2]
    assert len(same) >= 5 and len(diff) >= 20
    assert np.mean(same) > 0.65 and np.mean(diff) < 0.45 and np.mean(same) - np.mean(diff) > 0.3


@need_rooms
def test_mixed_language_room(client):
    meta = json.loads((TESTDATA / "room_mixed_zh_en.json").read_text())
    j = post_file(client, TESTDATA / "room_mixed_zh_en.wav").json()
    text = " ".join(u["text"] for u in j["utterances"]).lower()
    for word in ("meeting", "netflix", "amazon", "dishwasher", "dentist"):
        assert word in text, word
    assert {"zh", "en"} <= {u["lang"] for u in j["utterances"]}
    assert len([e for e in meta["timeline"] if e["kind"] == "speech"]) <= len(j["utterances"]) + 3


@need_rooms
def test_music_is_not_reported_as_speech(client):
    meta = json.loads((TESTDATA / "room_with_music_noise.json").read_text())
    j = post_file(client, TESTDATA / "room_with_music_noise.wav").json()
    for seg in (e for e in meta["timeline"] if e["kind"] == "music"):
        for u in j["utterances"]:
            inside = min(u["end"], seg["end"]) - max(u["start"], seg["start"]) > 0.7 * (u["end"] - u["start"])
            if inside:
                assert u["event"] == "music", (seg, u)
                assert u["embedding"] is None
    # and the real speech around it still comes through
    assert any("打疫苗" in u["text"] for u in j["utterances"])
    assert any("dishwasher" in u["text"].lower() or "forget" in u["text"].lower() for u in j["utterances"])


@need_rooms
def test_long_continuous_speech_is_split_below_limit(client):
    meta = json.loads((TESTDATA / "long_monologue_zh.json").read_text())
    j = post_file(client, TESTDATA / "long_monologue_zh.wav").json()
    assert len(j["utterances"]) >= 2
    assert max(u["end"] - u["start"] for u in j["utterances"]) <= 25.5
    spoken = sum(len(e["text"]) for e in meta["timeline"] if e["kind"] == "speech")
    got = sum(len(u["text"]) for u in j["utterances"])
    assert 0.8 < got / spoken < 1.2


@need_rooms
def test_concurrent_requests(client):
    out = []

    def go():
        out.append(post_file(client, TESTDATA / "room_family_zh.wav").status_code)

    ts = [threading.Thread(target=go) for _ in range(4)]  # > workers: some queue
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert out == [200] * 4


@need_rooms
def test_short_utterances_have_no_embedding():
    from murmur_asr.download_models import ensure_models
    from murmur_asr.pipeline import Engine

    s = Settings.from_env()
    s.min_embedding_seconds = 99.0
    eng = Engine(s, ensure_models(s))
    x, _ = sf.read(TESTDATA / "sherpa" / "sensevoice_test_wavs" / "zh.wav", dtype="float32")
    r = eng.process(x)
    assert r.utterances and all(u.embedding is None for u in r.utterances) and r.utterances[0].text


@need_rooms
def test_response_time_is_reasonable(client):
    t = time.perf_counter()
    j = post_file(client, TESTDATA / "room_family_zh.wav").json()
    assert (time.perf_counter() - t) / j["duration"] < 0.5  # RTF well under 0.5 even on a loaded CI box


# ---------------------------------------------------------------- whisper backend (optional, needs the tiny model)

def _tiny_present():
    s = Settings.from_env()
    return (s.model_dir / "sherpa-onnx-whisper-tiny" / "tiny-encoder.int8.onnx").exists()


@need_sherpa
@pytest.mark.skipif(not _tiny_present(), reason="whisper tiny not downloaded (python -m murmur_asr.download_models --backend whisper --whisper-model tiny)")
def test_whisper_backend_end_to_end():
    s = Settings.from_env()
    s.backend, s.whisper_model, s.workers = "whisper", "tiny", 1
    s.auto_download = False
    with TestClient(create_app(s)) as c:
        _wait(c)
        i = c.get("/v1/info").json()
        assert i["asr_model"] == "whisper-tiny-int8" and i["features"]["event_tags"] is False
        j = post_file(c, SV / "en.wav").json()
        assert j["utterances"] and j["utterances"][0]["event"] == "speech"
        assert "chief" in j["utterances"][0]["text"].lower() and j["utterances"][0]["lang"] == "en"
        assert len(j["utterances"][0]["embedding"]) == i["embedding_dim"]
        assert post(c, wav_bytes(np.zeros(32000, np.float32))).json()["utterances"] == []
