// The person's own song library (kept in this browser), online search on BitMidi (a public
// archive of MIDI files whose API allows requests from web pages) and search suggestions.
const KEY = 'library';
const BITMIDI = 'https://bitmidi.com';

export function loadLibrary(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function saveLibrary(list, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    throw new Error('Your library is full on this device. Remove a song and try again.');
  }
}

// source: 'bitmidi' | 'file'; url: where an online song came from (used to spot duplicates).
export function addToLibrary(song, { source = 'file', url = null } = {}, storage) {
  const list = loadLibrary(storage);
  const entry = { id: `lib-${Date.now().toString(36)}`, title: song.title, source, url, song };
  saveLibrary([...list, entry], storage);
  return entry;
}

export function findInLibrary(url, storage) {
  return url ? loadLibrary(storage).find(e => e.url === url) ?? null : null;
}

export function removeFromLibrary(id, storage) {
  saveLibrary(loadLibrary(storage).filter(e => e.id !== id), storage);
}

// "beethoven-symphony9-4-ode-to-joy.mid" -> "Beethoven Symphony9 4 Ode To Joy"
export const prettyName = name => name.replace(/\.midi?$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/\b\w/g, c => c.toUpperCase());

async function get(url, fetchFn, what) {
  let res;
  try {
    res = await fetchFn(url);
  } catch { // Safari only says "Load failed"
    throw new Error(`Couldn't reach the song archive to ${what}. Check your internet connection and try again.`);
  }
  if (!res.ok) throw new Error(`The song archive didn't answer (error ${res.status}). Try again in a moment.`);
  return res;
}

const cache = new Map(); // query -> results promise, so suggestions and the real search share requests

export function searchOnline(query, fetchFn = globalThis.fetch) {
  const key = normalize(query);
  if (!cache.has(key)) {
    const p = (async () => {
      const res = await get(`${BITMIDI}/api/midi/search?q=${encodeURIComponent(query)}&pageSize=20`, fetchFn, 'search');
      const data = await res.json();
      return (data?.result?.results ?? [])
        .filter(r => typeof r.downloadUrl === 'string' && r.downloadUrl.startsWith('/'))
        .map(r => ({ title: prettyName(r.name ?? 'Untitled'), url: BITMIDI + r.downloadUrl, plays: r.plays ?? 0 }));
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // don't remember failures
  }
  return cache.get(key);
}

export async function downloadMidi(url, fetchFn = globalThis.fetch) {
  return (await get(url, fetchFn, 'download the song')).arrayBuffer();
}

// ---------- suggestions ----------

// Well-known pieces and songs people often look for: instant, offline suggestions and the
// vocabulary for "did you mean". Titles only (no music), all common search phrases.
export const CATALOG = [
  'Fur Elise', 'Moonlight Sonata', 'Canon in D', 'Clair de Lune', 'Gymnopedie', 'Turkish March', 'Minuet in G',
  'Prelude in C', 'Ode to Joy', 'Twinkle Twinkle Little Star', 'Happy Birthday', 'Jingle Bells', 'Silent Night',
  'Amazing Grace', 'Greensleeves', 'Scarborough Fair', 'Swan Lake', 'Nocturne', 'Waltz in A Minor',
  'The Entertainer', 'Maple Leaf Rag', 'Flight of the Bumblebee', 'In the Hall of the Mountain King',
  'Eine Kleine Nachtmusik', 'Air on the G String', 'Ave Maria', 'Wedding March', 'Brahms Lullaby',
  'Mary Had a Little Lamb', 'Row Row Row Your Boat', 'London Bridge', 'Auld Lang Syne',
  'We Wish You a Merry Christmas', 'Deck the Halls', 'O Holy Night', 'Carol of the Bells', 'Danny Boy',
  'House of the Rising Sun', 'When the Saints Go Marching In', 'Yankee Doodle', 'Oh Susanna', 'Chopsticks',
  'Heart and Soul', 'Tetris', 'Super Mario', 'Zelda', 'Pokemon', 'Star Wars', 'Harry Potter',
  'Pirates of the Caribbean', 'Game of Thrones', 'River Flows in You', 'Interstellar', 'Let It Be', 'Imagine',
  'Bohemian Rhapsody', 'Piano Man', 'Hallelujah', 'Someone Like You', 'Clocks', 'Rondo alla Turca',
  'Prelude in E Minor', 'Raindrop Prelude', 'Liebestraum', 'Arabesque', 'Spring Waltz', 'Kiss the Rain',
  'Merry Go Round of Life', 'Comptine', 'Una Mattina', 'Nuvole Bianche', 'Minecraft', 'Megalovania',
  'Can Can', 'Blue Danube', 'Habanera', 'Toccata and Fugue', 'Jesu Joy of Man\'s Desiring', 'Sakura',
];

export const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Titles where every typed word starts a word of the title ("moon so" -> "Moonlight Sonata").
export function matchTitles(query, titles, limit = 6) {
  const q = normalize(query).split(' ').filter(Boolean);
  if (!q.length) return [];
  const scored = [];
  for (const t of titles) {
    const words = normalize(t).split(' ');
    if (!q.every(w => words.some(x => x.startsWith(w)))) continue;
    scored.push([words.findIndex(x => x.startsWith(q[0])), t.length, t]); // earlier match, shorter title first
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(s => s[2]);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// The closest well-known title for a misspelt query ("fur elsie" -> "Fur Elise"), or null.
export function didYouMean(query, titles = CATALOG) {
  const q = normalize(query);
  if (q.length < 3) return null;
  let best = null, bestD = Infinity;
  for (const t of titles) {
    const n = normalize(t);
    if (n === q) return null; // spelt right already
    // Compare with the whole title and with its start (people type the beginning).
    const d = Math.min(editDistance(q, n), editDistance(q, n.slice(0, q.length)) + 1);
    if (d < bestD) { bestD = d; best = t; }
  }
  return bestD <= Math.max(1, Math.floor(q.length * 0.3)) ? best : null;
}

// Tidy, de-duplicated song names out of search results, to suggest as next searches.
export function titleSuggestions(results, query, limit = 5) {
  const q = normalize(query);
  const seen = new Set([q]);
  const out = [];
  for (const r of results) {
    let clean = r.title
      .replace(/\b(mid|midi|piano|version|ver|v\d+)\b/gi, '') // file-name noise
      .replace(/[([]\s*[)\]]/g, '')                           // brackets left empty by that
      .replace(/^\d+\s+|\s\d+$/g, '')                         // track numbers: "149 Moon", "Fur Elise 2"
      .replace(/\s+/g, ' ').trim();
    if (clean === clean.toUpperCase()) clean = clean.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); // "MOON" -> "Moon"
    const key = normalize(clean);
    if (key.length < 3 || seen.has(key) || clean.length > 40) continue;
    seen.add(key);
    out.push(clean);
    if (out.length === limit) break;
  }
  return out;
}
