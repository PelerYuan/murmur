"""Audio sources.  Every source yields :class:`Block` (16 kHz mono int16 + UTC timestamp)."""

from __future__ import annotations

import logging
import queue
import threading
import time
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import numpy as np

from .segmenter import SAMPLE_RATE

log = logging.getLogger("murmur.source")


@dataclass
class Block:
    t: float  # UTC epoch seconds of first sample
    pcm: np.ndarray  # int16 mono 16 kHz


class SourceError(Exception):
    """Source failed (device vanished, stream error); caller reports state=error and retries."""


class EndOfSource(Exception):
    """File source reached EOF (and loop is off)."""


class Resampler:
    """Streaming mono int16 resampler to 16 kHz (soxr, high quality)."""

    def __init__(self, in_rate: int) -> None:
        self.in_rate = in_rate
        if in_rate == SAMPLE_RATE:
            self._stream = None
        else:
            import soxr

            self._stream = soxr.ResampleStream(in_rate, SAMPLE_RATE, 1, dtype="int16")

    def process(self, mono: np.ndarray, last: bool = False) -> np.ndarray:
        if self._stream is None:
            return mono
        out = self._stream.resample_chunk(mono, last=last)
        return np.asarray(out, dtype=np.int16).reshape(-1)


def to_mono_int16(raw: np.ndarray) -> np.ndarray:
    """(frames, channels) or (frames,) int16 -> mono int16 (channel average)."""
    if raw.ndim == 1:
        return raw
    if raw.shape[1] == 1:
        return raw[:, 0]
    return raw.astype(np.int32).mean(axis=1).astype(np.int16)


class Source:
    description = "source"
    active_device: Optional[str] = None

    def open(self) -> None: ...

    def read(self, timeout: float) -> Optional[Block]:
        """Next block, or None on timeout. May raise SourceError / EndOfSource."""
        raise NotImplementedError

    def close(self) -> None: ...


# --------------------------------------------------------------------------- device
class DeviceSource(Source):
    BLOCK_SECONDS = 0.1
    STALL_SECONDS = 4.0  # no audio for this long => stream considered dead
    # PortAudio's "high" latency can be as small as 0.1 s on ALSA, which overran on a VM loopback;
    # recording does not care about latency, so ask for a comfortable 0.5 s ring buffer.
    LATENCY_S = 0.5
    REANCHOR_S = 0.3  # ADC-clock vs sample-count mismatch that means samples were lost

    def __init__(self, device_spec: Optional[str]) -> None:
        self.device_spec = device_spec
        self._stream = None
        self._q: "queue.Queue[tuple]" = queue.Queue(maxsize=600)  # ~60 s of 100 ms blocks
        self._resampler: Optional[Resampler] = None
        self._channels = 1
        self._rate = SAMPLE_RATE
        self._t0 = 0.0
        self._n_out = 0
        self._anchored = False
        self._last_data = 0.0
        self._cb_error: Optional[str] = None
        self.overflows = 0
        self.dropped_blocks = 0
        self.description = f"device {device_spec or 'default'}"

    def open(self) -> None:
        import sounddevice as sd

        from .devices import list_input_devices, resolve_device

        devs = list_input_devices()
        try:
            dev = resolve_device(self.device_spec, devs)
        except LookupError as e:
            raise SourceError(str(e)) from e
        if dev is None:
            if not devs:
                raise SourceError("no input device available (is a microphone connected / is /dev/snd passed through?)")
            index = None  # PortAudio default
            default = next((d for d in devs if d["is_default"]), devs[0])
            default_rate, max_ch = default["default_samplerate"], default["channels"]
            self.active_device = default["id"]
        else:
            index = dev["index"]
            default_rate, max_ch = dev["default_samplerate"], dev["channels"]
            self.active_device = dev["id"]

        attempts = []
        for rate, ch in ((SAMPLE_RATE, 1), (default_rate, 1), (SAMPLE_RATE, min(2, max_ch)), (default_rate, min(2, max_ch))):
            if (rate, ch) not in attempts:
                attempts.append((rate, ch))
        last_err: Optional[Exception] = None
        for rate, ch, latency in [(r, c, lat) for r, c in attempts for lat in (self.LATENCY_S, "high")]:
            blocksize = int(rate * self.BLOCK_SECONDS)
            try:
                stream = sd.InputStream(
                    device=index,
                    samplerate=rate,
                    channels=ch,
                    dtype="int16",
                    blocksize=blocksize,
                    latency=latency,
                    callback=self._callback,
                )
                stream.start()
            except Exception as e:  # PortAudioError and friends
                last_err = e
                log.debug("open %s @%d Hz x%d failed: %s", self.active_device, rate, ch, e)
                continue
            self._stream, self._rate, self._channels = stream, rate, ch
            self._resampler = Resampler(rate)
            self._anchored = False
            self._last_data = time.monotonic()
            log.info(
                "capturing from %s at %d Hz, %d ch%s",
                self.active_device,
                rate,
                ch,
                "" if rate == SAMPLE_RATE else " (resampling to 16 kHz)",
            )
            return
        raise SourceError(f"cannot open input device {self.active_device!r}: {last_err}")

    # PortAudio thread: keep it trivial
    def _callback(self, indata, frames, time_info, status):  # noqa: ANN001
        if status:
            self.overflows += 1
            self._cb_error = str(status)
        # capture time of the first sample, from PortAudio's ADC clock (callbacks can arrive in bursts)
        delay = time_info.currentTime - time_info.inputBufferAdcTime
        if not 0.0 <= delay < 5.0:
            delay = frames / self._rate
        try:
            self._q.put_nowait((time.time() - delay, indata.copy()))
        except queue.Full:
            self.dropped_blocks += 1

    def read(self, timeout: float) -> Optional[Block]:
        try:
            wall, raw = self._q.get(timeout=timeout)
        except queue.Empty:
            if time.monotonic() - self._last_data > self.STALL_SECONDS:
                raise SourceError(f"no audio from {self.active_device} for {self.STALL_SECONDS:.0f}s (device unplugged?)")
            return None
        self._last_data = time.monotonic()
        if self._stream is not None and not self._stream.active:
            raise SourceError(f"stream on {self.active_device} stopped")
        mono = to_mono_int16(raw)
        pcm = self._resampler.process(mono)  # type: ignore[union-attr]
        if pcm.size == 0:
            return None
        # sample-count clock anchored to the wall clock at capture; re-anchor on big jumps (overflow, suspend)
        block_start_wall = wall
        if not self._anchored:
            self._t0, self._n_out, self._anchored = block_start_wall, 0, True
        expected = self._t0 + self._n_out / SAMPLE_RATE
        if abs(expected - block_start_wall) > self.REANCHOR_S:
            log.warning("audio clock jumped by %.1fs (overrun/suspend); re-anchoring", block_start_wall - expected)
            self._t0, self._n_out = block_start_wall, 0
            expected = self._t0
        t = expected
        self._n_out += len(pcm)
        return Block(t, pcm)

    def close(self) -> None:
        s, self._stream = self._stream, None
        if s is not None:
            try:
                s.stop()
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass
        while not self._q.empty():
            try:
                self._q.get_nowait()
            except queue.Empty:
                break


