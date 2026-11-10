"""Environment-driven configuration (all variables are prefixed ``MURMUR_ASR_``)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(f"MURMUR_ASR_{name}")
    if v is None or v.strip() == "":
        return default
    return v.strip()


def _int(name: str, default: int) -> int:
    v = _env(name)
    return default if v is None else int(v)


def _float(name: str, default: float) -> float:
    v = _env(name)
    return default if v is None else float(v)


def _bool(name: str, default: bool) -> bool:
    v = _env(name)
    return default if v is None else v.lower() in ("1", "true", "yes", "on")


def default_model_dir() -> Path:
    return Path(os.path.expanduser("~/.cache/murmur-models"))


@dataclass
class Settings:
    host: str = "0.0.0.0"
    port: int = 8100
    provider: str = "cpu"  # cpu | cuda
    num_threads: int = field(default_factory=lambda: min(4, os.cpu_count() or 1))
    workers: int = 2  # concurrent requests actually processed (= model copies in RAM)
    max_queue: int = 8  # extra requests allowed to wait; beyond that -> 503 busy
    model_dir: Path = field(default_factory=default_model_dir)
    backend: str = "sensevoice"  # sensevoice | whisper
    whisper_model: str = "small"  # tiny | base | small | medium | large-v3 ... (+ .en variants)
    api_key: str | None = None
    max_upload_mb: int = 100
    max_audio_seconds: float = 3600.0
    auto_download: bool = True
    download_proxy: str | None = None  # prefix replacing https://github.com in model URLs
    log_level: str = "INFO"

    # pipeline tuning
    vad_threshold: float = 0.5
    vad_min_silence: float = 0.3
    vad_min_speech: float = 0.25
    max_segment_seconds: float = 25.0
    merge_gap: float = 0.3
    min_segment_seconds: float = 0.3
    segment_pad: float = 0.25
    min_embedding_seconds: float = 0.8
    lang_cache: int = 2  # extra recognizers kept per worker for explicit language hints

    @classmethod
    def from_env(cls) -> "Settings":
        d = cls()
        d.host = _env("HOST", d.host)
        d.port = _int("PORT", d.port)
        d.provider = _env("PROVIDER", d.provider).lower()
        d.num_threads = _int("NUM_THREADS", d.num_threads)
        d.workers = max(1, _int("WORKERS", d.workers))
        d.max_queue = max(0, _int("MAX_QUEUE", d.max_queue))
        md = _env("MODEL_DIR")
        d.model_dir = Path(os.path.expanduser(md)) if md else default_model_dir()
        d.backend = _env("BACKEND", d.backend).lower()
        d.whisper_model = _env("WHISPER_MODEL", d.whisper_model)
        d.api_key = _env("API_KEY")
        d.max_upload_mb = _int("MAX_UPLOAD_MB", d.max_upload_mb)
        d.max_audio_seconds = _float("MAX_AUDIO_SECONDS", d.max_audio_seconds)
        d.auto_download = _bool("AUTO_DOWNLOAD", d.auto_download)
        d.download_proxy = _env("DOWNLOAD_PROXY")
        d.log_level = _env("LOG_LEVEL", d.log_level).upper()
        d.vad_threshold = _float("VAD_THRESHOLD", d.vad_threshold)
        d.vad_min_silence = _float("VAD_MIN_SILENCE", d.vad_min_silence)
        d.vad_min_speech = _float("VAD_MIN_SPEECH", d.vad_min_speech)
        d.max_segment_seconds = _float("MAX_SEGMENT_SECONDS", d.max_segment_seconds)
        d.merge_gap = _float("MERGE_GAP", d.merge_gap)
        d.min_embedding_seconds = _float("MIN_EMBEDDING_SECONDS", d.min_embedding_seconds)
        d.validate()
        return d

    def validate(self) -> None:
        if self.provider not in ("cpu", "cuda"):
            raise ValueError(f"MURMUR_ASR_PROVIDER must be cpu or cuda, got {self.provider!r}")
        if self.backend not in ("sensevoice", "whisper"):
            raise ValueError(f"MURMUR_ASR_BACKEND must be sensevoice or whisper, got {self.backend!r}")
        if self.max_segment_seconds < 5 or self.max_segment_seconds > 29:
            raise ValueError("MURMUR_ASR_MAX_SEGMENT_SECONDS must be within 5..29")
        if self.num_threads < 1:
            raise ValueError("MURMUR_ASR_NUM_THREADS must be >= 1")
