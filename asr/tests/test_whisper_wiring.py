"""Backend selection and the Whisper wrapper's behaviour, with the sherpa recogniser replaced by a fake."""
import sys
import types

import numpy as np

from murmur_asr import recognizers as R
from murmur_asr.config import Settings
from murmur_asr.download_models import ModelPaths
from pathlib import Path


class _Res:
    def __init__(self, text, lang=""):
        self.text, self.lang, self.event = text, lang, ""


class _FakeOffline:
    created = []
    next_text = "hello world"

    def __init__(self, kind, **kw):
        self.kind, self.kw = kind, kw
        _FakeOffline.created.append((kind, kw))

    def create_stream(self):
        return types.SimpleNamespace(accept_waveform=lambda sr, x: None, result=None)

    def decode_stream(self, st):
        st.result = _Res(_FakeOffline.next_text, "<|en|>")


def install_fake(monkeypatch):
    mod = types.ModuleType("sherpa_onnx")

    class OfflineRecognizer:
        from_whisper = staticmethod(lambda **kw: _FakeOffline("whisper", **kw))
        from_sense_voice = staticmethod(lambda **kw: _FakeOffline("sensevoice", **kw))

    mod.OfflineRecognizer = OfflineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", mod)
    _FakeOffline.created.clear()


PATHS = ModelPaths(vad=Path("v"), embedding=Path("e"), sensevoice_model=Path("m"), sensevoice_tokens=Path("t"),
                   whisper_encoder=Path("enc"), whisper_decoder=Path("dec"), whisper_tokens=Path("tok"))
X = np.zeros(16000 * 3, np.float32)


def test_factory_selects_backend(monkeypatch):
    install_fake(monkeypatch)
    assert isinstance(R.create_recognizer(PATHS, Settings(backend="sensevoice")), R.SenseVoiceRecognizer)
    w = R.create_recognizer(PATHS, Settings(backend="whisper", whisper_model="base"))
    assert isinstance(w, R.WhisperRecognizer) and w.model_name == "whisper-base-int8"
    assert not w.supports_events
    kinds = [k for k, _ in _FakeOffline.created]
    assert kinds == ["sensevoice", "whisper"]


def test_whisper_passes_provider_threads_and_language(monkeypatch):
    install_fake(monkeypatch)
    w = R.create_recognizer(PATHS, Settings(backend="whisper", num_threads=3, provider="cuda"))
    assert _FakeOffline.created[0][1]["language"] == "" and _FakeOffline.created[0][1]["num_threads"] == 3
    assert _FakeOffline.created[0][1]["provider"] == "cuda"
    w.transcribe(X, "zh")
    assert _FakeOffline.created[-1][1]["language"] == "zh"
    w.transcribe(X, "zh")  # cached, no new recogniser
    assert len(_FakeOffline.created) == 2
    w.transcribe(X, "not a code!")  # invalid hint falls back to auto-detect
    assert len(_FakeOffline.created) == 2


def test_whisper_always_speech_and_guard(monkeypatch):
    install_fake(monkeypatch)
    w = R.create_recognizer(PATHS, Settings(backend="whisper"))
    r = w.transcribe(X)
    assert (r.text, r.event, r.lang) == ("hello world", "speech", "en")
    _FakeOffline.next_text = "谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢"
    assert w.transcribe(X).text == ""  # hallucinated repetition dropped
    _FakeOffline.next_text = "Thank you for watching!"
    assert w.transcribe(X[:16000 * 2]).text == ""
    _FakeOffline.next_text = "hello world"


def test_sensevoice_language_cache_is_lru(monkeypatch):
    install_fake(monkeypatch)
    sv = R.create_recognizer(PATHS, Settings(backend="sensevoice", lang_cache=2))
    for lang in ("zh", "en", "ja", "zh"):
        sv.transcribe(X, lang)
    langs = [kw["language"] for _, kw in _FakeOffline.created]
    assert langs == ["auto", "zh", "en", "ja", "zh"]  # zh was evicted by ja, so it is rebuilt
    sv.transcribe(X, "klingon")  # unsupported -> auto
    assert len(_FakeOffline.created) == 5
