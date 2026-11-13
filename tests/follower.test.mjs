import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollower } from '../web/js/follower.js';

// A fake detector frame: levels in dB, a note is "present" at >= 10, onsets listed explicitly.
const frame = (levels, onsets = []) => ({
  heard: Object.keys(levels).map(Number).filter(m => levels[m] >= 10),
  levelOf: m => levels[m] ?? 0,
  isPresent: m => (levels[m] ?? 0) >= 10,
  isOnset: m => onsets.includes(m),
});
const song = steps => ({ steps: steps.map((notes, i) => ({ t: i, d: 1, notes })) });
const types = events => events.map(e => e.type);

test('advances on the right note and finishes', () => {
  const f = createFollower(song([[60], [62]]));
  assert.deepEqual(types(f.update(frame({}), 0)), []);
  assert.deepEqual(types(f.update(frame({ 60: 30 }), 100)), ['hit', 'step']);
  assert.deepEqual(types(f.update(frame({ 60: 25, 62: 30 }), 200)), ['hit', 'done']);
  assert.equal(f.done, true);
});

test('a chord needs every note', () => {
  const f = createFollower(song([[60, 64, 67]]));
  assert.deepEqual(types(f.update(frame({ 60: 30, 64: 30 }), 0)), ['hit', 'hit']);
  assert.equal(f.done, false);
  assert.deepEqual(types(f.update(frame({ 60: 28, 64: 28, 67: 30 }), 50)), ['hit', 'done']);
});

test('a repeated note must be struck again, ringing does not count', () => {
  const f = createFollower(song([[60], [60]]));
  f.update(frame({ 60: 30 }), 0);
  assert.equal(f.index, 1);
  assert.deepEqual(f.update(frame({ 60: 29 }), 100), []); // still ringing
  assert.deepEqual(f.update(frame({ 60: 26 }), 200), []); // decaying
  assert.deepEqual(types(f.update(frame({ 60: 38 }), 300)), ['hit', 'done']); // struck again
});

test('wrong notes are counted once, not right after a step change', () => {
  const f = createFollower(song([[60], [62]]));
  f.update(frame({ 60: 30 }), 0); // -> step 1, quiet for 450 ms
  assert.deepEqual(f.update(frame({ 65: 30 }, [65]), 100), []);
  assert.deepEqual(types(f.update(frame({ 65: 30 }, [65]), 600)), ['wrong']);
  assert.deepEqual(f.update(frame({ 65: 30 }, [65]), 700), []); // same strike, debounced
  assert.equal(f.wrong, 1);
});

test('skip moves on and is counted', () => {
  const f = createFollower(song([[60], [62]]));
  assert.deepEqual(types(f.skip(null, 0)), ['step']);
  assert.deepEqual(types(f.skip(null, 10)), ['done']);
  assert.equal(f.skipped, 2);
});
