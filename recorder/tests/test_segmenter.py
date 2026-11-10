"""Segmenter tests: deterministic state-machine tests with an injected energy VAD, plus
realism tests with the real WebRTC VAD on real speech."""

import numpy as np
import pytest

from murmur_recorder.segmenter import FRAME_SAMPLES, SAMPLE_RATE, Segmenter, SegmenterParams

from conftest import silence

T0 = 1_800_000_000.0


def energy_vad_factory(_aggr):
    def vad(frame: bytes) -> bool:
        a = np.frombuffer(frame, dtype="<i2")
        return float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) > 1000

    return vad


def tone(seconds: float, amp: int = 8000, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (amp * np.sin(2 * np.pi * freq * t)).astype("<i2")


def run(seg: Segmenter, audio: np.ndarray, t0: float = T0, block: int = 1600):
    """Feed in blocks; returns chunks incl. final flush."""
    out = []
    for i in range(0, len(audio), block):
        out += seg.feed(audio[i : i + block], t0 + i / SAMPLE_RATE)
    out += seg.flush()
    return out


def make(**kw):
    return Segmenter(SegmenterParams(**kw), vad_factory=energy_vad_factory)


def test_pure_silence_produces_nothing():
    seg = make()
    assert run(seg, silence(30)) == []
    assert seg.discarded == 0 and seg.emitted == 0


def test_low_noise_produces_nothing():
    assert run(make(), silence(20, noise_rms=200)) == []


def test_single_burst_with_preroll_and_end_silence():
    seg = make(pre_roll_ms=300, end_silence_ms=1200, min_speech_ms=300)
    audio = np.concatenate([silence(2), tone(1.0), silence(5)])
    chunks = run(seg, audio)
    assert len(chunks) == 1
    c = chunks[0]
    assert c.reason == "silence"
    # starts ~pre_roll before the burst (burst at t=2.0), within one frame/onset tolerance
    assert T0 + 1.7 - 0.05 <= c.started_at <= T0 + 1.7 + 0.05
    # pre-roll 0.3 + speech ~1.0 + trailing silence 1.2
    assert c.duration == pytest.approx(0.3 + 1.0 + 1.2, abs=0.08)
    assert 900 <= c.speech_ms <= 1060
    assert len(c.pcm) == int(round(c.duration * SAMPLE_RATE)) * 2


def test_chunk_content_matches_input_samples():
    seg = make()
    audio = np.concatenate([silence(1), tone(0.8), silence(3)])
    c = run(seg, audio)[0]
    off = int(round((c.started_at - T0) * SAMPLE_RATE))
    got = np.frombuffer(c.pcm, dtype="<i2")
    assert np.array_equal(got, audio[off : off + len(got)])


def test_short_pause_inside_speech_does_not_split():
    seg = make(end_silence_ms=1200)
    audio = np.concatenate([silence(1), tone(1), silence(0.8), tone(1), silence(4)])
    chunks = run(seg, audio)
    assert len(chunks) == 1
    assert chunks[0].duration > 2.8


def test_long_pause_splits_into_two_chunks_in_order():
    seg = make(end_silence_ms=1200)
    audio = np.concatenate([silence(1), tone(1), silence(3), tone(1), silence(3)])
    chunks = run(seg, audio)
    assert len(chunks) == 2
    assert chunks[0].started_at < chunks[1].started_at
    assert chunks[1].started_at >= T0 + 5.0 - 0.4


def test_min_speech_discard():
    seg = make(min_speech_ms=300)
    audio = np.concatenate([silence(1), tone(0.12), silence(4)])  # 120 ms click/blip
    assert run(seg, audio) == []
    # exactly counted as discarded or never opened (both fine); a long enough burst passes
    seg2 = make(min_speech_ms=300)
    assert len(run(seg2, np.concatenate([silence(1), tone(0.5), silence(3)]))) == 1


def test_min_speech_threshold_is_configurable():
    audio = np.concatenate([silence(1), tone(0.5), silence(3)])
    assert len(run(make(min_speech_ms=300), audio)) == 1
    assert run(make(min_speech_ms=900), audio) == []


def test_max_chunk_hard_cut_continuous_speech():
    seg = make(max_chunk_seconds=10, soft_cut_window_seconds=0)
    audio = np.concatenate([silence(1), tone(25), silence(3)])
    chunks = run(seg, audio)
    assert len(chunks) >= 3
    for c in chunks:
        assert c.duration <= 10.0 + 0.001
    assert chunks[0].reason == "max"
    # continuous: no gap/overlap between consecutive hard-cut chunks
    end0 = chunks[0].started_at + chunks[0].duration
    assert chunks[1].started_at == pytest.approx(end0, abs=0.001)
    total_speech_audio = sum(c.duration for c in chunks)
    assert total_speech_audio >= 25  # nothing lost from the monologue


def test_soft_cut_prefers_a_pause_before_hard_limit():
    seg = make(max_chunk_seconds=20, soft_cut_window_seconds=10, soft_cut_silence_ms=400, end_silence_ms=1200)
    # speech 12 s, 0.6 s pause (< end_silence), speech 12 s -> would hit hard limit at 20 s without soft cut
    audio = np.concatenate([silence(1), tone(12), silence(0.6), tone(12), silence(3)])
    chunks = run(seg, audio)
    assert chunks[0].reason == "soft"
    assert 12.0 <= chunks[0].duration < 14.0
    assert all(c.duration <= 20.001 for c in chunks)


def test_flush_returns_in_progress_chunk():
    seg = make()
    out = seg.feed(np.concatenate([silence(1), tone(2)]), T0)
    assert out == []  # still inside speech
    assert seg.in_speech
    chunks = seg.flush()
    assert len(chunks) == 1 and chunks[0].reason == "flush"
    assert not seg.in_speech
    assert seg.flush() == []


def test_flush_discards_too_short_in_progress():
    seg = make(min_speech_ms=500)
    seg.feed(np.concatenate([silence(1), tone(0.2)]), T0)
    assert seg.flush() == []


def test_timestamp_gap_flushes_and_restarts():
    seg = make()
    out = seg.feed(np.concatenate([silence(1), tone(1.5)]), T0)
    out += seg.feed(np.concatenate([tone(1.0), silence(3)]), T0 + 100.0)  # 100 s discontinuity
    out += seg.flush()
    assert len(out) >= 1
    assert out[0].reason == "gap"
    assert out[0].started_at < T0 + 10
    assert all(c.started_at < T0 + 10 or c.started_at >= T0 + 99 for c in out)


def test_arbitrary_block_sizes_give_same_result():
    audio = np.concatenate([silence(1), tone(1), silence(3), tone(2), silence(3)])
    ref = run(make(), audio, block=1600)
    for block in (7, 321, 4999):
        got = run(make(), audio, block=block)
        assert len(got) == len(ref)
        for g, r in zip(got, ref):
            assert g.started_at == pytest.approx(r.started_at, abs=1e-4)
            assert g.pcm == r.pcm


def test_update_params_applies_live_without_losing_chunk():
    seg = make(end_silence_ms=3000)
    seg.feed(np.concatenate([silence(1), tone(1)]), T0)
    assert seg.in_speech
    seg.update_params(SegmenterParams(end_silence_ms=500))
    out = seg.feed(silence(1), T0 + 2.0)
    assert len(out) == 1  # now ends after 0.5 s of silence


def test_update_params_changes_vad_aggressiveness():
    created = []

    def factory(a):
        created.append(a)
        return energy_vad_factory(a)

    seg = Segmenter(SegmenterParams(vad_aggressiveness=1), vad_factory=factory)
    seg.update_params(SegmenterParams(vad_aggressiveness=3))
    assert created == [1, 3]


def test_deterministic():
    audio = np.concatenate([silence(1), tone(1), silence(3), tone(2), silence(3)])
    a = run(make(), audio)
    b = run(make(), audio)
    assert [(c.started_at, c.pcm) for c in a] == [(c.started_at, c.pcm) for c in b]


# ---------------------------------------------------------------- real VAD, real speech
@pytest.mark.parametrize("aggr", [1, 2, 3])
def test_real_speech_is_captured_with_webrtc(speech_clips, aggr):
    clip = speech_clips["en"]
    audio = np.concatenate([silence(3, 30), clip, silence(4, 30, seed=1)])
    seg = Segmenter(SegmenterParams(vad_aggressiveness=aggr))
    chunks = run(seg, audio)
    assert chunks, "speech was not detected"
    covered = sum(c.speech_ms for c in chunks) / 1000
    assert covered >= 0.5 * (len(clip) / SAMPLE_RATE)
    # the first chunk starts shortly before the actual speech onset, pre-roll included
    onset = 3.0 + np.argmax(np.abs(clip) > 1000) / SAMPLE_RATE
    assert 2.6 <= chunks[0].started_at - T0 <= onset + 0.05


def test_real_speech_chunks_do_not_swallow_leading_silence(speech_clips):
    audio = np.concatenate([silence(10, 30), speech_clips["zh"], silence(5, 30, seed=2)])
    chunks = run(Segmenter(SegmenterParams(vad_aggressiveness=2)), audio)
    assert len(chunks) >= 1
    total = sum(c.duration for c in chunks)
    assert total < (len(audio) / SAMPLE_RATE) - 8  # the 10 s of noise floor is not uploaded


def test_real_speech_between_noise_floor_only_yields_speech_chunks(speech_clips):
    """Two utterances separated by long quiet -> two chunks; noise floor alone -> none."""
    gap = silence(5, 30, seed=3)
    audio = np.concatenate([gap, speech_clips["en"], gap, speech_clips["zh"], gap])
    chunks = run(Segmenter(SegmenterParams(vad_aggressiveness=2)), audio)
    assert len(chunks) >= 2
    assert chunks[0].started_at < chunks[-1].started_at
    assert run(Segmenter(SegmenterParams(vad_aggressiveness=3)), silence(60, 30, seed=4)) == []


def test_real_vad_chunk_length_respects_max(speech_clips):
    audio = np.concatenate([silence(1, 30)] + [speech_clips["en"]] * 6 + [silence(3, 30)])  # ~40 s
    seg = Segmenter(SegmenterParams(max_chunk_seconds=15, end_silence_ms=1200))
    chunks = run(seg, audio)
    assert all(c.duration <= 15.001 for c in chunks)
