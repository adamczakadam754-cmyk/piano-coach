// Finds piano notes in a dB magnitude spectrum (what AnalyserNode.getFloatFrequencyData gives).
// Pure code, no Web Audio, so it also runs in Node tests.
// Mirrored in tools/detector_lab.py for tuning on recordings: keep the two in sync.
import { midiToFreq } from './notes.js';

export const DEFAULTS = {
  minMidi: 40,        // E2
  maxMidi: 96,        // C7
  harmonics: 6,
  maxHz: 5000,
  peakDb: 10,         // a harmonic counts when it stands this far above the local noise floor...
  hysteresisDb: 3,    // ...or this much less once the note is already sounding
  absMinDb: -85,      // ...and is louder than this (dBFS)
  ownMarginDb: 4,     // a note's own (unexplained) harmonics must clear peakDb by this much
  attackDb: 6,        // a loudness rise this big means the key was (re)struck
  historyFrames: 15,  // ~250 ms at 60 fps, for attack detection
  stableFrames: 3,    // a note must be found this many frames in a row (~50 ms) to count
  floorBlock: 24,     // noise floor measured per block of this many bins (~140 Hz)
};
const WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0.3];
const SILENT = -140;
const clean = v => (v > SILENT ? v : SILENT); // also maps -Infinity and NaN to SILENT

