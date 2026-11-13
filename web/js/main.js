// Screens, the animation loop and the wiring between mic, detector, game modes, renderer,
// metronome, practice history, the song library and online search.
import { startMic } from './audio.js';
import { createDetector, DEFAULTS } from './detector.js';
import { createFollower } from './follower.js';
import { createTimed } from './timed.js';
import { createRenderer } from './render.js';
import { createDisplaySmoother } from './smooth.js';
import { createMetronome } from './metronome.js';
import { addSession, dayKey, motivation, summarize } from './stats.js';
import { renderDashboard } from './dashboard.js';
import { parseMidi, suggestTrack, toSong } from './midi.js';
import {
  CATALOG, addToLibrary, didYouMean, downloadMidi, findInLibrary, loadLibrary, matchTitles, normalize, removeFromLibrary,
  searchOnline, titleSuggestions,
} from './library.js';
import { noteName } from './notes.js';

const $ = id => document.getElementById(id);
const saved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage full or blocked */ } };
const savedJson = (key, fallback) => { try { return JSON.parse(saved(key, 'null')) ?? fallback; } catch { return fallback; } };
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const MODES = {
  wait: { name: 'Practice', blurb: 'Waits until you play each note' },
  timed: { name: 'Play along', blurb: 'Notes fall in time: play them as they land' },
  listen: { name: 'Listen', blurb: 'Hear how it goes first' },
};
const NOTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l11-2v11.5a3 3 0 1 1-2-2.8V8.3l-7 1.3v7.9a3 3 0 1 1-2-2.8z"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="flameGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#facc15"/></linearGradient></defs><path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1.5-.6-2.4-1.2-3.4C17 9 19 12 19 15a7 7 0 0 1-14 0c0-5 5-7 7-13z"/></svg>';
const starsFor = score => (score >= 0.9 ? 3 : score >= 0.7 ? 2 : score >= 0.4 ? 1 : 0);
const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);
const getBest = (id, mode) => savedJson(`best:${id}:${mode}`, null);
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

let builtIn = [];    // songs shipped with the app: { id, title, steps }
let chosen = null;   // entry picked on the home screen
let mic = null;
let detector = null;
let micPending = null; // so a double tap doesn't open the mic twice
let view = null;       // the open practice / play-along / listen / mic-check session
let raf = 0;
let wakeLock = null;
let pendingImport = null; // { midi, source }

const allSongs = () => [
  ...builtIn,
  ...loadLibrary().map(e => ({ id: e.id, title: e.title, steps: e.song.steps.length, song: e.song, library: true })),
];

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
  showTab('home');
}

let toastTimer = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

// ---------- settings ----------
for (const [id, fallback] of [['sensitivity', '0'], ['latency', '130'], ['tempo', '100']]) {
  $(id).value = saved(id, fallback);
  $(id).addEventListener('input', () => { save(id, $(id).value); applySettings(); });
}
const metronomeOn = () => saved('metronome', '0') === '1';
function setMetronome(on) {
  save('metronome', on ? '1' : '0');
  $('metronome').checked = on;
  $('metro-toggle').setAttribute('aria-pressed', String(on));
  view?.metronome?.reset();
}
$('metronome').addEventListener('change', () => setMetronome($('metronome').checked));
$('metro-toggle').addEventListener('click', () => setMetronome(!metronomeOn()));
setMetronome(metronomeOn());

function applySettings() {
  const s = Number($('sensitivity').value);
  setText($('sensitivity-value'), s === 0 ? '0 (default)' : s > 0 ? `+${s} (more sensitive)` : `${s} (less sensitive)`);
  setText($('latency-value'), `${$('latency').value} ms`);
  setText($('tempo-value'), `${$('tempo').value}%`);
  if (!detector) return;
  detector.options.peakDb = DEFAULTS.peakDb - s;
  detector.options.absMinDb = DEFAULTS.absMinDb - 2 * s;
}
applySettings();

// ---------- tabs ----------
function showTab(name) {
  for (const id of ['home', 'discover', 'progress']) $(id).hidden = id !== name;
  for (const b of document.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (name === 'home') renderHome();
  if (name === 'progress') renderProgress();
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- home ----------
const history = () => savedJson('history', []);
const goalMin = () => Number(saved('goal', '10'));

function ringSvg(fraction) {
  const r = 30, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, fraction));
  return `<svg class="ring" viewBox="0 0 76 76" aria-hidden="true"><defs><linearGradient id="homeRing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><circle cx="38" cy="38" r="${r}" class="ring-track"/><circle cx="38" cy="38" r="${r}" class="ring-fill" stroke="url(#homeRing)" stroke-dasharray="${c}" style="--off:${c * (1 - f)};--full:${c}"/></svg>`;
}

