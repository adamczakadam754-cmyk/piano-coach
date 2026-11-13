// Screens, the animation loop and wiring between mic, detector, game modes and renderer.
import { startMic } from './audio.js';
import { createDetector, DEFAULTS } from './detector.js';
import { createFollower } from './follower.js';
import { createTimed } from './timed.js';
import { createRenderer } from './render.js';
import { noteName } from './notes.js';

const $ = id => document.getElementById(id);
const saved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: not needed */ } };
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

const MODES = {
  wait: { name: 'Practice', blurb: 'Waits until you play each note' },
  timed: { name: 'Play along', blurb: 'Notes fall in time; play them as they land' },
  listen: { name: 'Listen', blurb: 'Hear how it goes first' },
};
const starsFor = score => (score >= 0.9 ? 3 : score >= 0.7 ? 2 : score >= 0.4 ? 1 : 0);
const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);
const getBest = (file, mode) => { try { return JSON.parse(saved(`best:${file}:${mode}`, 'null')); } catch { return null; } };

let songs = [];
let chosen = null;     // song picked on the home screen
let mic = null;
let detector = null;
let micPending = null; // so a double tap doesn't open the mic twice
let view = null;       // the open practice / play-along / listen / mic-check session
let raf = 0;
let wakeLock = null;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.json();
}

function showError(err) {
  $('home-error').textContent = err.name === 'NotAllowedError'
    ? 'Microphone access was blocked. On iPad: Settings › Apps › Safari › Microphone › Allow, then reload.'
    : err.message || String(err);
  $('home-error').hidden = false;
}

// ---------- settings ----------
for (const [id, fallback] of [['sensitivity', '0'], ['latency', '130'], ['tempo', '100']]) {
  $(id).value = saved(id, fallback);
  $(id).addEventListener('input', () => { save(id, $(id).value); applySettings(); });
}
function applySettings() {
  const s = Number($('sensitivity').value);
  setText($('latency-value'), `${$('latency').value} ms`);
  setText($('tempo-value'), `${$('tempo').value}%`);
  if (!detector) return;
  detector.options.peakDb = DEFAULTS.peakDb - s;
  detector.options.absMinDb = DEFAULTS.absMinDb - 2 * s;
}
applySettings();

// ---------- home & song chooser ----------
function renderSongList() {
  $('song-list').replaceChildren(...songs.map(s => {
    const best = Math.max(getBest(s.file, 'wait')?.stars ?? 0, getBest(s.file, 'timed')?.stars ?? 0);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const info = document.createElement('small');
    info.textContent = `${starText(best)}  ·  ${s.steps} notes`;
    btn.append(s.title, info);
    btn.addEventListener('click', () => openChooser(s));
    li.append(btn);
    return li;
  }));
}

function openChooser(song) {
  chosen = song;
  $('chooser-title').textContent = song.title;
  for (const btn of document.querySelectorAll('[data-mode]')) {
    const mode = btn.dataset.mode;
    const best = getBest(song.file, mode);
    btn.querySelector('small').textContent = best ? `Best ${starText(best.stars)} ${Math.round(best.score * 100)}%` : MODES[mode].blurb;
  }
  $('chooser').hidden = false;
}

async function loadSongs() {
  try {
    songs = await fetchJson('songs/index.json');
    renderSongList();
  } catch (err) {
    showError(err);
  }
}

// ---------- starting a session ----------
function resetMic() {
  mic?.close();
  mic = detector = null;
}

async function open(file, mode) {
  if (micPending) return;
  try {
    if (mic && !mic.alive()) resetMic();
    if (!mic) {
      micPending = startMic();
      mic = await micPending;
      detector = createDetector(mic.sampleRate, mic.fftSize);
      applySettings();
    }
    play(mode, file ? await fetchJson(`songs/${file}`) : null, file);
  } catch (err) {
    showError(err);
  } finally {
    micPending = null;
  }
}

