from __future__ import annotations

import io
import wave

import numpy as np


class WavError(ValueError):
    pass


def read_wav(data: bytes) -> tuple[np.ndarray, int, int]:
    """Returns (int16 samples shaped (n, channels), sample_rate, channels)."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            channels, width, rate, frames = wf.getnchannels(), wf.getsampwidth(), wf.getframerate(), wf.getnframes()
            raw = wf.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise WavError(f"not a valid WAV file: {exc}") from exc
    if width != 2:
        raise WavError("only 16-bit PCM WAV is supported")
    samples = np.frombuffer(raw, dtype="<i2").reshape(-1, channels)
    return samples, rate, channels


def wav_duration(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            return wf.getnframes() / float(wf.getframerate() or 1)
    except (wave.Error, EOFError) as exc:
        raise WavError(f"not a valid WAV file: {exc}") from exc


def write_wav(samples: np.ndarray, rate: int) -> bytes:
    samples = np.asarray(samples, dtype="<i2")
    channels = 1 if samples.ndim == 1 else samples.shape[1]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


def cut_wav(data: bytes, start: float, end: float) -> bytes:
    samples, rate, _ = read_wav(data)
    a = max(0, int(start * rate))
    b = min(len(samples), int(end * rate))
    if b <= a:
        raise WavError("empty cut")
    return write_wav(samples[a:b], rate)