function renderHome() {
  const sum = summarize(history(), { goalMin: goalMin() });
  const mot = motivation(sum);
  const ring = el('span', 'ring-wrap');
  ring.innerHTML = ringSvg(sum.todayMin / sum.goalMin);
  const text = el('div');
  text.append(el('b', '', mot.headline), el('small', '', `${Math.round(sum.todayMin)} of ${sum.goalMin} min today`));
  const badge = el('div', 'streak-badge');
  badge.innerHTML = FLAME;
  badge.append(el('b', '', String(sum.streak)), el('small', '', 'streak'));
  $('today-card').replaceChildren(ring, text, badge);

  const all = allSongs();
  setText($('song-count'), `${all.length} songs`);
  $('song-filter').hidden = all.length <= 8; // only worth it once the library grows
  const filter = $('song-filter').hidden ? '' : $('song-filter').value;
  const songs = filter ? all.filter(s => matchTitles(filter, [s.title]).length) : all;
  $('song-empty').hidden = songs.length > 0;
  $('song-empty').textContent = `No songs match “${filter}”. Find more in Discover.`;
  $('song-list').replaceChildren(...songs.map((s, i) => {
    const stars = Math.max(getBest(s.id, 'wait')?.stars ?? 0, getBest(s.id, 'timed')?.stars ?? 0);
    const btn = el('button', 'song');
    btn.style.setProperty('--i', i);
    const icon = el('span', 'song-icon');
    icon.style.setProperty('--h', hue(s.title));
    icon.innerHTML = NOTE_ICON;
    const text = el('span', 'song-text');
    const title = el('b', '', s.title);
    if (s.library) title.append(el('span', 'badge', 'Library'));
    const meta = el('small');
    meta.append(el('span', 'song-stars', starText(stars)), `  ·  ${s.steps} notes`);
    text.append(title, meta);
    btn.append(icon, text);
    btn.insertAdjacentHTML('beforeend', CHEVRON);
    btn.addEventListener('click', () => openChooser(s));
    const li = el('li');
    li.append(btn);
    return li;
  }));
}

function openChooser(entry) {
  chosen = entry;
  $('chooser-title').textContent = entry.title;
  $('chooser-meta').textContent = `${entry.steps} notes${entry.library ? ' · from your library' : ''}`;
  for (const btn of document.querySelectorAll('[data-mode]')) {
    const mode = btn.dataset.mode;
    const best = getBest(entry.id, mode);
    btn.querySelector('small').textContent = best ? `Best ${starText(best.stars)} · ${Math.round(best.score * 100)}%` : MODES[mode].blurb;
  }
  $('remove-song').hidden = !entry.library;
  $('chooser').hidden = false;
}

$('song-filter').addEventListener('input', renderHome);

async function loadSongs() {
  try {
    builtIn = (await fetchJson('songs/index.json')).map(s => ({ id: s.file, title: s.title, steps: s.steps }));
  } catch (err) {
    showError(err);
  }
  renderHome();
}

// ---------- progress ----------
function renderProgress() {
  const sum = summarize(history(), { goalMin: goalMin() });
  renderDashboard($('dashboard'), sum, motivation(sum));
  for (const b of $('dashboard').querySelectorAll('[data-goal]')) {
    b.addEventListener('click', () => { save('goal', b.dataset.goal); renderProgress(); });
  }
}
function showTip(e) {
  const t = e.target?.closest?.('[data-tip]');
  if (!t) { $('chart-tip').hidden = true; return; }
  $('chart-tip').textContent = t.dataset.tip;
  $('chart-tip').style.left = `${Math.min(window.innerWidth - 90, Math.max(90, e.clientX))}px`;
  $('chart-tip').style.top = `${e.clientY}px`;
  $('chart-tip').hidden = false;
}
$('dashboard').addEventListener('pointermove', showTip);
$('dashboard').addEventListener('pointerup', showTip); // after the document handler that hides it
$('dashboard').addEventListener('pointerleave', () => { $('chart-tip').hidden = true; });

