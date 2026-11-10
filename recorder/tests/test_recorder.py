"""Recorder-level tests: heartbeat/config application, pause, device switch, outages, file e2e."""

import socket
from datetime import datetime, timezone
import threading
import time
import wave

import numpy as np
import pytest
import soxr

from murmur_recorder.buffer import ChunkBuffer, iso_utc
from murmur_recorder.config import RemoteConfig, Settings
from murmur_recorder.recorder import Recorder, apply_gain, block_level_db
from murmur_recorder.sources import Block, EndOfSource, FileSource, Source, SourceError

from conftest import SR, fake_core_mod, silence, write_wav16k

DEVICES = [
    {"id": "hw:1,0", "name": "USB Camera Mic", "channels": 1, "default_samplerate": 48000, "is_default": False},
    {"id": "hw:2,0", "name": "Other Mic", "channels": 2, "default_samplerate": 44100, "is_default": True},
]


def wait_until(cond, timeout=8.0, step=0.02):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(step)
    return False


class ArraySource(Source):
    """Feeds a fixed array once (fast), then silence forever; records its lifecycle."""

    def __init__(self, audio, device=None, registry=None, t0=1_800_000_000.0, pace=0.002):
        self.audio, self.device, self.pace = audio, device, pace
        self.pos = 0
        self.t0 = t0
        self.opened = self.closed = False
        self.active_device = device or "default"
        if registry is not None:
            registry.append(self)

    def open(self):
        self.opened = True

    def read(self, timeout):
        time.sleep(self.pace)
        n = 1600
        seg = self.audio[self.pos : self.pos + n]
        if len(seg) < n:
            seg = np.concatenate([seg, np.zeros(n - len(seg), dtype="<i2")])
        blk = Block(self.t0 + self.pos / SR, seg)
        self.pos += n
        return blk

    def close(self):
        self.closed = True


def tone(seconds, amp=8000):
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * 220 * t)).astype("<i2")


def make_recorder(tmp_path, core_url, source_factory=None, token="tok", **kw):
    s = Settings(core_url=core_url, token=token, buffer_dir=str(tmp_path / "buf"), heartbeat_interval=0.1)
    for k, v in kw.items():
        setattr(s, k, v)
    rec = Recorder(s, device_lister=lambda: DEVICES, source_factory=source_factory)
    rec.uploader.backoff_initial, rec.uploader.backoff_cap = 0.05, 0.3
    return rec


@pytest.fixture
def rec_factory(tmp_path):
    made = []

    def make(core_url, **kw):
        r = make_recorder(tmp_path, core_url, **kw)
        made.append(r)
        return r

    yield make
    for r in made:
        r.stop(timeout=3)


# ---------------------------------------------------------------- pure helpers
def test_remote_config_validation_and_partial_update():
    base = RemoteConfig()
    c = RemoteConfig.from_dict({"gain_db": "6", "vad_aggressiveness": 9, "device": "", "bogus": 1, "min_speech_ms": "abc"}, base)
    assert c.gain_db == 6.0 and c.vad_aggressiveness == 3 and c.device is None
    assert c.min_speech_ms == base.min_speech_ms  # invalid value ignored
    assert RemoteConfig.from_dict({"enabled": False}, c).gain_db == 6.0  # partial keeps the rest


def test_gain_and_level_math():
    x = tone(0.5, amp=3277)  # rms ~ 2317 -> about -23 dBFS
    assert block_level_db(x) == pytest.approx(-23.0, abs=0.3)
    assert block_level_db(apply_gain(x, 6.0)) == pytest.approx(-17.0, abs=0.3)
    loud = apply_gain(tone(0.1, amp=30000), 20.0)
    assert loud.dtype == np.int16 and loud.max() <= 32767 and loud.min() >= -32768  # clipped, no wrap
    assert block_level_db(np.zeros(1600, dtype="<i2")) == -100.0


