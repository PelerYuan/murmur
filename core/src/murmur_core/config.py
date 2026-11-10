"""Process-level configuration from environment variables (MURMUR_*).

Runtime-tunable behaviour (ASR/LLM endpoints, schedules, thresholds) lives in the settings table; see
settings_store.py. The env vars here only decide where things live and which roles run.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MURMUR_", extra="ignore")

    data_dir: Path = Field(default=Path("./data"))
    database_url: Optional[str] = None
    secret_key: Optional[str] = None
    role: str = "all"  # all | api | worker
    host: str = "0.0.0.0"
    port: int = 8000
    storage: str = "local"  # local | local:/path | s3://bucket/prefix
    web_dir: Optional[Path] = None
    log_level: str = "INFO"
    cookie_secure: bool = False
    max_upload_mb: int = 100

    # First-run defaults for runtime settings (the database wins once a value is saved).
    asr_url: Optional[str] = None
    asr_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'murmur.db').resolve()}"

    def resolve_web_dir(self) -> Optional[Path]:
        candidates = []
        if self.web_dir:
            candidates.append(self.web_dir)
        here = Path(__file__).resolve()
        candidates.append(here.parent / "web_dist")  # baked into the Docker image
        candidates.append(here.parents[3] / "web" / "dist")  # monorepo checkout
        for c in candidates:
            if (c / "index.html").is_file():
                return c
        return None


@lru_cache
def get_config() -> Config:
    return Config()
