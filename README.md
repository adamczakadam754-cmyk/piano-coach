# Piano Coach

A free piano-practice web app for iPad and iPhone. Stand the device on a real piano. It shows falling
notes and listens through the microphone. No App Store, no Mac, no MIDI keyboard needed.

Three ways to play each song:
- **Practice**: waits until you've played the right notes before moving on.
- **Play along**: notes fall at the song's tempo (adjustable 50-120%) after a 4-beat count-in. Each note
  is judged Perfect / Good / Miss on timing, with a combo counter, a percentage and stars.
- **Listen**: plays the song so you can hear how it goes, then offers to practise it.

Also:
- **Metronome**: switch it on in the song sheet or with the button while playing. The click is pitched
  so the note detector can't mistake it for a key.
- **Progress dashboard**: daily goal ring, streaks, minutes per day (14 days), a 12-week practice
  calendar, an accuracy trend, and a daily motivation (headline reacts to your progress, tip changes daily).
- **Discover**: search BitMidi's public MIDI archive from inside the app, or import a `.mid` file. Pick
  which track to play, optionally "Melody only", and it's added to your library.

Best scores, practice history and your library are stored in each device's browser.

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
| `web/js/follower.js` | Practice mode. A step is done when each of its notes is *freshly struck*: its level rises 6 dB, so a note still ringing from the last step doesn't count. Also holds `isWrongNote`, the strict "was that really a mistake?" check both modes use. |
| `web/js/timed.js` | Play along and Listen. Matches each note onset to the nearest expected note within -250/+300 ms (after latency correction), grades it, and counts misses as their windows close. |
| `web/js/smooth.js` | Steadies what the screen shows: a key lights only after its note has been heard ~60 ms, stays lit 350 ms, and the "Hearing" name only switches once another note has been loudest for 150 ms. |
| `web/js/render.js` | Draws falling notes and the keyboard. Yellow = play now, green = heard, red = wrong, purple = what the mic hears. Glow, spark bursts, beat pulse. |
| `web/js/metronome.js` | Schedules clicks 120 ms ahead on the audio clock, locked to the song's beat grid (accent on beat 1). |
| `web/js/stats.js` | Practice history: daily minutes, streaks, summaries, daily motivation. |
| `web/js/dashboard.js` | The Progress screen's tiles and SVG charts, with hover tooltips and a table view. |
| `web/js/midi.js` | Standard MIDI File parser and MIDI-to-song conversion (track choice, range folding, "skyline" melody extraction). |
| `web/js/library.js` | The personal song library and BitMidi search/download (BitMidi's API allows browser requests). |
| `web/js/main.js` | Tabs, sheets, the animation loop, wake lock, settings, wiring everything together. |
| `tools/song_tool.py` | Converts `.txt` (easy hand-written format) or `.mid` into song JSON and rebuilds `songs/index.json`. |
| `tools/detector_lab.py` | Python twin of `detector.js` for tuning on recordings. |

**Why detection works without "real" transcription:** the app knows which notes *should* come next,
so it only has to confirm them, which is much easier than working out arbitrary chords from scratch.
The rules that make it robust:
- **Tonal peaks only:** a harmonic counts if it's a local maximum above both the *local* noise floor
  (median per ~140 Hz block, since room noise is much louder in the bass) and the spectrum 4 bins either
  side. Hammer thumps and neighbouring notes don't qualify.
- **3 harmonics, fundamental required from C3 up.** One real overtone plus one noise blip isn't a note,
  and C4+G4 together look like the overtones of C3.
- **Stable for 3 frames (~50 ms) with hysteresis**, so notes don't flash on and off.
- **Explaining away:** a note is only "heard" if 2 of its harmonics aren't part of a lower sounding
  note's harmonic series, and are clearly real (4 dB above threshold). This removes octave, fifth and
  higher overtone ghosts in general.
- **Strikes use raw loudness**, not the pass/fail peak test, so a flickering test can't fake a new strike.
- **A wrong note must be the loudest note**, unrelated to (and not next to) any note you're meant to be
  playing, at least 300 ms after a correct note, and at most one per 0.8 s.

On a simulated reverberant room (6 rooms, 96 notes), these changes cut ghost note onsets from 108 to 6
and missed notes from 8 to 3. The wrong-note rules filter out most of the rest.

## Run it on your PC

```sh
cd web
python -m http.server 8000
```
Open http://localhost:8000 in Chrome or Edge. The mic works on `localhost` without HTTPS.
Use **Mic check** and play notes (a piano app on your phone works) to see what the detector hears.
`python tools/detector_lab.py --demo` shows the detector on a simulated piano in a reverberant room.

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

The in-app **Settings** do this per device without code changes. *Microphone sensitivity* shifts the
thresholds. *Timing correction* is the delay between playing a note and the app hearing it (~130 ms by
default). Raise it if Play along keeps calling you late.

## Tests

```sh
python -m pytest tools          # detector on simulated piano + rooms, metronome clicks, song tool
node --test tests/*.test.mjs    # browser detector, modes, display smoothing, metronome, stats, MIDI import, library, dashboard
```

## Known limits / next steps

- Songs have no left/right-hand information, so all notes are drawn the same colour.
- A note played an octave away from the expected one may be accepted (deliberately lenient).
- Listen mode is quieter on iPhone while the mic is open (iOS routes audio for calls); fine on iPad.
- Scores, history and the library live in each device's browser storage, not in the cloud, so they
  don't sync between devices. Clearing Safari's website data erases them.
- Online songs are full arrangements of varying quality; "Melody only" and choosing a single track help.
- The metronome assumes 4 beats per bar.
- No offline support or home-screen icon yet (needs a service worker and a PNG `apple-touch-icon`).
- Real pianos and rooms vary, so expect to tune with `detector_lab.py` on your friend's piano.