function play(mode, song, file) {
  view?.synth?.stop();
  const timedOpts = {
    tempo: Number($('tempo').value) / 100,
    latencyMs: Number($('latency').value),
    countInBeats: mode === 'listen' ? 2 : 4,
    auto: mode === 'listen',
  };
  const session = mode === 'wait' ? createFollower(song) : song ? createTimed(song, timedOpts) : null;
  view = {
    mode, song, file, session,
    renderer: createRenderer($('stage'), song),
    viewBeat: mode === 'wait' ? song.steps[0].t : 0,
    flash: null,   // wrong key shown red
    banner: null,  // "Perfect" / "Good" / "Miss"
    frame: null,
    synth: null,
    lastTime: performance.now(),
    lastDetect: -Infinity,
  };
  if (mode === 'listen') {
    const now = performance.now();
    session.start(now);
    view.synth = mic.synth();
    for (const x of session.notes) view.synth.play(x.note, (session.leadMs + x.time) / 1000, x.dur / 1000);
  }
  $('song-title').textContent = song ? `${song.title} · ${MODES[mode].name}` : 'Mic check';
  $('skip').hidden = mode !== 'wait';
  $('done').hidden = true;
  $('chooser').hidden = true;
  $('home-error').hidden = true;
  $('home').hidden = true;
  $('practice').hidden = false;
  keepAwake();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

// ---------- the loop ----------
function handle(events, now) {
  for (const e of events) {
    if (e.type === 'wrong' || e.type === 'extra') view.flash = { note: e.note, until: now + 400 };
    if (e.type === 'hit' && e.grade && view.mode === 'timed') {
      view.banner = e.grade === 'perfect' ? { text: 'Perfect', color: '#22c55e', until: now + 450 }
        : { text: 'Good', color: '#2dd4bf', until: now + 450 };
    }
    if (e.type === 'miss') view.banner = { text: 'Miss', color: '#ef4444', until: now + 450 };
    if (e.type === 'done') showDone();
  }
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  const v = view;
  if (v.mode === 'listen') {
    handle(v.session.update(null, now), now); // the mic would only hear our own speaker
  } else if (now - v.lastDetect >= 15 || !v.frame) {
    // The detector's memory is counted in frames tuned for ~60 fps; 120 Hz iPads would halve it.
    v.lastDetect = now;
    v.frame = detector.process(mic.read());
    if (v.session) handle(v.session.update(v.frame, now), now);
  }
  const { song, session, frame } = v;

  let banner = v.banner && now < v.banner.until ? v.banner : null;
  if (v.mode === 'wait') { // glide the falling notes towards the current step
    const last = song.steps.at(-1);
    const target = session.done ? last.t + last.d : song.steps[session.index].t;
    v.viewBeat += (target - v.viewBeat) * Math.min(1, (now - v.lastTime) / 150);
  } else if (session) {
    v.viewBeat = session.beat(now);
    if (v.viewBeat < 0) banner = { text: String(Math.ceil(-v.viewBeat)), color: '#f4f4f5' }; // count-in
  }
  v.lastTime = now;

  const flash = v.flash && now < v.flash.until ? v.flash.note : null;
  const keyState = m => (m === flash ? 'wrong' : session ? session.keyState(m) : null);

  setText($('heard'), v.mode === 'listen' ? 'listening paused while the song plays'
    : !mic.running() ? 'tap the screen to start listening'
      : frame.best === null ? '–' : noteName(frame.best));
  $('level').value = frame?.loudness ?? 0;
  setText($('progress'), v.mode === 'wait' ? `${Math.min(session.index + 1, song.steps.length)} / ${song.steps.length}`
    : v.mode === 'timed' ? `Combo ${session.combo}` : '');
  v.renderer.draw({
    viewBeat: v.viewBeat,
    frame,
    noteState: session ? session.noteState : null,
    keyState,
    banner,
    big: song ? undefined : (frame?.best != null ? noteName(frame.best) : null),
  });
}

// ---------- results ----------
function showDone() {
  const { mode, session, file } = view;
  const secs = Math.round((session.finishedAt - session.startedAt) / 1000);
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  let stats;
  let score = null;
  if (mode === 'wait') {
    score = session.score();
    stats = [`Time ${time}`, `${session.wrong} wrong`];
    if (session.skipped) stats.push(`${session.skipped} skipped`);
  } else if (mode === 'timed') {
    score = session.score();
    stats = [`${Math.round(score * 100)}%`, `${session.perfect} perfect`, `${session.good} good`, `${session.miss} missed`,
      `best combo ${session.maxCombo}`];
    if (session.extra) stats.push(`${session.extra} extra`);
  } else {
    stats = ['Now try it in Practice mode'];
  }
  $('done-title').textContent = mode === 'listen' ? 'That’s how it goes' : score >= 0.7 ? 'Well done!' : 'Keep practising!';
  $('done-stars').textContent = score === null ? '' : starText(starsFor(score));
  $('done-stats').textContent = stats.join(' · ');
  $('again').textContent = mode === 'listen' ? 'Practise it' : 'Play again';

  const prev = getBest(file, mode);
  const isBest = score !== null && (!prev || score > prev.score);
  if (isBest) save(`best:${file}:${mode}`, JSON.stringify({ score, stars: starsFor(score) }));
  $('done-best').hidden = !(isBest && prev);
  $('done').hidden = false;
}

// ---------- housekeeping ----------
async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (view) wakeLock = lock;
    else lock?.release(); // left the screen while the request was pending
  } catch { /* unsupported: screen may dim */ }
}

function goHome() {
  cancelAnimationFrame(raf);
  view?.synth?.stop();
  wakeLock?.release();
  wakeLock = null;
  view = null;
  $('practice').hidden = true;
  $('home').hidden = false;
  renderSongList();
}

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => open(chosen.file, btn.dataset.mode));
}
$('chooser-close').addEventListener('click', () => { $('chooser').hidden = true; });
$('mic-check').addEventListener('click', () => open(null, 'check'));
$('back').addEventListener('click', goHome);
$('done-back').addEventListener('click', goHome);
$('again').addEventListener('click', () => play(view.mode === 'listen' ? 'wait' : view.mode, view.song, view.file));
$('skip').addEventListener('click', () => {
  if (view?.mode === 'wait') handle(view.session.skip(view.frame, performance.now()), performance.now());
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !view) return;
  if (!mic.alive()) { // iOS stopped the microphone while we were in the background
    goHome();
    resetMic();
    showError(new Error('The microphone was switched off while the app was in the background. Tap a song to start again.'));
    return;
  }
  mic.resume(); // iOS suspends audio in the background
  keepAwake();  // and drops the wake lock
});
// If iOS refused to start audio without a tap, any tap starts it.
document.addEventListener('pointerdown', () => { if (mic && !mic.running()) mic.resume(); });
loadSongs();
