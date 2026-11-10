"""Shared runtime container: config, database, storage, settings. Used by the API and the workers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import httpx
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import Config
from .db import init_db, make_engine, make_session_factory, session_scope
from .security import Crypto, LoginLimiter
from .settings_store import AllSettings, SettingsStore
from .storage import Storage, make_storage


@dataclass
class Runtime:
    config: Config
    engine: Engine
    sessions: sessionmaker[Session]
    storage: Storage
    crypto: Crypto
    settings: SettingsStore
    limiter: LoginLimiter = field(default_factory=LoginLimiter)
    # Test hooks: inject httpx transports so ASR/LLM calls can be served by in-process fakes.
    asr_transport: Optional[httpx.BaseTransport] = None
    llm_transport: Optional[httpx.BaseTransport] = None

    def scope(self):
        return session_scope(self.sessions)

    def load_settings(self) -> AllSettings:
        with self.scope() as s:
            return self.settings.get(s)


def build_runtime(config: Config, storage: Optional[Storage] = None) -> Runtime:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    engine = make_engine(config.db_url)
    init_db(engine)
    crypto = Crypto.from_config(config.secret_key, config.data_dir)
    return Runtime(
        config=config,
        engine=engine,
        sessions=make_session_factory(engine),
        storage=storage or make_storage(config.storage, config.data_dir),
        crypto=crypto,
        settings=SettingsStore(config, crypto),
    )
