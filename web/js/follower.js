// Practice (wait) mode: show a step, wait until every note in it has been played, move on.

// Should note n, just struck, count as a mistake? Deliberately strict: a false "wrong" is far more
// discouraging than a missed one. `nearby` = notes the player is meant to be playing around now.
export function isWrongNote(frame, n, nearby) {
  if (n !== frame.best || !frame.heard.includes(n)) return false; // only the dominant, ghost-free note
  for (const e of nearby) {
    const d = Math.abs(n - e);
    if (d === 0 || d === 12 || d === 19 || d === 24) return false; // the note itself or an overtone relation
    if (d <= 2 && frame.isPresent(e)) return false;               // spill-over from a sounding neighbour
  }
  return true;
}

export function createFollower(song, { attackDb = 6 } = {}) {
  const f = { index: 0, hit: new Set(), wrong: 0, skipped: 0, done: false, startedAt: null, finishedAt: null };
  let lowest = new Map(song.steps[0].notes.map(n => [n, 0])); // quietest level of each expected note this step
  let quietUntil = 0; // no wrong-note checks just after a step change: the last notes are still ringing
  let lastHit = -Infinity;
  let lastWrong = -Infinity;

  function enter(index, frame, now) {
    f.index = index;
    f.hit = new Set();
    if (index >= song.steps.length) {
      f.done = true;
      f.finishedAt = now;
      return [{ type: 'done' }];
    }
    lowest = new Map(song.steps[index].notes.map(n => [n, frame ? frame.levelOf(n) : 0]));
    quietUntil = now + 450;
    return [{ type: 'step', index }];
  }

  f.update = (frame, now) => {
    if (f.done) return [];
    if (f.startedAt === null) f.startedAt = now;
    const events = [];
    const step = song.steps[f.index];

    for (const n of step.notes) {
      if (f.hit.has(n)) continue;
      const level = frame.levelOf(n);
      const low = Math.min(lowest.get(n), level);
      lowest.set(n, low);
      // Must be a fresh strike: a note still ringing from the previous step only counts once replayed.
      if (frame.isPresent(n) && level - low >= attackDb) {
        f.hit.add(n);
        lastHit = now;
        events.push({ type: 'hit', note: n });
      }
    }
    if (f.hit.size === step.notes.length) return events.concat(enter(f.index + 1, frame, now));

    if (now > quietUntil && now - lastHit > 300 && now - lastWrong > 800) {
      const nearby = f.index > 0 ? step.notes.concat(song.steps[f.index - 1].notes) : step.notes;
      const n = frame.onsets.find(m => isWrongNote(frame, m, nearby));
      if (n !== undefined) {
        lastWrong = now;
        f.wrong++;
        events.push({ type: 'wrong', note: n });
      }
    }
    return events;
  };

  // For when detection lets you down: move on without hearing the notes.
  f.skip = (frame, now) => {
    if (f.done) return [];
    f.skipped++;
    return enter(f.index + 1, frame, now);
  };

  // 0..1 for the results screen.
  f.score = () => Math.max(0, (song.steps.length - f.skipped - 0.5 * f.wrong) / song.steps.length);

  // For the renderer.
  f.noteState = (i, n) => (i < f.index ? 'past' : i > f.index ? 'upcoming' : f.hit.has(n) ? 'hit' : 'current');
  f.keyState = m => {
    if (f.done || !song.steps[f.index].notes.includes(m)) return null;
    return f.hit.has(m) ? 'hit' : 'current';
  };

  return f;
}
