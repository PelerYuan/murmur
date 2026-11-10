"""HTTP contract + error handling, with the model pipeline replaced by a fake (fast, no models needed)."""
import threading
import time

import numpy as np
from fastapi.testclient import TestClient

from conftest import FakeEngine, tone, wav_bytes
from murmur_asr.config import Settings
from murmur_asr.service import create_app


def post(c, data, **fields):
    return c.post("/v1/process", files={"file": ("a.wav", data, "audio/wav")}, data=fields)


def test_health_and_info(fake_client):
    assert fake_client.get("/health").json() == {"status": "ok"}
    i = fake_client.get("/v1/info").json()
    assert i["name"] == "murmur-asr" and i["embedding_dim"] == 4 and i["features"]["event_tags"] is True
    assert set(i) >= {"name", "version", "asr_model", "embedding_model", "embedding_dim", "languages", "features"}


def test_process_shape(fake_client):
    r = post(fake_client, wav_bytes(tone(3.0)))
    assert r.status_code == 200
    j = r.json()
    assert j["language"] == "zh" and abs(j["duration"] - 3.0) < 1e-6
    u = j["utterances"][0]
    assert set(u) == {"start", "end", "text", "lang", "event", "speech_prob", "embedding"}
    assert u["embedding"] == [0.1, 0.2, 0.3, 0.4]


def test_silence_returns_empty_list(fake_client):
    j = post(fake_client, wav_bytes(np.zeros(32000, np.float32))).json()
    assert j["utterances"] == [] and j["duration"] == 2.0


def test_zero_frame_wav(fake_client):
    r = post(fake_client, wav_bytes(np.zeros(0, np.float32)))
    assert r.status_code == 200 and r.json()["utterances"] == [] and r.json()["duration"] == 0


def test_language_is_forwarded(fake_client):
    post(fake_client, wav_bytes(tone(1.0)), language="EN")
    assert FakeEngine.calls[-1][1] == "en"
    post(fake_client, wav_bytes(tone(1.0)))
    assert FakeEngine.calls[-1][1] == "auto"


def test_resampling_and_stereo_are_applied_before_the_engine(fake_client):
    post(fake_client, wav_bytes(np.stack([tone(1.0, sr=44100)] * 2, axis=1), sr=44100))
    n, _ = FakeEngine.calls[-1]
    assert abs(n - 16000) <= 1


def test_corrupt_file(fake_client):
    r = post(fake_client, b"RIFFxxxxWAVEgarbage")
    assert r.status_code == 400 and r.json()["code"] == "invalid_audio" and r.json()["detail"]
    r = post(fake_client, b"\x00" * 100)
    assert r.status_code == 400 and r.json()["code"] == "invalid_audio"


def test_empty_file(fake_client):
    r = post(fake_client, b"")
    assert r.status_code == 400 and r.json()["code"] == "invalid_audio"


def test_unsupported_codec(fake_client):
    b = bytearray(wav_bytes(tone(0.5)))
    b[20:22] = (6).to_bytes(2, "little")  # A-law
    r = post(fake_client, bytes(b))
    assert r.status_code == 415 and r.json()["code"] == "unsupported_audio"


def test_missing_file_field_and_wrong_content_type(fake_client):
    r = fake_client.post("/v1/process", files={"other": ("a.wav", b"x")})
    assert r.status_code == 400 and r.json()["code"] == "invalid_audio"
    r = fake_client.post("/v1/process", json={"a": 1})
    assert r.status_code == 400 and "multipart" in r.json()["detail"]
    r = fake_client.post("/v1/process", content=b"x", headers={"content-type": "audio/wav"})
    assert r.status_code == 400


def test_oversized_upload_is_rejected(fake_client):  # fixture limit is 1 MB
    big = wav_bytes(np.zeros(16000 * 40, np.float32))  # 1.28 MB
    r = post(fake_client, big)
    assert r.status_code == 413 and r.json()["code"] == "payload_too_large"
    assert FakeEngine.calls == []


def test_oversized_streaming_body_without_content_length(fake_client):
    def gen():
        for _ in range(40):
            yield b"x" * 65536

    r = fake_client.post("/v1/process", content=gen(), headers={"content-type": "multipart/form-data; boundary=zzz"})
    assert r.status_code == 413 and r.json()["code"] == "payload_too_large"


