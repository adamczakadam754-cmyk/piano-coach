"""Run with:  python -m pytest tools"""
import pytest

from detector_lab import analyse, room, synth

C4, D4, E4, F4, G4, C3 = 60, 62, 64, 65, 67, 48


def frames(events, seconds=2.0, in_room=False, seed=0, **kw):
    samples, sr = synth(events, seconds=seconds, seed=seed)
    if in_room:
        samples = room(samples, sr, seed=seed + 10)
    return list(analyse(samples, sr, **kw))


def at(fs, t):
    return min(fs, key=lambda f: abs(f[0] - t))[1]


def onsets(fs):
    return [(round(t, 2), m) for t, f in fs for m in f.onsets if m in f.heard]


def test_single_note_is_heard_without_ghosts():
    f = at(frames([(0.1, 1.5, [C4])]), 0.6)
    assert f.best == C4
    assert f.heard == [C4]  # no octave-above (C5) or fifth (G4) ghosts


def test_chord_notes_all_heard_and_no_phantom_bass():
    f = at(frames([(0.1, 1.5, [C4, E4, G4])]), 0.6)
    assert f.heard == [C4, E4, G4]
    assert not f.present[C3 - 40]  # C4 + G4 together look like C3's overtones


def test_silence_hears_nothing():
    assert all(not f.heard for _, f in frames([], seconds=1.0, in_room=True))


def test_one_onset_per_strike():
    assert [m for _, m in onsets(frames([(0.1, 1.5, [C4])]))] == [C4]


def test_repeated_note_gives_second_onset():
    found = onsets(frames([(0.1, 0.6, [C4]), (0.9, 0.8, [C4])]))
    assert [m for _, m in found] == [C4, C4]
    assert found[1][0] > 0.9


def test_onset_latency_is_short():
    (t, _), = onsets(frames([(0.5, 1.0, [G4])]))
    assert 0.5 < t < 0.7


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_reverberant_room_no_ghost_onsets_and_no_misses(seed):
    """The bug users saw: in a real room the heard note flickered and ghost notes piled up."""
    melody = [[C4], [D4], [E4], [F4], [G4], [C4, E4, G4]]
    events = [(0.2 + 0.6 * i, 0.5, n) for i, n in enumerate(melody)]
    found = onsets(frames(events, seconds=4.5, in_room=True, seed=seed))
    ghosts = [(t, m) for t, m in found
              if not any(m in ns and 0 <= t - st <= 0.35 for st, _, ns in events)]
    played = {(i, m) for i, (st, _, ns) in enumerate(events) for m in ns
              if any(mm == m and 0 <= t - st <= 0.35 for t, mm in found)}
    assert len(ghosts) <= 1, ghosts
    assert len(played) >= 7  # of the 8 notes
