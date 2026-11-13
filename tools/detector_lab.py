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
                peak_db=10, hysteresis_db=3, abs_min_db=-85, attack_db=6,
                history_frames=15, stable_frames=3, floor_block=24, own_margin_db=4)
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
    present: np.ndarray  # sounding, and stable for stable_frames frames
    attack: np.ndarray   # being struck: level rose attack_db within the last ~250 ms
    onset: np.ndarray    # first frame of an attack
    onsets: list         # notes with an onset this frame
    heard: list          # present notes minus overtone ghosts
    best: int | None


class Detector:
    def __init__(self, sample_rate: int, fft_size: int = FFT_SIZE, **options):
        self.o = o = {**DEFAULTS, **options}
        self.bin_hz = bin_hz = sample_rate / fft_size
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
        self.blocks = max(1, (self.floor_hi - self.floor_lo + 1) // o["floor_block"])
        n = len(self.notes)
        self.history = np.zeros((o["history_frames"], n))
        self.raw = np.zeros(n, dtype=bool)
        self.run = np.zeros(n, dtype=int)
        self.prev_attack = np.zeros(n, dtype=bool)
        self.slot = 0

    def process(self, db: np.ndarray) -> Frame:
        o = self.o
        db = np.maximum(np.nan_to_num(db, nan=SILENT, neginf=SILENT), SILENT)
        top = len(db) - 1
        B = o["floor_block"]

        # Local noise floor: median of each ~140 Hz block. Room noise is far louder in the bass,
        # so one floor for the whole spectrum lets bass noise through and hides quiet treble.
        floors = []
        for b in range(self.blocks):
            lo = self.floor_lo + b * B
            hi = self.floor_hi + 1 if b == self.blocks - 1 else lo + B
            chunk = np.sort(db[lo:hi])
            floors.append(float(chunk[len(chunk) // 2]))

        def at(k):
            return db[max(0, min(top, k))]

        def floor_at(k):
            return floors[max(0, min(self.blocks - 1, (k - self.floor_lo) // B))]

        n = len(self.notes)
        salience, level, raw = np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool)
        peaks = [[] for _ in range(n)]  # bins of each note's qualifying harmonics
        for i, w in enumerate(self.windows):
            # Hysteresis: once sounding, a note may dip a little without dropping out.
            thr = o["peak_db"] - (o["hysteresis_db"] if self.raw[i] else 0)
            total = wsum = lvl = 0.0
            hits, odd, fundamental = 0, False, False
            for h, (lo, hi) in enumerate(w):
                k = lo + int(np.argmax(db[lo : hi + 1]))
                v = db[k]
                is_peak = v >= at(k - 1) and v >= at(k + 1) and v > o["abs_min_db"]
                p = max(0.0, min(v - floor_at(k), v - max(at(k - 4), at(k + 4)))) if is_peak else 0.0
                total += WEIGHTS[h] * min(p, 40)
                wsum += WEIGHTS[h]
                if h < 3:  # raw loudness, NOT gated by the peak test: a flickering test must not look like a new strike
                    lvl = max(lvl, v - o["abs_min_db"])
                if p >= thr:
                    peaks[i].append((k, p))
                if p >= thr and h < 5:
                    hits += 1
                    fundamental |= h == 0
                    odd |= h in (0, 2, 4)
            salience[i] = total / wsum if wsum else 0.0
            level[i] = max(0.0, lvl)
            # 3 harmonics where the note has them (one real overtone + one noise blip is not a note);
            # fundamental required from C3 up, because chords supply the upper harmonics of lower notes.
            need = 3 if len(w) >= 4 else 2
            raw[i] = hits >= need and (fundamental if self.notes[i] >= 48 else odd)

        self.raw = raw
        self.run = np.where(raw, self.run + 1, 0)
        present = self.run >= o["stable_frames"]  # ignore notes that flash up for a frame or two
        attack = present & (level - self.history.min(axis=0) >= o["attack_db"])
        onset = attack & ~self.prev_attack
        self.prev_attack = attack
        self.history[self.slot] = level
        self.slot = (self.slot + 1) % len(self.history)

        # Explaining away: a note is only "heard" if at least 2 of its harmonics are its own, not
        # also harmonics of a lower sounding note. Removes octave/fifth/overtone ghosts in general.
        sounding = [j for j in range(n) if raw[j] or present[j]]
        heard = []
        for i in range(n):
            if not present[i]:
                continue
            lower = [midi_to_freq(self.notes[j]) for j in sounding if j < i]
            own = [p for k, p in peaks[i] if not any(self._is_harmonic(k * self.bin_hz, f0) for f0 in lower)]
            # Own harmonics must be clearly real: random noise peaks reach the plain threshold
            # somewhere in the spectrum every frame.
            if sum(p >= o["peak_db"] + o["own_margin_db"] for p in own) >= 2:
                heard.append(self.notes[i])
        best = max(heard, key=lambda m: salience[m - self.notes[0]], default=None)
        onsets = [self.notes[i] for i in range(n) if onset[i]]
        return Frame(salience, level, present, attack, onset, onsets, heard, best)

    def _is_harmonic(self, f: float, f0: float) -> bool:
        """Is frequency f (a measured peak) one of f0's harmonics? Allows stretched piano overtones."""
        r = round(f / f0)
        if r < 1:
            return False
        if abs(f - r * f0) <= 1.5 * self.bin_hz:
            return True
        cents = 1200 * math.log2(f / (r * f0))
        return -35 <= cents <= 35 + 8 * r


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
    """Piano-like test audio. events = [(start_s, length_s, [midi, ...]), ...].

    Each note has a hammer thump, 3 slightly detuned strings (so it "beats" like a real piano),
    stretched overtones and random phases, over background noise.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    out = rng.normal(0, noise, t.size)
    for start, length, notes in events:
        on = (t >= start) & (t < start + length)
        tt = t[on] - start
        env = np.minimum(1, tt / 0.003) * np.minimum(1, (start + length - t[on]) / 0.1)  # 100 ms damper release
        out[on] += rng.normal(0, 0.15, tt.size) * np.exp(-tt / 0.012)                    # hammer thump
        for m in notes:
            for h in range(1, 9):
                for cents in (-1.5, 0, 1.7):
                    fh = midi_to_freq(m) * 2 ** (cents / 1200) * h * math.sqrt(1 + 0.0004 * h * h)
                    out[on] += (0.035 / h * env * np.exp(-tt * (0.8 + 0.4 * h))
                                * np.sin(2 * np.pi * fh * tt + rng.uniform(0, 2 * np.pi)))
    return out, sample_rate


def room(samples: np.ndarray, sample_rate: int, reverb_s: float = 0.9, wet: float = 0.5,
         gain: float = 0.3, noise: float = 4e-3, seed: int = 0) -> np.ndarray:
    """Make a clean recording sound like a living room: reverb, distance (gain) and background noise."""
    rng = np.random.default_rng(seed)
    n = int(reverb_s * sample_rate)
    ir = rng.normal(0, 1, n) * np.exp(-6.9 * np.arange(n) / n)
    ir /= np.sqrt((ir ** 2).sum())
    size = 2 * len(samples)
    tail = np.fft.irfft(np.fft.rfft(samples, size) * np.fft.rfft(ir, size))[: len(samples)]
    return gain * (samples + wet * tail) + rng.normal(0, noise, len(samples))


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
        samples = room(samples, sr)
        print("played (in a simulated room): C4 at 0.20s, E4 at 1.00s, G4 at 1.80s, C4+E4+G4 at 2.60s\n")
    elif args.wav:
        samples, sr = read_wav(args.wav)
    else:
        ap.error("give a WAV file or --demo")

    for t, frame in analyse(samples, sr, peak_db=args.peak_db, attack_db=args.attack_db):
        new = [m for m in frame.onsets if m in frame.heard]
        if new:
            print(f"{t:6.2f}s  {' '.join(note_name(m) for m in new)}")


if __name__ == "__main__":
    main()