export function createDetector(sampleRate, fftSize, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const binHz = sampleRate / fftSize;
  const last = fftSize / 2 - 2;
  const count = o.maxMidi - o.minMidi + 1;
  const H = o.harmonics;

  // Bin range to search for each harmonic of each note, computed once.
  const windows = [];
  for (let i = 0; i < count; i++) {
    const f0 = midiToFreq(o.minMidi + i);
    const w = [];
    for (let h = 1; h <= H && f0 * h <= o.maxHz; h++) {
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
  const floorHi = Math.min(last, Math.floor(o.maxHz / binHz));
  const blocks = Math.max(1, Math.floor((floorHi - floorLo + 1) / o.floorBlock));
  const floors = new Float32Array(blocks);
  const scratch = new Float32Array(o.floorBlock * 2);

  const history = Array.from({ length: o.historyFrames }, () => new Float32Array(count));
  let slot = 0;
  const raw = new Uint8Array(count);
  const run = new Uint8Array(count);
  const peakBin = new Int32Array(count * H); // qualifying harmonics per note: bin and strength
  const peakP = new Float32Array(count * H);
  const peakN = new Uint8Array(count);

  let db = null;
  const at = k => clean(db[Math.max(0, Math.min(last + 1, k))]);
  const floorAt = k => floors[Math.max(0, Math.min(blocks - 1, Math.floor((k - floorLo) / o.floorBlock)))];
  const idx = m => (m >= o.minMidi && m <= o.maxMidi ? m - o.minMidi : -1);

  // Is frequency f (a measured peak) one of f0's harmonics? Allows stretched piano overtones.
  function isHarmonic(f, f0) {
    const r = Math.round(f / f0);
    if (r < 1) return false;
    if (Math.abs(f - r * f0) <= 1.5 * binHz) return true;
    const cents = 1200 * Math.log2(f / (r * f0));
    return cents >= -35 && cents <= 35 + 8 * r;
  }

  const frame = {
    loudness: 0,                       // strongest note level, for the level meter
    best: null,                        // most prominent heard note, or null
    heard: [],                         // present notes minus overtone ghosts
    onsets: [],                        // present notes struck this frame
    salience: new Float32Array(count), // weighted harmonic strength (ranking)
    level: new Float32Array(count),    // raw loudness of the first 3 harmonics, dB above absMinDb
    present: new Uint8Array(count),    // sounding, stable for stableFrames frames
    attack: new Uint8Array(count),     // being struck: level rose attackDb within the last ~250 ms
    isPresent: m => idx(m) >= 0 && frame.present[idx(m)] === 1,
    levelOf: m => (idx(m) >= 0 ? frame.level[idx(m)] : 0),
  };

  function process(spectrum) {
    db = spectrum;
    // Local noise floor: median of each block. Room noise is far louder in the bass, so a single
    // floor for the whole spectrum lets bass noise through and hides quiet treble.
    for (let b = 0; b < blocks; b++) {
      const lo = floorLo + b * o.floorBlock;
      const hi = b === blocks - 1 ? floorHi + 1 : lo + o.floorBlock;
      const chunk = scratch.subarray(0, hi - lo);
      for (let k = lo; k < hi; k++) chunk[k - lo] = clean(db[k]);
      chunk.sort();
      floors[b] = chunk[chunk.length >> 1];
    }

    let loudness = 0;
    frame.onsets = [];
    for (let i = 0; i < count; i++) {
      const w = windows[i];
      const thr = o.peakDb - (raw[i] ? o.hysteresisDb : 0); // once sounding, may dip without dropping out
      let sum = 0, wsum = 0, hits = 0, odd = false, fundamental = false, level = -Infinity;
      peakN[i] = 0;
      for (let h = 0; h < w.length; h++) {
        let k = w[h][0];
        for (let j = k + 1; j <= w[h][1]; j++) if (at(j) > at(k)) k = j;
        const v = at(k);
        // A tonal peak: a local maximum standing above both the local noise floor and the spectrum
        // 4 bins either side (a pure tone's main lobe is ±3 bins; hammer noise has no such peak).
        const isPeak = v >= at(k - 1) && v >= at(k + 1) && v > o.absMinDb;
        const p = isPeak ? Math.max(0, Math.min(v - floorAt(k), v - Math.max(at(k - 4), at(k + 4)))) : 0;
        sum += WEIGHTS[h] * Math.min(p, 40);
        wsum += WEIGHTS[h];
        // Raw loudness, NOT gated by the peak test: a flickering test must not look like a new strike.
        if (h < 3) level = Math.max(level, v - o.absMinDb);
        if (p >= thr) {
          peakBin[i * H + peakN[i]] = k;
          peakP[i * H + peakN[i]++] = p;
          if (h < 5) {
            hits++;
            if (h === 0) fundamental = true;
            if (h % 2 === 0) odd = true; // h = 0, 2, 4 are the 1st, 3rd, 5th harmonics
          }
        }
      }
      frame.salience[i] = wsum ? sum / wsum : 0;
      frame.level[i] = Math.max(0, level);
      // 3 harmonics where the note has them (one real overtone plus one noise blip is not a note).
      // From C3 up the fundamental is required: chords supply the upper harmonics of lower notes.
      // Bass notes have weak fundamentals (small mics barely hear them): 1st, 3rd or 5th will do.
      const need = w.length >= 4 ? 3 : 2;
      raw[i] = hits >= need && (o.minMidi + i >= 48 ? fundamental : odd) ? 1 : 0;
      run[i] = raw[i] ? Math.min(255, run[i] + 1) : 0;
      frame.present[i] = run[i] >= o.stableFrames ? 1 : 0; // ignore notes that flash up for a frame or two

      let min = Infinity;
      for (const past of history) min = Math.min(min, past[i]);
      const attack = frame.present[i] && frame.level[i] - min >= o.attackDb ? 1 : 0;
      if (attack && !frame.attack[i]) frame.onsets.push(o.minMidi + i);
      frame.attack[i] = attack;
      loudness = Math.max(loudness, frame.level[i]);
    }
    history[slot].set(frame.level);
    slot = (slot + 1) % history.length;

    // Explaining away: a note is only "heard" if at least 2 of its harmonics are its own, i.e. not
    // harmonics of a lower sounding note, and clearly real. Removes octave/fifth/overtone ghosts.
    frame.heard = [];
    frame.best = null;
    let bestSal = 0;
    for (let i = 0; i < count; i++) {
      if (!frame.present[i]) continue;
      let own = 0;
      for (let a = 0; a < peakN[i]; a++) {
        if (peakP[i * H + a] < o.peakDb + o.ownMarginDb) continue;
        const f = peakBin[i * H + a] * binHz;
        let explained = false;
        for (let j = 0; j < i && !explained; j++) {
          if (raw[j] || frame.present[j]) explained = isHarmonic(f, midiToFreq(o.minMidi + j));
        }
        if (!explained) own++;
      }
      if (own < 2) continue;
      frame.heard.push(o.minMidi + i);
      if (frame.salience[i] > bestSal) {
        bestSal = frame.salience[i];
        frame.best = o.minMidi + i;
      }
    }
    frame.loudness = loudness;
    return frame;
  }

  return { process, options: o };
}
