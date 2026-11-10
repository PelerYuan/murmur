"""Minimal WAV helpers (16 kHz mono 16-bit PCM, the Murmur audio format)."""

from __future__ import annotations

import io
import struct
import wave
from typing import Tuple

SAMPLE_RATE = 16000
HEADER_BYTES = 44


def wav_bytes(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def wav_duration_from_size(size: int, sample_rate: int = SAMPLE_RATE) -> float:
    return max(0, size - HEADER_BYTES) / 2 / sample_rate


def read_wav_header(path: str) -> Tuple[int, int, int, int]:
    """Return (channels, sample_width, rate, frames); raises ValueError/wave.Error if invalid."""
    with wave.open(path, "rb") as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


def is_valid_chunk_wav(path: str) -> bool:
    try:
        ch, sw, rate, frames = read_wav_header(path)
    except (wave.Error, EOFError, OSError, struct.error):
        return False
    return ch == 1 and sw == 2 and rate == SAMPLE_RATE and frames > 0
