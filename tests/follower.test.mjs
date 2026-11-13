import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollower } from '../web/js/follower.js';
import { frame } from './fake-frame.mjs';

const song = steps => ({ steps: steps.map((notes, i) => ({ t: i, d: 1, notes })) });
const types = events => events.map(e => e.type);

test('advances on the right note and finishes', () => {
  const f = createFollower(song([[60], [62]]));
  assert.deepEqual(types(f.update(frame({}), 0)), []);
  assert.deepEqual(types(f.update(frame({ 60: 30 }), 100)), ['hit', 'step']);
  assert.deepEqual(types(f.update(frame({ 60: 25, 62: 30 }), 200)), ['hit', 'done']);
  assert.equal(f.done, true);
  assert.equal(f.score(), 1);
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

test('a clear wrong note is counted', () => {
  const f = createFollower(song([[60], [62]]));
  f.update(frame({ 60: 30 }), 0); // -> step 1, quiet for 450 ms
  assert.deepEqual(f.update(frame({ 69: 30 }, [69]), 100), []); // too soon after the step change
  assert.deepEqual(types(f.update(frame({ 69: 30 }, [69]), 600)), ['wrong']);
  assert.equal(f.wrong, 1);
});

test('a burst of different ghost notes counts at most once', () => {
  const f = createFollower(song([[60], [62]]));
  f.update(frame({ 60: 30 }), 0);
  let wrong = 0;
  for (const [i, m] of [69, 71, 74, 77, 79].entries()) {
    wrong += f.update(frame({ [m]: 30 }, [m]), 600 + i * 100).length;
  }
  assert.equal(wrong, 1);
});

test('overtones of the expected note are not wrong', () => {
  const f = createFollower(song([[60]]));
  assert.deepEqual(f.update(frame({ 72: 30 }, [72]), 1000), []); // octave above
  assert.deepEqual(f.update(frame({ 79: 30 }, [79]), 1900), []); // octave + fifth
  assert.equal(f.wrong, 0);
});

test('spill-over next to a sounding note is not wrong', () => {
  const f = createFollower(song([[60], [62]]));
  f.update(frame({ 60: 30 }), 0);                                     // C4 played, now waiting for D4
  assert.deepEqual(f.update(frame({ 61: 30, 60: 25 }, [61]), 1000), []); // C#4 blip while C4 still rings
  assert.equal(f.wrong, 0);
});

test('a note that is struck but not the loudest is not wrong', () => {
  const f = createFollower(song([[60], [62]]));
  f.update(frame({ 60: 30 }), 0);
  assert.deepEqual(f.update(frame({ 69: 15, 60: 30 }, [69]), 1000), []);
  assert.equal(f.wrong, 0);
});

test('skip moves on and is counted', () => {
  const f = createFollower(song([[60], [62]]));
  assert.deepEqual(types(f.skip(null, 0)), ['step']);
  assert.deepEqual(types(f.skip(null, 10)), ['done']);
  assert.equal(f.skipped, 2);
  assert.equal(f.score(), 0);
});
