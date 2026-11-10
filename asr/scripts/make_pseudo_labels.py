#!/usr/bin/env python
"""Pseudo speaker labels for the real-human sherpa demo wavs (no ground truth is published).

Runs sherpa-onnx offline diarization (pyannote-segmentation-3-0 + an embedding model that is NOT the
CAM++ one under test, so label noise is independent of the embeddings we evaluate) and stores
segments in <testdata>/sherpa/diarization_pseudo_labels.json.

  python scripts/make_pseudo_labels.py --models DIR   # DIR has the pyannote dir and the two embedding onnx files
"""
import argparse
import json
from pathlib import Path

import sherpa_onnx as so
import soundfile as sf


def run(wav, seg_model, emb_model, n):
    cfg = so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model), num_threads=2),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=emb_model, num_threads=2),
        clustering=so.FastClusteringConfig(num_clusters=n, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.5)
    sd = so.OfflineSpeakerDiarization(cfg)
    x, sr = sf.read(wav, dtype="float32")
    assert sr == sd.sample_rate
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "speaker": f"spk{s.speaker}"} for s in sd.process(x).sort_by_start_time()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--testdata", default="/home/peler/murmur-testdata")
    a = ap.parse_args()
    m, td = Path(a.models), Path(a.testdata) / "sherpa"
    seg = str(m / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx")
    zh = str(m / "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx")
    en = str(m / "nemo_en_titanet_small.onnx")
    plan = {"0-four-speakers-zh.wav": (zh, 4), "1-two-speakers-en.wav": (en, 2), "2-two-speakers-en.wav": (en, 2),
            "3-two-speakers-en.wav": (en, 2)}
    out = {w: run(str(td / w), seg, e, n) for w, (e, n) in plan.items()}
    (td / "diarization_pseudo_labels.json").write_text(json.dumps(out, indent=1))
    for w, segs in out.items():
        print(w, len(segs), "segments", sorted({s["speaker"] for s in segs}))


if __name__ == "__main__":
    main()
