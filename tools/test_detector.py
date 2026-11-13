"""Run with:  python -m pytest tools"""
from detector_lab import analyse, synth

C4, E4, G4, C3, C5 = 60, 64, 67, 48, 72


def frames(events, seconds=2.0, **kw):
    samples, sr = synth(events, seconds=seconds)
    return list(analyse(samples, sr, **kw))


def at(fs, t):
    return min(fs, key=lambda f: abs(f[0] - t))[1]


def onsets(fs):
    return [(round(t, 2), m) for t, f in fs for m in f.heard if f.onset[m - 40]]


def test_single_note_is_heard_without_ghosts():
    f = at(frames([(0.1, 1.5, [C4])]), 0.6)
    assert f.best == C4
    assert f.heard == [C4]  # no octave-above (C5) or fifth (G4) ghosts


def test_chord_notes_all_heard_and_no_phantom_bass():
    f = at(frames([(0.1, 1.5, [C4, E4, G4])]), 0.6)
    assert {C4, E4, G4} <= set(f.heard)
    assert not f.present[C3 - 40]  # C4 + G4 together look like C3's overtones


def test_silence_hears_nothing():
    fs = frames([], seconds=1.0)
    assert all(not f.heard for _, f in fs)


def test_one_onset_per_strike():
    assert [m for _, m in onsets(frames([(0.1, 1.5, [C4])]))] == [C4]


def test_repeated_note_gives_second_onset():
    found = onsets(frames([(0.1, 0.6, [C4]), (0.9, 0.8, [C4])]))
    assert [m for _, m in found] == [C4, C4]
    assert found[1][0] > 0.9


def test_onset_latency_is_short():
    (t, _), = onsets(frames([(0.5, 1.0, [G4])]))
    assert 0.5 < t < 0.65
