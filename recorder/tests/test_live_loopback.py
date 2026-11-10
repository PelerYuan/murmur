"""Real PortAudio capture through the ALSA loopback card (``sudo modprobe snd-aloop``).

Skipped automatically when the loopback card, aplay or access to /dev/snd is missing, so it only
runs on machines where it can really exercise DeviceSource.
"""

import os
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

from conftest import SR, silence, write_wav16k
from murmur_recorder.segmenter import Segmenter, SegmenterParams
from murmur_recorder.sources import DeviceSource, SourceError


def _loopback_available() -> bool:
    try:
        return "Loopback" in Path("/proc/asound/cards").read_text() and shutil.which("aplay") and os.access("/dev/snd/controlC0", os.R_OK)
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _loopback_available(), reason="ALSA loopback (snd-aloop) not available")


def test_capture_speech_through_alsa_loopback(tmp_path, speech_clips):
    wav = tmp_path / "play.wav"
    write_wav16k(wav, np.concatenate([silence(1), speech_clips["en"], silence(3)]))
    src = DeviceSource("hw:0,1")
    try:
        src.open()
    except SourceError as e:
        pytest.skip(f"cannot open loopback capture: {e}")
    seg = Segmenter(SegmenterParams())
    chunks = []
    player = subprocess.Popen(["aplay", "-q", "-D", "plughw:0,0,0", str(wav)], stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 12
        t_end_play = None
        while time.time() < deadline:
            blk = src.read(0.3)
            if blk is not None:
                chunks += seg.feed(blk.pcm, blk.t)
            if player.poll() is not None:
                t_end_play = t_end_play or time.time()
                if time.time() - t_end_play > 2.5:
                    break
        chunks += seg.flush()
    finally:
        player.kill()
        src.close()
    assert chunks, "no speech captured from the loopback device"
    speech = sum(c.speech_ms for c in chunks) / 1000
    clip_s = len(speech_clips["en"]) / SR
    assert 0.5 * clip_s <= speech <= 1.5 * clip_s
    assert abs(time.time() - (chunks[-1].started_at + chunks[-1].duration)) < 15  # wall-clock stamped
