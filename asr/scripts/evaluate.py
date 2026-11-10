#!/usr/bin/env python
"""Measure the running service against the shared test data.

  python scripts/evaluate.py [--url http://127.0.0.1:8100] [--testdata /home/peler/murmur-testdata] [sections...]

sections: rtf, cer, seg, emb   (default: all)
Prints plain-text tables; numbers are pasted into README "Measured on this VM".
"""
from __future__ import annotations

import argparse
import itertools
import json
import re
import statistics as st
import sys
import time
import unicodedata
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf


def process(url, path, language="auto", key=None):
    h = {"Authorization": f"Bearer {key}"} if key else {}
    t = time.perf_counter()
    r = httpx.post(f"{url}/v1/process", files={"file": (Path(path).name, open(path, "rb"), "audio/wav")},
                   data={"language": language}, headers=h, timeout=600)
    wall = time.perf_counter() - t
    r.raise_for_status()
    return r.json(), wall


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower()
    return re.sub(r"[\W_]+", "", s)


def edit_distance(a, b) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def tokens_for_cer(s: str) -> list[str]:
    """CJK characters individually, latin words as one token each (mixed-language 'CER')."""
    s = unicodedata.normalize("NFKC", s).lower()
    return re.findall(r"[぀-ヿ㐀-鿿가-힯]|[a-z0-9]+", s)


def cer(ref: str, hyp: str) -> float:
    r, h = tokens_for_cer(ref), tokens_for_cer(hyp)
    return edit_distance(r, h) / max(1, len(r))


def overlap(a, b):
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def cos(a, b):
    a, b = np.asarray(a), np.asarray(b)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))


# --------------------------------------------------------------------------- sections

def sec_rtf(url, td, key):
    print("== RTF (wall-clock incl. HTTP + decode, single request at a time) ==")
    files = sorted(td.glob("room_*.wav")) + [td / "long_monologue_zh.wav"] + sorted((td / "sherpa").glob("*.wav"))
    tot_a = tot_w = 0.0
    for f in files:
        d, wall = process(url, f, key=key)
        tot_a += d["duration"]
        tot_w += wall
        print(f"{f.name:34s} audio={d['duration']:6.1f}s wall={wall:6.2f}s rtf={wall / d['duration']:.3f} utts={len(d['utterances'])}")
    print(f"TOTAL audio={tot_a:.0f}s wall={tot_w:.1f}s rtf={tot_w / tot_a:.3f}")


def sec_cer(url, td, key):
    print("== transcript accuracy on single-utterance sherpa samples ==")
    ref = {"zh": "开放时间早上9点至下午5点", "en": "The tribal chieftain called for the boy and presented him with 50 pieces of gold",
           "ja": "うちの中学は弁当制で持っていけない場合は50円の学校販売のパンを買う", "ko": "조금만 생각을 하면서 살면 훨씬 편할 거야",
           "yue": "呢几个字都表达唔到我想讲嘅意思"}
    for k, r in ref.items():
        d, _ = process(url, td / "sherpa" / "sensevoice_test_wavs" / f"{k}.wav", key=key)
        hyp = "".join(u["text"] for u in d["utterances"]) if k in ("zh", "ja", "ko", "yue") else " ".join(u["text"] for u in d["utterances"])
        hyp_cmp = hyp.replace(" ", "") if k in ("ja", "ko") else hyp
        print(f"{k:4s} CER/WER={cer(r, hyp_cmp):.3f}  ref={r}\n     hyp={hyp}")
    print("== TTS composites (ground truth text known) ==")
    allr = []
    for name in ("room_family_zh", "room_mixed_zh_en", "room_with_music_noise", "long_monologue_zh"):
        meta = json.loads((td / f"{name}.json").read_text())
        d, _ = process(url, td / f"{name}.wav", key=key)
        speech = [e for e in meta["timeline"] if e["kind"] == "speech"]
        ref = "".join(e["text"] + " " for e in speech)
        hyp = " ".join(u["text"] for u in d["utterances"] if u["event"] == "speech")
        c = cer(ref, hyp)
        allr.append((name, c, len(tokens_for_cer(ref))))
        print(f"{name:26s} mixed-token CER={c:.3f} (ref tokens={len(tokens_for_cer(ref))})")
    w = sum(n for _, _, n in allr)
    print(f"weighted CER over composites = {sum(c * n for _, c, n in allr) / w:.3f}")


