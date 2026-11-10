from __future__ import annotations

import hashlib
import io
import json
import wave
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from murmur_core.app import create_app
from murmur_core.config import Config
from murmur_core.runtime import build_runtime


def make_wav(seconds: float = 3.0, rate: int = 16000, freq: float = 220.0) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    samples = (np.sin(2 * np.pi * freq * t) * 8000).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


class FakeAsr:
    """In-process stand-in for the ASR service; tests script what it returns."""

    def __init__(self):
        self.responses: list = []  # list of dicts or Exceptions, consumed in order; last one repeats
        self.calls = 0
        self.fail_status: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/info":
            return httpx.Response(200, json={"name": "fake-asr", "version": "0", "embedding_dim": 4})
        self.calls += 1
        if self.fail_status:
            return httpx.Response(self.fail_status, json={"detail": "boom"})
        item = self.responses[min(self.calls - 1, len(self.responses) - 1)]
        return httpx.Response(200, json=item)


class FakeLlm:
    def __init__(self):
        self.requests: list[dict] = []
        self.summary_text = "## 摘要\n- 讨论了周末计划"
        self.todos_reply: dict = {"todos": []}
        self.fail = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if self.fail:
            return httpx.Response(500, text="llm down")
        prompt = body["messages"][-1]["content"]
        if body.get("response_format"):
            content = json.dumps(self.todos_reply, ensure_ascii=False)
        elif "pong" in prompt:
            content = "pong"
        else:
            content = self.summary_text
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}}]})


def utt(start, end, text, emb, event="speech", prob=0.95):
    return {"start": start, "end": end, "text": text, "lang": "zh", "event": event, "speech_prob": prob, "embedding": emb}


# Four clearly separated 4-d "voices" for speaker tests.
VOICE_A = [1.0, 0.05, 0.0, 0.0]
VOICE_A2 = [0.97, 0.12, 0.02, 0.0]
VOICE_B = [0.0, 1.0, 0.05, 0.0]
VOICE_C = [0.0, 0.0, 1.0, 0.1]


@pytest.fixture
def asr():
    return FakeAsr()


@pytest.fixture
def llm():
    return FakeLlm()


@pytest.fixture
def rt(tmp_path, asr, llm):
    config = Config(data_dir=tmp_path / "data", secret_key="test-secret")
    runtime = build_runtime(config)
    runtime.asr_transport = httpx.MockTransport(asr.handler)
    runtime.llm_transport = httpx.MockTransport(llm.handler)
    return runtime


@pytest.fixture
def client(rt):
    app = create_app(rt.config, runtime=rt, start_background=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def authed(client):
    r = client.post("/api/v1/auth/setup", json={"password": "secret123"})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture
def recorder(authed):
    room = authed.post("/api/v1/rooms", json={"name": "客厅"}).json()
    rec = authed.post("/api/v1/recorders", json={"name": "Living room mic", "room_id": room["id"]}).json()
    return {"room": room, "recorder": rec, "headers": {"Authorization": f"Bearer {rec['token']}"}}


def upload(client, recorder, started_at: datetime, wav: bytes | None = None, duration: float = 3.0):
    wav = wav or make_wav(duration, freq=200 + (int(started_at.timestamp()) % 1000) * 3)
    sha = hashlib.sha256(wav).hexdigest()
    return client.post(
        "/api/v1/recorder/chunks",
        headers=recorder["headers"],
        files={"file": ("c.wav", wav, "audio/wav")},
        data={"started_at": started_at.isoformat() + "Z", "duration": str(duration), "sha256": sha},
    )
