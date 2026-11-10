import importlib.util
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
TESTDATA = Path("/home/peler/murmur-testdata/sherpa/sensevoice_test_wavs")
SR = 16000


def _load_fake_core():
    spec = importlib.util.spec_from_file_location("fake_core", ROOT / "tools" / "fake_core.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["fake_core"] = mod
    spec.loader.exec_module(mod)
    return mod


fake_core_mod = _load_fake_core()


def read_wav16k(path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").copy()


def write_wav16k(path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.asarray(samples, dtype="<i2").tobytes())


def silence(seconds: float, noise_rms: float = 0.0, seed: int = 0) -> np.ndarray:
    n = int(SR * seconds)
    if noise_rms <= 0:
        return np.zeros(n, dtype="<i2")
    return np.random.default_rng(seed).normal(0, noise_rms, n).astype("<i2")


def espeak_clip(text: str, voice: str, tmp: Path) -> np.ndarray:
    import soxr

    out = tmp / f"{voice}.wav"
    subprocess.run(["espeak-ng", "-v", voice, "-s", "150", text, "-w", str(out)], check=True)
    with wave.open(str(out), "rb") as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        r = w.getframerate()
    return soxr.resample(a, r, SR).astype("<i2")


@pytest.fixture(scope="session")
def speech_clips(tmp_path_factory):
    """Real speech (16 kHz mono int16): prefers the shared test data, falls back to espeak-ng."""
    clips = {}
    if (TESTDATA / "en.wav").exists():
        clips["en"] = read_wav16k(TESTDATA / "en.wav")
        clips["zh"] = read_wav16k(TESTDATA / "zh.wav")
    elif shutil.which("espeak-ng"):
        tmp = tmp_path_factory.mktemp("espeak")
        clips["en"] = espeak_clip("Please remember to send the report before five o'clock today.", "en", tmp)
        clips["zh"] = espeak_clip("明天下午三点记得开会，别忘了带上文件。", "zh", tmp)
    else:
        pytest.skip("no real speech available (need murmur-testdata or espeak-ng)")
    return clips


@pytest.fixture
def fake_core(tmp_path):
    core = fake_core_mod.FakeCore(out_dir=tmp_path / "received")
    port = core.start()
    core.url = f"http://127.0.0.1:{port}"
    core.port = port
    yield core
    core.stop()