def sec_seg(url, td, key):
    print("== segmentation vs ground-truth timeline ==")
    tot = dict(turns=0, found=0, merged=0, split=0, pred=0, nonspeech_text=0, nonspeech_events={})
    for name in ("room_family_zh", "room_mixed_zh_en", "room_with_music_noise"):
        meta = json.loads((td / f"{name}.json").read_text())
        d, _ = process(url, td / f"{name}.wav", key=key)
        utts = d["utterances"]
        turns = [e for e in meta["timeline"] if e["kind"] == "speech"]
        merged = split = found = 0
        for t in turns:
            ov = [u for u in utts if overlap((u["start"], u["end"]), (t["start"], t["end"])) > 0.3 * (t["end"] - t["start"]) * 0.5]
            if ov:
                found += 1
            if len(ov) > 1:
                split += 1
        for u in utts:
            ts = [t for t in turns if overlap((u["start"], u["end"]), (t["start"], t["end"])) > 0.25]
            if len({t["speaker"] for t in ts}) > 1:
                merged += 1
        for e in meta["timeline"]:
            if e["kind"] in ("music", "noise"):
                for u in utts:
                    if overlap((u["start"], u["end"]), (e["start"], e["end"])) > 0.5 * (u["end"] - u["start"]):
                        tot["nonspeech_events"][(e["kind"], u["event"], bool(u["text"]))] = tot["nonspeech_events"].get((e["kind"], u["event"], bool(u["text"])), 0) + 1
        print(f"{name:26s} turns={len(turns)} found={found} turns_split_in_pieces={split} utterances={len(utts)} utterances_mixing_speakers={merged}")
        tot["turns"] += len(turns); tot["found"] += found; tot["merged"] += merged; tot["split"] += split; tot["pred"] += len(utts)
    print("TOTAL", {k: v for k, v in tot.items() if k != "nonspeech_events"})
    print("utterances inside music/noise stretches (truth kind, predicted event, has_text):", tot["nonspeech_events"])


def collect_embeddings(url, td, key):
    """-> list of (label, group, vector). group = 'tts' | 'real'."""
    items = []
    for name in ("room_family_zh", "room_mixed_zh_en", "room_with_music_noise", "long_monologue_zh"):
        meta = json.loads((td / f"{name}.json").read_text())
        d, _ = process(url, td / f"{name}.wav", key=key)
        turns = [e for e in meta["timeline"] if e["kind"] == "speech"]
        for u in d["utterances"]:
            if u["embedding"] is None or u["event"] != "speech":
                continue
            best = max(turns, key=lambda t: overlap((u["start"], u["end"]), (t["start"], t["end"])), default=None)
            if best is None:
                continue
            ov = overlap((u["start"], u["end"]), (best["start"], best["end"]))
            if ov < 0.8 * (u["end"] - u["start"]):
                continue  # utterance spans several turns; label would be wrong
            items.append((best["speaker"], "tts", u["embedding"], f"{name}@{u['start']:.1f}"))
    return items


def collect_single_clips(url, td, key):
    """One embedding per synthetic single-sentence clip (long enough ones only)."""
    man = json.loads((td / "speakers" / "manifest.json").read_text())
    items = []
    for rel, m in man.items():
        if m["duration"] < 1.5:
            continue
        d, _ = process(url, td / "speakers" / rel, key=key)
        for u in d["utterances"]:
            if u["embedding"]:
                items.append((m["speaker"], m["kind"], u["embedding"], rel))
                break
    return items


def stats(x):
    x = np.asarray(x)
    return dict(n=len(x), mean=round(float(x.mean()), 3), std=round(float(x.std()), 3), min=round(float(x.min()), 3),
                p5=round(float(np.percentile(x, 5)), 3), p50=round(float(np.percentile(x, 50)), 3),
                p95=round(float(np.percentile(x, 95)), 3), max=round(float(x.max()), 3))


def pair_scores(items):
    same, diff = [], []
    for (a, _, ea, _), (b, _, eb, _) in itertools.combinations(items, 2):
        (same if a == b else diff).append(cos(ea, eb))
    return np.array(same), np.array(diff)


