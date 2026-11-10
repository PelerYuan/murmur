import io
import tarfile
import threading
from pathlib import Path

import pytest

from murmur_asr import download_models as dm
from murmur_asr.config import Settings


def make_tar(path: Path, files: dict[str, bytes]):
    with tarfile.open(path, "w:bz2") as t:
        for name, data in files.items():
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))


def test_archive_extracts_only_wanted_and_flattens(tmp_path):
    src = tmp_path / "m.tar.bz2"
    make_tar(src, {"root/model.int8.onnx": b"M", "root/tokens.txt": b"T", "root/test_wavs/a.wav": b"W",
                   "root/export.py": b"E"})
    dest = tmp_path / "models" / "root"
    dest.parent.mkdir()
    dm._download_archive(Settings(), src.as_uri(), dest, lambda b: b in ("model.int8.onnx", "tokens.txt"))
    assert sorted(p.name for p in dest.iterdir()) == ["model.int8.onnx", "tokens.txt"]
    assert not [p for p in dest.parent.iterdir() if ".part" in p.name]


def test_failed_archive_leaves_nothing_behind(tmp_path):
    bad = tmp_path / "bad.tar.bz2"
    bad.write_bytes(b"not a tarball")
    dest = tmp_path / "models" / "root"
    dest.parent.mkdir()
    with pytest.raises(Exception):
        dm._download_archive(Settings(), bad.as_uri(), dest, lambda b: True)
    assert list(dest.parent.iterdir()) == []


def test_file_download_atomic_and_idempotent(tmp_path):
    src = tmp_path / "x.onnx"
    src.write_bytes(b"abc")
    dest = tmp_path / "out" / "x.onnx"
    dest.parent.mkdir()
    dm._download_file(Settings(), src.as_uri(), dest)
    assert dest.read_bytes() == b"abc"
    src.write_bytes(b"changed")
    dm._download_file(Settings(), src.as_uri(), dest)  # existing file is never re-downloaded
    assert dest.read_bytes() == b"abc"
    assert [p.name for p in dest.parent.iterdir()] == ["x.onnx"]


def test_missing_and_auto_download_disabled(tmp_path):
    s = Settings(model_dir=tmp_path, auto_download=False)
    paths = dm.resolve_paths(s)
    assert len(dm.missing(paths)) == 4  # vad, embedding, sensevoice model + tokens
    with pytest.raises(RuntimeError, match="models missing"):
        dm.ensure_models(s)


def test_whisper_paths(tmp_path):
    s = Settings(model_dir=tmp_path, backend="whisper", whisper_model="base")
    p = dm.resolve_paths(s)
    assert p.whisper_encoder.name == "base-encoder.int8.onnx" and p.whisper_encoder.parent.name == "sherpa-onnx-whisper-base"
    assert p.sensevoice_model is None


def test_unknown_whisper_model(tmp_path, monkeypatch):
    monkeypatch.setattr(dm, "_download_file", lambda *a, **k: None)
    s = Settings(model_dir=tmp_path, backend="whisper", whisper_model="gigantic")
    with pytest.raises(RuntimeError, match="unknown whisper model"):
        dm.ensure_models(s)


def test_concurrent_starts_download_once(tmp_path, monkeypatch):
    """Two starters race: the second waits on the lock, sees complete files and downloads nothing."""
    calls = []

    def fake_file(settings, url, dest):
        calls.append(dest.name)
        import time

        time.sleep(0.2)
        dest.write_bytes(b"x")

    def fake_archive(settings, url, dest, wanted):
        calls.append(dest.name)
        dest.mkdir()
        (dest / "model.int8.onnx").write_bytes(b"x")
        (dest / "tokens.txt").write_bytes(b"x")

    monkeypatch.setattr(dm, "_download_file", fake_file)
    monkeypatch.setattr(dm, "_download_archive", fake_archive)
    s = Settings(model_dir=tmp_path / "m")
    ts = [threading.Thread(target=dm.ensure_models, args=(s,)) for _ in range(3)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(calls) == sorted([dm.VAD_FILE, dm.CAMPPLUS_FILE, dm.SENSEVOICE_DIR])
    assert not dm.missing(dm.resolve_paths(s))


def test_proxy_prefix():
    s = Settings(download_proxy="https://mirror.example/")
    assert dm._url(s, "https://github.com/a/b") == "https://mirror.example/https://github.com/a/b"
    assert dm._url(Settings(), "https://github.com/a/b") == "https://github.com/a/b"


def test_settings_validation(monkeypatch):
    monkeypatch.setenv("MURMUR_ASR_BACKEND", "nope")
    with pytest.raises(ValueError):
        Settings.from_env()
    monkeypatch.setenv("MURMUR_ASR_BACKEND", "whisper")
    monkeypatch.setenv("MURMUR_ASR_NUM_THREADS", "3")
    monkeypatch.setenv("MURMUR_ASR_API_KEY", "k")
    s = Settings.from_env()
    assert s.backend == "whisper" and s.num_threads == 3 and s.api_key == "k" and s.port == 8100
