// Metronome scheduling, practice stats, MIDI import, the library and dashboard charts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetronome } from '../web/js/metronome.js';
import { addSession, dayKey, motivation, streakOf, summarize } from '../web/js/stats.js';
import { parseMidi, suggestTrack, toSong } from '../web/js/midi.js';
import { addToLibrary, loadLibrary, prettyName, removeFromLibrary, searchOnline } from '../web/js/library.js';
import { accuracyChart, calendar, minutesChart, renderDashboard } from '../web/js/dashboard.js';

// ---------- metronome ----------
test('metronome schedules every beat once, ahead of time, with an accent on beat 1', () => {
  const clicks = [];
  const m = createMetronome((delay, accent) => clicks.push({ delay, accent }));
  const msPerBeat = 500;
  for (let ms = -2000; ms <= 2000; ms += 16) m.update(ms / msPerBeat, msPerBeat); // count-in from beat -4
  assert.equal(clicks.length, 9); // beats -4..4
  assert.deepEqual(clicks.map(c => c.accent), [true, false, false, false, true, false, false, false, true]);
  assert.ok(clicks.every(c => c.delay >= 0 && c.delay <= 0.12));
});

test('metronome reset picks up from the current beat without a burst of old clicks', () => {
  let n = 0;
  const m = createMetronome(() => n++);
  m.update(0, 500);
  m.reset();
  m.update(10.5, 500);
  assert.equal(n, 1 + 0); // beat 0 earlier; after reset, beat 11 is 250 ms away: not yet
});

// ---------- stats ----------
const day = (s, h = 12) => new Date(`${s}T${String(h).padStart(2, '0')}:00`);
const session = (d, secs, score = null) => ({ day: dayKey(day(d)), t: day(d).getTime(), secs, score, title: 'X', mode: 'wait' });

test('streak counts consecutive days and survives until the day is over', () => {
  const days = new Set(['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(streakOf(days, day('2026-11-12')), 3);
  assert.equal(streakOf(days, day('2026-11-13')), 3); // today not played yet: still alive
  assert.equal(streakOf(days, day('2026-11-14')), 0); // missed a whole day
});

test('summary totals minutes per day, week, longest streak and scores', () => {
  let h = [];
  for (const [d, s, sc] of [['2026-11-01', 600, 0.5], ['2026-11-02', 300, null], ['2026-11-03', 300, 0.8], ['2026-11-12', 900, 0.9], ['2026-11-13', 120, null]]) {
    h = addSession(h, session(d, s, sc));
  }
  const s = summarize(h, { today: day('2026-11-13'), goalMin: 10 });
  assert.equal(s.todayMin, 2);
  assert.equal(s.streak, 2);
  assert.equal(s.longestStreak, 3);
  assert.equal(s.weekMin, 17);
  assert.equal(s.perDay.length, 14);
  assert.equal(s.perDay.at(-1).min, 2);
  assert.equal(s.heat.length, 84);
  assert.deepEqual(s.scores.map(x => x.score), [0.5, 0.8, 0.9]);
});

test('motivation reacts to progress and the tip changes daily', () => {
  const base = { goalMin: 10, sessions: 5, streak: 4 };
  assert.match(motivation({ ...base, todayMin: 0 }).headline, /4-day streak/);
  assert.match(motivation({ ...base, todayMin: 7 }).headline, /3 more minutes/);
  assert.match(motivation({ ...base, todayMin: 12 }).headline, /Goal reached/);
  assert.match(motivation({ ...base, sessions: 0, streak: 0, todayMin: 0 }).headline, /first song/);
  const a = motivation({ ...base, todayMin: 0 }, day('2026-11-13')).title;
  const b = motivation({ ...base, todayMin: 0 }, day('2026-11-14')).title;
  assert.notEqual(a, b);
});

// ---------- MIDI ----------
function vlq(n) { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; }
function track(events) { // events: [delta, ...bytes]
  const body = events.flatMap(([dt, ...b]) => [...vlq(dt), ...b]);
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body];
}
const text = s => [...s].map(c => c.charCodeAt(0));
function midiFile() {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0]; // format 1, 3 tracks, 480 tpb
  const conductor = track([[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [0, 0xf0, 2, 0x7e, 0xf7], [0, 0xff, 0x2f, 0]]); // 120 bpm, a sysex
  const melody = track([
    [0, 0xff, 0x03, 5, ...text('Piano')],
    [0, 0x90, 60, 80], [0, 64, 80], [3, 67, 80],     // C-E-G chord (running status, slightly ragged)
    [477, 0x80, 60, 0], [0, 0x90, 72, 80],           // C5 at beat 1 ...
    [480, 72, 0],                                     // note-off as velocity 0
    [0, 0x90, 30, 80],                                // very low note: folded up into range
    [480, 0xff, 0x2f, 0],
  ]);
  const drums = track([[0, 0x99, 36, 100], [240, 0x99, 38, 100], [0, 0xff, 0x2f, 0]]);
  return new Uint8Array([...header, ...conductor, ...melody, ...drums]);
}

test('MIDI parser reads tempo, names, running status, and spots drum tracks', () => {
  const m = parseMidi(midiFile());
  assert.equal(m.ticksPerBeat, 480);
  assert.equal(m.tempo, 500000);
  assert.equal(m.tracks.length, 3);
  assert.equal(m.tracks[1].name, 'Piano');
  assert.equal(m.tracks[1].notes.length, 5);
  assert.equal(m.tracks[2].drums, true);
  assert.equal(suggestTrack(m), 1);
});

test('toSong groups chords, folds range, and melody-only keeps the top note', () => {
  const m = parseMidi(midiFile());
  const song = toSong(m, { title: 'T' });
  assert.equal(song.bpm, 120);
  assert.deepEqual(song.steps.map(s => s.notes), [[60, 64, 67], [72], [42]]);
  assert.deepEqual(song.steps.map(s => s.t), [0, 1, 2]);
  assert.deepEqual(toSong(m, { melodyOnly: true }).steps.map(s => s.notes), [[67], [72], [42]]);
});

test('melody-only drops accompaniment played under a held melody note', () => {
  // Right hand: C5 held 2 beats, then D5. Left hand: C3-E3-G3 arpeggio in eighths underneath.
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  const ev = [[0, 0x90, 72, 90], [0, 0x90, 48, 70]];
  for (const n of [52, 55, 48]) ev.push([240, 0x90, n, 70]);       // arpeggio while C5 is held
  ev.push([240, 0x80, 72, 0], [0, 0x90, 74, 90], [480, 0x80, 74, 0], [0, 0xff, 0x2f, 0]);
  const m = parseMidi(new Uint8Array([...header, ...track(ev)]));
  assert.deepEqual(toSong(m, { melodyOnly: true }).steps.map(s => s.notes), [[72], [74]]);
  assert.equal(toSong(m).steps.length, 5); // full version keeps everything
});

test('damaged or non-MIDI files give a friendly error', () => {
  assert.throws(() => parseMidi(new TextEncoder().encode('hello world, not midi')), /not a MIDI file/);
  const corrupt = new Uint8Array([...midiFile().slice(0, 14), ...track([[0, 0xff, 0x03, 0xff, 0xff, 0xff, 0xff, 0x7f]])]);
  assert.throws(() => parseMidi(corrupt), /damaged or incomplete/);
});

test('a truncated file keeps what it can and import reports no notes instead of crashing', () => {
  const m = parseMidi(midiFile().slice(0, 40));
  assert.equal(suggestTrack(m), -1);
  assert.throws(() => toSong(m), /no notes/);
});

// ---------- library ----------
const memory = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };

