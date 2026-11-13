// Offline support. Network first for the app's own files, so online you always get the newest
// version and offline (no Wi-Fi at the piano) you get the last copy. Fonts: cache first.
// Song search and downloads always go to the network (nothing to show offline anyway).
const CACHE = 'piano-coach-v1';
const CORE = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'songs/index.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  ...['main', 'audio', 'detector', 'smooth', 'follower', 'timed', 'render', 'metronome', 'stats', 'dashboard',
    'midi', 'library', 'notes'].map(m => `js/${m}.js`)];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Best effort, file by file: one missing file must not stop the rest being cached.
    await Promise.all(CORE.map(u => cache.add(u).catch(() => {})));
    try { // the built-in songs too, so they play offline
      const songs = await (await fetch('songs/index.json')).json();
      await Promise.all(songs.map(s => cache.add(`songs/${s.file}`).catch(() => {})));
    } catch { /* offline during install: they get cached when first opened */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) event.respondWith(networkFirst(req));
  else if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  // A slow connection shouldn't make the app crawl: after 3 s use the saved copy if there is one.
  const timeout = new Promise(resolve => setTimeout(resolve, 3000, null));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    return (await cache.match(req, { ignoreSearch: true })) ?? await network;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
