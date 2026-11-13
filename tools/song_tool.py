"""Turn songs into the JSON the web app plays.

    python tools/song_tool.py                # rebuild web/songs from everything in tools/songs_src
    python tools/song_tool.py path/to/x.mid  # convert extra .txt / .mid files into web/songs

Text format (each token is one beat unless you give a length):
    title: Ode to Joy
    bpm: 100
    E4 E4 F4 G4        # single notes, 1 beat each
    C4+E4+G4:2         # chord held for 2 beats
    r:0.5              # half-beat rest
A token starting with # begins a comment, so F#4 is still a note.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "tools" / "songs_src"
OUT_DIR = ROOT / "web" / "songs"
PITCH = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_RE = re.compile(r"([A-G])([#b]?)(-?\d)")
META_RE = re.compile(r"(title|bpm)\s*:\s*(.+)", re.IGNORECASE)


def note_to_midi(name: str) -> int:
    m = NOTE_RE.fullmatch(name)
    if not m:
        raise ValueError(f"not a note: {name!r} (expected something like C4, F#3, Bb2)")
    letter, accidental, octave = m.groups()
    midi = 12 * (int(octave) + 1) + PITCH[letter] + {"#": 1, "b": -1, "": 0}[accidental]
    if not 21 <= midi <= 108:
        raise ValueError(f"{name} is outside the piano's range (A0-C8)")
    return midi


def parse_text(text: str, default_title: str = "Untitled") -> dict:
    meta = {"title": default_title, "bpm": "90"}
    steps, beat = [], 0.0
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if m := META_RE.fullmatch(line):
            meta[m.group(1).lower()] = m.group(2).split(" #")[0].strip()  # "bpm: 80  # slow"
            continue
        for token in line.split():
            if token.startswith("#"):
                break
            notes_part, _, dur_part = token.partition(":")
            try:
                dur = float(dur_part) if dur_part else 1.0
                if dur <= 0:
                    raise ValueError
            except ValueError:
                raise ValueError(f"line {lineno}: bad length in {token!r}") from None
            if notes_part.lower() != "r":
                try:
                    notes = sorted({note_to_midi(n) for n in notes_part.split("+")})
                except ValueError as e:
                    raise ValueError(f"line {lineno}: {e}") from None
                steps.append({"t": round(beat, 3), "d": dur, "notes": notes})
            beat += dur
    if not steps:
        raise ValueError("song has no notes")
    try:
        bpm = int(meta["bpm"])
    except ValueError:
        raise ValueError(f"bpm must be a whole number, got {meta['bpm']!r}") from None
    return {"title": meta["title"], "bpm": bpm, "steps": steps}


def parse_midi(path: Path) -> dict:
    try:
        import mido
    except ImportError:
        sys.exit("MIDI support needs mido:  pip install mido")
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    tempo, tick, starts = 500_000, 0, []
    for msg in mido.merge_tracks(mid.tracks):
        tick += msg.time
        if msg.type == "set_tempo" and not starts:
            tempo = msg.tempo
        elif msg.type == "note_on" and msg.velocity > 0 and msg.channel != 9:  # channel 10 is drums
            starts.append((tick, msg.note))
    if not starts:
        raise ValueError("no notes in this MIDI file")

    groups = []  # notes starting within 1/16 beat of each other form one chord
    for t, note in sorted(starts):
        if groups and t - groups[-1][0] <= tpb // 16:
            groups[-1][1].add(note)
        else:
            groups.append((t, {note}))
    # ponytail: length = gap to the next chord, which is all wait mode needs. Every track is merged,
    # so delete accompaniment tracks in a MIDI editor first if you only want the melody.
    steps = []
    for i, (t, notes) in enumerate(groups):
        nxt = groups[i + 1][0] if i + 1 < len(groups) else t + tpb
        steps.append({"t": round(t / tpb, 3), "d": round((nxt - t) / tpb, 3), "notes": sorted(notes)})
    title = re.sub(r"^\d+[-_ ]*", "", path.stem).replace("_", " ").replace("-", " ").title()
    return {"title": title, "bpm": round(mido.tempo2bpm(tempo)), "steps": steps}


def convert(path: Path) -> dict:
    if path.suffix.lower() in (".mid", ".midi"):
        return parse_midi(path)
    return parse_text(path.read_text(encoding="utf-8"), default_title=path.stem)


def write_index() -> None:
    songs = []
    for p in sorted(OUT_DIR.glob("*.json")):
        if p.name == "index.json":
            continue
        song = json.loads(p.read_text(encoding="utf-8"))
        songs.append({"file": p.name, "title": song["title"], "steps": len(song["steps"])})
    (OUT_DIR / "index.json").write_text(json.dumps(songs, indent=2), encoding="utf-8")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", type=Path, help=".txt or .mid files (default: all of tools/songs_src)")
    args = ap.parse_args(argv)
    files = args.files or sorted(p for p in SRC_DIR.iterdir() if p.suffix.lower() in (".txt", ".mid", ".midi"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in files:
        try:
            song = convert(path)
        except (ValueError, OSError, EOFError) as e:
            sys.exit(f"{path}: {e}")
        out = OUT_DIR / f"{path.stem}.json"
        out.write_text(json.dumps(song), encoding="utf-8")
        print(f"{path.name} -> web/songs/{out.name}  ({len(song['steps'])} steps)")
    write_index()


if __name__ == "__main__":
    main()
