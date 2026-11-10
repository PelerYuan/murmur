import pytest

from murmur_asr.events import EVENTS, map_event, normalize_lang, strip_tags
from murmur_asr.recognizers import is_hallucination


@pytest.mark.parametrize("raw,exp", [
    ("<|Speech|>", "speech"), ("<|BGM|>", "music"), ("<|Applause|>", "applause"), ("<|Laughter|>", "laughter"),
    ("<|Cough|>", "noise"), ("<|Sneeze|>", "noise"), ("<|Breath|>", "noise"), ("<|Cry|>", "other"),
    ("<|Sing|>", "music"), ("<|SomethingNew|>", "other"), ("", "speech"), (None, "speech"), ("BGM", "music"),
    ("<|bgm|>", "music"),
])
def test_map_event(raw, exp):
    assert map_event(raw) == exp
    assert exp in EVENTS


@pytest.mark.parametrize("raw,exp", [("<|zh|>", "zh"), ("<|EN|>", "en"), ("<|nospeech|>", "unknown"), ("", "unknown"),
                                     (None, "unknown"), ("yue", "yue")])
def test_normalize_lang(raw, exp):
    assert normalize_lang(raw) == exp


def test_strip_tags():
    assert strip_tags("<|zh|><|NEUTRAL|>你好 <|Speech|>世界") == "你好 世界"


@pytest.mark.parametrize("text,sec,bad", [
    ("", 3, True), ("...", 3, True), ("。。。", 2, True),
    ("谢谢谢谢谢谢谢谢谢谢谢谢谢谢", 4, True),
    ("I'm sorry. I'm sorry. I'm sorry. I'm sorry. I'm sorry. I'm sorry.", 8, True),
    ("Thank you for watching!", 2.0, True),
    ("字幕由Amara.org社区提供", 3.0, True),
    ("这是一段很长的文字" * 20, 2.0, True),  # impossible speaking rate
    ("明天下午三点记得开会。", 3.0, False),
    ("Thank you for watching, now let me tell you what happened at the office on Monday morning when the boss came in.", 9.0, False),
    ("好的好的，我知道了。", 3.0, False),
])
def test_hallucination_guard(text, sec, bad):
    assert is_hallucination(text, sec) is bad
