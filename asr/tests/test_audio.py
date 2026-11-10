import numpy as np
import pytest
from scipy import signal

from conftest import tone, wav_bytes
from murmur_asr.audio import decode_wav, load_audio, resample, to_mono
from murmur_asr.errors import InvalidAudio, PayloadTooLarge, UnsupportedAudio


@pytest.mark.parametrize("sub", ["pcm8", "pcm16", "pcm24", "pcm32", "float32"])
def test_decode_formats(sub):
    x = tone(0.25)
    y, sr, ch = decode_wav(wav_bytes(x, 16000, sub))
    assert sr == 16000 and ch == 1 and y.shape == (len(x), 1)
    assert np.abs(y[:, 0] - x).max() < (0.02 if sub == "pcm8" else 1e-3)


def test_stereo_downmix_averages_channels():
    l, r = tone(0.2, 440), tone(0.2, 880)
    mono = load_audio(wav_bytes(np.stack([l, r], axis=1)))
    assert mono.shape == (len(l),)
    assert np.allclose(mono, (l + r) / 2, atol=1e-3)


def test_to_mono_passthrough():
    x = tone(0.1)
    assert to_mono(x).shape == x.shape


@pytest.mark.parametrize("sr_in", [8000, 11025, 22050, 24000, 44100, 48000])
def test_resample_length_and_frequency(sr_in):
    f = 1000.0
    x = tone(1.0, f, sr=sr_in)
    y = resample(x, sr_in, 16000)
    assert abs(len(y) - 16000) <= 1
    # dominant frequency preserved, amplitude preserved (away from the edges)
    mid = y[2000:-2000]
    spec = np.abs(np.fft.rfft(mid * np.hanning(len(mid))))
    peak = np.argmax(spec) * 16000 / len(mid)
    assert abs(peak - f) < 5
    assert abs(np.abs(mid).max() - 0.5) < 0.03


def test_resample_matches_scipy_reference():
    rng = np.random.default_rng(0)
    x = np.convolve(rng.standard_normal(44100), np.ones(5) / 5, "same").astype(np.float32)  # band-limited-ish noise
    ours = resample(x, 44100, 16000)
    ref = signal.resample_poly(x, 160, 441).astype(np.float32)
    n = min(len(ours), len(ref))
    err = ours[500:n - 500] - ref[500:n - 500]
    assert 10 * np.log10((ref[500:n - 500] ** 2).mean() / (err ** 2).mean()) > 30  # >30 dB SNR


def test_resample_antialiasing():
    x = tone(1.0, 20000, sr=48000)  # above 16k Nyquist (8k) must vanish
    y = resample(x, 48000, 16000)
    assert np.abs(y[1000:-1000]).max() < 0.02


def test_resample_noop_and_empty():
    x = tone(0.1)
    assert resample(x, 16000, 16000) is x or np.array_equal(resample(x, 16000, 16000), x)
    assert len(resample(np.zeros(0, np.float32), 8000, 16000)) == 0


def test_not_a_wav_is_rejected():
    with pytest.raises(InvalidAudio):
        load_audio(b"this is not a wav file at all")
    with pytest.raises(InvalidAudio):
        load_audio(b"")


def test_corrupt_wav_headers():
    good = wav_bytes(tone(0.2))
    with pytest.raises(InvalidAudio):
        load_audio(good[:20])  # truncated inside fmt
    with pytest.raises(InvalidAudio):
        load_audio(good[:12] + b"junk" + b"\x00" * 40)  # no fmt/data
    bad = bytearray(good)
    bad[22:24] = (0).to_bytes(2, "little")  # zero channels
    with pytest.raises(InvalidAudio):
        load_audio(bytes(bad))


def test_truncated_data_chunk_is_tolerated():
    good = wav_bytes(tone(1.0))
    y = load_audio(good[:-4001])  # cut in the middle of the data chunk, as a crashed recorder would leave it
    assert 0.87 < len(y) / 16000 < 0.88


def test_unsupported_codec():
    good = bytearray(wav_bytes(tone(0.2)))
    good[20:22] = (2).to_bytes(2, "little")  # MS ADPCM
    with pytest.raises(UnsupportedAudio):
        load_audio(bytes(good))


def test_zero_length_wav_is_empty_not_error():
    y = load_audio(wav_bytes(np.zeros(0, np.float32)))
    assert len(y) == 0


def test_max_seconds_limit():
    with pytest.raises(PayloadTooLarge):
        load_audio(wav_bytes(tone(3.0)), max_seconds=2.0)


def test_extra_chunks_before_data_are_skipped():
    good = wav_bytes(tone(0.2))
    list_chunk = b"LIST" + (5).to_bytes(4, "little") + b"abcde" + b"\x00"  # odd size + pad byte
    data = good[:36] + list_chunk + good[36:]
    assert len(load_audio(data)) == 3200
