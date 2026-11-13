// The person's own song library (kept in this browser) and online search on BitMidi,
// a public archive of MIDI files whose API allows requests from web pages.
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

export function addToLibrary(song, source, storage) {
  const list = loadLibrary(storage);
  const entry = { id: `lib-${Date.now().toString(36)}`, title: song.title, source, song };
  saveLibrary([...list, entry], storage);
  return entry;
}

export function removeFromLibrary(id, storage) {
  saveLibrary(loadLibrary(storage).filter(e => e.id !== id), storage);
}

// "beethoven-symphony9-4-ode-to-joy.mid" -> "Beethoven Symphony9 4 Ode To Joy"
export const prettyName = name => name.replace(/\.midi?$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/\b\w/g, c => c.toUpperCase());

export async function searchOnline(query, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`${BITMIDI}/api/midi/search?q=${encodeURIComponent(query)}&pageSize=20`);
  if (!res.ok) throw new Error(`Search failed (${res.status}). Try again in a moment.`);
  const data = await res.json();
  return (data?.result?.results ?? [])
    .filter(r => typeof r.downloadUrl === 'string' && r.downloadUrl.startsWith('/'))
    .map(r => ({ title: prettyName(r.name ?? 'Untitled'), url: BITMIDI + r.downloadUrl, plays: r.plays ?? 0 }));
}

export async function downloadMidi(url, fetchFn = globalThis.fetch) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return res.arrayBuffer();
}
