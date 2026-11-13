# Piano Coach

A free piano-practice web app for iPad and iPhone. Stand the device on a real piano. It shows falling
notes and listens through the microphone, then waits until you've played the right notes before moving on.
No App Store, no Mac, no MIDI keyboard needed.

## Architecture

```
 PC (Python tools)                         Browser on iPad / iPhone (JavaScript)
 ─────────────────                         ──────────────────────────────────────────────────────────
 tools/songs_src/*.txt, *.mid              mic ──► audio.js ──► detector.js ──► follower.js ──► main.js
        │  song_tool.py                    (getUserMedia,  (spectrum →     (expected vs     (screens,
        ▼                                   AnalyserNode    which notes     heard: hit /     60 fps loop)
 web/songs/*.json ─────── loaded by ─────►  8192-pt FFT)    are sounding)   wrong / next)       │
                                                                                                ▼
 detector_lab.py: same detector as                                                 render.js (canvas:
 detector.js, run on WAV recordings                                                falling notes + keys)
 to tune its thresholds
```

| File | Job |
|---|---|
| `web/js/audio.js` | Opens the mic with voice processing **off** (it squashes piano) and feeds an `AnalyserNode`. |
| `web/js/detector.js` | Per frame: for every note E2–C7, checks for tonal peaks at its harmonics. Returns which notes are sounding (`present`), which were just struck (`onset`), and the most prominent one (`best`). |
| `web/js/follower.js` | Wait mode. A step is done when each of its notes is *freshly struck*: its level rises 6 dB, so a note still ringing from the last step doesn't count. Counts wrong notes and skips. |
| `web/js/render.js` | Draws falling notes and the keyboard. Yellow = play now, green = heard, red = wrong, purple = what the mic hears. |
| `web/js/main.js` | Home / practice / done screens, the animation loop, wake lock, sensitivity setting. |
| `tools/song_tool.py` | Converts `.txt` (easy hand-written format) or `.mid` into song JSON and rebuilds `songs/index.json`. |
| `tools/detector_lab.py` | Python twin of `detector.js` for tuning on recordings. |

**Why detection works without "real" transcription:** the app knows which notes *should* come next,
so it only has to confirm them, which is much easier than working out arbitrary chords from scratch.
The rules that make it robust:
- A harmonic counts only if it's a sharp peak above both the noise floor and the spectrum 4 bins
  either side. Hammer noise and neighbouring notes don't qualify.
- From C3 up, the fundamental is required, because C4+G4 together look like the overtones of C3.
- Octave-above and fifth-above ghosts are dropped when a lower note explains them.

## Run it on your PC

```sh
cd web
python -m http.server 8000
```
Open http://localhost:8000 in Chrome or Edge. The mic works on `localhost` without HTTPS.
Use **Mic check** and play notes (a piano app on your phone works) to see what the detector hears.

## Put it on the iPad (free)

1. Create a GitHub account and a new **public** repo, e.g. `piano-coach`.
2. In this folder:
   ```sh
   git init -b main
   git add .
   git commit -m "Piano Coach"
   git remote add origin https://github.com/<you>/piano-coach.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Source: GitHub Actions**. The included workflow publishes `web/`
   to `https://<you>.github.io/piano-coach/` on every push.
4. On the iPad, open that link in **Safari**, then **Share → Add to Home Screen**. It now opens full-screen like an app.
5. First tap on a song asks for the microphone. Allow it.

## Add songs

Write a `.txt` in `tools/songs_src/` (see the existing ones), or drop in a `.mid`, then:
```sh
pip install -r requirements.txt
python tools/song_tool.py
```
```
title: Ode to Joy
bpm: 100
E4 E4 F4 G4      # 1 beat each
C4+E4+G4:2       # chord, 2 beats
r:0.5            # half-beat rest
```
File names set the order (`01-…`, `02-…`). MIDI files have all tracks merged, so remove the accompaniment first.

## Tune the detector for a real piano

1. Record the piano from where the iPad will stand: a few single notes, some repeated notes, a few chords.
   Save as 16-bit WAV (Audacity can convert Voice Memos).
2. `python tools/detector_lab.py recording.wav` prints each note it hears and when.
3. If it misses notes, lower `peak_db` (try `--peak-db 7`). If it hears notes that weren't played,
   raise it. Then copy the values into `DEFAULTS` in **both** `tools/detector_lab.py` and `web/js/detector.js`.

The in-app **sensitivity slider** does the same adjustment per device without code changes.

## Tests

```sh
python -m pytest tools          # detector (synthetic piano audio) + song tool
node --test tests/*.test.mjs    # the actual browser detector + follower
```

## Known limits / next steps

- Wait mode only. A timed mode (notes move at the song's tempo, scored for timing) fits into `follower.js`.
- No "listen to the song first" playback yet (Web Audio oscillators would do).
- A note played an octave *below* the expected one may be accepted.
- No offline support or home-screen icon yet (needs a service worker and a PNG `apple-touch-icon`).
- Real pianos and rooms vary, so expect to tune with `detector_lab.py` on your friend's piano.
