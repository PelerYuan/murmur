"""One worker's complete pipeline: VAD -> merge/split -> recognise -> speaker embedding."""
from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from .config import Settings
from .download_models import ModelPaths
from .embedding import SpeakerEmbedder
from .recognizers import SpeechRecognizer, create_recognizer
from .segmentation import (SR, Seg, VadSegmenter, drop_short, enforce_max_len, merge_segments, pad_segments)


@dataclass
class Utterance:
    start: float
    end: float
    text: str
    lang: str
    event: str
    speech_prob: float
    embedding: list[float] | None

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 3), "end": round(self.end, 3), "text": self.text, "lang": self.lang,
            "event": self.event, "speech_prob": round(self.speech_prob, 3), "embedding": self.embedding,
        }


@dataclass
class ProcessResult:
    language: str
    duration: float
    processing_time: float
    utterances: list[Utterance] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "language": self.language, "duration": round(self.duration, 3),
            "processing_time": round(self.processing_time, 3),
            "utterances": [u.to_dict() for u in self.utterances],
        }


def dominant_language(utts: list[Utterance], hint: str) -> str:
    weight: dict[str, float] = defaultdict(float)
    for u in utts:
        if u.text and u.lang != "unknown":
            weight[u.lang] += u.end - u.start
    if weight:
        return max(weight, key=weight.get)
    return hint if hint not in ("", "auto") else "unknown"


class Engine:
    """Holds one copy of every model. Not thread-safe; used by one request at a time."""

    def __init__(self, settings: Settings, paths: ModelPaths):
        self.settings = settings
        self.vad = VadSegmenter(
            str(paths.vad), threshold=settings.vad_threshold, min_silence=settings.vad_min_silence,
            min_speech=settings.vad_min_speech, max_speech=settings.max_segment_seconds,
            num_threads=1, provider="cpu",  # silero is tiny; keep it on CPU even with a GPU provider
        )
        self.recognizer: SpeechRecognizer = create_recognizer(paths, settings)
        self.embedder = SpeakerEmbedder(str(paths.embedding), settings.num_threads, settings.provider)

    @property
    def asr_model(self) -> str:
        return self.recognizer.model_name

    @property
    def embedding_dim(self) -> int:
        return self.embedder.dim

    def segments(self, samples: np.ndarray) -> list[Seg]:
        s = self.settings
        segs = merge_segments(self.vad.segment(samples), s.merge_gap, s.max_segment_seconds)
        segs = enforce_max_len(samples, segs, s.max_segment_seconds)
        return drop_short(segs, s.min_segment_seconds)

    def process(self, samples: np.ndarray, language: str = "auto") -> ProcessResult:
        t0 = time.perf_counter()
        s = self.settings
        language = (language or "auto").lower()
        segs = self.segments(samples)
        padded = pad_segments(segs, len(samples), s.segment_pad)
        out: list[Utterance] = []
        for seg, pseg in zip(segs, padded):
            rec = self.recognizer.transcribe(samples[pseg.start:pseg.end], language)
            if rec.event == "speech" and not rec.text:
                continue  # VAD false alarm / unintelligible
            core = samples[seg.start:seg.end]
            emb = None
            if rec.event == "speech" and seg.seconds() >= s.min_embedding_seconds:
                emb = self.embedder.embed(core)
            out.append(Utterance(
                start=seg.start / SR, end=seg.end / SR, text=rec.text, lang=rec.lang, event=rec.event,
                speech_prob=self.vad.speech_density(core), embedding=emb,
            ))
        return ProcessResult(
            language=dominant_language(out, language), duration=len(samples) / SR,
            processing_time=time.perf_counter() - t0, utterances=out,
        )
