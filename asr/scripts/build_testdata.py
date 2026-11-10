#!/usr/bin/env python
"""Build the shared end-to-end test material in /home/peler/murmur-testdata (default).

Phase 1 (synth):   edge-tts voices -> one WAV per sentence per speaker (ground-truth text known)
Phase 2 (compose): stitch them into "room" recordings with silences, room noise, music, TV-like noise
                   and write <name>.json with the true timeline (start/end/speaker/text/kind).

Needs the `edge-tts` package and internet access (Microsoft's public TTS endpoint) for phase 1.
Everything is 16 kHz mono 16-bit PCM WAV, deterministic given --seed (TTS output itself may vary a little).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from murmur_asr.audio import resample

SR = 16000

ZH = [
    "明天下午三点记得带孩子去打疫苗。",
    "今晚的饭我来做，你想吃红烧肉还是清蒸鱼？",
    "快递到了，帮我去门口拿一下好吗？",
    "这个周末我们去爷爷家吃饭，别忘了买点水果。",
    "空调有点冷，我把温度调高两度吧。",
    "老师说下周五要交手工作业，我们得提前准备材料。",
    "电费这个月多了一百多块，是不是热水器一直开着？",
    "我今天加班，大概九点才能到家，你们先吃。",
    "洗衣机里的衣服已经洗好了，麻烦晾一下。",
    "周六上午有家长会，我请好假了，你不用去。",
    "冰箱里的牛奶快过期了，早上记得喝掉。",
    "你看看这个新闻，说下个月油价又要涨了。",
]
MIX = [
    "下午的 meeting 改到四点了，我需要先把 PPT 发给老板。",
    "帮我订一张去 Shanghai 的高铁票，周五早上出发。",
    "这个 bug 我已经 fix 了，晚点 push 到 GitHub 上。",
    "今晚的 Netflix 看什么？我想看那个新出的纪录片。",
    "记得把 WiFi 密码发给明天来的客人。",
    "我在 Amazon 上买的耳机明天到，到时候你签收一下。",
]
EN = [
    "Don't forget to pick up the kids from school at four o'clock.",
    "The dishwasher is full, can you run it before you go to bed?",
    "I think we should book the flights this week, the prices are going up.",
    "What do you want for dinner tonight, pasta or stir fry?",
    "The plumber is coming on Thursday morning between nine and noon.",
    "Could you turn down the music a little, I am on a call.",
    "Remind me to call the dentist tomorrow to reschedule my appointment.",
    "We are out of coffee, so I will stop by the store on my way home.",
]

# short id -> (edge voice, languages it speaks)
VOICES = {
    "zh_xiaoxiao_f": ("zh-CN-XiaoxiaoNeural", ("zh", "mix")),
    "zh_xiaoyi_f": ("zh-CN-XiaoyiNeural", ("zh", "mix")),
    "zh_yunxi_m": ("zh-CN-YunxiNeural", ("zh", "mix")),
    "zh_yunjian_m": ("zh-CN-YunjianNeural", ("zh", "mix")),
    "zh_yunyang_m": ("zh-CN-YunyangNeural", ("zh", "mix")),
    "zh_yunxia_m": ("zh-CN-YunxiaNeural", ("zh", "mix")),
    "en_guy_m": ("en-US-GuyNeural", ("en",)),
    "en_jenny_f": ("en-US-JennyNeural", ("en",)),
    "en_aria_f": ("en-US-AriaNeural", ("en",)),
    "en_ryan_m": ("en-GB-RyanNeural", ("en",)),
    "en_sonia_f": ("en-GB-SoniaNeural", ("en",)),
    "en_eric_m": ("en-US-EricNeural", ("en",)),
    "ml_ava_f": ("en-US-AvaMultilingualNeural", ("zh", "mix", "en")),
    "ml_andrew_m": ("en-US-AndrewMultilingualNeural", ("zh", "mix", "en")),
    "ml_emma_f": ("en-US-EmmaMultilingualNeural", ("zh", "mix", "en")),
    "ml_brian_m": ("en-US-BrianMultilingualNeural", ("zh", "mix", "en")),
}
TEXTS = {"zh": ZH, "mix": MIX, "en": EN}


def trim(x: np.ndarray, keep: float = 0.08) -> np.ndarray:
    thr = 0.01 * np.abs(x).max()
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    k = int(keep * SR)
    return x[max(0, idx[0] - k): idx[-1] + k]


async def _tts(text: str, voice: str, path: Path) -> None:
    import edge_tts

    for attempt in range(4):
        try:
            await edge_tts.Communicate(text, voice).save(str(path))
            return
        except Exception as e:  # noqa: BLE001
            print("  retry", voice, e)
            await asyncio.sleep(2 + attempt * 2)
    raise RuntimeError(f"edge-tts failed for {voice}")


def synth(out: Path) -> dict:
    spk_dir = out / "speakers"
    manifest: dict = {}
    with tempfile.TemporaryDirectory() as td:
        for sid, (voice, kinds) in VOICES.items():
            d = spk_dir / sid
            d.mkdir(parents=True, exist_ok=True)
            for kind in kinds:
                for i, text in enumerate(TEXTS[kind]):
                    f = d / f"{kind}_{i:02d}.wav"
                    if not f.exists():
                        mp3 = Path(td) / "x.mp3"
                        asyncio.run(_tts(text, voice, mp3))
                        x, sr = sf.read(mp3, dtype="float32")
                        if x.ndim > 1:
                            x = x.mean(axis=1)
                        x = trim(resample(x, sr, SR))
                        sf.write(f, x, SR, subtype="PCM_16")
                    manifest[f"{sid}/{f.name}"] = {"speaker": sid, "voice": voice, "kind": kind, "text": text,
                                                    "duration": round(sf.info(f).duration, 2)}
            print("voice", sid, "done")
    (out / "speakers" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    return manifest


# ---------------------------------------------------------------- non-speech sounds

def music(seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Plucked-string melody over a bass line, 100 bpm, A minor pentatonic."""
    t_beat = 60 / 100
    scale = [0, 3, 5, 7, 10, 12, 15, 17]
    out = np.zeros(int(seconds * SR) + SR, np.float32)

    def note(freq, dur, amp, at):
        n = int(dur * SR)
        t = np.arange(n) / SR
        w = sum(a * np.sin(2 * np.pi * freq * k * t) for k, a in ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.15)))
        w *= np.exp(-t * 3.0) * np.minimum(1, t * 200)
        i = int(at * SR)
        out[i: i + n] += (amp * w[: len(out) - i]).astype(np.float32)

    t = 0.0
    while t < seconds:
        deg = scale[rng.integers(0, len(scale))]
        note(220 * 2 ** (deg / 12) * 2, t_beat * 1.5, 0.12, t)
        if int(t / t_beat) % 4 == 0:
            note(110, t_beat * 3, 0.18, t)
        t += t_beat * rng.choice([0.5, 1, 1])
    return out[: int(seconds * SR)]


