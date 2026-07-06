/* Birdomania service worker — v2: stale-while-revalidate for the app shell.
   v1 was network-first, which made every cold launch WAIT on the network —
   painful in the field. Now the cached shell is served instantly and a
   background fetch refreshes the cache, so a pushed update is picked up on the
   NEXT launch after the one that downloaded it (worst case: two launches after
   a push). Cross-origin requests (Wikipedia / Wikimedia bird photos) are left
   untouched — the app manages those itself (live fetch + IndexedDB offline
   store). */
const CACHE = 'birdomania-shell-v2';
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
      return k === CACHE ? null : caches.delete(k);   // purge v1
    }));
    await self.clients.claim();
  })());
});

/* Fetch + cache one request. Two safety guards:
   - never cache non-OK responses (a transient 404/500 must not poison the shell);
   - never cache redirected responses (serving one to a navigation later throws
     "redirected response used for a request whose redirect mode is not follow").
   Navigations are refetched via their URL (a plain GET with redirect:'follow')
   instead of the original navigate-mode Request for the same reason. */
async function revalidate(req) {
  // fetch by URL (plain GET, redirect:'follow') rather than the navigate-mode
  // Request, and bypass the HTTP cache: GitHub Pages serves max-age=600, and a
  // revalidation satisfied from the HTTP cache would re-store the OLD bytes and
  // restart the update clock. 'no-cache' still sends conditional headers, so an
  // unchanged file costs only a 304.
  const res = await fetch(req.url, { cache: 'no-cache' });
  if (res && res.ok && !res.redirected) {
    const cache = await caches.open(CACHE);
    await cache.put(req, res.clone());
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  // Only manage same-origin GETs (the app shell). Let everything else pass.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async function () {
    const cached = await caches.match(req);
    if (cached) {
      // Instant start: serve the cached copy now, refresh in the background.
      e.waitUntil(revalidate(req).catch(function () {}));
      return cached;
    }
    try {
      // First run (or purged cache): must hit the network.
      return await revalidate(req);
    } catch (err) {
      if (req.mode === 'navigate') {
        // Prefer './' — it's the key navigations actually refresh, so it's the
        // newest copy; 'index.html' is only touched at install time.
        const idx = (await caches.match('./')) || (await caches.match('index.html'));
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
