// Play-along mode: notes fall at the song's tempo and each one is judged on when it was played.
// With `auto: true` it plays itself (Listen mode): every note is marked as played on time.
import { isWrongNote } from './follower.js';

const EARLY = 250;   // ms: how early a note may be played and still count
const LATE = 300;    // ms: how late
const PERFECT = 90;  // ms: within this is "perfect", otherwise "good"

export function createTimed(song, { tempo = 1, latencyMs = 130, countInBeats = 4, auto = false } = {}) {
  const msPerBeat = 60000 / (song.bpm * tempo);
  const notes = song.steps.flatMap((st, i) => st.notes.map(note => ({
    step: i, note, time: st.t * msPerBeat, dur: st.d * msPerBeat, grade: null,
  })));
  const byKey = new Map(notes.map(x => [`${x.step}:${x.note}`, x]));
  const end = song.steps.at(-1);
  const endMs = (end.t + end.d) * msPerBeat;

  const s = {
    notes, msPerBeat, leadMs: countInBeats * msPerBeat,
    startedAt: null, finishedAt: null, songMs: -Infinity, done: false,
    perfect: 0, good: 0, miss: 0, extra: 0, combo: 0, maxCombo: 0,
  };
  let next = 0;            // first note whose judging window hasn't closed
  let lastExtra = -Infinity;

  s.start = now => { s.startedAt = now; };
  s.beat = now => (s.startedAt === null ? -countInBeats : (now - s.startedAt - s.leadMs) / msPerBeat);

  function judge(x, grade, events) {
    x.grade = grade;
    if (grade === 'miss') {
      s.miss++;
      s.combo = 0;
    } else {
      s[grade]++;
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
    }
    events.push({ type: grade === 'miss' ? 'miss' : 'hit', grade, note: x.note });
  }

  s.update = (frame, now) => {
    if (s.done) return [];
    if (s.startedAt === null) s.start(now);
    const events = [];
    s.songMs = now - s.startedAt - s.leadMs;
    // What we hear now was played latencyMs ago (analysis window + stability check + audio input).
    const t = auto ? s.songMs : s.songMs - latencyMs;

    if (auto) {
      while (next < notes.length && notes[next].time <= t) judge(notes[next++], 'perfect', events);
    } else {
      for (const m of frame.onsets) {
        let match = null;
        for (let i = next; i < notes.length && notes[i].time <= t + EARLY; i++) {
          const x = notes[i];
          if (x.grade || x.note !== m || t - x.time > LATE) continue;
          if (!match || Math.abs(x.time - t) < Math.abs(match.time - t)) match = x;
        }
        if (match) {
          judge(match, Math.abs(match.time - t) <= PERFECT ? 'perfect' : 'good', events);
        } else if (now - lastExtra > 800) {
          const nearby = notes.filter(x => Math.abs(x.time - t) < 600).map(x => x.note);
          if (isWrongNote(frame, m, nearby)) {
            lastExtra = now;
            s.extra++;
            events.push({ type: 'extra', note: m });
          }
        }
      }
      while (next < notes.length && t - notes[next].time > LATE) {
        if (!notes[next].grade) judge(notes[next], 'miss', events);
        next++;
      }
    }

    if (next >= notes.length && s.songMs > endMs + 300) {
      s.done = true;
      s.finishedAt = now;
      events.push({ type: 'done' });
    }
    return events;
  };

  // 0..1: perfect counts fully, good 60%. Extra notes are shown but don't cost points.
  s.score = () => (s.perfect + 0.6 * s.good) / notes.length;

  // For the renderer.
  s.noteState = (i, n) => {
    const x = byKey.get(`${i}:${n}`);
    if (x.grade) return x.grade === 'perfect' ? 'hit' : x.grade;
    return Math.abs(x.time - s.songMs) < 150 ? 'current' : 'upcoming';
  };
  s.keyState = m => {
    for (const x of notes) {
      if (x.time > s.songMs + 150) break;
      if (x.note !== m || s.songMs - x.time > x.dur) continue;
      if (x.grade && x.grade !== 'miss') return 'hit';
      if (!x.grade) return 'current';
    }
    return null;
  };

  return s;
}
