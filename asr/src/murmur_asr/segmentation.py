"""Speech segmentation: silero VAD (via sherpa-onnx) plus pure merge/split post-processing.

Segments are expressed in samples at 16 kHz. The pure helpers (`merge_segments`,
`split_long`, `pad_segments`) do not depend on sherpa-onnx and are unit-tested directly.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SR = 16000
WINDOW = 512  # silero window at 16 kHz


@dataclass(frozen=True)
class Seg:
    start: int  # sample index, inclusive
    end: int  # sample index, exclusive

    @property
    def n(self) -> int:
        return self.end - self.start

    def seconds(self) -> float:
        return self.n / SR


def merge_segments(segs: list[Seg], max_gap: float, max_len: float) -> list[Seg]:
    """Join neighbours separated by <= max_gap seconds as long as the result stays <= max_len."""
    out: list[Seg] = []
    for s in sorted(segs, key=lambda s: s.start):
        if out and (s.start - out[-1].end) <= max_gap * SR and (s.end - out[-1].start) <= max_len * SR:
            out[-1] = Seg(out[-1].start, max(out[-1].end, s.end))
        else:
            out.append(s)
    return out


def split_long(samples: np.ndarray, seg: Seg, max_len: float, search: float = 0.4) -> list[Seg]:
    """Split a segment longer than max_len into pieces <= max_len.

    Each cut is placed at the quietest 30 ms frame within the last `search` fraction of the
    allowed length (so pieces stay reasonably long and cut in a pause instead of mid-word).
    """
    max_n = int(max_len * SR)
    if seg.n <= max_n:
        return [seg]
    frame = int(0.03 * SR)
    out: list[Seg] = []
    cur = seg.start
    while seg.end - cur > max_n:
        lo = cur + int(max_n * (1 - search))
        hi = cur + max_n
        region = samples[lo:hi]
        nf = len(region) // frame
        if nf < 2:
            cut = hi
        else:
            e = (region[: nf * frame].reshape(nf, frame) ** 2).mean(axis=1)
            cut = lo + int(np.argmin(e)) * frame + frame // 2
        out.append(Seg(cur, cut))
        cur = cut
    if seg.end > cur:
        out.append(Seg(cur, seg.end))
    return out


def enforce_max_len(samples: np.ndarray, segs: list[Seg], max_len: float) -> list[Seg]:
    out: list[Seg] = []
    for s in segs:
        out.extend(split_long(samples, s, max_len))
    return out


def drop_short(segs: list[Seg], min_len: float) -> list[Seg]:
    return [s for s in segs if s.n >= min_len * SR]


def pad_segments(segs: list[Seg], total: int, pad: float) -> list[Seg]:
    """Add `pad` seconds each side for the recogniser, never crossing the midpoint to a neighbour."""
    p = int(pad * SR)
    out: list[Seg] = []
    for i, s in enumerate(segs):
        lo = 0 if i == 0 else (segs[i - 1].end + s.start) // 2
        hi = total if i == len(segs) - 1 else (s.end + segs[i + 1].start) // 2
        out.append(Seg(max(lo, s.start - p), min(hi, s.end + p)))
    return out


class VadSegmenter:
    """Wraps sherpa-onnx VoiceActivityDetector; one instance per worker (not thread-safe)."""

    def __init__(self, model_path: str, *, threshold: float, min_silence: float, min_speech: float,
                 max_speech: float, num_threads: int = 1, provider: str = "cpu"):
        import sherpa_onnx as so

        cfg = so.VadModelConfig()
        cfg.silero_vad.model = model_path
        cfg.silero_vad.threshold = threshold
        cfg.silero_vad.min_silence_duration = min_silence
        cfg.silero_vad.min_speech_duration = min_speech
        cfg.silero_vad.max_speech_duration = max_speech
        cfg.silero_vad.window_size = WINDOW
        cfg.sample_rate = SR
        cfg.num_threads = num_threads
        cfg.provider = provider
        self._so = so
        self._cfg = cfg
        self._vad = so.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)
        # a second, frame-level silero instance used to compute the per-utterance speech density
        self._frame_model = so.VadModel.create(cfg)

    def segment(self, samples: np.ndarray) -> list[Seg]:
        vad = self._vad
        vad.reset()
        segs: list[Seg] = []

        def drain():
            while not vad.empty():
                s = vad.front
                segs.append(Seg(int(s.start), int(s.start) + len(s.samples)))
                vad.pop()

        # NOTE: feed exactly one window at a time. sherpa-onnx computes segment start offsets
        # wrongly (too late by up to seconds) when several windows are pushed in a single call.
        for i in range(0, len(samples), WINDOW):
            vad.accept_waveform(samples[i : i + WINDOW])
            if not vad.empty():
                drain()
        vad.flush()
        drain()
        vad.reset()
        return segs

    def speech_density(self, samples: np.ndarray) -> float:
        """Fraction of 32 ms silero windows judged speech (0..1). Proxy for 'speech_prob'."""
        m = self._frame_model
        m.reset()
        n = len(samples) // WINDOW
        if n == 0:
            return 0.0
        hits = 0
        for i in range(n):
            if m.is_speech(samples[i * WINDOW : (i + 1) * WINDOW]):
                hits += 1
        m.reset()
        return hits / n
