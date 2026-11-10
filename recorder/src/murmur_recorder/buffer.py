"""On-disk chunk buffer.

Files are ``<UTC start>.wav`` (e.g. ``20261111T083000.123Z.wav``) written atomically
(``.tmp`` then rename), so a crash never leaves a half-written ``.wav`` and the
filename sorts in time order.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from .wavio import is_valid_chunk_wav, wav_bytes, wav_duration_from_size

log = logging.getLogger("murmur.buffer")

_NAME_RE = re.compile(r"^(\d{8}T\d{6})\.(\d{3})Z\.wav$")


def format_name(started_at: float) -> str:
    ms_total = int(round(started_at * 1000))
    dt = datetime.fromtimestamp(ms_total // 1000, tz=timezone.utc)
    return f"{dt.strftime('%Y%m%dT%H%M%S')}.{ms_total % 1000:03d}Z.wav"


def parse_name(name: str) -> Optional[float]:
    m = _NAME_RE.match(name)
    if not m:
        return None
    dt = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    return dt.timestamp() + int(m.group(2)) / 1000.0


def iso_utc(epoch: float) -> str:
    """ISO 8601 UTC with Z, whole seconds (matches the API contract examples)."""
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class BufferedChunk:
    path: Path
    started_at: float
    size: int

    @property
    def duration(self) -> float:
        return wav_duration_from_size(self.size)


class ChunkBuffer:
    def __init__(self, directory: os.PathLike, max_bytes: int = 2 * 1024**3) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rejected_dir = self.dir / "rejected"
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self.evicted = 0
        self.cleanup_stale()

    def cleanup_stale(self) -> None:
        for p in self.dir.glob("*.tmp"):
            try:
                p.unlink()
            except OSError:
                pass

    # -- writing -------------------------------------------------------
    def write(self, pcm: bytes, started_at: float) -> BufferedChunk:
        with self._lock:
            ts = started_at
            path = self.dir / format_name(ts)
            while path.exists():  # ms collision: nudge forward
                ts += 0.001
                path = self.dir / format_name(ts)
            tmp = path.with_suffix(".wav.tmp")
            data = wav_bytes(pcm)
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        self.enforce_cap()
        return BufferedChunk(path, ts, len(data))

    # -- reading -------------------------------------------------------
    def list(self) -> List[BufferedChunk]:
        out = []
        try:
            entries = list(os.scandir(self.dir))
        except FileNotFoundError:
            return []
        for e in entries:
            ts = parse_name(e.name)
            if ts is None or not e.is_file():
                continue
            try:
                size = e.stat().st_size
            except OSError:
                continue
            out.append(BufferedChunk(Path(e.path), ts, size))
        out.sort(key=lambda c: (c.started_at, c.path.name))
        return out

    def count(self) -> int:
        return len(self.list())

    def total_bytes(self) -> int:
        return sum(c.size for c in self.list())

    # -- maintenance ---------------------------------------------------
    def remove(self, chunk: BufferedChunk) -> None:
        try:
            chunk.path.unlink()
        except FileNotFoundError:
            pass

    def quarantine(self, chunk: BufferedChunk, why: str) -> None:
        self.rejected_dir.mkdir(exist_ok=True)
        target = self.rejected_dir / chunk.path.name
        try:
            os.replace(chunk.path, target)
            log.error("moved %s to %s (%s)", chunk.path.name, target, why)
        except OSError:
            self.remove(chunk)

    def is_valid(self, chunk: BufferedChunk) -> bool:
        return is_valid_chunk_wav(str(chunk.path))

    def enforce_cap(self) -> int:
        """Delete oldest chunks until the buffer fits ``max_bytes``; returns number evicted."""
        if self.max_bytes <= 0:
            return 0
        chunks = self.list()
        total = sum(c.size for c in chunks)
        n = 0
        freed = 0
        while total > self.max_bytes and len(chunks) > 1:
            victim = chunks.pop(0)
            self.remove(victim)
            total -= victim.size
            freed += victim.size
            n += 1
        if n:
            self.evicted += n
            log.warning(
                "buffer over limit (%d MB): evicted %d oldest chunk(s), %.1f MB of audio LOST. "
                "Core has been unreachable for too long or the cap is too small "
                "(MURMUR_BUFFER_MAX_MB).",
                self.max_bytes // 1024**2,
                n,
                freed / 1024**2,
            )
        return n
