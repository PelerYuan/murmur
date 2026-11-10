"""WAV decoding, down-mixing and resampling (numpy only).

The service contract says audio is 16 kHz mono 16-bit PCM, but real-world callers
(and tests) send other things, so we accept any RIFF/WAVE with integer PCM
(8/16/24/32 bit), IEEE float (32/64 bit) or WAVE_FORMAT_EXTENSIBLE wrappers of those,
any channel count and any sample rate.
"""
from __future__ import annotations

import struct

import numpy as np

from .errors import InvalidAudio, UnsupportedAudio

TARGET_SR = 16000

_FMT_PCM = 1
_FMT_FLOAT = 3
_FMT_EXTENSIBLE = 0xFFFE


def decode_wav(data: bytes) -> tuple[np.ndarray, int, int]:
    """Parse WAV bytes. Returns (float32 samples shaped (n, channels) in [-1, 1], sample_rate, channels)."""
    if len(data) < 12 or data[:4] not in (b"RIFF", b"RF64") or data[8:12] != b"WAVE":
        raise InvalidAudio("not a RIFF/WAVE file")
    pos = 12
    fmt = None
    pcm = None
    n = len(data)
    while pos + 8 <= n:
        cid = data[pos : pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        body = pos + 8
        if cid == b"fmt ":
            if size < 16 or body + 16 > n:
                raise InvalidAudio("truncated fmt chunk")
            tag, ch, sr, _br, _ba, bits = struct.unpack_from("<HHIIHH", data, body)
            if tag == _FMT_EXTENSIBLE and size >= 26 and body + 26 <= n:
                (tag,) = struct.unpack_from("<H", data, body + 24)  # first 2 bytes of the sub-format GUID
            fmt = (tag, ch, sr, bits)
        elif cid == b"data":
            end = n if (size == 0xFFFFFFFF or body + size > n) else body + size  # tolerate streamed/truncated files
            pcm = data[body:end]
            if fmt is not None:
                break
        pos = body + size + (size & 1)
    if fmt is None:
        raise InvalidAudio("missing fmt chunk")
    if pcm is None:
        raise InvalidAudio("missing data chunk")
    tag, ch, sr, bits = fmt
    if ch < 1 or ch > 16:
        raise InvalidAudio(f"invalid channel count {ch}")
    if sr < 4000 or sr > 384000:
        raise InvalidAudio(f"invalid sample rate {sr}")

    if tag == _FMT_PCM:
        if bits == 8:
            x = (np.frombuffer(pcm, dtype=np.uint8, count=len(pcm)).astype(np.float32) - 128.0) / 128.0
        elif bits == 16:
            x = np.frombuffer(pcm, dtype="<i2", count=len(pcm) // 2).astype(np.float32) / 32768.0
        elif bits == 24:
            m = len(pcm) // 3
            b = np.frombuffer(pcm, dtype=np.uint8, count=m * 3).reshape(-1, 3).astype(np.int32)
            v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
            v = np.where(v & 0x800000, v - 0x1000000, v)
            x = v.astype(np.float32) / 8388608.0
        elif bits == 32:
            x = np.frombuffer(pcm, dtype="<i4", count=len(pcm) // 4).astype(np.float32) / 2147483648.0
        else:
            raise UnsupportedAudio(f"unsupported PCM bit depth {bits}")
    elif tag == _FMT_FLOAT:
        if bits == 32:
            x = np.frombuffer(pcm, dtype="<f4", count=len(pcm) // 4).astype(np.float32)
        elif bits == 64:
            x = np.frombuffer(pcm, dtype="<f8", count=len(pcm) // 8).astype(np.float32)
        else:
            raise UnsupportedAudio(f"unsupported float bit depth {bits}")
        x = np.nan_to_num(x, nan=0.0, posinf=1.0, neginf=-1.0)
    else:
        raise UnsupportedAudio(f"unsupported WAV format tag {tag} (only PCM and IEEE float are supported)")

    frames = len(x) // ch
    x = x[: frames * ch].reshape(frames, ch)
    return x, sr, ch


def to_mono(x: np.ndarray) -> np.ndarray:
    """Average channels of an (n, channels) array into float32 mono."""
    if x.ndim == 1:
        return x.astype(np.float32, copy=False)
    if x.shape[1] == 1:
        return np.ascontiguousarray(x[:, 0], dtype=np.float32)
    return x.mean(axis=1, dtype=np.float32)


def resample(x: np.ndarray, sr_in: int, sr_out: int = TARGET_SR, half_width: int = 24) -> np.ndarray:
    """Band-limited (Hann-windowed sinc) resampler for 1-D float arrays."""
    if sr_in == sr_out or len(x) == 0:
        return x.astype(np.float32, copy=False)
    ratio = sr_out / sr_in
    cutoff = min(1.0, ratio) * 0.95  # fraction of the input Nyquist
    n_out = int(np.floor(len(x) * ratio))
    if n_out == 0:
        return np.zeros(0, dtype=np.float32)
    # taps are measured in input samples; widen when downsampling so the lowpass keeps its sharpness
    hw = int(np.ceil(half_width / min(1.0, ratio)))
    xp = np.concatenate([np.zeros(hw, np.float32), x.astype(np.float32, copy=False), np.zeros(hw + 1, np.float32)])
    taps = np.arange(-hw + 1, hw + 1)  # 2*hw taps
    out = np.empty(n_out, dtype=np.float32)
    block = 8192
    for s in range(0, n_out, block):
        idx = np.arange(s, min(n_out, s + block))
        t = idx / ratio  # position in input samples
        base = np.floor(t).astype(np.int64)
        frac = (t - base)[:, None]
        d = taps[None, :] - frac  # distance of each tap from t
        w = 0.5 * (1.0 + np.cos(np.pi * d / hw))
        w[np.abs(d) >= hw] = 0.0
        k = cutoff * np.sinc(cutoff * d) * w
        gather = base[:, None] + taps[None, :] + hw  # index into xp
        out[s : s + len(idx)] = (xp[gather] * k).sum(axis=1)
    return out


def load_audio(data: bytes, max_seconds: float | None = None) -> np.ndarray:
    """Decode WAV bytes to 16 kHz mono float32 in [-1, 1]."""
    if not data:
        raise InvalidAudio("empty upload")
    x, sr, _ch = decode_wav(data)
    if max_seconds is not None and len(x) / sr > max_seconds:
        from .errors import PayloadTooLarge

        raise PayloadTooLarge(f"audio is {len(x) / sr:.0f}s, limit is {max_seconds:.0f}s")
    mono = to_mono(x)
    return np.clip(resample(mono, sr, TARGET_SR), -1.0, 1.0)
