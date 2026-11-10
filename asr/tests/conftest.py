from __future__ import annotations

import io
import os
import struct
from pathlib import Path

import numpy as np
import pytest

TESTDATA = Path(os.environ.get("MURMUR_TESTDATA", "/home/peler/murmur-testdata"))


def wav_bytes(x: np.ndarray, sr: int = 16000, subtype: str = "pcm16") -> bytes:
    """Minimal WAV writer. x: float array shaped (n,) or (n, ch) in [-1, 1]."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    ch = x.shape[1]
    if subtype == "pcm16":
        raw, tag, bits = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes(), 1, 16
    elif subtype == "pcm8":
        raw, tag, bits = ((np.clip(x, -1, 1) * 127) + 128).astype(np.uint8).tobytes(), 1, 8
    elif subtype == "pcm24":
        v = (np.clip(x, -1, 1) * 8388607).astype(np.int32).reshape(-1)
        raw = b"".join(struct.pack("<i", int(i))[:3] for i in v)
        tag, bits = 1, 24
    elif subtype == "pcm32":
        raw, tag, bits = (np.clip(x, -1, 1) * 2147483647).astype("<i4").tobytes(), 1, 32
    elif subtype == "float32":
        raw, tag, bits = x.astype("<f4").tobytes(), 3, 32
    else:
        raise ValueError(subtype)
    fmt = struct.pack("<HHIIHH", tag, ch, sr, sr * ch * bits // 8, ch * bits // 8, bits)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(raw)) + raw
    return b"RIFF" + struct.pack("<I", len(body)) + body


def tone(seconds=1.0, freq=440.0, sr=16000, amp=0.5):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


@pytest.fixture
def make_wav():
    return wav_bytes


class FakeEngine:
    """Stands in for the model pipeline in API tests (no models needed)."""

    asr_model = "fake-asr"
    embedding_dim = 4

    class recognizer:  # noqa: N801
        supports_events = True

    delay = 0.0
    calls: list = []

    def __init__(self, settings=None):
        pass

    def process(self, samples, language="auto"):
        import time

        from murmur_asr.pipeline import ProcessResult, Utterance

        FakeEngine.calls.append((len(samples), language))
        time.sleep(FakeEngine.delay)
        dur = len(samples) / 16000
        utts = []
        if np.abs(samples).max() > 0.01:
            utts.append(Utterance(0.5, dur - 0.1, "你好 world", "zh", "speech", 0.9, [0.1, 0.2, 0.3, 0.4]))
        return ProcessResult(language="zh" if utts else "unknown", duration=dur, processing_time=0.001, utterances=utts)


@pytest.fixture(autouse=True)
def _reset_fake():
    FakeEngine.delay = 0.0
    FakeEngine.calls = []


@pytest.fixture
def fake_client():
    from fastapi.testclient import TestClient

    from murmur_asr.config import Settings
    from murmur_asr.service import create_app

    s = Settings(workers=2, max_upload_mb=1)
    with TestClient(create_app(s, engine_factory=FakeEngine)) as c:
        for _ in range(100):
            if c.get("/health").status_code == 200:
                break
            import time

            time.sleep(0.05)
        yield c