// ---------- discover: online search and MIDI import ----------
const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="M15 15l5 5"/></svg>';
const SONG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/></svg>';
let searchSeq = 0;   // only the newest search may write results (an older, slower one must not)
let suggestSeq = 0;
let suggestTimer = 0;

function runSearch(q) {
  $('search-input').value = q;
  hideSuggestions();
  if ($('search-form').requestSubmit) $('search-form').requestSubmit();
  else $('search-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

const recentSearches = () => savedJson('recent', []);
function rememberSearch(q) {
  save('recent', JSON.stringify([q, ...recentSearches().filter(r => normalize(r) !== normalize(q))].slice(0, 6)));
  renderRecent();
}
function renderRecent() {
  const recent = recentSearches();
  $('recent').hidden = !recent.length;
  const clear = el('button', 'chip clear', 'Clear');
  clear.addEventListener('click', () => { save('recent', '[]'); renderRecent(); });
  $('recent').replaceChildren(el('span', '', 'Recent:'), ...recent.map(q => {
    const b = el('button', 'chip', q);
    b.addEventListener('click', () => runSearch(q));
    return b;
  }), clear);
}

// The typed words in bold inside a suggestion, without using innerHTML on untrusted text.
function highlighted(text, query) {
  const words = normalize(query).split(' ').filter(Boolean);
  const frag = el('span');
  for (const part of text.split(/(\s+)/)) {
    const w = words.find(q => normalize(part).startsWith(q));
    if (w && part.trim()) {
      frag.append(el('mark', '', part.slice(0, w.length)), part.slice(w.length));
    } else frag.append(part);
  }
  return frag;
}

function suggestionButton(text, query, icon, onPick, note) {
  const b = el('button', 'sugg-item');
  b.type = 'button';
  b.setAttribute('role', 'option');
  b.innerHTML = icon;
  b.append(highlighted(text, query));
  if (note) b.append(el('small', '', note));
  b.addEventListener('click', onPick); // the list hides 200 ms after the input blurs, so taps land first
  return b;
}

function renderSuggestions(q, live = []) {
  const box = $('suggestions');
  const mine = matchTitles(q, allSongs().map(s => s.title), 3);
  const known = matchTitles(q, CATALOG, 5);
  const seen = new Set([...mine, ...known].map(normalize));
  const fromArchive = live.filter(t => !seen.has(normalize(t))).slice(0, 4);
  const items = [];
  if (mine.length) {
    items.push(el('div', 'sugg-head', 'Already in your songs'));
    for (const t of mine) {
      items.push(suggestionButton(t, q, SONG_ICON, () => {
        hideSuggestions();
        showTab('home');
        openChooser(allSongs().find(s => s.title === t));
      }, 'Play'));
    }
  }
  if (known.length || fromArchive.length) {
    items.push(el('div', 'sugg-head', 'Search for'));
    for (const t of [...known, ...fromArchive]) items.push(suggestionButton(t, q, SEARCH_ICON, () => runSearch(t)));
  }
  if (!items.length) {
    const guess = didYouMean(q);
    if (guess) {
      items.push(el('div', 'sugg-head', 'Did you mean'));
      items.push(suggestionButton(guess, guess, SEARCH_ICON, () => runSearch(guess)));
    }
  }
  box.replaceChildren(...items);
  box.hidden = !items.length;
}

function hideSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq++;
  $('suggestions').hidden = true;
}

$('search-input').addEventListener('input', () => {
  const q = $('search-input').value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) { hideSuggestions(); return; }
  renderSuggestions(q); // instant: your songs + well-known titles
  if (q.length < 3 || navigator.onLine === false) return;
  const seq = ++suggestSeq;
  suggestTimer = setTimeout(async () => { // then names from the archive, once typing pauses
    try {
      const results = await searchOnline(q);
      if (seq === suggestSeq && document.activeElement === $('search-input')) renderSuggestions(q, titleSuggestions(results, q));
    } catch { /* suggestions are optional */ }
  }, 350);
});
$('search-input').addEventListener('focus', () => { if ($('search-input').value.trim().length >= 2) $('search-input').dispatchEvent(new Event('input')); });
$('search-input').addEventListener('blur', () => setTimeout(hideSuggestions, 200));