test('library add / remove round-trips', () => {
  const store = memory();
  const song = { title: 'Mine', bpm: 90, steps: [{ t: 0, d: 1, notes: [60] }] };
  const e = addToLibrary(song, 'file', store);
  assert.equal(loadLibrary(store).length, 1);
  assert.equal(loadLibrary(store)[0].song.title, 'Mine');
  removeFromLibrary(e.id, store);
  assert.equal(loadLibrary(store).length, 0);
});

test('library full is reported clearly', () => {
  const full = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.throws(() => addToLibrary({ title: 'x', steps: [] }, 'file', full), /library is full/);
});

test('online search maps BitMidi results and ignores odd entries', async () => {
  const fakeFetch = async url => {
    assert.match(url, /^https:\/\/bitmidi\.com\/api\/midi\/search\?q=fur%20elise/);
    return { ok: true, json: async () => ({ result: { results: [
      { name: 'Fur-Elise.mid', downloadUrl: '/uploads/1.mid', plays: 5 },
      { name: 'bad.mid', downloadUrl: 'https://evil.example/x.mid' },
    ] } }) };
  };
  const r = await searchOnline('fur elise', fakeFetch);
  assert.deepEqual(r, [{ title: 'Fur Elise', url: 'https://bitmidi.com/uploads/1.mid', plays: 5 }]);
  assert.equal(prettyName('beethoven_symphony-9.midi'), 'Beethoven Symphony 9');
});

// ---------- dashboard ----------
test('dashboard charts render, escape text, and carry hover tooltips', () => {
  let h = [session('2026-11-12', 900, 0.9), session('2026-11-13', 300, 0.6)];
  h[1].title = '<script>alert(1)</script>';
  const s = summarize(h, { today: day('2026-11-13'), goalMin: 10 });
  const bars = minutesChart(s.perDay, 10);
  assert.equal((bars.match(/class="hit"/g) ?? []).length, 14);
  assert.match(bars, /Today/);
  assert.equal((calendar(s.heat, 10).match(/class="cell"/g) ?? []).length, 84);
  const acc = accuracyChart(s.scores);
  assert.ok(!acc.includes('<script>'));
  assert.match(acc, /&lt;script&gt;/);
  const el = {};
  renderDashboard(el, s, motivation(s));
  assert.match(el.innerHTML, /Current streak/);
  assert.match(el.innerHTML, /data-goal="10" class="chip active"/);
});