# --------------------------------------------------------------------------- file
def _read_wav_frames(w: wave.Wave_read, n: int) -> np.ndarray:
    raw = w.readframes(n)
    ch, sw = w.getnchannels(), w.getsampwidth()
    if sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.int16) - 128) << 8
    elif sw == 2:
        a = np.frombuffer(raw, dtype="<i2")
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        a = (b[:, 1].astype(np.int16) | (b[:, 2].astype(np.int16) << 8))  # top 16 bits
    elif sw == 4:
        a = (np.frombuffer(raw, dtype="<i4") >> 16).astype(np.int16)
    else:
        raise SourceError(f"unsupported WAV sample width {sw}")
    a = a.reshape(-1, ch)
    return to_mono_int16(a)


class FileSource(Source):
    """Plays a WAV through the same pipeline as a live device (for tests/demos)."""

    BLOCK_SECONDS = 0.1

    def __init__(self, path: str, speed: float = 1.0, start_at: Optional[float] = None, loop: bool = False) -> None:
        self.path = path
        self.speed = max(0.01, float(speed))
        self.start_at = start_at
        self.loop = loop
        self._w: Optional[wave.Wave_read] = None
        self._resampler: Optional[Resampler] = None
        self._media_samples = 0  # output samples (16 kHz) produced so far
        self._wall0 = 0.0
        self._t0 = 0.0
        self._eof = False
        self.active_device = f"file:{path}"
        self.description = f"file {path} (x{self.speed:g}{', loop' if loop else ''})"

    def open(self) -> None:
        try:
            self._w = wave.open(self.path, "rb")
        except (OSError, wave.Error, EOFError) as e:
            raise SourceError(f"cannot open WAV {self.path}: {e}") from e
        self._resampler = Resampler(self._w.getframerate())
        self._wall0 = time.monotonic()
        self._t0 = self.start_at if self.start_at is not None else time.time()
        log.info("playing %s: %d Hz %d ch, %.1fs, speed x%g", self.path, self._w.getframerate(),
                 self._w.getnchannels(), self._w.getnframes() / self._w.getframerate(), self.speed)

    def read(self, timeout: float) -> Optional[Block]:
        assert self._w is not None and self._resampler is not None
        # pacing: block k is "due" at wall0 + media_time/speed
        due = self._wall0 + (self._media_samples / SAMPLE_RATE) / self.speed
        wait = due - time.monotonic()
        if wait > 0.002:
            time.sleep(min(wait, timeout))
            if due - time.monotonic() > 0.002:
                return None
        n = int(self._w.getframerate() * self.BLOCK_SECONDS)
        mono = _read_wav_frames(self._w, n)
        if len(mono) == 0:
            if self.loop:
                self._w.rewind()
                self._resampler = Resampler(self._w.getframerate())
                return None
            if not self._eof:
                self._eof = True
                tail = self._resampler.process(np.zeros(0, dtype=np.int16), last=True)
                if tail.size:
                    blk = Block(self._t0 + self._media_samples / SAMPLE_RATE, tail)
                    self._media_samples += len(tail)
                    return blk
            raise EndOfSource()
        pcm = self._resampler.process(mono)
        if pcm.size == 0:
            return None
        blk = Block(self._t0 + self._media_samples / SAMPLE_RATE, pcm)
        self._media_samples += len(pcm)
        return blk

    def close(self) -> None:
        if self._w is not None:
            self._w.close()
            self._w = None


def parse_start_at(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()