def test_audio_too_long():
    s = Settings(workers=1, max_audio_seconds=2.0)
    with TestClient(create_app(s, engine_factory=FakeEngine)) as c:
        _wait(c)
        r = post(c, wav_bytes(tone(3.0)))
        assert r.status_code == 413 and r.json()["code"] == "payload_too_large"


def test_unknown_route_and_method(fake_client):
    r = fake_client.get("/nope")
    assert r.status_code == 404 and r.json()["code"] == "not_found"
    r = fake_client.get("/v1/process")
    assert r.status_code == 405 and "detail" in r.json()


def _wait(c, n=100):
    for _ in range(n):
        if c.get("/health").status_code == 200:
            return
        time.sleep(0.05)
    raise AssertionError("service never became healthy")


def test_api_key():
    s = Settings(workers=1, api_key="sekret")
    with TestClient(create_app(s, engine_factory=FakeEngine)) as c:
        _wait(c)
        assert c.get("/health").status_code == 200  # health stays open for container healthchecks
        assert c.get("/v1/info").status_code == 401
        r = post(c, wav_bytes(tone(1)))
        assert r.status_code == 401 and r.json()["code"] == "unauthorized"
        h = {"Authorization": "Bearer wrong"}
        assert c.get("/v1/info", headers=h).status_code == 401
        h = {"Authorization": "Bearer sekret"}
        assert c.get("/v1/info", headers=h).status_code == 200
        assert c.post("/v1/process", files={"file": ("a.wav", wav_bytes(tone(1)))}, headers=h).status_code == 200


def test_busy_when_queue_is_full():
    s = Settings(workers=1, max_queue=0)
    FakeEngine.delay = 0.6
    with TestClient(create_app(s, engine_factory=FakeEngine)) as c:
        _wait(c)
        res = {}

        def first():
            res["a"] = post(c, wav_bytes(tone(1)))

        t = threading.Thread(target=first)
        t.start()
        time.sleep(0.25)
        r = post(c, wav_bytes(tone(1)))
        t.join()
        assert r.status_code == 503 and r.json()["code"] == "busy" and r.headers.get("retry-after")
        assert res["a"].status_code == 200
        assert post(c, wav_bytes(tone(1))).status_code == 200  # recovers


def test_queueing_up_to_limit_serialises_on_one_worker():
    s = Settings(workers=1, max_queue=3)
    FakeEngine.delay = 0.15
    with TestClient(create_app(s, engine_factory=FakeEngine)) as c:
        _wait(c)
        codes = []
        ts = [threading.Thread(target=lambda: codes.append(post(c, wav_bytes(tone(1))).status_code)) for _ in range(4)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        assert codes == [200] * 4


def test_loading_state_then_ready():
    def slow(_s):
        time.sleep(0.5)
        return FakeEngine()

    with TestClient(create_app(Settings(workers=1), engine_factory=slow)) as c:
        r = c.get("/health")
        assert r.status_code == 503 and r.json()["status"] == "loading"
        assert post(c, wav_bytes(tone(1))).json()["code"] == "loading"
        _wait(c, 200)
        assert post(c, wav_bytes(tone(1))).status_code == 200


def test_load_failure_is_reported():
    def boom(_s):
        raise RuntimeError("no model")

    with TestClient(create_app(Settings(workers=1), engine_factory=boom)) as c:
        time.sleep(0.3)
        r = c.get("/health")
        assert r.status_code == 503 and r.json()["status"] == "error" and "no model" in r.json()["detail"]


def test_engine_exception_becomes_500_json():
    class Bad(FakeEngine):
        def process(self, samples, language="auto"):
            raise ValueError("kaboom")

    with TestClient(create_app(Settings(workers=1), engine_factory=Bad), raise_server_exceptions=False) as c:
        _wait(c)
        r = post(c, wav_bytes(tone(1)))
        assert r.status_code == 500 and r.json()["code"] == "internal_error"
        assert post(c, wav_bytes(tone(1))).status_code == 500  # the engine went back to the pool, service still alive
