"""Recorder orchestration: capture thread, heartbeat thread, uploader thread."""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from dataclasses import replace
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from . import __version__
from .buffer import ChunkBuffer
from .client import CoreClient, CoreError, CoreUnauthorized
from .config import RemoteConfig, Settings
from .devices import list_input_devices_subprocess, public_device
from .segmenter import SAMPLE_RATE, Segmenter, SegmenterParams, chunk_params_from_config
from .sources import (
    Block,
    DeviceSource,
    EndOfSource,
    FileSource,
    Source,
    SourceError,
    parse_start_at,
)
from .uploader import Uploader

log = logging.getLogger("murmur.recorder")

LEVEL_FLOOR_DB = -100.0
LEVEL_DECAY_DB_PER_S = 30.0
DEVICE_REFRESH_S = 30.0


def block_level_db(pcm: np.ndarray) -> float:
    """RMS level in dBFS of an int16 block (floor -100)."""
    if pcm.size == 0:
        return LEVEL_FLOOR_DB
    x = pcm.astype(np.float64) / 32768.0
    rms = math.sqrt(float(np.mean(x * x)))
    if rms <= 1e-5:
        return LEVEL_FLOOR_DB
    return max(LEVEL_FLOOR_DB, 20.0 * math.log10(rms))


def apply_gain(pcm: np.ndarray, gain_db: float) -> np.ndarray:
    if abs(gain_db) < 1e-6:
        return pcm
    g = 10.0 ** (gain_db / 20.0)
    return np.clip(pcm.astype(np.float32) * g, -32768, 32767).astype(np.int16)