$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  hideSuggestions();
  $('search-input').blur(); // put the iPad keyboard away so results are visible
  const seq = ++searchSeq;
  $('search-status').innerHTML = '<span class="spinner"></span> Searching…';
  $('search-results').replaceChildren();
  try {
    const results = await searchOnline(q);
    if (seq !== searchSeq) return;
    rememberSearch(q);
    if (results.length) {
      $('search-status').textContent = `${results.length} results for “${q}”`;
    } else {
      $('search-status').textContent = `Nothing found for “${q}”.`;
      const guess = didYouMean(q);
      if (guess) {
        const b = el('button', 'chip did-you-mean', `Try “${guess}”`);
        b.addEventListener('click', () => runSearch(guess));
        $('search-status').append(b);
      } else $('search-status').append(' Try fewer or different words.');
    }
    $('search-results').replaceChildren(...results.map((r, i) => {
      const li = el('li', 'result');
      li.style.setProperty('--i', i);
      const info = el('div');
      info.append(el('b', '', r.title), el('small', '', `${r.plays.toLocaleString()} plays`));
      const have = findInLibrary(r.url);
      const add = el('button', have ? '' : 'primary', have ? 'Open' : 'Add');
      add.addEventListener('click', async () => {
        const existing = findInLibrary(r.url);
        if (existing) { // already added: no duplicates, just open it
          showTab('home');
          openChooser(allSongs().find(s => s.id === existing.id));
          return;
        }
        add.disabled = true;
        add.innerHTML = '<span class="spinner"></span>';
        try {
          beginImport(parseMidi(await downloadMidi(r.url)), r.title, 'bitmidi', r.url);
        } catch (err) {
          toast(err.message);
        } finally {
          add.disabled = false;
          add.textContent = 'Add';
        }
      });
      li.append(info, add);
      return li;
    }));
  } catch (err) {
    if (seq !== searchSeq) return;
    $('search-status').textContent = navigator.onLine === false ? 'You are offline. Connect to the internet to search.' : err.message;
  }
});

for (const chip of document.querySelectorAll('[data-query]')) {
  chip.addEventListener('click', () => runSearch(chip.dataset.query)); // plain ASCII: archive names rarely have accents
}
renderRecent();

$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files?.[0];
  if (!file) return;
  try {
    beginImport(parseMidi(await file.arrayBuffer()), file.name.replace(/\.midi?$/i, ''), 'file');
  } catch (err) {
    toast(err.message);
  }
  $('file-input').value = '';
});

function beginImport(midi, title, source, url = null) {
  const playable = midi.tracks.map((t, i) => ({ ...t, i })).filter(t => t.notes.length);
  if (!playable.length) throw new Error('This MIDI file has no notes.');
  pendingImport = { midi, source, url };
  $('import-title').value = title.slice(0, 80);
  const suggested = suggestTrack(midi);
  $('import-tracks').replaceChildren(...playable.map(t => {
    const li = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.value = String(t.i);
    box.checked = t.i === suggested;
    box.disabled = t.drums;
    box.addEventListener('change', updateImportSummary);
    label.append(box, el('span', '', t.name || `Track ${t.i + 1}`), el('small', '', t.drums ? 'drums' : `${t.notes.length} notes`));
    li.append(label);
    return li;
  }));
  $('import-error').hidden = true;
  updateImportSummary();
  $('import').hidden = false;
}

function importOptions() {
  return {
    title: $('import-title').value.trim() || 'Imported song',
    tracks: [...$('import-tracks').querySelectorAll('input')].filter(b => b.checked).map(b => Number(b.value)),
    melodyOnly: $('import-melody').checked,
  };
}

function updateImportSummary() {
  if (!pendingImport) return;
  const opts = importOptions();
  if (!opts.tracks.length) { $('import-summary').textContent = 'Pick at least one track.'; return; }
  try {
    const song = toSong(pendingImport.midi, opts);
    const last = song.steps.at(-1);
    const secs = Math.round(((last.t + last.d) * 60) / song.bpm);
    const notes = song.steps.flatMap(s => s.notes);
    $('import-summary').textContent = `${song.steps.length} notes · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} at ${song.bpm} bpm · ${noteName(Math.min(...notes))} to ${noteName(Math.max(...notes))}`;
  } catch (err) {
    $('import-summary').textContent = err.message;
  }
}
$('import-melody').addEventListener('change', updateImportSummary);
$('import-cancel').addEventListener('click', () => { $('import').hidden = true; pendingImport = null; });
$('import-add').addEventListener('click', () => {
  try {
    const opts = importOptions();
    if (!opts.tracks.length) throw new Error('Pick at least one track.');
    const entry = addToLibrary(toSong(pendingImport.midi, opts), { source: pendingImport.source, url: pendingImport.url });
    $('import').hidden = true;
    pendingImport = null;
    toast(`Added “${entry.title}” to your songs`);
    showTab('home');
    openChooser(allSongs().find(s => s.id === entry.id));
  } catch (err) {
    $('import-error').textContent = err.message;
    $('import-error').hidden = false;
  }
});

