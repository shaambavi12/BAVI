// Bump this every release — activating a new version purges every old cache,
// so a fresh deploy can never get tangled with stale files again.
const CACHE_NAME = 'flowstate-v15';
const ASSETS = [
  './', './index.html',
  './db.js', './tts.js', './sync.js', './nav.js', './ai.js', './app.js',
  './manifest.json', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  // Never cache API traffic (ElevenLabs voices, your sync Worker)
  if (url.includes('api.elevenlabs.io') || url.includes('workers.dev') || url.includes('/flows') || url.includes('/command') || url.includes('/events')) return;

  // Stale-while-revalidate: serve from cache instantly (paint never waits on
  // the network), refresh the cache in the background. A new deploy ships a
  // byte-different sw.js, which installs, purges old caches, and re-caches
  // the new files — so updates land on the next open instead of never.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const refresh = fetch(e.request).then(r => {
        if (r && r.ok) { const clone = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, clone)); }
        return r;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
