"""Mapping of model-specific event/language tags to the contract vocabulary."""
from __future__ import annotations

import re

EVENTS = ("speech", "music", "noise", "laughter", "applause", "other")

_MAP = {
    "speech": "speech",
    "bgm": "music",
    "music": "music",
    "sing": "music",
    "singing": "music",
    "song": "music",
    "applause": "applause",
    "laughter": "laughter",
    "laugh": "laughter",
    "cough": "noise",
    "sneeze": "noise",
    "breath": "noise",
    "noise": "noise",
    "cry": "other",
    "crying": "other",
}

_TAG = re.compile(r"<\|([^|>]*)\|>")


def map_event(raw: str | None) -> str:
    """`<|BGM|>` / 'BGM' / '' -> one of EVENTS. Empty or missing means plain speech."""
    if raw is None:
        return "speech"
    m = _TAG.search(raw)
    name = (m.group(1) if m else raw).strip().lower()
    if not name:
        return "speech"
    return _MAP.get(name, "other")


def normalize_lang(raw: str | None) -> str:
    """`<|zh|>` -> `zh`; `<|nospeech|>`/empty -> `unknown`."""
    if raw is None:
        return "unknown"
    m = _TAG.search(raw)
    name = (m.group(1) if m else raw).strip().lower()
    if name in ("", "nospeech"):
        return "unknown"
    return name


def strip_tags(text: str) -> str:
    return _TAG.sub("", text).strip()
