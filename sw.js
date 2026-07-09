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

/* Bird-image byte cache (v3): upload.wikimedia.org thumbnails are served
   cache-first from Cache Storage, so every previously-seen bird paints
   instantly on later launches — even offline. Thumb URLs are filename-
   versioned (and pinned in the app's wikiCache), so entries never go stale
   ahead of the app's own metadata. ~452 thumbs ≈ 8-18 MB real bytes. */
const IMG_CACHE = 'birdomania-imgs-v1';
const IMG_MAX = 800;   // entry cap (~38 KB avg -> ~30 MB ceiling)

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
      // Purge superseded shell caches but ALWAYS keep the image cache — if it
      // gets deleted here on a future shell bump, every bird photo silently
      // redownloads and nothing looks broken in online testing.
      return (k === CACHE || k === IMG_CACHE) ? null : caches.delete(k);
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

/* Cache-first bird images. The page's <img> requests are no-cors, but we
   re-fetch with mode:'cors' (upload.wikimedia.org sends
   Access-Control-Allow-Origin:*) and cache the clean cors response.
   LOAD-BEARING: never cache an opaque (no-cors) response here — Chromium
   pads each opaque cache entry to ~7 MB against the origin's storage quota
   (anti-fingerprinting), so 450 thumbs would count as ~3 GB and trigger
   whole-origin eviction that can destroy the user's IndexedDB photos.
   A SW may legally answer a no-cors <img> request with a cors response. */
async function imageCacheFirst(u) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(u);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(u, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    return fetch(u, { mode: 'no-cors' });   // passthrough, uncached
  }
  if (res && res.ok && res.type !== 'opaque') {
    cache.put(u, res.clone()).then(function () { return pruneImages(cache); })
      .catch(function () {});               // quota full -> still render
  }
  return res;
}

/* Amortized FIFO cap so the image cache can't grow unbounded. */
async function pruneImages(cache) {
  if (Math.random() > 0.05) return;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - IMG_MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  // Update-check probes (Settings -> "Check for updates") carry ?__fresh=1:
  // step aside entirely so they hit GitHub Pages, not this SW's cache —
  // otherwise the check compares the cached shell against itself and always
  // reports "up to date".
  if (url.searchParams.has('__fresh')) return;
  // Bird thumbnails / gallery images: cache-first from IMG_CACHE.
  if (req.method === 'GET' && url.hostname === 'upload.wikimedia.org') {
    e.respondWith(imageCacheFirst(req.url));
    return;
  }
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