def vacuum(seconds: float, rng: np.random.Generator) -> np.ndarray:
    n = int(seconds * SR)
    x = rng.standard_normal(n).astype(np.float32)
    k = np.ones(8) / 8  # crude lowpass -> hissy motor noise
    x = np.convolve(x, k, "same")
    x += 0.5 * np.sin(2 * np.pi * 180 * np.arange(n) / SR).astype(np.float32)
    env = np.minimum(1, np.minimum(np.arange(n), n - np.arange(n)) / (0.4 * SR))
    return (0.12 * x * env).astype(np.float32)


def knocks(rng: np.random.Generator, seconds: float = 4.0) -> np.ndarray:
    out = np.zeros(int(seconds * SR), np.float32)
    for at in (0.3, 0.8, 1.3):
        n = int(0.15 * SR)
        t = np.arange(n) / SR
        out[int(at * SR): int(at * SR) + n] += (0.5 * rng.standard_normal(n) * np.exp(-t * 40)).astype(np.float32)
    return out


def room_noise(n: int, rng: np.random.Generator, level_db: float = -52) -> np.ndarray:
    x = rng.standard_normal(n).astype(np.float32)
    x = np.convolve(x, np.ones(6) / 6, "same")
    return x * (10 ** (level_db / 20) / (x.std() + 1e-9))


# ---------------------------------------------------------------- composition

