"""Pure, deterministic VAD segmenter.

No threads, no I/O and no wall clock: it is fed 16 kHz mono int16 PCM together
with the timestamp (UTC epoch seconds) of the first sample, and returns finished
:class:`Chunk` objects.

A chunk is: ``pre_roll_ms`` of audio before the first speech frame, the speech
itself (including short pauses), and ``end_silence_ms`` of trailing silence.

State machine (20 ms frames)::

    IDLE --(>= ONSET_MIN speech frames in the last ONSET_WINDOW)--> SPEECH
    SPEECH --(end_silence_ms without "active" frames)--> flush -> IDLE
    SPEECH --(max_chunk_seconds reached)--> flush -> keep going / IDLE

A frame is *active* when at least ``ACTIVE_MIN`` of the last ``ONSET_WINDOW``
VAD decisions were speech; this smooths the very spiky raw WebRTC output so an
isolated noise blip does not keep a chunk open and a 20 ms hole inside a word
does not end it.  A chunk whose speech span is shorter than ``min_speech_ms`` is
discarded (``Segmenter.discarded`` counts them).

To avoid chopping words in half on long monologues, once a chunk is longer than
``max_chunk_seconds - soft_cut_window`` it is cut at the first pause of
``soft_cut_silence_ms``; ``max_chunk_seconds`` is the hard limit.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from typing import Callable, Deque, List, Optional, Union

import numpy as np

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 320
FRAME_BYTES = FRAME_SAMPLES * 2

ONSET_WINDOW = 8  # frames (160 ms)
ONSET_MIN = 4  # speech frames in the window needed to open a chunk
ACTIVE_MIN = 2  # speech frames in the window for a frame to count as active
GAP_TOLERANCE_S = 1.0  # timestamp jump (s) that is treated as an audio discontinuity


@dataclass(frozen=True)
class SegmenterParams:
    vad_aggressiveness: int = 2
    min_speech_ms: int = 300
    end_silence_ms: int = 1200
    max_chunk_seconds: float = 60.0
    pre_roll_ms: int = 300
    soft_cut_window_seconds: float = 10.0
    soft_cut_silence_ms: int = 400


@dataclass
class Chunk:
    pcm: bytes  # 16 kHz mono int16 little-endian
    started_at: float  # UTC epoch seconds of the first sample
    speech_ms: int
    reason: str  # "silence" | "max" | "soft" | "flush" | "gap"

    @property
    def duration(self) -> float:
        return len(self.pcm) / 2 / SAMPLE_RATE


VadFn = Callable[[bytes], bool]


def _default_vad_factory(aggressiveness: int) -> VadFn:
    import webrtcvad

    vad = webrtcvad.Vad(max(0, min(3, int(aggressiveness))))

    def is_speech(frame: bytes) -> bool:
        return vad.is_speech(frame, SAMPLE_RATE)

    return is_speech


class Segmenter:
    def __init__(
        self,
        params: Optional[SegmenterParams] = None,
        vad_factory: Optional[Callable[[int], VadFn]] = None,
    ) -> None:
        self.params = params or SegmenterParams()
        self._vad_factory = vad_factory or _default_vad_factory
        self._vad = self._vad_factory(self.params.vad_aggressiveness)
        self.discarded = 0  # chunks dropped for being too short
        self.emitted = 0
        self.reset()

    # -- configuration -------------------------------------------------
    def update_params(self, params: SegmenterParams) -> None:
        """Apply new parameters without losing the in-progress chunk."""
        if params.vad_aggressiveness != self.params.vad_aggressiveness:
            self._vad = self._vad_factory(params.vad_aggressiveness)
        self.params = params

    def reset(self) -> None:
        """Forget everything (in-progress audio is dropped, use flush() first to keep it)."""
        self._buf = bytearray()
        self._buf_t: Optional[float] = None
        self._window: Deque[bool] = deque(maxlen=ONSET_WINDOW)
        self._ring: Deque[tuple] = deque()  # (t, frame) not yet part of a chunk
        self._in_speech = False
        self._frames: List[bytes] = []
        self._chunk_t: Optional[float] = None
        self._first_active = 0  # frame index inside the chunk
        self._last_active = 0
        self._silence_run = 0
        self._active_frames = 0

    # -- helpers -------------------------------------------------------
    @staticmethod
    def _ms_to_frames(ms: float) -> int:
        return max(0, int(round(ms / FRAME_MS)))

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    # -- feeding -------------------------------------------------------
    def feed(self, pcm: Union[bytes, np.ndarray], t: float) -> List[Chunk]:
        """Feed samples; ``t`` is the UTC epoch time of the first sample in ``pcm``."""
        if isinstance(pcm, np.ndarray):
            pcm = np.ascontiguousarray(pcm, dtype="<i2").tobytes()
        out: List[Chunk] = []
        if self._buf_t is not None:
            expected = self._buf_t + len(self._buf) / 2 / SAMPLE_RATE
            if abs(t - expected) > GAP_TOLERANCE_S:
                out.extend(self.flush(reason="gap"))
                self.reset()
        if not self._buf:
            self._buf_t = t
        self._buf.extend(pcm)
        base_t = self._buf_t
        n_frames = len(self._buf) // FRAME_BYTES
        pos = 0
        for k in range(n_frames):
            frame = bytes(self._buf[pos : pos + FRAME_BYTES])
            pos += FRAME_BYTES
            c = self._process_frame(frame, base_t + k * FRAME_MS / 1000.0)
            if c is not None:
                out.append(c)
        if pos:
            del self._buf[:pos]
            self._buf_t = base_t + n_frames * FRAME_MS / 1000.0
        return out

    def flush(self, reason: str = "flush") -> List[Chunk]:
        """Close the in-progress chunk (shutdown, pause, device switch)."""
        if not self._in_speech:
            self._ring.clear()
            return []
        c = self._finish(reason)
        return [c] if c is not None else []

    # -- core ----------------------------------------------------------
    def _process_frame(self, frame: bytes, t: float) -> Optional[Chunk]:
        p = self.params
        speech = bool(self._vad(frame))
        self._window.append(speech)
        votes = sum(self._window)

        if not self._in_speech:
            pre_frames = self._ms_to_frames(p.pre_roll_ms)
            self._ring.append((t, frame))
            # keep enough for the onset window + pre-roll
            while len(self._ring) > pre_frames + ONSET_WINDOW:
                self._ring.popleft()
            if len(self._window) >= ONSET_WINDOW and votes >= ONSET_MIN and speech:
                self._open_chunk(pre_frames)
            return None

        # in speech
        self._frames.append(frame)
        idx = len(self._frames) - 1
        if votes >= ACTIVE_MIN and speech:
            self._last_active = idx
            self._active_frames += 1
            self._silence_run = 0
        else:
            self._silence_run += 1

        end_frames = self._ms_to_frames(p.end_silence_ms)
        if self._silence_run >= end_frames:
            return self._finish("silence")
        max_frames = self._ms_to_frames(p.max_chunk_seconds * 1000)
        if len(self._frames) >= max_frames:
            return self._finish("max", continue_speech=self._silence_run == 0)
        soft_start = max_frames - self._ms_to_frames(p.soft_cut_window_seconds * 1000)
        if (
            len(self._frames) >= soft_start
            and self._silence_run >= self._ms_to_frames(p.soft_cut_silence_ms)
            and self._silence_run < end_frames
        ):
            return self._finish("soft")
        return None

    def _open_chunk(self, pre_frames: int) -> None:
        # The window holds the last ONSET_WINDOW decisions aligned with the tail of the ring.
        ring = list(self._ring)
        win = list(self._window)
        first_speech_in_ring = len(ring) - len(win) + win.index(True)
        start = max(0, first_speech_in_ring - pre_frames)
        sel = ring[start:]
        self._chunk_t = sel[0][0]
        self._frames = [f for _, f in sel]
        self._first_active = first_speech_in_ring - start
        self._last_active = len(self._frames) - 1
        self._active_frames = sum(1 for v in win if v)
        self._silence_run = 0
        self._in_speech = True
        self._ring.clear()

    def _finish(self, reason: str, continue_speech: bool = False) -> Optional[Chunk]:
        frames = self._frames
        t0 = self._chunk_t
        span = self._last_active - self._first_active + 1
        speech_ms = span * FRAME_MS
        next_t = t0 + len(frames) * FRAME_MS / 1000.0
        # Trailing silence beyond end_silence_ms can't happen (we flush at the threshold), but
        # on a forced flush trim excess silence down to end_silence_ms.
        keep = self._last_active + 1 + self._ms_to_frames(self.params.end_silence_ms)
        if reason in ("flush", "gap") and len(frames) > keep:
            frames = frames[:keep]
        chunk: Optional[Chunk] = None
        if speech_ms >= self.params.min_speech_ms and frames:
            chunk = Chunk(pcm=b"".join(frames), started_at=t0, speech_ms=speech_ms, reason=reason)
            self.emitted += 1
        else:
            self.discarded += 1
        # reset chunk state
        self._frames = []
        self._chunk_t = None
        self._ring.clear()
        if continue_speech:
            # long monologue hit the hard limit: next chunk starts seamlessly
            self._chunk_t = next_t
            self._first_active = 0
            self._last_active = 0
            self._active_frames = 0
            self._silence_run = 0
        else:
            self._in_speech = False
            self._window.clear()
        return chunk


def chunk_params_from_config(cfg: dict, base: Optional[SegmenterParams] = None) -> SegmenterParams:
    base = base or SegmenterParams()
    return replace(
        base,
        vad_aggressiveness=int(cfg.get("vad_aggressiveness", base.vad_aggressiveness)),
        min_speech_ms=int(cfg.get("min_speech_ms", base.min_speech_ms)),
        end_silence_ms=int(cfg.get("end_silence_ms", base.end_silence_ms)),
        max_chunk_seconds=float(cfg.get("max_chunk_seconds", base.max_chunk_seconds)),
        pre_roll_ms=int(cfg.get("pre_roll_ms", base.pre_roll_ms)),
    )
