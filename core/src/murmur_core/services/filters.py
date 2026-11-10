"""Drops utterances that are not real conversation: music/noise, ASR hallucinations, fillers."""

from __future__ import annotations

import re
from typing import Optional

from ..settings_store import Filters
from .asr_client import RawUtterance

NON_SPEECH_EVENTS = {"music", "noise", "laughter", "applause", "other"}

# Phrases speech models famously invent on silence/noise (Whisper-family and SenseVoice training-data artefacts).
_HALLUCINATIONS = [
    r"谢谢(大家)?(观看|收看|收听)",
    r"感谢(您)?(的)?(观看|收看|收听|支持)",
    r"请(不吝)?(点赞|订阅|关注)",
    r"点赞.{0,6}(订阅|关注|转发)",
    r"字幕(由|志愿者|组|制作|提供)",
    r"(中文)?字幕\s*(by|:|：)",
    r"amara\.org",
    r"明镜(与)?点点栏目",
    r"thanks? for watching",
    r"thank you for watching",
    r"please subscribe",
    r"subtitles? (by|made)",
    r"^\W*(you|bye\.?|thank you\.?)\W*$",
    r"^[\W_]*$",
]
_HALLUCINATION_RE = re.compile("|".join(f"(?:{p})" for p in _HALLUCINATIONS), re.IGNORECASE)

_FILLERS_RE = re.compile(r"^(?:[\s嗯啊呃哦噢唉额哎诶哈呵呀哇嘿\W_]|\b(?:uh+|um+|hm+|mm+|ah+|oh+|er+|huh)\b)+$", re.IGNORECASE)
_REPEAT_RE = re.compile(r"(.{1,6}?)\1{5,}")


def collapse_repeats(text: str) -> str:
    """Cut runaway repetition ('哈哈哈哈…' / looped phrases) down to three repeats."""
    return _REPEAT_RE.sub(lambda m: m.group(1) * 3, text)


def reject_reason(u: RawUtterance, cfg: Filters) -> Optional[str]:
    """Returns why this utterance should be dropped, or None to keep it."""
    text = u.text.strip()
    if not text:
        return "empty"
    if cfg.drop_non_speech and (u.event or "speech") in NON_SPEECH_EVENTS:
        return f"event:{u.event}"
    if u.speech_prob is not None and u.speech_prob < cfg.min_confidence:
        return "low_confidence"
    if cfg.min_text_chars and len(re.sub(r"[\W_]+", "", text)) < cfg.min_text_chars:
        return "too_short"
    if cfg.drop_hallucinations:
        if _HALLUCINATION_RE.search(text):
            return "hallucination"
        if _FILLERS_RE.match(text):
            return "filler"
    return None


def apply_filters(utterances: list[RawUtterance], cfg: Filters) -> tuple[list[RawUtterance], dict[str, int]]:
    kept: list[RawUtterance] = []
    dropped: dict[str, int] = {}
    for u in utterances:
        u.text = collapse_repeats(u.text.strip()) if cfg.drop_hallucinations else u.text.strip()
        reason = reject_reason(u, cfg)
        if reason:
            dropped[reason] = dropped.get(reason, 0) + 1
        else:
            kept.append(u)
    return kept, dropped
