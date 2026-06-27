/* Birdomania service worker.
   Network-first for the app shell so pushed updates appear on the next launch,
   with a cache fallback so the app still works offline in the field.
   Cross-origin requests (Wikipedia / Wikimedia bird photos) are left untouched —
   the app manages those itself (live fetch + its own IndexedDB offline store). */
const CACHE = 'birdomania-shell-v1';
const SHELL = ['./', 'index.html', 'android-inject.css', 'android-inject.js'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL).catch(function () {});
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      return k === CACHE ? null : caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  // Only manage same-origin GETs (the app shell). Let everything else pass.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async function () {
    try {
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const idx = await caches.match('index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