class Composer:
    def __init__(self, out: Path, name: str, seed: int):
        self.out, self.name = out, name
        self.rng = np.random.default_rng(seed)
        self.py = random.Random(seed)
        self.parts: list[np.ndarray] = []
        self.t = 0.0
        self.timeline: list[dict] = []
        self.gains: dict[str, float] = {}

    def silence(self, seconds: float) -> None:
        self.parts.append(np.zeros(int(seconds * SR), np.float32))
        self.t += seconds

    def clip(self, spk: str, kind: str, idx: int) -> None:
        f = self.out / "speakers" / spk / f"{kind}_{idx:02d}.wav"
        x, _ = sf.read(f, dtype="float32")
        g = self.gains.setdefault(spk, self.py.uniform(0.55, 1.0))
        x = x / (np.abs(x).max() + 1e-9) * 0.8 * g
        text = TEXTS[kind][idx]
        self.timeline.append({"start": round(self.t, 2), "end": round(self.t + len(x) / SR, 2), "speaker": spk,
                              "kind": "speech", "lang": kind, "text": text})
        self.parts.append(x)
        self.t += len(x) / SR

    def sound(self, x: np.ndarray, label: str) -> None:
        self.timeline.append({"start": round(self.t, 2), "end": round(self.t + len(x) / SR, 2), "speaker": None,
                              "kind": label, "text": ""})
        self.parts.append(x)
        self.t += len(x) / SR

    def save(self, description: str) -> dict:
        x = np.concatenate(self.parts)
        x = x + room_noise(len(x), self.rng)
        x = np.clip(x, -1, 1)
        path = self.out / f"{self.name}.wav"
        sf.write(path, x, SR, subtype="PCM_16")
        meta = {"file": path.name, "duration": round(len(x) / SR, 2), "description": description,
                "speakers": sorted({e["speaker"] for e in self.timeline if e["speaker"]}),
                "timeline": self.timeline}
        (self.out / f"{self.name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        print(self.name, meta["duration"], "s", len(self.timeline), "events")
        return meta


def conversation(c: Composer, turns: list[tuple[str, str, int]], gap=(0.6, 2.2), long_pause_every=0) -> None:
    for i, (spk, kind, idx) in enumerate(turns):
        c.clip(spk, kind, idx)
        if long_pause_every and (i + 1) % long_pause_every == 0:
            c.silence(c.py.uniform(8, 14))
        else:
            c.silence(c.py.uniform(*gap))


def compose(out: Path, seed: int = 7) -> list[dict]:
    metas = []

    # 1. family at home, Chinese only, 4 speakers, pauses
    c = Composer(out, "room_family_zh", seed)
    c.silence(2.0)
    conversation(c, [
        ("zh_xiaoxiao_f", "zh", 0), ("zh_yunxi_m", "zh", 1), ("zh_xiaoxiao_f", "zh", 2), ("zh_xiaoyi_f", "zh", 3),
        ("zh_yunxi_m", "zh", 4), ("zh_yunjian_m", "zh", 5), ("zh_xiaoyi_f", "zh", 6), ("zh_xiaoxiao_f", "zh", 7),
        ("zh_yunjian_m", "zh", 8), ("zh_yunxi_m", "zh", 9), ("zh_xiaoyi_f", "zh", 10), ("zh_xiaoxiao_f", "zh", 11),
        ("zh_yunjian_m", "zh", 0), ("zh_xiaoyi_f", "zh", 1), ("zh_yunxi_m", "zh", 2),
    ], long_pause_every=6)
    metas.append(c.save("4 Chinese speakers (2 female, 2 male), 15 turns, 0.6-2.2 s gaps and two 8-14 s pauses of room noise."))

    # 2. mixed languages (zh/en code-switching), 4 speakers incl. 2 multilingual voices speaking both
    c = Composer(out, "room_mixed_zh_en", seed + 1)
    c.silence(1.5)
    conversation(c, [
        ("ml_ava_f", "mix", 0), ("ml_andrew_m", "mix", 1), ("ml_ava_f", "en", 0), ("en_guy_m", "en", 1),
        ("ml_andrew_m", "zh", 3), ("zh_yunxi_m", "mix", 2), ("en_jenny_f", "en", 2), ("ml_ava_f", "zh", 4),
        ("zh_yunxi_m", "mix", 3), ("en_guy_m", "en", 3), ("ml_andrew_m", "mix", 4), ("en_jenny_f", "en", 4),
        ("ml_ava_f", "mix", 5), ("zh_yunxi_m", "zh", 6), ("en_guy_m", "en", 5), ("ml_andrew_m", "en", 6),
    ], gap=(0.5, 1.8), long_pause_every=7)
    metas.append(c.save("Chinese/English/code-switching, 5 speakers (ml_ava_f and ml_andrew_m speak both languages), 16 turns."))

    # 3. non-speech: music stretch, vacuum cleaner, knocking, between speech
    c = Composer(out, "room_with_music_noise", seed + 2)
    rng = c.rng
    c.silence(1.5)
    conversation(c, [("zh_xiaoxiao_f", "zh", 0), ("zh_yunjian_m", "zh", 1), ("zh_xiaoxiao_f", "zh", 2)])
    c.sound(music(18, rng), "music")
    c.silence(2.0)
    conversation(c, [("zh_yunjian_m", "zh", 3), ("en_eric_m", "en", 0), ("zh_xiaoxiao_f", "zh", 4)])
    c.sound(vacuum(12, rng), "noise")
    c.silence(1.5)
    c.sound(knocks(rng), "noise")
    c.silence(1.0)
    conversation(c, [("en_eric_m", "en", 1), ("zh_yunjian_m", "zh", 5), ("zh_xiaoxiao_f", "mix", 1), ("en_eric_m", "en", 2)])
    c.sound(music(10, rng), "music")
    c.silence(1.5)
    metas.append(c.save("3 speakers (zh_xiaoxiao_f, zh_yunjian_m, en_eric_m) plus an 18 s and a 10 s synthetic music stretch, a 12 s vacuum-cleaner-like noise and door knocks. Non-speech segments have kind music/noise and empty text."))

    # 4. long continuous monologue (> 25 s of unbroken speech) to exercise segment splitting
    c = Composer(out, "long_monologue_zh", seed + 3)
    c.silence(1.0)
    for i in range(10):
        c.clip("zh_yunyang_m", "zh", i)
        c.silence(0.12)
    c.silence(1.5)
    metas.append(c.save("one Chinese speaker (zh_yunyang_m) talking 10 sentences back-to-back with 0.12 s gaps (>30 s of near-continuous speech)."))
    return metas


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/home/peler/murmur-testdata")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--skip-synth", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if not a.skip_synth:
        synth(out)
    compose(out, a.seed)


if __name__ == "__main__":
    main()