class Recorder:
    def __init__(
        self,
        settings: Settings,
        client: Optional[CoreClient] = None,
        device_lister: Optional[Callable[[], List[Dict[str, Any]]]] = None,
        source_factory: Optional[Callable[[RemoteConfig], Source]] = None,
    ) -> None:
        self.settings = settings
        self.buffer = ChunkBuffer(settings.buffer_dir, max_bytes=settings.buffer_max_mb * 1024 * 1024)
        self.client = client or CoreClient(settings.core_url, settings.token)
        self.uploader = Uploader(self.buffer, self.client)
        self._device_lister = device_lister or list_input_devices_subprocess
        self._source_factory = source_factory or self._default_source_factory

        self.stop_event = threading.Event()
        self.finished = threading.Event()  # file source reached EOF and was fully processed
        self._cfg_lock = threading.Lock()
        self._cfg = RemoteConfig()
        self._cfg_cache_path = self.buffer.dir / ".murmur-config.json"
        self._config_ready = threading.Event()
        self._load_cached_config()

        self._st_lock = threading.Lock()
        self._state = "starting"
        self._error: Optional[str] = None
        self._level_db = LEVEL_FLOOR_DB
        self._active_device: Optional[str] = None

        self._devices: List[Dict[str, Any]] = []
        self._devices_at = 0.0
        self._devices_err_logged = False
        self._hb_failures = 0
        self._hb_last_log = 0.0
        self._hb_ok_once = False
        self._unauthorized = False

        self.segmenter = Segmenter(self._seg_params(self._cfg))
        self._threads: List[threading.Thread] = []
        self.chunks_written = 0

    # ------------------------------------------------------------------ config
    def _load_cached_config(self) -> None:
        try:
            d = json.loads(self._cfg_cache_path.read_text())
            self._cfg = RemoteConfig.from_dict(d)
            self._config_ready.set()
            log.info("using cached config from last run (device=%r enabled=%s)", self._cfg.device, self._cfg.enabled)
        except (OSError, ValueError):
            pass

    def config(self) -> RemoteConfig:
        with self._cfg_lock:
            return self._cfg

    def apply_config(self, d: Dict[str, Any]) -> None:
        with self._cfg_lock:
            new = RemoteConfig.from_dict(d, base=self._cfg)
            changed = new != self._cfg
            self._cfg = new
        self._config_ready.set()
        if changed:
            log.info("config updated: %s", new.to_dict())
            try:
                tmp = self._cfg_cache_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(new.to_dict()))
                os.replace(tmp, self._cfg_cache_path)
            except OSError:
                pass

    @staticmethod
    def _seg_params(cfg: RemoteConfig) -> SegmenterParams:
        return chunk_params_from_config(cfg.to_dict())

    # ------------------------------------------------------------------ status
    def _set_state(self, state: str, error: Optional[str] = None, device: Optional[str] = None) -> None:
        with self._st_lock:
            self._state = state
            self._error = error
            if device is not None or state != "recording":
                self._active_device = device

    def status(self) -> Dict[str, Any]:
        with self._st_lock:
            state, err, dev, level = self._state, self._error, self._active_device, self._level_db
        if err is None and self.uploader.last_error:
            err = f"upload: {self.uploader.last_error}"
        if state != "recording":
            level = LEVEL_FLOOR_DB
        return {
            "state": state,
            "level_db": round(level, 1),
            "buffered_chunks": self.buffer.count(),
            "active_device": dev,
            "error": err,
        }

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        for name, target in (("capture", self._capture_loop), ("heartbeat", self._heartbeat_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
        self.uploader.start()
        pending = self.buffer.count()
        if pending:
            log.info("found %d buffered chunk(s) from a previous run; uploading in time order", pending)
            self.uploader.notify()

    def stop(self, timeout: float = 10.0) -> None:
        self.stop_event.set()
        self.uploader.stop()
        for t in self._threads:
            t.join(timeout)
        self.uploader.join(timeout)
        self.client.close()

    def wait(self) -> None:
        """Block until stop() or (file source) EOF + drained buffer."""
        while not self.stop_event.is_set():
            if self.finished.is_set():
                deadline = time.monotonic() + self.settings.drain_timeout
                while self.buffer.count() and time.monotonic() < deadline and not self.stop_event.is_set():
                    time.sleep(0.1)
                left = self.buffer.count()
                if left:
                    log.warning("file source finished but %d chunk(s) are still buffered (Core unreachable?)", left)
                return
            self.stop_event.wait(0.2)

    # ------------------------------------------------------------------ capture
    def _default_source_factory(self, cfg: RemoteConfig) -> Source:
        path = self.settings.file_path
        if path:
            return FileSource(
                path,
                speed=self.settings.file_speed,
                start_at=parse_start_at(self.settings.file_start_at),
                loop=self.settings.file_loop,
            )
        return DeviceSource(cfg.device)

    def _write_chunks(self, chunks) -> None:
        for c in chunks:
            try:
                bc = self.buffer.write(c.pcm, c.started_at)
            except OSError as e:
                log.error("cannot write chunk to %s: %s (chunk lost)", self.buffer.dir, e)
                self._set_state("error", f"buffer write failed: {e}", None)
                continue
            self.chunks_written += 1
            log.info("chunk %s: %.1fs (speech %.1fs, %s)", bc.path.name, c.duration, c.speech_ms / 1000, c.reason)
            self.uploader.notify()

    def _capture_loop(self) -> None:
        # Give the first heartbeat a moment to deliver config when there is no cached one.
        self._config_ready.wait(3.0)
        source: Optional[Source] = None
        src_key: Any = None
        is_file = self.settings.file_path is not None
        last_err_log = 0.0
        level = LEVEL_FLOOR_DB
        try:
            while not self.stop_event.is_set():
                cfg = self.config()
                if not cfg.enabled:
                    if source is not None:
                        self._write_chunks(self.segmenter.flush())
                        if not is_file:
                            source.close()
                            source, src_key = None, None
                    self._set_state("paused")
                    level = LEVEL_FLOOR_DB
                    self.stop_event.wait(0.2)
                    continue
                key = "file" if is_file else cfg.device
                if source is not None and key != src_key:
                    log.info("device changed %r -> %r: reopening stream", src_key, key)
                    self._write_chunks(self.segmenter.flush())
                    source.close()
                    source = None
                if source is None:
                    try:
                        source = self._source_factory(cfg)
                        source.open()
                        src_key = key
                        self._set_state("recording", None, source.active_device)
                        last_err_log = 0.0
                    except SourceError as e:
                        if source is not None:
                            source.close()
                        source = None
                        self._set_state("error", str(e), None)
                        if time.monotonic() - last_err_log > 60:
                            last_err_log = time.monotonic()
                            log.error("%s -- retrying every 5s", e)
                        self.stop_event.wait(5.0)
                        continue
                    except Exception as e:  # e.g. PortAudio missing
                        source = None
                        self._set_state("error", f"{type(e).__name__}: {e}", None)
                        if time.monotonic() - last_err_log > 60:
                            last_err_log = time.monotonic()
                            log.error("audio backend failure: %s: %s -- retrying every 5s", type(e).__name__, e)
                        self.stop_event.wait(5.0)
                        continue
                    self.segmenter.reset()

                self.segmenter.update_params(self._seg_params(cfg))
                try:
                    blk = source.read(0.2)
                except EndOfSource:
                    self._write_chunks(self.segmenter.flush())
                    log.info("file source finished")
                    self.finished.set()
                    return
                except SourceError as e:
                    self._write_chunks(self.segmenter.flush())
                    source.close()
                    source = None
                    self._set_state("error", str(e), None)
                    log.error("capture failed: %s -- reopening in 3s", e)
                    self.stop_event.wait(3.0)
                    continue
                if blk is None:
                    continue
                pcm = apply_gain(blk.pcm, cfg.gain_db)
                db = block_level_db(pcm)
                dt = len(pcm) / SAMPLE_RATE
                level = max(db, level - LEVEL_DECAY_DB_PER_S * dt)
                with self._st_lock:
                    self._level_db = level
                self._write_chunks(self.segmenter.feed(pcm, blk.t))
        except Exception:
            log.exception("capture thread crashed")
            self._set_state("error", "capture thread crashed (see logs)", None)
        finally:
            try:
                self._write_chunks(self.segmenter.flush())  # graceful shutdown: keep in-progress chunk
            finally:
                if source is not None:
                    source.close()

    # ------------------------------------------------------------------ heartbeat
    def _refresh_devices(self) -> None:
        now = time.monotonic()
        if self._devices_at and now - self._devices_at < DEVICE_REFRESH_S:
            return
        try:
            devs = self._device_lister()
            self._devices = [public_device(d) if "index" in d else d for d in devs]
            self._devices_err_logged = False
        except Exception as e:
            if not self._devices_err_logged:
                log.warning("cannot enumerate audio devices (%s: %s); is libportaudio2 installed?", type(e).__name__, e)
                self._devices_err_logged = True
        self._devices_at = now

    def heartbeat_once(self) -> bool:
        self._refresh_devices()
        try:
            resp = self.client.heartbeat(self._devices, self.status())
        except CoreUnauthorized as e:
            self._unauthorized = True
            self._hb_fail(
                f"Core rejected the recorder token ({e}). Check MURMUR_TOKEN or rotate the token in the web UI. "
                "Capturing continues; audio is buffered locally",
                level=logging.ERROR,
            )
            return False
        except CoreError as e:
            self._hb_fail(f"heartbeat failed: {e}")
            return False
        if self._hb_failures:
            log.info("heartbeat OK again after %d failure(s)", self._hb_failures)
        elif not self._hb_ok_once:
            log.info("connected to Core %s (recorder_id=%s)", self.settings.core_url, resp.get("recorder_id"))
        self._hb_ok_once = True
        self._unauthorized = False
        self._hb_failures = 0
        cfg = resp.get("config")
        if isinstance(cfg, dict):
            self.apply_config(cfg)
        else:
            self._config_ready.set()
        return True

    def _hb_fail(self, msg: str, level: int = logging.WARNING) -> None:
        self._hb_failures += 1
        now = time.monotonic()
        if self._hb_failures == 1 or now - self._hb_last_log > 300:
            self._hb_last_log = now
            log.log(level, "%s (failure #%d; retrying every %.0fs)", msg, self._hb_failures, self.settings.heartbeat_interval)
        self._config_ready.set()  # don't block capture start on an unreachable Core

    def _heartbeat_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.heartbeat_once()
            except Exception:
                log.exception("heartbeat loop error")
            try:  # liveness marker for the Docker HEALTHCHECK (independent of Core being reachable)
                (self.buffer.dir / ".alive").touch()
            except OSError:
                pass
            # token invalid: keep retrying, but slowly
            self.stop_event.wait(max(self.settings.heartbeat_interval, 30.0) if self._unauthorized
                                 else self.settings.heartbeat_interval)