def best_threshold(same, diff):
    """Threshold minimising total error (FAR + FRR) and the EER point."""
    best = None
    for th in np.linspace(-0.2, 0.95, 231):
        frr = float((same < th).mean())
        far = float((diff >= th).mean())
        cand = (frr + far, th, frr, far)
        if best is None or cand < best:
            best = cand
    return best


def report_pairs(title, items):
    same, diff = pair_scores(items)
    print(f"-- {title}: {len(items)} embeddings, {len(same)} same-speaker pairs, {len(diff)} different-speaker pairs")
    print("   same:", stats(same))
    print("   diff:", stats(diff))
    _, th, frr, far = best_threshold(same, diff)
    print(f"   best single threshold={th:.2f} (false-reject {frr:.3f}, false-accept {far:.3f})")
    for t in (0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7):
        print(f"   th={t:.2f}: same>=th {float((same >= t).mean()):.3f}   diff>=th {float((diff >= t).mean()):.4f}")
    return same, diff


def sec_emb(url, td, key):
    print("== cosine similarity of CAM++ embeddings ==")
    tts = collect_embeddings(url, td, key)
    report_pairs("TTS speakers, utterances inside composites", tts)
    clips = collect_single_clips(url, td, key)
    report_pairs("TTS speakers, single-sentence clips (all 16 voices, same-speaker pairs may cross languages)", clips)
    # same speaker across languages (multilingual voices speak zh/mix/en) vs within one language
    cross, within = [], []
    for (a, ka, ea, _), (b, kb, eb, _) in itertools.combinations(clips, 2):
        if a != b:
            continue
        (within if (ka == kb or {ka, kb} == {"zh", "mix"}) else cross).append(cos(ea, eb))
    print("   same speaker, same language (zh and zh/en-mixed count as one):", stats(within))
    print("   same speaker, zh vs en (only the 4 multilingual voices):", stats(cross))
    zh_en_same = [c for c in clips if c[1] in ("zh", "mix") or not c[0].startswith("ml_")]
    report_pairs("TTS clips excluding cross-language same-speaker pairs", [c for c in clips if not c[0].startswith("ml_")] + [c for c in clips if c[0].startswith("ml_") and c[1] != "en"])
    # centroid-based: how does a new utterance compare to the centroid of its own speaker vs the nearest other centroid
    spk = sorted({a for a, *_ in tts})
    cents = {s: np.mean([np.asarray(e) / np.linalg.norm(e) for a, _, e, _ in tts if a == s], axis=0) for s in spk}
    own, other = [], []
    for a, _, e, _ in tts:
        for s, c in cents.items():
            (own if s == a else other).append(cos(e, c))
    print("   utterance-vs-speaker-centroid (incl. itself): own", stats(own), "\n   other speakers", stats(other))
    real = collect_real(url, td, key)
    if real:
        report_pairs("REAL humans (sherpa demo wavs, pseudo-labels from independent diarization)", real)
    allr = tts + real
    report_pairs("ALL combined", allr)


def collect_real(url, td, key):
    f = td / "sherpa" / "diarization_pseudo_labels.json"
    if not f.exists():
        return []
    lab = json.loads(f.read_text())
    items = []
    for wav, segs in lab.items():
        d, _ = process(url, td / "sherpa" / wav, key=key)
        for u in d["utterances"]:
            if u["embedding"] is None or u["event"] != "speech":
                continue
            ov = {}
            for s in segs:
                ov[s["speaker"]] = ov.get(s["speaker"], 0) + overlap((u["start"], u["end"]), (s["start"], s["end"]))
            sp, o = max(ov.items(), key=lambda kv: kv[1])
            if o >= 0.9 * (u["end"] - u["start"]):
                items.append((f"{wav}:{sp}", "real", u["embedding"], f"{wav}@{u['start']:.1f}"))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sections", nargs="*", default=["rtf", "cer", "seg", "emb"])
    ap.add_argument("--url", default="http://127.0.0.1:8100")
    ap.add_argument("--testdata", default="/home/peler/murmur-testdata")
    ap.add_argument("--key")
    a = ap.parse_args()
    td = Path(a.testdata)
    for s in a.sections:
        {"rtf": sec_rtf, "cer": sec_cer, "seg": sec_seg, "emb": sec_emb}[s](a.url, td, a.key)
        print()


if __name__ == "__main__":
    main()