# ---------------------------------------------------------------- heartbeat & config
def test_heartbeat_payload_and_config_applied_without_restart(tmp_path, fake_core, rec_factory):
    srcs = []
    rec = rec_factory(fake_core.url, source_factory=lambda cfg: ArraySource(silence(1), cfg.device, srcs))
    fake_core.config.update(gain_db=12.0, vad_aggressiveness=3, min_speech_ms=500, end_silence_ms=2000,
                            max_chunk_seconds=30, pre_roll_ms=100)
    rec.start()
    assert wait_until(lambda: rec.config().gain_db == 12.0)
    assert wait_until(lambda: rec.segmenter.params.vad_aggressiveness == 3)
    p = rec.segmenter.params
    assert (p.min_speech_ms, p.end_silence_ms, p.max_chunk_seconds, p.pre_roll_ms) == (500, 2000, 30, 100)
    hb = fake_core.heartbeats[-1]
    assert hb["version"] == "0.1.0"
    assert hb["devices"] == DEVICES
    assert set(hb["status"]) == {"state", "level_db", "buffered_chunks", "active_device", "error"}
    assert hb["status"]["state"] in ("recording", "starting")
    # change again live
    fake_core.config["gain_db"] = -3.0
    assert wait_until(lambda: rec.config().gain_db == -3.0)
    assert len(srcs) == 1  # no reopen for a gain change


def test_disable_pauses_and_reports_paused_then_resumes(tmp_path, fake_core, rec_factory):
    srcs = []
    rec = rec_factory(fake_core.url, source_factory=lambda cfg: ArraySource(silence(1), cfg.device, srcs))
    rec.start()
    assert wait_until(lambda: fake_core.heartbeats and fake_core.heartbeats[-1]["status"]["state"] == "recording")
    fake_core.config["enabled"] = False
    assert wait_until(lambda: fake_core.heartbeats[-1]["status"]["state"] == "paused")
    assert srcs[0].closed  # microphone released while paused
    assert fake_core.heartbeats[-1]["status"]["level_db"] == -100.0
    fake_core.config["enabled"] = True
    assert wait_until(lambda: fake_core.heartbeats[-1]["status"]["state"] == "recording")
    assert len(srcs) == 2 and srcs[1].opened


