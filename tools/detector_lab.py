"""Python twin of web/js/detector.js, for tuning the note detector on real recordings.

    python tools/detector_lab.py recording.wav   # print the notes it hears, and when
    python tools/detector_lab.py --demo          # same, on synthesised piano-like notes

Workflow: record your friend's piano from where the iPad will stand, save it as a 16-bit WAV,
run this, and compare the printout with what was played. Adjust DEFAULTS until it matches,
then copy the numbers into DEFAULTS in web/js/detector.js.
"""
import argparse
import math
import wave
from dataclasses import dataclass

import numpy as np

# Keep in sync with DEFAULTS in web/js/detector.js.
DEFAULTS = dict(min_midi=40, max_midi=96, harmonics=6, max_hz=5000,
                peak_db=10, abs_min_db=-85, attack_db=6, history_frames=15)
WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0.3]
SILENT = -140.0
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FFT_SIZE = 8192


def midi_to_freq(m: int) -> float:
    return 440 * 2 ** ((m - 69) / 12)


def note_name(m: int) -> str:
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def spectrum_db(samples: np.ndarray) -> np.ndarray:
    """dB spectrum the way the browser's AnalyserNode computes it (Blackman window, |X| / N)."""
    n = len(samples)
    mag = np.abs(np.fft.rfft(samples * np.blackman(n)))[: n // 2] / n
    with np.errstate(divide="ignore"):
        return np.maximum(20 * np.log10(mag), SILENT)


@dataclass
class Frame:
    salience: np.ndarray
    level: np.ndarray
    present: np.ndarray
    attack: np.ndarray  # being struck: level rose attack_db within the last ~250 ms
    onset: np.ndarray   # first frame of an attack
    heard: list
    best: int | None
    floor: float


class Detector:
    def __init__(self, sample_rate: int, fft_size: int = FFT_SIZE, **options):
        self.o = o = {**DEFAULTS, **options}
        bin_hz = sample_rate / fft_size
        last = fft_size // 2 - 2
        self.notes = list(range(o["min_midi"], o["max_midi"] + 1))
        self.windows = []
        for m in self.notes:
            f0, w = midi_to_freq(m), []
            for h in range(1, o["harmonics"] + 1):
                f = f0 * h
                if f > o["max_hz"]:
                    break
                centre = math.floor(f / bin_hz + 0.5)  # same rounding as JS Math.round
                lo = min(math.floor(f * 2 ** (-35 / 1200) / bin_hz), centre - 1)
                hi = max(math.ceil(f * 2 ** ((35 + 8 * h) / 1200) / bin_hz), centre + 1)
                w.append((max(1, lo), min(last, hi)))
            self.windows.append(w)
        self.floor_lo = math.ceil(60 / bin_hz)
        self.floor_hi = min(last, math.floor(o["max_hz"] / bin_hz))
        self.history = np.zeros((o["history_frames"], len(self.notes)))
        self.prev_attack = np.zeros(len(self.notes), dtype=bool)
        self.slot = 0

    def process(self, db: np.ndarray) -> Frame:
        o = self.o
        db = np.maximum(np.nan_to_num(db, nan=SILENT, neginf=SILENT), SILENT)
        band = np.sort(db[self.floor_lo : self.floor_hi + 1])
        floor = float(band[len(band) // 2])
        n = len(self.notes)
        salience, level, present = np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool)
        top = len(db) - 1

        def at(k):
            return db[max(0, min(top, k))]

        for i, w in enumerate(self.windows):
            total = wsum = lvl = 0.0
            hits, odd, fundamental = 0, False, False
            for h, (lo, hi) in enumerate(w):
                k = lo + int(np.argmax(db[lo : hi + 1]))
                v = db[k]
                # Tonal peak: local max, above the floor AND above the spectrum 4 bins either side.
                is_peak = v >= at(k - 1) and v >= at(k + 1) and v > o["abs_min_db"]
                p = max(0.0, min(v - floor, v - max(at(k - 4), at(k + 4)))) if is_peak else 0.0
                total += WEIGHTS[h] * min(p, 40)
                wsum += WEIGHTS[h]
                if p >= o["peak_db"]:
                    if h < 3:
                        lvl = max(lvl, v - o["abs_min_db"])
                    if h < 4:
                        hits += 1
                    fundamental |= h == 0
                    odd |= h in (0, 2)
            salience[i] = total / wsum if wsum else 0.0
            level[i] = lvl
            present[i] = hits >= 2 and (fundamental if self.notes[i] >= 48 else odd)

        attack = present & (level - self.history.min(axis=0) >= o["attack_db"])
        onset = attack & ~self.prev_attack
        self.prev_attack = attack
        self.history[self.slot] = level
        self.slot = (self.slot + 1) % len(self.history)

        heard = [self.notes[i] for i in range(n)
                 if present[i] and not any(i >= d and present[i - d] for d in (12, 19, 24))]
        best = max(heard, key=lambda m: salience[m - self.notes[0]], default=None)
        return Frame(salience, level, present, attack, onset, heard, best, floor)


def analyse(samples: np.ndarray, sample_rate: int, fps: int = 60, **options):
    """Yield (time_in_seconds, Frame) at the rate the web app runs (~60 fps)."""
    det = Detector(sample_rate, **options)
    hop = sample_rate // fps
    padded = np.concatenate([np.zeros(FFT_SIZE), samples])
    for end in range(FFT_SIZE + hop, len(padded) + 1, hop):
        yield (end - FFT_SIZE) / sample_rate, det.process(spectrum_db(padded[end - FFT_SIZE : end]))


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as f:
        if f.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16-bit PCM WAV (convert with e.g. Audacity or ffmpeg)")
        data = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float64) / 32768
        return data.reshape(-1, f.getnchannels()).mean(axis=1), f.getframerate()


def synth(events, sample_rate: int = 48000, seconds: float = 2.0, noise: float = 3e-3, seed: int = 0):
    """Piano-ish test audio over room-like noise. events = [(start_s, length_s, [midi, ...]), ...]."""
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    out = np.random.default_rng(seed).normal(0, noise, t.size)
    for start, length, notes in events:
        on = (t >= start) & (t < start + length)
        tt = t[on] - start
        env = np.minimum(1, tt / 0.005) * np.minimum(1, (start + length - t[on]) / 0.1)  # 100 ms damper release
        for m in notes:
            f0 = midi_to_freq(m)
            for h in range(1, 9):
                fh = f0 * h * math.sqrt(1 + 0.0004 * h * h)  # slight inharmonicity, like real strings
                out[on] += 0.1 / h * env * np.exp(-tt * (0.8 + 0.4 * h)) * np.sin(2 * np.pi * fh * tt)
    return out, sample_rate


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav", nargs="?", help="16-bit WAV recording")
    ap.add_argument("--demo", action="store_true", help="analyse synthesised notes instead")
    ap.add_argument("--peak-db", type=float, default=DEFAULTS["peak_db"])
    ap.add_argument("--attack-db", type=float, default=DEFAULTS["attack_db"])
    args = ap.parse_args()
    if args.demo:
        samples, sr = synth([(0.2, 0.6, [60]), (1.0, 0.6, [64]), (1.8, 0.6, [67]), (2.6, 1.0, [60, 64, 67])],
                            seconds=4.0)
        print("played: C4 at 0.20s, E4 at 1.00s, G4 at 1.80s, C4+E4+G4 at 2.60s\n")
    elif args.wav:
        samples, sr = read_wav(args.wav)
    else:
        ap.error("give a WAV file or --demo")

    for t, frame in analyse(samples, sr, peak_db=args.peak_db, attack_db=args.attack_db):
        new = [m for m in frame.heard if frame.onset[m - DEFAULTS["min_midi"]]]
        if new:
            print(f"{t:6.2f}s  {' '.join(note_name(m) for m in new)}")


if __name__ == "__main__":
    main()
