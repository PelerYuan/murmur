import hashlib
import time
import wave

import numpy as np
import pytest

from murmur_recorder.buffer import ChunkBuffer, format_name, iso_utc, parse_name
from murmur_recorder.client import CoreClient
from murmur_recorder.uploader import Uploader
from murmur_recorder.wavio import wav_bytes

T0 = 1_800_000_000.0
SR = 16000


_counter = iter(range(10_000))


def pcm(seconds=1.0, amp=3000):
    """Unique content on every call (distinct sha256) unless two identical chunks are wanted."""
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * (200 + next(_counter)) * t)).astype("<i2").tobytes()


# ---------------------------------------------------------------- WAV format / naming
def test_wav_is_16k_mono_16bit(tmp_path):
    buf = ChunkBuffer(tmp_path)
    bc = buf.write(pcm(1.5), T0)
    with wave.open(str(bc.path), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        assert w.getnframes() == int(1.5 * SR)
    assert bc.path.read_bytes()[:4] == b"RIFF"
    assert bc.size == 44 + int(1.5 * SR) * 2
    assert bc.duration == pytest.approx(1.5)


def test_filename_encodes_utc_start_and_roundtrips():
    name = format_name(T0 + 0.123)
    assert name.endswith("Z.wav") and name.startswith("20270115T080000.123")
    assert parse_name(name) == pytest.approx(T0 + 0.123, abs=1e-3)
    assert parse_name("junk.wav") is None
    assert iso_utc(T0) == "2027-01-15T08:00:00Z"


def test_write_is_atomic_no_tmp_left_and_collision_safe(tmp_path):
    buf = ChunkBuffer(tmp_path)
    a = buf.write(pcm(0.5), T0)
    b = buf.write(pcm(0.5), T0)  # same ms timestamp
    assert a.path != b.path and a.path.exists() and b.path.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_startup_rescan_and_stale_tmp_cleanup(tmp_path):
    buf = ChunkBuffer(tmp_path)
    buf.write(pcm(), T0 + 10)
    buf.write(pcm(), T0)
    (tmp_path / "20270115T080000.000Z.wav.tmp").write_bytes(b"partial")
    again = ChunkBuffer(tmp_path)  # "restart"
    assert [c.started_at for c in again.list()] == sorted(c.started_at for c in again.list())
    assert again.count() == 2
    assert not list(tmp_path.glob("*.tmp"))


def test_eviction_oldest_first_with_warning(tmp_path, caplog):
    one = len(wav_bytes(pcm(1.0)))
    buf = ChunkBuffer(tmp_path, max_bytes=int(one * 3.5))
    for i in range(5):
        buf.write(pcm(1.0), T0 + i * 10)
    left = buf.list()
    assert len(left) == 3
    assert [round(c.started_at) for c in left] == [round(T0 + 20), round(T0 + 30), round(T0 + 40)]
    assert buf.evicted == 2
    assert any("LOST" in r.message for r in caplog.records)


# ---------------------------------------------------------------- uploader
def make_uploader(core, buf, token="tok", **kw):
    client = CoreClient(core.url, token, timeout=2, upload_timeout=5)
    kw.setdefault("backoff_initial", 0.05)
    kw.setdefault("backoff_cap", 0.4)
    return Uploader(buf, client, **kw)


def drain(up, limit=50):
    for _ in range(limit):
        r = up.step()
        if r == "idle":
            return
        if r in ("backoff", "failed"):
            time.sleep(0.06)
    raise AssertionError("did not drain")


def test_uploads_in_time_order_and_deletes_after_success(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    # written out of order
    for off in (30, 10, 20):
        buf.write(pcm(0.5 + off / 100), T0 + off)
    up = make_uploader(fake_core, buf)
    drain(up)
    assert buf.count() == 0
    assert [c["started_at"] for c in fake_core.chunks] == [iso_utc(T0 + o) for o in (10, 20, 30)]
    c = fake_core.chunks[0]
    assert c["duration"] == pytest.approx(0.6, abs=0.001)
    assert len(c["sha256"]) == 64


def test_upload_sends_correct_sha256_and_bearer(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    bc = buf.write(pcm(1), T0)
    sha = hashlib.sha256(bc.path.read_bytes()).hexdigest()
    up = make_uploader(fake_core, buf, token="s3cret")
    assert up.step() == "ok"
    assert fake_core.chunks[0]["sha256"] == sha
    assert fake_core.tokens_seen == ["s3cret"]


def test_idempotent_duplicate_returns_200_and_file_is_deleted(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    bc = buf.write(pcm(1), T0)
    data = bc.path.read_bytes()
    up = make_uploader(fake_core, buf)
    assert up.step() == "ok"
    # simulate "uploaded but ack lost": the same bytes re-appear in the buffer
    bc.path.write_bytes(data)
    assert up.step() == "ok"
    assert len(fake_core.chunks) == 1 and len(fake_core.chunk_posts) == 2
    assert up.duplicates == 1
    assert buf.count() == 0


def test_core_down_keeps_files_and_backs_off_then_recovers(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    for i in range(3):
        buf.write(pcm(0.5), T0 + i * 10)
    fake_core.fail_all = True
    up = make_uploader(fake_core, buf)
    assert up.step() == "failed"
    assert buf.count() == 3 and up.last_error
    assert up.step() == "backoff"  # respects the retry time
    fake_core.fail_all = False
    drain(up)
    assert buf.count() == 0 and len(fake_core.chunks) == 3
    assert up.last_error is None


def test_backoff_is_exponential_and_capped():
    class Dummy:
        dir = "."

        def count(self):
            return 0

    up = Uploader(Dummy(), None, backoff_initial=1.0, backoff_cap=60.0)  # type: ignore[arg-type]
    delays = []
    for _ in range(10):
        before = time.monotonic()
        up._fail("x")
        delays.append(up._next_try - before)
    assert delays[0] < 1.3 and 1.6 < delays[1] < 2.6 and 3.2 < delays[2] < 5.2
    assert max(delays) <= 60.0 + 0.1
    assert delays[-1] > 40  # reached the cap region


def test_unreachable_core_connection_refused(tmp_path):
    buf = ChunkBuffer(tmp_path / "buf")
    buf.write(pcm(0.5), T0)

    class C:
        url = "http://127.0.0.1:1"  # nothing listens

    up = make_uploader(C, buf)
    assert up.step() == "failed"
    assert buf.count() == 1
    assert "unreachable" in up.last_error


def test_401_is_clear_slow_retry_and_keeps_audio(tmp_path, fake_core, caplog):
    fake_core.required_token = "right"
    buf = ChunkBuffer(tmp_path / "buf")
    buf.write(pcm(0.5), T0)
    up = make_uploader(fake_core, buf, token="wrong", backoff_cap=5.0)
    before = time.monotonic()
    assert up.step() == "failed"
    assert buf.count() == 1
    assert up.unauthorized
    assert "MURMUR_TOKEN" in up.last_error
    assert up._next_try - before > 3.0  # slow retry (capped at 5 here, jittered)
    assert any("token" in r.message.lower() for r in caplog.records)
    # fixing the token (e.g. rotated + restarted) works
    up2 = make_uploader(fake_core, buf, token="right")
    assert up2.step() == "ok" and buf.count() == 0


def test_invalid_wav_in_buffer_is_quarantined_not_retried_forever(tmp_path, fake_core):
    buf = ChunkBuffer(tmp_path / "buf")
    (buf.dir / format_name(T0)).write_bytes(b"RIFFnot really")
    good = buf.write(pcm(0.5), T0 + 5)
    up = make_uploader(fake_core, buf)
    drain(up)
    assert (buf.rejected_dir / format_name(T0)).exists()
    assert len(fake_core.chunks) == 1 and not good.path.exists()


def test_permanent_4xx_moves_to_rejected(tmp_path, fake_core, monkeypatch):
    buf = ChunkBuffer(tmp_path / "buf")
    bc = buf.write(pcm(0.5), T0)
    orig = fake_core.handle

    def handle(method, path, headers, body):
        if path.endswith("/chunks"):
            return 422, {"detail": "nope", "code": "validation_error"}
        return orig(method, path, headers, body)

    monkeypatch.setattr(fake_core, "handle", handle)
    up = make_uploader(fake_core, buf)
    assert up.step() == "rejected"
    assert (buf.rejected_dir / bc.path.name).exists() and buf.count() == 0


def test_core_goes_down_mid_run_and_comes_back_on_same_port(tmp_path, fake_core):
    """Threaded uploader keeps working across a real server shutdown/restart."""
    buf = ChunkBuffer(tmp_path / "buf")
    up = make_uploader(fake_core, buf)
    up.start()
    try:
        buf.write(pcm(0.5), T0)
        up.notify()
        deadline = time.time() + 5
        while buf.count() and time.time() < deadline:
            time.sleep(0.05)
        assert buf.count() == 0 and len(fake_core.chunks) == 1

        port = fake_core.port
        fake_core.stop()  # Core dies
        for i in range(1, 4):
            buf.write(pcm(0.5), T0 + 10 * i)
            up.notify()
        time.sleep(0.6)
        assert buf.count() == 3  # nothing lost, nothing uploaded
        assert up.last_error

        fake_core.start(port=port)  # Core returns (same state object, new socket)
        deadline = time.time() + 8
        while buf.count() and time.time() < deadline:
            time.sleep(0.05)
        assert buf.count() == 0
        assert [c["started_at"] for c in fake_core.chunks] == [iso_utc(T0 + 10 * i) for i in range(0, 4)]
    finally:
        up.stop()
        up.join(2)


def test_uploader_survives_recorder_restart(tmp_path, fake_core):
    d = tmp_path / "buf"
    buf = ChunkBuffer(d)
    fake_core.fail_all = True
    for i in range(2):
        buf.write(pcm(0.5), T0 + i * 10)
    up = make_uploader(fake_core, buf)
    assert up.step() == "failed"
    # process "restarts": new buffer object + new uploader, Core is back
    fake_core.fail_all = False
    up2 = make_uploader(fake_core, ChunkBuffer(d))
    drain(up2)
    assert len(fake_core.chunks) == 2