$('remove-song').addEventListener('click', () => {
  if (!chosen?.library || !confirm(`Remove “${chosen.title}” from your library?`)) return;
  removeFromLibrary(chosen.id);
  for (const m of Object.keys(MODES)) { try { localStorage.removeItem(`best:${chosen.id}:${m}`); } catch { /* fine */ } }
  $('chooser').hidden = true;
  toast('Removed from your library');
  renderHome();
});

// ---------- starting a session ----------
function resetMic() {
  mic?.close();
  mic = detector = null;
}

async function open(entry, mode) {
  if (micPending) return;
  try {
    if (mic && !mic.alive()) resetMic();
    if (!mic) {
      micPending = startMic();
      mic = await micPending;
      detector = createDetector(mic.sampleRate, mic.fftSize);
      applySettings();
    }
    const song = entry ? entry.song ?? await fetchJson(`songs/${entry.id}`) : null;
    play(mode, song, entry);
  } catch (err) {
    showError(err);
  } finally {
    micPending = null;
  }
}

function play(mode, song, entry) {
  view?.synth?.stop();
  mic.resume(); // we are inside a tap; also undoes a pause's suspend
  $('paused').hidden = true;
  const tempo = Number($('tempo').value) / 100;
  const timedOpts = { tempo, latencyMs: Number($('latency').value), countInBeats: mode === 'listen' ? 2 : 4, auto: mode === 'listen' };
  const session = mode === 'wait' ? createFollower(song) : song ? createTimed(song, timedOpts) : null;
  const now = performance.now();
  view = {
    mode, song, entry, session,
    renderer: createRenderer($('stage'), song, { reducedMotion }),
    smooth: createDisplaySmoother(),
    display: { lit: [], shown: null },
    metronome: createMetronome((delay, accent) => mic.click(delay, accent)),
    msPerBeat: song ? 60000 / (song.bpm * tempo) : 500,
    startedAt: now,
    viewBeat: mode === 'wait' ? song.steps[0].t : 0,
    flash: null,   // wrong key shown red
    banner: null,  // "Perfect" / "Good" / "Miss"
    frame: null,
    synth: null,
    activeMs: 0,
    recorded: false,
    paused: null,
    lastTime: now,
    lastDetect: -Infinity,
  };
  if (mode === 'listen') {
    session.start(now);
    view.synth = mic.synth();
    for (const x of session.notes) view.synth.play(x.note, (session.leadMs + x.time) / 1000, x.dur / 1000);
  }
  $('song-title').textContent = song ? `${song.title} · ${MODES[mode].name}` : 'Mic check';
  $('skip').hidden = mode !== 'wait';
  $('metro-toggle').hidden = !song;
  $('pause').hidden = !song;
  for (const id of ['done', 'chooser', 'home-error', 'home', 'discover', 'progress']) $(id).hidden = true;
  $('tabbar').hidden = true;
  $('practice').hidden = false;
  keepAwake();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

// ---------- pause ----------
// Play along and Listen run on a clock: pausing stops the clock (and the audio engine, which
// freezes Listen's scheduled notes and the metronome exactly where they are).
function pause() {
  const v = view;
  if (!v?.song || v.paused || v.session.done) return;
  v.paused = { at: performance.now() };
  cancelAnimationFrame(raf);
  if (v.mode !== 'wait') mic.suspend();
  $('paused').hidden = false;
}

function resume() {
  const v = view;
  if (!v?.paused) return;
  const gap = performance.now() - v.paused.at;
  v.paused = null;
  mic.resume();
  v.session.shift?.(gap);
  v.startedAt += gap;
  v.lastTime = performance.now();
  v.metronome.reset();
  $('paused').hidden = true;
  raf = requestAnimationFrame(tick);
}

function restart() {
  recordSession(null);
  play(view.mode, view.song, view.entry);
}

// ---------- the loop ----------
function handle(events, now) {
  for (const e of events) {
    if (e.type === 'wrong' || e.type === 'extra') view.flash = { note: e.note, until: now + 400 };
    if (e.type === 'hit') view.renderer.burst(e.note, e.grade === 'good' ? 'good' : 'hit', now);
    if (e.type === 'hit' && e.grade && view.mode === 'timed') {
      view.banner = e.grade === 'perfect' ? { text: 'Perfect', color: '#4ade80', born: now, until: now + 450 }
        : { text: 'Good', color: '#5eead4', born: now, until: now + 450 };
    }
    if (e.type === 'miss') view.banner = { text: 'Miss', color: '#f87171', born: now, until: now + 450 };
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
    v.display = v.smooth.update(v.frame, now);
    if (v.session) handle(v.session.update(v.frame, now), now);
  }
  if (!view) return; // a handler may have left the screen
  const { song, session } = v;
  const dt = Math.min(250, now - v.lastTime); // ignore time spent in the background
  if (song && !session.done) v.activeMs += dt;

  // Beat position, for the metronome and the hit-line pulse.
  const beat = session?.beat ? session.beat(now) : (now - v.startedAt) / v.msPerBeat;
  const msPerBeat = session?.msPerBeat ?? v.msPerBeat;
  if (song && metronomeOn() && !session.done) v.metronome.update(beat, msPerBeat);
  const sinceBeat = (beat - Math.floor(beat)) * msPerBeat;
  const pulse = song && (metronomeOn() || v.mode !== 'wait') ? Math.max(0, 1 - sinceBeat / 160) : 0;
  $('beat-dot').classList.toggle('on', pulse > 0.4);

  let banner = v.banner && now < v.banner.until ? v.banner : null;
  if (v.mode === 'wait') { // glide the falling notes towards the current step
    const last = song.steps.at(-1);
    const target = session.done ? last.t + last.d : song.steps[session.index].t;
    v.viewBeat += (target - v.viewBeat) * Math.min(1, dt / 150);
  } else if (session) {
    v.viewBeat = beat;
    if (beat < 0) banner = { text: String(Math.ceil(-beat)), color: '#f4f4f7', born: v.startedAt + (Math.floor(beat) + session.leadMs / msPerBeat) * msPerBeat };
  }
  v.lastTime = now;

  const flash = v.flash && now < v.flash.until ? v.flash.note : null;
  const keyState = m => (m === flash ? 'wrong' : session ? session.keyState(m) : null);
  const shown = v.display.shown;
  setText($('heard'), v.mode === 'listen' ? 'paused while the song plays'
    : !mic.running() ? 'tap the screen to start' : shown === null ? '–' : noteName(shown));
  $('level').value = v.frame?.loudness ?? 0;
  setText($('progress-text'), v.mode === 'wait' ? `${Math.min(session.index + 1, song.steps.length)} / ${song.steps.length}`
    : v.mode === 'timed' ? `Combo ${session.combo}` : '');
  v.renderer.draw({
    viewBeat: v.viewBeat,
    heard: v.mode === 'listen' ? [] : v.display.lit,
    noteState: session ? session.noteState : null,
    keyState,
    banner,
    big: song ? undefined : (shown != null ? noteName(shown) : null),
    pulse,
    now,
  });
}

// ---------- results ----------
// A finished song always counts; an abandoned one counts once it lasted 20 s (not just a peek).
function recordSession(score, finished = false) {
  const v = view;
  if (!v || v.recorded || !v.song || v.activeMs < (finished ? 5000 : 20000)) return;
  v.recorded = true;
  save('history', JSON.stringify(addSession(history(), {
    day: dayKey(new Date()), t: Date.now(), file: v.entry?.id, title: v.song.title, mode: v.mode,
    secs: Math.round(v.activeMs / 1000), score,
  })));
}

function showDone() {
  const { mode, session, entry } = view;
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
  recordSession(score, true);
  const stars = score === null ? 0 : starsFor(score);
  $('done-title').textContent = mode === 'listen' ? 'That’s how it goes' : score >= 0.7 ? 'Well done!' : 'Keep practising!';
  $('done-stars').replaceChildren(...(score === null ? [] : [0, 1, 2].map(i => {
    const s = el('span', i < stars ? 'on' : '', '★');
    s.style.setProperty('--i', i);
    return s;
  })));
  $('done-stars').setAttribute('aria-label', score === null ? '' : `${stars} of 3 stars`);
  $('done-stats').textContent = stats.join(' · ');
  $('again').textContent = mode === 'listen' ? 'Practise it' : 'Play again';

  const prev = entry ? getBest(entry.id, mode) : null;
  const isBest = score !== null && entry && (!prev || score > prev.score);
  if (isBest) save(`best:${entry.id}:${mode}`, JSON.stringify({ score, stars }));
  $('done-best').hidden = !(isBest && prev);
  const songs = allSongs();
  const next = songs[songs.findIndex(s => s.id === entry?.id) + 1];
  $('next-song').hidden = !entry || !next;
  if (next) $('next-song').textContent = `Next: ${next.title}`;
  $('done').hidden = false;
  if (stars >= 2 && !reducedMotion) confetti();
}

function confetti() {
  const c = $('confetti');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  const colors = ['#a78bfa', '#22d3ee', '#facc15', '#4ade80', '#f472b6'];
  const bits = Array.from({ length: 140 }, () => ({
    x: c.width / 2, y: c.height * 0.35, vx: (Math.random() - 0.5) * 14 * dpr, vy: (-Math.random() * 14 - 4) * dpr,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, w: (6 + Math.random() * 6) * dpr, color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frames = 0;
  (function step() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.vy += 0.35 * dpr; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
      ctx.fillStyle = b.color; ctx.fillRect(-b.w / 2, -b.w / 4, b.w, b.w / 2);
      ctx.restore();
    }
    if (++frames < 150 && !$('done').hidden) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, c.width, c.height);
  })();
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
  recordSession(null); // an unfinished session still counts as practice time
  cancelAnimationFrame(raf);
  view?.synth?.stop();
  if (view?.paused) mic?.resume();
  $('paused').hidden = true;
  wakeLock?.release();
  wakeLock = null;
  view = null;
  $('practice').hidden = true;
  $('tabbar').hidden = false;
  showTab('home');
}

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => open(chosen, btn.dataset.mode));
}
$('chooser-close').addEventListener('click', () => { $('chooser').hidden = true; });
$('chooser').addEventListener('click', e => { if (e.target === $('chooser')) $('chooser').hidden = true; });
$('mic-check').addEventListener('click', () => open(null, 'check'));
$('back').addEventListener('click', goHome);
$('done-back').addEventListener('click', goHome);
$('again').addEventListener('click', () => {
  recordSession(null);
  play(view.mode === 'listen' ? 'wait' : view.mode, view.song, view.entry);
});
$('next-song').addEventListener('click', () => {
  const songs = allSongs();
  const next = songs[songs.findIndex(s => s.id === view.entry?.id) + 1];
  if (next) open(next, view.mode);
});
$('skip').addEventListener('click', () => {
  if (view?.mode === 'wait') handle(view.session.skip(view.frame, performance.now()), performance.now());
});
$('pause').addEventListener('click', pause);
$('resume').addEventListener('click', resume);
$('restart').addEventListener('click', restart);
$('paused-back').addEventListener('click', goHome);

