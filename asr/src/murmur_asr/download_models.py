"""Model download / verification.  Run with ``python -m murmur_asr.download_models``.

* Models live in MURMUR_ASR_MODEL_DIR (default ~/.cache/murmur-models, /models in Docker).
* Archives are streamed straight into extraction; the .tar.bz2 is never stored on disk.
* Files are written under a temporary name and renamed atomically; an advisory file lock
  (``<model_dir>/.download.lock``) serialises concurrent starters so nobody sees half a model.
* MURMUR_ASR_DOWNLOAD_PROXY, if set, replaces the ``https://github.com`` prefix of every URL
  (for mirrors such as ghproxy-style services).
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import logging
import os
import shutil
import sys
import tarfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .config import Settings

log = logging.getLogger("murmur_asr.models")

GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SENSEVOICE_DIR = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
SENSEVOICE_URL = f"{GH}/asr-models/{SENSEVOICE_DIR}.tar.bz2"
CAMPPLUS_FILE = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
CAMPPLUS_URL = f"{GH}/speaker-recongition-models/{CAMPPLUS_FILE}"
VAD_FILE = "silero_vad.onnx"
VAD_URL = f"{GH}/asr-models/{VAD_FILE}"

WHISPER_NAMES = (
    "tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
    "large-v1", "large-v2", "large-v3", "distil-small.en", "distil-medium.en",
)


@dataclass
class ModelPaths:
    vad: Path
    embedding: Path
    sensevoice_model: Path | None = None
    sensevoice_tokens: Path | None = None
    whisper_encoder: Path | None = None
    whisper_decoder: Path | None = None
    whisper_tokens: Path | None = None


def whisper_dir(name: str) -> str:
    return f"sherpa-onnx-whisper-{name}"


def whisper_files(name: str) -> dict[str, str]:
    return {
        "encoder": f"{name}-encoder.int8.onnx",
        "decoder": f"{name}-decoder.int8.onnx",
        "tokens": f"{name}-tokens.txt",
    }


def _url(settings: Settings, url: str) -> str:
    if settings.download_proxy and url.startswith("https://github.com"):
        return settings.download_proxy.rstrip("/") + "/" + url
    return url


def _open(url: str, retries: int = 3):
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "murmur-asr"})
            return urllib.request.urlopen(req, timeout=60)
        except Exception as e:  # noqa: BLE001
            last = e
            log.warning("download %s failed (%s), attempt %d/%d", url, e, i + 1, retries)
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"cannot download {url}: {last}")


class _Progress:
    def __init__(self, label: str, total: int | None):
        self.label, self.total, self.done, self._next = label, total, 0, 10

    def add(self, n: int) -> None:
        self.done += n
        if self.total:
            pct = self.done * 100 // self.total
            if pct >= self._next:
                log.info("  %s: %d%% (%.0f MB)", self.label, pct, self.done / 1e6)
                self._next = pct + 10 - pct % 10


class _Reader:
    """File-like wrapper that reports progress while tarfile streams from the socket."""

    def __init__(self, resp, prog: _Progress):
        self.resp, self.prog = resp, prog

    def read(self, n=-1):
        b = self.resp.read(n)
        self.prog.add(len(b))
        return b


def _download_file(settings: Settings, url: str, dest: Path) -> None:
    if dest.exists():
        return
    log.info("downloading %s -> %s", url, dest)
    tmp = dest.with_name(dest.name + f".part-{os.getpid()}")
    try:
        with _open(_url(settings, url)) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0) or None
            prog = _Progress(dest.name, total)
            while chunk := r.read(1 << 20):
                f.write(chunk)
                prog.add(len(chunk))
        if tmp.stat().st_size == 0:
            raise RuntimeError(f"empty download from {url}")
        os.replace(tmp, dest)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def _download_archive(settings: Settings, url: str, dest_dir: Path, wanted) -> None:
    """Stream a tar.bz2, extract only members whose basename satisfies `wanted`, into dest_dir."""
    if dest_dir.exists():
        return
    log.info("downloading+extracting %s -> %s (archive is not kept)", url, dest_dir)
    tmp = dest_dir.with_name(dest_dir.name + f".part-{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        with _open(_url(settings, url)) as r:
            total = int(r.headers.get("Content-Length") or 0) or None
            prog = _Progress(dest_dir.name, total)
            with tarfile.open(fileobj=_Reader(r, prog), mode="r|bz2") as tar:
                for m in tar:
                    base = os.path.basename(m.name)
                    if not m.isfile() or not wanted(base):
                        continue
                    src = tar.extractfile(m)
                    with open(tmp / base, "wb") as out:
                        shutil.copyfileobj(src, out, 1 << 20)
        os.rename(tmp, dest_dir)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


@contextlib.contextmanager
def _lock(model_dir: Path):
    model_dir.mkdir(parents=True, exist_ok=True)
    f = open(model_dir / ".download.lock", "w")
    try:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.info("another process is downloading models, waiting for it ...")
            fcntl.flock(f, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def resolve_paths(settings: Settings) -> ModelPaths:
    d = settings.model_dir
    p = ModelPaths(vad=d / VAD_FILE, embedding=d / CAMPPLUS_FILE)
    if settings.backend == "sensevoice":
        p.sensevoice_model = d / SENSEVOICE_DIR / "model.int8.onnx"
        p.sensevoice_tokens = d / SENSEVOICE_DIR / "tokens.txt"
    else:
        f = whisper_files(settings.whisper_model)
        wd = d / whisper_dir(settings.whisper_model)
        p.whisper_encoder, p.whisper_decoder, p.whisper_tokens = wd / f["encoder"], wd / f["decoder"], wd / f["tokens"]
    return p


def missing(paths: ModelPaths) -> list[Path]:
    return [v for v in vars(paths).values() if v is not None and not v.exists()]


def ensure_models(settings: Settings) -> ModelPaths:
    """Make sure every model needed by the configured backend exists; download what is missing."""
    paths = resolve_paths(settings)
    if not missing(paths):
        return paths
    if not settings.auto_download:
        raise RuntimeError(
            f"models missing in {settings.model_dir}: {[p.name for p in missing(paths)]}; "
            "run `python -m murmur_asr.download_models` or set MURMUR_ASR_AUTO_DOWNLOAD=1"
        )
    d = settings.model_dir
    with _lock(d):
        # re-check after acquiring the lock: the other process may have finished the job
        if not missing(paths):
            log.info("models already present in %s", d)
            return paths
        _download_file(settings, VAD_URL, paths.vad)
        _download_file(settings, CAMPPLUS_URL, paths.embedding)
        if settings.backend == "sensevoice":
            _download_archive(settings, SENSEVOICE_URL, d / SENSEVOICE_DIR,
                              lambda b: b in ("model.int8.onnx", "tokens.txt", "LICENSE"))
        else:
            name = settings.whisper_model
            if name not in WHISPER_NAMES:
                raise RuntimeError(f"unknown whisper model {name!r}; known: {', '.join(WHISPER_NAMES)}")
            files = set(whisper_files(name).values())
            _download_archive(settings, f"{GH}/asr-models/{whisper_dir(name)}.tar.bz2", d / whisper_dir(name),
                              lambda b: b in files)
        still = missing(paths)
        if still:
            raise RuntimeError(f"download finished but files are missing: {still}")
    log.info("models ready in %s", d)
    return paths


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download the models murmur-asr needs.")
    ap.add_argument("--backend", choices=["sensevoice", "whisper", "all"], help="default: MURMUR_ASR_BACKEND")
    ap.add_argument("--whisper-model", help="default: MURMUR_ASR_WHISPER_MODEL")
    ap.add_argument("--model-dir", help="default: MURMUR_ASR_MODEL_DIR")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = Settings.from_env()
    if a.model_dir:
        s.model_dir = Path(os.path.expanduser(a.model_dir))
    if a.whisper_model:
        s.whisper_model = a.whisper_model
    s.auto_download = True
    backends = ["sensevoice", "whisper"] if a.backend == "all" else [a.backend or s.backend]
    for b in backends:
        s.backend = b
        ensure_models(s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
