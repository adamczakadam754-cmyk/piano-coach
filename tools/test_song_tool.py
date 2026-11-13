import pytest

from song_tool import note_to_midi, parse_midi, parse_text


def test_note_names():
    assert note_to_midi("C4") == 60
    assert note_to_midi("F#3") == 54
    assert note_to_midi("Bb2") == 46
    with pytest.raises(ValueError):
        note_to_midi("H4")
    with pytest.raises(ValueError):
        note_to_midi("C9")


def test_text_song_with_chords_rests_and_comments():
    song = parse_text("title: Test\nbpm: 100\n# comment\nC4 E4:2 r:0.5 C4+E4+G4 F#4 # trailing comment")
    assert song["title"] == "Test" and song["bpm"] == 100
    assert song["steps"] == [
        {"t": 0, "d": 1.0, "notes": [60]},
        {"t": 1.0, "d": 2.0, "notes": [64]},
        {"t": 3.5, "d": 1.0, "notes": [60, 64, 67]},
        {"t": 4.5, "d": 1.0, "notes": [66]},
    ]


def test_text_errors_name_the_line():
    with pytest.raises(ValueError, match="line 2"):
        parse_text("C4\nC4 X9")
    with pytest.raises(ValueError, match="no notes"):
        parse_text("title: Empty")


def test_midi_chords_are_grouped(tmp_path):
    mido = pytest.importorskip("mido")
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120))])
    for note, delta in [(60, 0), (64, 5), (67, 0)]:  # a chord, slightly ragged
        track.append(mido.Message("note_on", note=note, velocity=80, time=delta))
    track.append(mido.Message("note_on", note=62, velocity=80, time=475))
    mid.tracks.append(track)
    path = tmp_path / "03-my_song.mid"
    mid.save(path)
    song = parse_midi(path)
    assert song["title"] == "My Song" and song["bpm"] == 120
    assert [s["notes"] for s in song["steps"]] == [[60, 64, 67], [62]]
    assert song["steps"][1]["t"] == 1.0
