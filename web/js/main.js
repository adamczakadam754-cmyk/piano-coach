// Screens, the animation loop and wiring between mic, detector, follower and renderer.
import { startMic } from './audio.js';
import { createDetector, DEFAULTS } from './detector.js';
import { createFollower } from './follower.js';
import { createRenderer } from './render.js';
import { noteName } from './notes.js';

const $ = id => document.getElementById(id);
const saved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: not needed */ } };
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

let mic = null;
let detector = null;
let view = null; // the open practice / mic-check session
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

function applySensitivity() {
  const s = Number($('sensitivity').value);
  save('sensitivity', s);
  if (!detector) return;
  detector.options.peakDb = DEFAULTS.peakDb - s;
  detector.options.absMinDb = DEFAULTS.absMinDb - 2 * s;
}

let micPending = null; // so a double tap doesn't open the mic twice

function resetMic() {
  mic?.close();
  mic = detector = null;
}

async function open(file) {
  if (micPending) return;
  try {
    if (mic && !mic.alive()) resetMic();
    if (!mic) {
      micPending = startMic();
      mic = await micPending;
      detector = createDetector(mic.sampleRate, mic.fftSize);
      applySensitivity();
    }
    play(file ? await fetchJson(`songs/${file}`) : null);
  } catch (err) {
    showError(err);
  } finally {
    micPending = null;
  }
}

function play(song) {
  view = {
    song,
    follower: song && createFollower(song),
    renderer: createRenderer($('stage'), song),
    viewBeat: song ? song.steps[0].t : 0,
    wrong: null,
    frame: null,
    lastTime: performance.now(),
    lastDetect: -Infinity,
  };
  $('song-title').textContent = song ? song.title : 'Mic check';
  $('skip').hidden = !song;
  $('done').hidden = true;
  $('home-error').hidden = true;
  $('home').hidden = true;
  $('practice').hidden = false;
  keepAwake();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function handle(events, now) {
  for (const e of events) {
    if (e.type === 'wrong') view.wrong = { note: e.note, until: now + 400 };
    if (e.type === 'done') showDone();
  }
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  const { song, follower } = view;
  // The detector's attack memory is counted in frames tuned for ~60 fps; 120 Hz iPads would halve it.
  if (now - view.lastDetect >= 15 || !view.frame) {
    view.lastDetect = now;
    view.frame = detector.process(mic.read());
    if (follower) handle(follower.update(view.frame, now), now);
  }
  const frame = view.frame;

  // Glide the falling notes towards the current step.
  const last = song?.steps.at(-1);
  const target = !song ? 0 : follower.done ? last.t + last.d : song.steps[follower.index].t;
  view.viewBeat += (target - view.viewBeat) * Math.min(1, (now - view.lastTime) / 150);
  view.lastTime = now;

  setText($('heard'), !mic.running() ? 'tap the screen to start listening'
    : frame.best === null ? '–' : noteName(frame.best));
  $('level').value = frame.loudness;
  setText($('progress'), song ? `${Math.min(follower.index + 1, song.steps.length)} / ${song.steps.length}` : '');
  view.renderer.draw({ follower, viewBeat: view.viewBeat, frame, wrong: view.wrong, now });
}

function showDone() {
  const f = view.follower;
  const secs = Math.round((f.finishedAt - f.startedAt) / 1000);
  const parts = [`Time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, `${f.wrong} wrong`];
  if (f.skipped) parts.push(`${f.skipped} skipped`);
  $('done-stats').textContent = parts.join(' · ');
  $('done').hidden = false;
}

async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (view) wakeLock = lock;
    else lock?.release(); // left the practice screen while the request was pending
  } catch { /* unsupported: screen may dim */ }
}

function goHome() {
  cancelAnimationFrame(raf);
  wakeLock?.release();
  wakeLock = null;
  view = null;
  $('practice').hidden = true;
  $('home').hidden = false;
}

async function loadSongs() {
  try {
    const songs = await fetchJson('songs/index.json');
    $('song-list').replaceChildren(...songs.map(s => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const count = document.createElement('small');
      count.textContent = `${s.steps} steps`;
      btn.append(s.title, count);
      btn.addEventListener('click', () => open(s.file));
      li.append(btn);
      return li;
    }));
  } catch (err) {
    showError(err);
  }
}

$('sensitivity').value = saved('sensitivity', '0');
$('sensitivity').addEventListener('input', applySensitivity);
$('mic-check').addEventListener('click', () => open(null));
$('back').addEventListener('click', goHome);
$('done-back').addEventListener('click', goHome);
$('again').addEventListener('click', () => play(view.song));
$('skip').addEventListener('click', () => {
  if (view?.follower) handle(view.follower.skip(view.frame, performance.now()), performance.now());
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