def test_device_switch_reopens_stream_and_flushes(tmp_path, fake_core, rec_factory, speech_clips):
    srcs = []
    # speech that never stops (looped real speech, no pauses): only a flush can close the chunk
    endless = np.tile(speech_clips["zh"][SR // 2 : -SR // 2], 100)
    rec = rec_factory(fake_core.url, source_factory=lambda cfg: ArraySource(endless, cfg.device, srcs))
    rec.start()
    assert wait_until(lambda: len(srcs) == 1 and srcs[0].pos > SR)
    assert wait_until(lambda: fake_core.heartbeats and fake_core.heartbeats[-1]["status"]["active_device"] == "default")
    fake_core.config["device"] = "hw:1,0"
    assert wait_until(lambda: len(srcs) == 2)
    assert srcs[0].closed and srcs[1].device == "hw:1,0"
    assert wait_until(lambda: any(c["duration"] > 0.5 for c in fake_core.chunks))  # old stream's chunk flushed+uploaded
    assert wait_until(lambda: fake_core.heartbeats[-1]["status"]["active_device"] == "hw:1,0")


def test_device_open_error_reports_error_state_and_recovers(tmp_path, fake_core, rec_factory):
    calls = {"n": 0}

    def factory(cfg):
        calls["n"] += 1

        class S(ArraySource):
            def open(self_inner):
                if calls["n"] == 1:
                    raise SourceError("no input device available")
                super().open()

        return S(silence(1), cfg.device)

    rec = rec_factory(fake_core.url, source_factory=factory)
    rec.start()
    assert wait_until(lambda: fake_core.heartbeats and fake_core.heartbeats[-1]["status"]["state"] == "error")
    st = fake_core.heartbeats[-1]["status"]
    assert "no input device" in st["error"]
    # retry interval is 5 s in production; poke the loop by waiting
    assert wait_until(lambda: fake_core.heartbeats[-1]["status"]["state"] == "recording", timeout=10)


def test_cached_config_survives_restart_offline(tmp_path, fake_core):
    fake_core.config["enabled"] = False
    rec = make_recorder(tmp_path, fake_core.url, source_factory=lambda cfg: ArraySource(silence(1)))
    rec.start()
    assert wait_until(lambda: rec.config().enabled is False)
    rec.stop(3)
    # restart with Core unreachable: still paused (does not secretly start recording)
    dead = f"http://127.0.0.1:{free_port()}"
    srcs = []
    rec2 = make_recorder(tmp_path, dead, source_factory=lambda cfg: ArraySource(silence(1), None, srcs))
    rec2.start()
    try:
        assert rec2.config().enabled is False
        assert wait_until(lambda: rec2.status()["state"] == "paused")
        assert not srcs
    finally:
        rec2.stop(3)


# ---------------------------------------------------------------- level meter
def test_level_meter_reports_smoothed_dbfs_with_gain(tmp_path, fake_core, rec_factory):
    rec = rec_factory(fake_core.url, source_factory=lambda cfg: ArraySource(tone(600, amp=3277), cfg.device, pace=0.01))
    rec.start()
    assert wait_until(lambda: rec.status()["level_db"] > -30)
    assert rec.status()["level_db"] == pytest.approx(-23.0, abs=1.5)
    fake_core.config["gain_db"] = 6.0
    assert wait_until(lambda: abs(rec.status()["level_db"] + 17.0) < 1.5)


# ---------------------------------------------------------------- outages & auth
def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def test_starts_with_core_unreachable_buffers_then_uploads_when_core_appears(tmp_path, speech_clips):
    port = free_port()
    audio = np.concatenate([silence(1), speech_clips["en"], silence(3), speech_clips["zh"], silence(3)])
    rec = make_recorder(tmp_path, f"http://127.0.0.1:{port}",
                        source_factory=lambda cfg: ArraySource(audio, pace=0.0))
    rec.start()
    try:
        assert wait_until(lambda: rec.buffer.count() >= 2, timeout=15)
        assert rec.status()["state"] == "recording"  # not crashed, still capturing
        assert rec.status()["buffered_chunks"] >= 2
        core = fake_core_mod.FakeCore(out_dir=tmp_path / "recv")
        core.start(port=port)
        try:
            assert wait_until(lambda: len(core.chunks) >= 2 and rec.buffer.count() == 0, timeout=15)
            assert wait_until(lambda: core.heartbeats)
            times = [c["started_at"] for c in core.chunks]
            assert times == sorted(times)
        finally:
            core.stop()
    finally:
        rec.stop(3)


def test_invalid_token_does_not_crash_keeps_recording_and_buffering(tmp_path, fake_core, speech_clips, caplog):
    fake_core.required_token = "good"
    audio = np.concatenate([silence(1), speech_clips["en"], silence(3)])
    rec = make_recorder(tmp_path, fake_core.url, token="bad", source_factory=lambda cfg: ArraySource(audio, pace=0.0))
    rec.start()
    try:
        assert wait_until(lambda: rec.buffer.count() >= 1, timeout=10)
        assert wait_until(lambda: rec.uploader.unauthorized and rec._unauthorized)
        assert rec.status()["state"] == "recording"
        assert "MURMUR_TOKEN" in rec.status()["error"]
        assert any("token" in r.message.lower() and r.levelname == "ERROR" for r in caplog.records)
        assert not fake_core.chunks and not fake_core.heartbeats
    finally:
        rec.stop(3)


def test_graceful_shutdown_flushes_in_progress_chunk(tmp_path, speech_clips):
    dead = f"http://127.0.0.1:{free_port()}"
    # speech keeps going until we stop: only the shutdown flush can create the chunk
    audio = np.concatenate([silence(0.5), np.tile(speech_clips["en"], 5)])
    srcs = []
    rec = make_recorder(tmp_path, dead, source_factory=lambda cfg: ArraySource(audio, None, srcs, pace=0.002))
    rec.start()
    assert wait_until(lambda: srcs and srcs[0].pos > SR * 4)
    assert rec.buffer.count() == 0
    rec.stop(5)
    assert srcs[0].closed
    chunks = ChunkBuffer(tmp_path / "buf").list()
    assert len(chunks) >= 1 and chunks[0].duration > 2.0


def test_restart_uploads_leftover_buffer(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    for i in range(3):
        buf.write(tone(0.5 + i * 0.1)[:].tobytes(), 1_800_000_000 + i * 20)
    rec = make_recorder(tmp_path, fake_core.url, source_factory=lambda cfg: ArraySource(silence(1)))
    rec.start()
    try:
        assert wait_until(lambda: len(fake_core.chunks) == 3 and rec.buffer.count() == 0)
    finally:
        rec.stop(3)


# ---------------------------------------------------------------- file source end-to-end
@pytest.mark.parametrize("src_rate,channels", [(16000, 1), (48000, 1), (44100, 2)])
def test_file_source_end_to_end(tmp_path, fake_core, speech_clips, src_rate, channels):
    clip_en, clip_zh = speech_clips["en"], speech_clips["zh"]
    audio16 = np.concatenate([silence(2), clip_en, silence(4), clip_zh, silence(3)])
    path = tmp_path / "in.wav"
    if src_rate == 16000:
        write_wav16k(path, audio16)
    else:
        a = soxr.resample(audio16, 16000, src_rate).astype("<i2")
        if channels == 2:
            a = np.repeat(a[:, None], 2, axis=1)
        with wave.open(str(path), "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(2)
            w.setframerate(src_rate)
            w.writeframes(np.ascontiguousarray(a).tobytes())
    start = "2026-11-11T08:30:00Z"
    s = Settings(core_url=fake_core.url, token="tok", buffer_dir=str(tmp_path / "buf"), source=f"file:{path}",
                 file_speed=200.0, file_start_at=start, heartbeat_interval=0.2)
    rec = Recorder(s, device_lister=lambda: DEVICES)
    rec.start()
    rec.wait()  # returns at EOF once the buffer is drained
    rec.stop(3)
    assert rec.buffer.count() == 0
    assert len(fake_core.chunks) >= 2
    t0 = int(datetime(2026, 11, 11, 8, 30, tzinfo=timezone.utc).timestamp())
    assert iso_utc(t0) == start
    first = fake_core.chunks[0]
    assert first["started_at"] >= iso_utc(t0 + 1)       # silence is not uploaded...
    assert first["started_at"] <= iso_utc(t0 + 3)       # ...but the speech (t=2 s) is stamped relative to start_at
    # every uploaded file is a valid 16 kHz mono 16-bit WAV
    for f in sorted((tmp_path / "received").glob("*.wav")):
        with wave.open(str(f), "rb") as w:
            assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
    total_up = sum(c["duration"] for c in fake_core.chunks)
    assert total_up < len(audio16) / SR - 3  # leading/trailing quiet was dropped
    assert total_up > (len(clip_en) + len(clip_zh)) / SR * 0.5


def test_file_source_loop_and_speed_pacing(tmp_path, speech_clips):
    path = tmp_path / "in.wav"
    write_wav16k(path, np.concatenate([silence(1), speech_clips["en"][: SR * 3], silence(2)]))
    src = FileSource(str(path), speed=50.0, start_at=1_800_000_000.0, loop=True)
    src.open()
    total = 0
    last_t = None
    t_wall = time.time()
    while total < SR * 60:  # 60 s of media must pass in ~1.2 s (x50)
        b = src.read(0.5)
        if b is None:
            continue
        if last_t is not None:
            assert b.t == pytest.approx(last_t, abs=1e-3)  # contiguous timestamps across loops
        last_t = b.t + len(b.pcm) / SR
        total += len(b.pcm)
    src.close()
    assert time.time() - t_wall < 6


def test_file_source_eof_raises_and_not_loop(tmp_path):
    path = tmp_path / "in.wav"
    write_wav16k(path, silence(0.5))
    src = FileSource(str(path), speed=100.0)
    src.open()
    with pytest.raises(EndOfSource):
        for _ in range(100):
            src.read(0.2)
    src.close()


def test_file_source_missing_file():
    src = FileSource("/nonexistent.wav")
    with pytest.raises(SourceError):
        src.open()
