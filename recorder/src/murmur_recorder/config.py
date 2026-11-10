"""Local settings (env vars / CLI) and the remote config received in heartbeats."""

from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, Optional

log = logging.getLogger("murmur.config")


def _env_bool(v: Optional[str], default: bool = False) -> bool:
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    core_url: str = ""
    token: str = ""
    buffer_dir: str = "./buffer"
    source: str = "device"  # "device" or "file:/path/to.wav"
    file_speed: float = 1.0
    file_start_at: Optional[str] = None
    file_loop: bool = False
    buffer_max_mb: int = 2048
    heartbeat_interval: float = 10.0
    drain_timeout: float = 60.0  # file mode: how long to wait for the buffer to empty at EOF
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "Settings":
        e = os.environ if env is None else env
        s = cls()
        s.core_url = e.get("MURMUR_CORE_URL", s.core_url)
        s.token = e.get("MURMUR_TOKEN", s.token)
        s.buffer_dir = e.get("MURMUR_BUFFER_DIR", s.buffer_dir)
        s.source = e.get("MURMUR_SOURCE", s.source) or "device"
        s.file_speed = float(e.get("MURMUR_FILE_SPEED", s.file_speed))
        s.file_start_at = e.get("MURMUR_FILE_START_AT") or None
        s.file_loop = _env_bool(e.get("MURMUR_FILE_LOOP"), False)
        s.buffer_max_mb = int(e.get("MURMUR_BUFFER_MAX_MB", s.buffer_max_mb))
        s.heartbeat_interval = float(e.get("MURMUR_HEARTBEAT_INTERVAL", s.heartbeat_interval))
        s.drain_timeout = float(e.get("MURMUR_DRAIN_TIMEOUT", s.drain_timeout))
        s.log_level = e.get("MURMUR_LOG_LEVEL", s.log_level)
        return s

    @property
    def file_path(self) -> Optional[str]:
        if self.source.startswith("file:"):
            return self.source[5:]
        return None

    def validate(self) -> None:
        if not self.core_url:
            raise ValueError("MURMUR_CORE_URL / --core-url is required")
        if not self.token:
            raise ValueError("MURMUR_TOKEN / --token is required (create a recorder in the web UI)")
        if self.source != "device" and not self.source.startswith("file:"):
            raise ValueError(f"unsupported source {self.source!r}: use 'device' or 'file:/path/to.wav'")


@dataclass
class RemoteConfig:
    enabled: bool = True
    device: Optional[str] = None
    gain_db: float = 0.0
    vad_aggressiveness: int = 2
    min_speech_ms: int = 300
    end_silence_ms: int = 1200
    max_chunk_seconds: float = 60.0
    pre_roll_ms: int = 300

    # (min, max) for numeric clamps
    _LIMITS = {
        "gain_db": (-60.0, 60.0),
        "vad_aggressiveness": (0, 3),
        "min_speech_ms": (0, 10000),
        "end_silence_ms": (100, 30000),
        "max_chunk_seconds": (5.0, 600.0),
        "pre_roll_ms": (0, 5000),
    }

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]], base: Optional["RemoteConfig"] = None) -> "RemoteConfig":
        """Build from a (possibly partial / malformed) dict; bad values keep ``base``'s value."""
        out = RemoteConfig(**asdict(base)) if base else cls()
        for f in fields(cls):
            if f.name.startswith("_") or not d or f.name not in d:
                continue
            v = d[f.name]
            try:
                if f.name == "enabled":
                    out.enabled = bool(v)
                elif f.name == "device":
                    out.device = None if v is None or str(v).strip() == "" else str(v)
                else:
                    cur = getattr(out, f.name)
                    num = float(v) if isinstance(cur, float) else int(v)
                    lo, hi = cls._LIMITS[f.name]
                    setattr(out, f.name, type(cur)(min(hi, max(lo, num))))
            except (TypeError, ValueError):
                log.warning("ignoring invalid config value %s=%r", f.name, v)
        return out

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
