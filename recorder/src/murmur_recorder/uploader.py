"""Uploader thread: oldest-first, delete only after 200/201, exponential backoff."""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Optional

from .buffer import ChunkBuffer
from .client import CoreClient, CoreError, CoreRejected, CoreUnauthorized

log = logging.getLogger("murmur.uploader")


class Uploader(threading.Thread):
    def __init__(
        self,
        buffer: ChunkBuffer,
        client: CoreClient,
        backoff_initial: float = 1.0,
        backoff_cap: float = 60.0,
        idle_poll: float = 0.5,
    ) -> None:
        super().__init__(name="uploader", daemon=True)
        self.buffer = buffer
        self.client = client
        self.backoff_initial = backoff_initial
        self.backoff_cap = backoff_cap
        self.idle_poll = idle_poll
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.last_error: Optional[str] = None
        self.uploaded = 0
        self.duplicates = 0
        self._failures = 0
        self._next_try = 0.0
        self._last_logged = 0.0
        self._unauthorized = False

    def notify(self) -> None:
        self.wake.set()

    @property
    def unauthorized(self) -> bool:
        return self._unauthorized

    def stop(self) -> None:
        self.stop_event.set()
        self.wake.set()

    # -- one step (also used by tests) --------------------------------
    def step(self) -> str:
        """Try to upload the oldest chunk. Returns 'idle' | 'ok' | 'rejected' | 'backoff' | 'failed'."""
        now = time.monotonic()
        if now < self._next_try:
            return "backoff"
        chunks = self.buffer.list()
        if not chunks:
            return "idle"
        chunk = chunks[0]
        if not self.buffer.is_valid(chunk):
            self.buffer.quarantine(chunk, "not a valid 16 kHz mono 16-bit WAV (incomplete write?)")
            return "rejected"
        try:
            res = self.client.upload_chunk(chunk)
        except FileNotFoundError:
            return "ok"  # evicted concurrently
        except CoreRejected as e:
            self.buffer.quarantine(chunk, f"rejected by Core: {e}")
            return "rejected"
        except CoreUnauthorized as e:
            self._unauthorized = True
            self._fail(
                f"Core rejected the recorder token ({e}). Check MURMUR_TOKEN (rotate it in the web UI if needed); "
                f"audio keeps accumulating in {self.buffer.dir}",
                slow=True,
            )
            return "failed"
        except CoreError as e:
            self._fail(f"upload failed, will retry: {e}")
            return "failed"
        self.buffer.remove(chunk)
        self.uploaded += 1
        self.duplicates += int(res.duplicate)
        if self._failures:
            log.info("upload recovered after %d failure(s)", self._failures)
        self._failures = 0
        self._next_try = 0.0
        self._unauthorized = False
        self.last_error = None
        log.info(
            "uploaded %s (%.1fs)%s",
            chunk.path.name,
            chunk.duration,
            " [duplicate]" if res.duplicate else "",
        )
        return "ok"

    def _fail(self, msg: str, slow: bool = False) -> None:
        self._failures += 1
        delay = self.backoff_cap if slow else min(self.backoff_cap, self.backoff_initial * 2 ** (self._failures - 1))
        delay *= 0.85 + 0.3 * random.random()
        delay = min(delay, self.backoff_cap)
        self._next_try = time.monotonic() + delay
        self.last_error = msg
        now = time.monotonic()
        # log the first failure, then at most once per minute
        if self._failures == 1 or now - self._last_logged > 60:
            self._last_logged = now
            log.warning("%s (attempt %d, next retry in %.0fs, %d chunk(s) buffered)", msg, self._failures, delay,
                        self.buffer.count())

    def run(self) -> None:
        while not self.stop_event.is_set():
            r = self.step()
            if r in ("ok", "rejected"):
                continue
            # idle / backoff / failed: sleep until woken, stopped, or retry time
            wait = self.idle_poll
            if r in ("backoff", "failed"):
                wait = max(0.05, min(self.idle_poll, self._next_try - time.monotonic()))
            self.wake.wait(wait)
            self.wake.clear()
