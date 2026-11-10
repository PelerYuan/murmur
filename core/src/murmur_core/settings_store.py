"""Runtime settings: typed groups stored as JSON in the settings table, secrets encrypted at rest."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from .config import Config
from .models import Setting
from .security import Crypto

MASK = "***"


class _Group(BaseModel):
    model_config = ConfigDict(extra="ignore")


class General(_Group):
    timezone: str = "Asia/Shanghai"
    ui_language: str = "zh"
    output_language: str = "zh"


class Asr(_Group):
    mode: str = "murmur"  # murmur | openai
    base_url: str = "http://localhost:8100"
    api_key: str = ""
    model: str = ""
    language: str = "auto"
    timeout_seconds: int = Field(300, ge=5, le=3600)
    concurrency: int = Field(2, ge=1, le=16)

    @field_validator("mode")
    @classmethod
    def _mode(cls, v: str) -> str:
        if v not in ("murmur", "openai"):
            raise ValueError("asr.mode must be 'murmur' or 'openai'")
        return v


class Prompts(_Group):
    summary: str = ""
    daily: str = ""
    todos: str = ""


class Llm(_Group):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    temperature: float = Field(0.3, ge=0, le=2)
    max_input_chars: int = Field(24000, ge=2000, le=1_000_000)
    timeout_seconds: int = Field(180, ge=5, le=3600)
    prompts: Prompts = Prompts()


class Speakers(_Group):
    match_threshold: float = Field(0.55, ge=0, le=1)
    cluster_threshold: float = Field(0.60, ge=0, le=1)
    sample_count: int = Field(5, ge=0, le=20)
    sample_seconds: float = Field(5.0, ge=1, le=15)
    min_utterance_seconds: float = Field(0.8, ge=0, le=10)


class Filters(_Group):
    drop_non_speech: bool = True
    drop_hallucinations: bool = True
    min_confidence: float = Field(0.3, ge=0, le=1)
    min_text_chars: int = Field(1, ge=0, le=100)


class Retention(_Group):
    delete_audio_after_transcribe: bool = True
    failed_audio_days: int = Field(7, ge=0, le=3650)
    utterance_embedding_days: int = Field(30, ge=0, le=3650)


class Incremental(_Group):
    enabled: bool = True
    every_minutes: int = Field(30, ge=1, le=1440)
    min_utterances: int = Field(5, ge=1, le=10000)


class Hourly(_Group):
    enabled: bool = False


class Daily(_Group):
    enabled: bool = True
    time: str = "23:30"

    @field_validator("time")
    @classmethod
    def _time(cls, v: str) -> str:
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
            raise ValueError("schedule.daily.time must be HH:MM")
        return v


class Idle(_Group):
    enabled: bool = False
    idle_minutes: int = Field(10, ge=1, le=1440)


class Schedule(_Group):
    incremental: Incremental = Incremental()
    hourly: Hourly = Hourly()
    daily: Daily = Daily()
    idle: Idle = Idle()


class Todos(_Group):
    enabled: bool = True
    every_minutes: int = Field(10, ge=1, le=1440)
    min_confidence: float = Field(0.6, ge=0, le=1)
    default_remind_before_minutes: int = Field(10, ge=0, le=10080)


class AllSettings(_Group):
    general: General = General()
    asr: Asr = Asr()
    llm: Llm = Llm()
    speakers: Speakers = Speakers()
    filters: Filters = Filters()
    retention: Retention = Retention()
    schedule: Schedule = Schedule()
    todos: Todos = Todos()


SECRET_PATHS = [("asr", "api_key"), ("llm", "api_key")]


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class SettingsStore:
    def __init__(self, config: Config, crypto: Crypto):
        self.config = config
        self.crypto = crypto

    def _env_defaults(self) -> dict:
        c = self.config
        d: dict[str, dict] = {"asr": {}, "llm": {}}
        if c.asr_url:
            d["asr"]["base_url"] = c.asr_url
        if c.asr_api_key:
            d["asr"]["api_key"] = c.asr_api_key
        if c.llm_base_url:
            d["llm"]["base_url"] = c.llm_base_url
        if c.llm_api_key:
            d["llm"]["api_key"] = c.llm_api_key
        if c.llm_model:
            d["llm"]["model"] = c.llm_model
        return d

    def _stored(self, session: Session) -> dict:
        out: dict[str, Any] = {}
        for row in session.query(Setting).all():
            try:
                out[row.key] = json.loads(row.value_json)
            except json.JSONDecodeError:
                continue
        for group, field in SECRET_PATHS:
            val = out.get(group, {}).get(field)
            if isinstance(val, str):
                out[group][field] = self.crypto.decrypt(val)
        return out

    def get(self, session: Session) -> AllSettings:
        base = AllSettings().model_dump()
        merged = _deep_merge(base, self._env_defaults())
        merged = _deep_merge(merged, self._stored(session))
        return AllSettings.model_validate(merged)

    def get_public(self, session: Session) -> dict:
        data = self.get(session).model_dump()
        for group, field in SECRET_PATHS:
            if data[group][field]:
                data[group][field] = MASK
        return data

    def update(self, session: Session, patch: dict) -> AllSettings:
        if not isinstance(patch, dict):
            raise ValueError("settings patch must be an object")
        unknown = set(patch) - set(AllSettings.model_fields)
        if unknown:
            raise ValueError(f"unknown settings group: {', '.join(sorted(unknown))}")
        current = self.get(session).model_dump()
        for group, field in SECRET_PATHS:  # "***" means keep the stored secret
            if isinstance(patch.get(group), dict) and patch[group].get(field) == MASK:
                patch[group] = {k: v for k, v in patch[group].items() if k != field}
        merged = _deep_merge(current, patch)
        validated = AllSettings.model_validate(merged)
        dumped = validated.model_dump()
        for group in AllSettings.model_fields:
            if group not in patch:
                continue
            payload = dict(dumped[group])
            for g, f in SECRET_PATHS:
                if g == group:
                    payload[f] = self.crypto.encrypt(payload[f])
            row = session.get(Setting, group)
            if row is None:
                session.add(Setting(key=group, value_json=json.dumps(payload)))
            else:
                row.value_json = json.dumps(payload)
        session.flush()
        return validated


def read_state(session: Session, key: str, default: Any = None) -> Any:
    from .models import State

    row = session.get(State, key)
    if row is None:
        return default
    try:
        return json.loads(row.value_json)
    except json.JSONDecodeError:
        return default


def write_state(session: Session, key: str, value: Any) -> None:
    from .models import State

    row = session.get(State, key)
    payload = json.dumps(value)
    if row is None:
        session.add(State(key=key, value_json=payload))
    else:
        row.value_json = payload
    session.flush()
