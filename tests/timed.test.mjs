import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimed } from '../web/js/timed.js';
import { frame } from './fake-frame.mjs';

// 60 bpm: one beat = 1000 ms. No latency correction and no count-in, to keep the numbers readable.
const song = { bpm: 60, steps: [{ t: 0, d: 1, notes: [60] }, { t: 1, d: 1, notes: [62] }, { t: 2, d: 1, notes: [64, 67] }] };
const opts = { latencyMs: 0, countInBeats: 0 };
const quiet = frame({});

function play(s, script) { // script: [[ms, midi], ...] onsets at those song times
  const events = [];
  s.update(quiet, 0);
  for (let ms = 0; ms <= 4000; ms += 10) {
    const strikes = script.filter(([t]) => t === ms).map(([, m]) => m);
    const levels = Object.fromEntries(strikes.map(m => [m, 30]));
    events.push(...s.update(frame(levels, strikes), ms));
  }
  return events;
}

test('on-time notes are perfect, slightly off are good, finishes with a score', () => {
  const s = createTimed(song, opts);
  const ev = play(s, [[30, 60], [1160, 62], [2000, 64], [2050, 67]]);
  assert.deepEqual(ev.filter(e => e.type === 'hit').map(e => e.grade), ['perfect', 'good', 'perfect', 'perfect']);
  assert.equal(ev.at(-1).type, 'done');
  assert.equal(s.miss, 0);
  assert.equal(s.maxCombo, 4);
  assert.ok(Math.abs(s.score() - 0.9) < 1e-9); // 3 perfect + 1 good * 0.6, over 4 notes
});

test('notes not played are missed and break the combo', () => {
  const s = createTimed(song, opts);
  const ev = play(s, [[0, 60], [2000, 64]]);
  assert.equal(s.perfect, 2);
  assert.equal(s.miss, 2);
  assert.ok(ev.some(e => e.type === 'miss' && e.note === 62));
});

test('a note far outside its window is not credited', () => {
  const s = createTimed(song, opts);
  play(s, [[600, 62]]); // D4 is due at 1000 ms, 400 ms early is too early
  assert.equal(s.perfect + s.good, 0);
});

test('latency correction: a note heard 130 ms late counts as on time', () => {
  const s = createTimed(song, { ...opts, latencyMs: 130 });
  play(s, [[130, 60], [1130, 62], [2130, 64], [2130, 67]]);
  assert.equal(s.perfect, 4);
});

test('count-in and tempo stretch the timeline', () => {
  const s = createTimed(song, { latencyMs: 0, countInBeats: 4, tempo: 0.5 });
  s.start(0);
  assert.equal(s.beat(0), -4);
  assert.equal(s.beat(8000), 0);  // 4 beats of 2000 ms at half speed
  assert.equal(s.notes[1].time, 2000);
});

test('listen mode plays itself', () => {
  const s = createTimed(song, { countInBeats: 0, auto: true });
  s.update(null, 0);
  const ev = [];
  for (let ms = 0; ms <= 4000; ms += 10) ev.push(...s.update(null, ms));
  assert.equal(s.perfect, 4);
  assert.equal(ev.at(-1).type, 'done');
});
