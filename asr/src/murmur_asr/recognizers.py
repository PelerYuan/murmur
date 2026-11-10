"""Pluggable speech recognisers behind the small `SpeechRecognizer` interface."""
from __future__ import annotations

import re
import zlib
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np

from .config import Settings
from .download_models import ModelPaths
from .events import map_event, normalize_lang, strip_tags

SR = 16000


@dataclass
class Recognition:
    text: str
    lang: str = "unknown"  # zh / en / ja ... or "unknown"
    event: str = "speech"  # contract vocabulary


class SpeechRecognizer(ABC):
    """Not thread-safe: every worker owns its own instance."""

    #: value reported as `asr_model` in /v1/info
    model_name: str = ""
    languages: tuple[str, ...] = ()
    supports_events: bool = False

    @abstractmethod
    def transcribe(self, samples: np.ndarray, language: str = "auto") -> Recognition:
        """Transcribe one VAD segment (<= ~25 s, 16 kHz mono float32)."""


class _LangCache:
    """Per-language recognisers. 'auto' is always loaded; explicit hints are LRU-cached."""

    def __init__(self, factory, size: int, auto_name: str = "auto"):
        self._factory, self._size, self._auto_name = factory, size, auto_name
        self._auto = None
        self._lru: OrderedDict[str, object] = OrderedDict()

    def get(self, lang: str):
        if lang in ("", "auto"):
            if self._auto is None:
                self._auto = self._factory(self._auto_name)
            return self._auto
        if lang in self._lru:
            self._lru.move_to_end(lang)
            return self._lru[lang]
        if self._size <= 0:
            return self.get("auto")
        r = self._factory(lang)
        self._lru[lang] = r
        while len(self._lru) > self._size:
            self._lru.popitem(last=False)
        return r


def _decode(rec, samples: np.ndarray):
    st = rec.create_stream()
    st.accept_waveform(SR, samples.astype(np.float32, copy=False))
    rec.decode_stream(st)
    return st.result


class SenseVoiceRecognizer(SpeechRecognizer):
    model_name = "sensevoice-small-int8"
    languages = ("zh", "en", "ja", "ko", "yue")
    supports_events = True

    def __init__(self, paths: ModelPaths, settings: Settings):
        import sherpa_onnx as so

        def make(lang: str):
            return so.OfflineRecognizer.from_sense_voice(
                model=str(paths.sensevoice_model), tokens=str(paths.sensevoice_tokens),
                num_threads=settings.num_threads, language=lang, use_itn=True, provider=settings.provider,
            )

        self._cache = _LangCache(make, settings.lang_cache, "auto")
        self._cache.get("auto")  # load eagerly so the first request is not slow

    def transcribe(self, samples: np.ndarray, language: str = "auto") -> Recognition:
        lang = language if language in self.languages else "auto"
        res = _decode(self._cache.get(lang), samples)
        return Recognition(
            text=strip_tags(res.text or ""),
            lang=normalize_lang(res.lang),
            event=map_event(res.event),
        )


# ---------------------------------------------------------------- whisper

_PHANTOMS = (
    "thank you for watching", "thanks for watching", "please subscribe", "subtitles by", "amara.org",
    "字幕由", "字幕志愿者", "请不要忘记订阅", "请订阅", "感谢观看", "謝謝觀看", "ご視聴ありがとうございました",
    "시청해 주셔서 감사합니다",
)


def is_hallucination(text: str, audio_seconds: float) -> bool:
    """Heuristics for Whisper's well-known failure modes. True -> drop the utterance.

    * empty / punctuation-only output
    * the same short unit repeated many times ("谢谢谢谢谢谢…", "I'm sorry. I'm sorry. …")
      (zlib compression ratio and explicit n-gram repetition)
    * stock phantom phrases on very short audio ("Thank you for watching", "字幕由…")
    * implausible text rate (more than ~25 characters per audio second)
    """
    t = text.strip()
    if not re.sub(r"[\W_]+", "", t, flags=re.UNICODE):
        return True
    low = t.lower()
    if audio_seconds < 6.0 and any(p in low for p in _PHANTOMS):
        return True
    if len(t) / max(audio_seconds, 0.1) > 25:
        return True
    b = t.encode("utf-8")
    if len(b) >= 40 and len(b) / len(zlib.compress(b)) > 2.4:
        return True
    squeezed = re.sub(r"\s+", "", t)
    for unit in range(1, 13):
        if len(squeezed) < unit * 5:
            break
        m = re.search(r"(.{%d})\1{4,}" % unit, squeezed)
        if m and len(m.group(0)) >= max(10, len(squeezed) * 0.5):
            return True
    return False


class WhisperRecognizer(SpeechRecognizer):
    """sherpa-onnx Whisper (int8). Optional alternative backend; emits no event tags."""

    languages = ("auto",)  # any whisper language code is accepted as a hint
    supports_events = False

    def __init__(self, paths: ModelPaths, settings: Settings):
        import sherpa_onnx as so

        self.model_name = f"whisper-{settings.whisper_model}-int8"

        def make(lang: str):
            return so.OfflineRecognizer.from_whisper(
                encoder=str(paths.whisper_encoder), decoder=str(paths.whisper_decoder),
                tokens=str(paths.whisper_tokens), language=lang, task="transcribe",
                num_threads=settings.num_threads, provider=settings.provider,
            )

        self._cache = _LangCache(make, settings.lang_cache, "")  # '' = whisper language detection
        self._cache.get("auto")

    def transcribe(self, samples: np.ndarray, language: str = "auto") -> Recognition:
        res = _decode(self._cache.get(language if re.fullmatch(r"[a-z]{2,3}", language or "") else "auto"), samples)
        text = (res.text or "").strip()
        if is_hallucination(text, len(samples) / SR):
            return Recognition(text="")
        lang = normalize_lang(getattr(res, "lang", None)) if getattr(res, "lang", None) else (
            language if language not in ("", "auto") else "unknown")
        return Recognition(text=text, lang=lang, event="speech")


def create_recognizer(paths: ModelPaths, settings: Settings) -> SpeechRecognizer:
    if settings.backend == "whisper":
        return WhisperRecognizer(paths, settings)
    return SenseVoiceRecognizer(paths, settings)
