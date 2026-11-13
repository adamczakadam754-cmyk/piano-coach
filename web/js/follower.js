// Wait-mode practice: show a step, wait until every note in it has been played, move on.
export function createFollower(song, { attackDb = 6 } = {}) {
  const f = { index: 0, hit: new Set(), wrong: 0, skipped: 0, done: false, startedAt: null, finishedAt: null };
  let lowest = new Map(song.steps[0].notes.map(n => [n, 0])); // quietest level of each expected note this step
  let quietUntil = 0;        // no wrong-note checks just after a step change: the last notes are still ringing
  const lastWrong = new Map();

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
        events.push({ type: 'hit', note: n });
      }
    }
    if (f.hit.size === step.notes.length) return events.concat(enter(f.index + 1, frame, now));

    if (now > quietUntil) {
      for (const n of frame.heard) {
        if (!frame.isOnset(n) || step.notes.includes(n) || now - (lastWrong.get(n) ?? -Infinity) < 600) continue;
        lastWrong.set(n, now);
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

  return f;
}
