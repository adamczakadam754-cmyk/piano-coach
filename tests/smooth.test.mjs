import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplaySmoother } from '../web/js/smooth.js';

const f = (heard, best = heard[0] ?? null) => ({ heard, best });

function feed(smoother, frames, start = 0, step = 16) {
  return frames.map((fr, i) => smoother.update(fr, start + i * step));
}

test('the displayed note does not flicker when detection alternates every frame', () => {
  const s = createDisplaySmoother();
  // C4 is played; detection keeps flipping "best" between C4 and a neighbour, and dropping out.
  const frames = Array.from({ length: 60 }, (_, i) => (i % 3 === 2 ? f([]) : i % 2 ? f([60, 62], 62) : f([60], 60)));
  const shown = feed(s, frames).map(o => o.shown).slice(10);
  assert.ok(shown.every(n => n === shown[0]), `display changed: ${[...new Set(shown)]}`);
  assert.equal(shown[0], 60);
});

test('a one-frame blip never shows', () => {
  const s = createDisplaySmoother();
  const out = feed(s, [f([]), f([71]), f([]), f([]), f([])]);
  assert.ok(out.every(o => o.shown === null && o.lit.length === 0));
});

test('a held note shows after ~60 ms and stays briefly after it stops', () => {
  const s = createDisplaySmoother();
  const out = feed(s, [...Array(10).fill(f([64])), ...Array(30).fill(f([]))]);
  assert.equal(out[2].shown, null);           // 32 ms in: not yet
  assert.equal(out[6].shown, 64);             // ~96 ms: shown
  assert.equal(out[25].shown, 64);            // ~250 ms after it stopped: still shown
  assert.equal(out[39].shown, null);          // ~470 ms after: gone
});

test('switching to a new note happens once it is clearly the loudest', () => {
  const s = createDisplaySmoother();
  const out = feed(s, [...Array(10).fill(f([60])), ...Array(20).fill(f([60, 67], 67))]);
  assert.equal(out[12].shown, 60);  // 67 only just arrived
  assert.equal(out[29].shown, 67);  // 67 has been loudest for > 150 ms
});
