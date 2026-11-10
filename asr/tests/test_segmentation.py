import numpy as np

from murmur_asr.segmentation import (SR, Seg, drop_short, enforce_max_len, merge_segments, pad_segments, split_long)


def S(a, b):  # seconds -> Seg
    return Seg(int(a * SR), int(b * SR))


def test_merge_joins_close_neighbours():
    out = merge_segments([S(0, 2), S(2.2, 4), S(10, 12)], max_gap=0.3, max_len=25)
    assert out == [S(0, 4), S(10, 12)]


def test_merge_respects_max_len():
    out = merge_segments([S(0, 20), S(20.1, 30)], max_gap=0.3, max_len=25)
    assert out == [S(0, 20), S(20.1, 30)]


def test_merge_sorts_and_handles_overlap():
    out = merge_segments([S(5, 7), S(0, 2), S(1.5, 3)], max_gap=0.0, max_len=25)
    assert out == [S(0, 3), S(5, 7)]


def test_merge_empty():
    assert merge_segments([], 0.3, 25) == []


def test_split_long_cuts_in_the_quietest_place():
    x = np.ones(SR * 40, np.float32) * 0.5
    quiet_at = int(18 * SR)
    x[quiet_at: quiet_at + int(0.2 * SR)] = 0.0  # a pause at 18.0-18.2 s
    parts = split_long(x, Seg(0, len(x)), max_len=25)
    assert len(parts) == 2
    assert parts[0].start == 0 and parts[-1].end == len(x) and parts[0].end == parts[1].start
    assert quiet_at <= parts[0].end <= quiet_at + int(0.2 * SR)


def test_split_long_all_pieces_bounded_and_contiguous():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(SR * 130).astype(np.float32)
    parts = split_long(x, Seg(0, len(x)), max_len=25)
    assert all(p.n <= 25 * SR for p in parts)
    assert parts[0].start == 0 and parts[-1].end == len(x)
    assert all(a.end == b.start for a, b in zip(parts, parts[1:]))
    assert len(parts) >= 6
    assert all(p.n >= 25 * SR * 0.5 for p in parts[:-1])  # no silly tiny pieces


def test_split_short_untouched():
    x = np.zeros(SR * 10, np.float32)
    assert split_long(x, Seg(0, len(x)), 25) == [Seg(0, len(x))]


def test_enforce_max_len_mixed():
    x = np.random.default_rng(0).standard_normal(SR * 100).astype(np.float32)
    out = enforce_max_len(x, [S(0, 10), S(20, 70)], 25)
    assert out[0] == S(0, 10)
    assert all(s.n <= 25 * SR for s in out) and len(out) == 1 + 3


def test_drop_short():
    assert drop_short([S(0, 0.2), S(1, 2)], 0.3) == [S(1, 2)]


def test_pad_never_crosses_neighbour_midpoint_or_bounds():
    total = 10 * SR
    segs = [S(0.1, 2), S(2.2, 4), S(8, 9.95)]
    p = pad_segments(segs, total, 0.5)
    assert p[0].start == 0 and p[-1].end == total
    assert p[0].end == (S(0, 2).end + segs[1].start) // 2  # 2.1 s, midpoint of the 0.2 s gap
    assert p[1].start == p[0].end
    assert p[1].end == 4 * SR + int(0.5 * SR)
    assert p[2].start == 8 * SR - int(0.5 * SR)
