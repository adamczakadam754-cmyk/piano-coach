// Finds piano notes in a dB magnitude spectrum (what AnalyserNode.getFloatFrequencyData gives).
// Pure code, no Web Audio, so it also runs in Node tests.
// Mirrored in tools/detector_lab.py for tuning on recordings: keep the two in sync.
import { midiToFreq } from './notes.js';

export const DEFAULTS = {
  minMidi: 40,       // E2
  maxMidi: 96,       // C7
  harmonics: 6,
  maxHz: 5000,
  peakDb: 10,        // a harmonic counts when it stands this far above the noise floor...
  absMinDb: -85,     // ...and is louder than this (dBFS)
  attackDb: 6,       // a rise this big means the key was (re)struck
  historyFrames: 15, // ~250 ms at 60 fps
};
const WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0.3];
const SILENT = -140;
const clean = v => (v > SILENT ? v : SILENT); // also maps -Infinity and NaN to SILENT

export function createDetector(sampleRate, fftSize, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const binHz = sampleRate / fftSize;
  const last = fftSize / 2 - 2;
  const count = o.maxMidi - o.minMidi + 1;

  // Bin range to search for each harmonic of each note, computed once.
  const windows = [];
  for (let i = 0; i < count; i++) {
    const f0 = midiToFreq(o.minMidi + i);
    const w = [];
    for (let h = 1; h <= o.harmonics && f0 * h <= o.maxHz; h++) {
      const f = f0 * h;
      const centre = Math.round(f / binHz);
      // Piano overtones run sharp (stiff strings), so search further up for higher harmonics.
      const lo = Math.min(Math.floor((f * 2 ** (-35 / 1200)) / binHz), centre - 1);
      const hi = Math.max(Math.ceil((f * 2 ** ((35 + 8 * h) / 1200)) / binHz), centre + 1);
      w.push([Math.max(1, lo), Math.min(last, hi)]);
    }
    windows.push(w);
  }

  const floorLo = Math.ceil(60 / binHz);
  const floorBand = new Float32Array(Math.min(last, Math.floor(o.maxHz / binHz)) - floorLo + 1);
  const history = Array.from({ length: o.historyFrames }, () => new Float32Array(count));
  let slot = 0;

  const idx = m => (m >= o.minMidi && m <= o.maxMidi ? m - o.minMidi : -1);
  let db = null;
  const at = k => clean(db[Math.max(0, Math.min(last + 1, k))]);
  const frame = {
    floor: SILENT,
    loudness: 0,                       // strongest note level, for the level meter
    best: null,                        // most prominent note heard, or null
    heard: [],                         // notes heard, overtone ghosts removed
    salience: new Float32Array(count), // weighted harmonic strength in dB above floor (ranking)
    level: new Float32Array(count),    // loudest of the first 3 harmonics, dB above absMinDb (attacks)
    present: new Uint8Array(count),
    attack: new Uint8Array(count),     // being struck: level rose attackDb within the last ~250 ms
    onset: new Uint8Array(count),      // first frame of an attack
    isPresent: m => idx(m) >= 0 && frame.present[idx(m)] === 1,
    isOnset: m => idx(m) >= 0 && frame.onset[idx(m)] === 1,
    levelOf: m => (idx(m) >= 0 ? frame.level[idx(m)] : 0),
  };

  function process(spectrum) {
    db = spectrum;
    for (let k = 0; k < floorBand.length; k++) floorBand[k] = clean(db[floorLo + k]);
    floorBand.sort();
    const floor = floorBand[floorBand.length >> 1]; // median: robust to the few bins the notes occupy
    let loudness = 0;

    for (let i = 0; i < count; i++) {
      const w = windows[i];
      let sum = 0, wsum = 0, hits = 0, odd = false, fundamental = false, level = 0;
      for (let h = 0; h < w.length; h++) {
        let k = w[h][0];
        for (let j = k + 1; j <= w[h][1]; j++) if (at(j) > at(k)) k = j;
        const v = at(k);
        // A tonal peak: a local maximum standing above both the noise floor and the spectrum 4 bins
        // either side. A pure tone's main lobe is ±3 bins wide; hammer noise and the skirts of
        // neighbouring notes don't make peaks like that.
        const isPeak = v >= at(k - 1) && v >= at(k + 1) && v > o.absMinDb;
        const p = isPeak ? Math.max(0, Math.min(v - floor, v - Math.max(at(k - 4), at(k + 4)))) : 0;
        sum += WEIGHTS[h] * Math.min(p, 40);
        wsum += WEIGHTS[h];
        if (p >= o.peakDb) {
          if (h < 3) level = Math.max(level, v - o.absMinDb); // absolute, so a jumping floor can't fake attacks
          if (h < 4) hits++;
          if (h === 0) fundamental = true;
          if (h === 0 || h === 2) odd = true;
        }
      }
      frame.salience[i] = wsum ? sum / wsum : 0;
      frame.level[i] = level;
      // Need 2 of the first 4 harmonics. From C3 up the fundamental is required too: chords supply
      // the upper harmonics of notes below them (C4 + G4 look like C3). Bass notes have weak
      // fundamentals (and small mics barely hear them), so there 1st or 3rd harmonic will do.
      frame.present[i] = hits >= 2 && (o.minMidi + i >= 48 ? fundamental : odd) ? 1 : 0;
      let min = Infinity;
      for (const past of history) min = Math.min(min, past[i]);
      const attack = frame.present[i] && level - min >= o.attackDb ? 1 : 0;
      frame.onset[i] = attack && !frame.attack[i] ? 1 : 0;
      frame.attack[i] = attack;
      loudness = Math.max(loudness, level);
    }
    history[slot].set(frame.level);
    slot = (slot + 1) % history.length;

    // Drop notes explained as overtones of a lower sounding note (octave, octave + fifth, two octaves).
    // ponytail: also hides genuine octave doublings, fine for "what did you just play?".
    frame.heard = [];
    frame.best = null;
    let bestSal = 0;
    for (let i = 0; i < count; i++) {
      if (!frame.present[i] || [12, 19, 24].some(d => i >= d && frame.present[i - d])) continue;
      frame.heard.push(o.minMidi + i);
      if (frame.salience[i] > bestSal) {
        bestSal = frame.salience[i];
        frame.best = o.minMidi + i;
      }
    }
    frame.floor = floor;
    frame.loudness = loudness;
    return frame;
  }

  return { process, options: o };
}