document.addEventListener('visibilitychange', () => {
  if (!view) return;
  if (document.visibilityState === 'hidden') { pause(); return; } // don't let the song run on without you
  if (!mic.alive()) { // iOS stopped the microphone while we were in the background
    goHome();
    resetMic();
    showError(new Error('The microphone was switched off while the app was in the background. Tap a song to start again.'));
    return;
  }
  if (!view.paused) mic.resume(); // iOS suspends audio in the background
  keepAwake();                     // and drops the wake lock
});
// If iOS refused to start audio without a tap, any tap starts it (but not while paused on purpose).
document.addEventListener('pointerdown', e => {
  if (mic && !mic.running() && !view?.paused) mic.resume();
  if (!e.target?.closest?.('[data-tip]')) $('chart-tip').hidden = true;
});

// Keyboard (iPad keyboards, laptops): Escape closes things, Space pauses.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('suggestions').hidden) hideSuggestions();
    else if (!$('import').hidden) $('import-cancel').click();
    else if (!$('chooser').hidden) $('chooser').hidden = true;
    else if (view?.paused) resume();
    else if (view) pause();
  } else if (e.key === ' ' && view?.song && !['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    if (view.paused) resume(); else pause();
  }
});

// Rotating the iPad: redraw the Progress charts at the new width.
let resizeTimer = 0;
window.addEventListener?.('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('progress').hidden) renderProgress(); }, 200);
});

// Offline support: cache the app so it opens at the piano without Wi-Fi.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* works without it, just not offline */ });
}
loadSongs();
