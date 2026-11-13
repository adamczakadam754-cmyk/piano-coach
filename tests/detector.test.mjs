// Run with:  node --test tests/
// Feeds the real browser detector synthetic piano audio, spectrum computed like AnalyserNode does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../web/js/detector.js';
import { midiToFreq } from '../web/js/notes.js';

const SR = 48000, N = 8192, HOP = 800; // 60 fps

function synth(events, seconds) {
  const out = new Float64Array(Math.round(seconds * SR));
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  for (let i = 0; i < out.length; i++) out[i] = rand() * 0.01; // room-ish noise
  for (const [start, len, notes] of events) {
    for (let i = Math.round(start * SR); i < Math.min(out.length, (start + len) * SR); i++) {
      const t = i / SR - start;
      const env = Math.min(1, t / 0.005) * Math.min(1, (start + len - i / SR) / 0.1);
      for (const m of notes) {
        for (let h = 1; h <= 8; h++) {
          const f = midiToFreq(m) * h * Math.sqrt(1 + 0.0004 * h * h);
          out[i] += (0.1 / h) * env * Math.exp(-t * (0.8 + 0.4 * h)) * Math.sin(2 * Math.PI * f * t);
        }
      }
    }
  }
  return out;
}

function spectrumDb(samples) { // Blackman window, radix-2 FFT, 20*log10(|X|/N)
  const re = Float64Array.from(samples, (x, i) =>
    x * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N)));
  const im = new Float64Array(N);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= N; len <<= 1) {
    for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos((-2 * Math.PI * k) / len), wi = Math.sin((-2 * Math.PI * k) / len);
      for (let i = 0; i < N; i += len) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  return Float32Array.from({ length: N / 2 }, (_, k) => 20 * Math.log10(Math.hypot(re[k], im[k]) / N));
}

function run(events, seconds) {
  const audio = synth(events, seconds);
  const det = createDetector(SR, N);
  const frames = [];
  for (let end = HOP; end <= audio.length; end += HOP) {
    const win = new Float64Array(N);
    win.set(audio.subarray(Math.max(0, end - N), end), N - Math.min(N, end));
    const f = det.process(spectrumDb(win));
    frames.push({ t: end / SR, heard: [...f.heard], best: f.best, onsets: f.heard.filter(m => f.isOnset(m)) });
  }
  return frames;
}
const at = (frames, t) => frames.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));

test('single note heard, no octave or fifth ghosts', () => {
  const f = at(run([[0.1, 1.2, [60]]], 0.8), 0.6);
  assert.equal(f.best, 60);
  assert.deepEqual(f.heard, [60]);
});

test('chord: all notes heard, no phantom bass', () => {
  const f = at(run([[0.1, 1.2, [60, 64, 67]]], 0.8), 0.6);
  assert.deepEqual(f.heard, [60, 64, 67]);
});

test('silence hears nothing', () => {
  assert.ok(run([], 0.5).every(f => f.heard.length === 0));
});

test('one onset per strike, and a repeated note strikes again', () => {
  const onsets = run([[0.1, 0.6, [60]], [0.9, 0.6, [60]]], 1.6).flatMap(f => f.onsets.map(m => [f.t, m]));
  assert.deepEqual(onsets.map(([, m]) => m), [60, 60]);
  assert.ok(onsets[1][0] > 0.9);
});
