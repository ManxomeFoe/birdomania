/* ============================================================
   Android shell behaviour for Birdomania.
   Injected by MainActivity AFTER index.html has loaded, so it runs in the
   page's global scope and can use BIRDS, state, save(), imgPut(), etc.
   Not part of the website copy.
   ============================================================ */
(function(){
  if (window.__birdomaniaInjected) return;
  window.__birdomaniaInjected = true;

  /* ---- Offline app shell: register the service worker when served over
          HTTPS (GitHub Pages). It caches index.html + the inject files so the
          app keeps working with no connection, while still picking up pushed
          updates on the next launch. ---- */
  try {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
      // Best-effort: ask the browser not to evict this origin's storage
      // (the SW image cache + the user's IndexedDB photos) under disk
      // pressure. Ignore the answer — it's advisory.
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(function () {});
      }
    }
  } catch (e) {}

  /* ---- 0a. Debounced persistence ----
     The page calls save() — a full-state JSON.stringify into localStorage —
     after EVERY Wikipedia/Commons lookup (once per bird while browsing) and on
     every interaction. Coalesce bursts into one write. The in-memory `state`
     stays the source of truth (load() only runs at boot, Export serializes the
     in-memory object, and resetAllData() re-persists via save()), so deferring
     the write is safe as long as we flush before the page is hidden/killed. */
  (function installSaveDebounce(){
    if (typeof save !== 'function') return;
    var _write = save;                 // the page's real localStorage writer
    var timer = null, dirty = false, firstDirtyAt = 0;
    var DELAY = 400, MAX_WAIT = 1500;  // trailing debounce with bounded latency
    function flush(){
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty) return;
      dirty = false; firstDirtyAt = 0;
      _write();
    }
    function schedule(){
      var now = Date.now();
      if (!dirty) { dirty = true; firstDirtyAt = now; }
      if (now - firstDirtyAt >= MAX_WAIT) { flush(); return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DELAY);
    }
    save = schedule;                   // rebinds the page's global declaration
    window.save = schedule;
    window.__birdFlushSave = flush;    // explicit flush hook (also for tests)
    // Flush whenever the app may be backgrounded or torn down (Android app
    // switch, screen off, reload) so no burst is ever lost.
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'hidden') flush();
    });
    // Modal-confirmed actions (data Import, trip edits, …) persist the moment
    // the dialog closes, shrinking the crash window after e.g. "Backup
    // restored" from ~400ms to zero.
    if (typeof closeModal === 'function') {
      var _closeModal = closeModal;
      closeModal = window.closeModal = function(){
        _closeModal.apply(this, arguments);
        flush();
      };
    }
  })();

  /* ---- 0. Reliable image fetching ----
     The page lazily fetches every bird's photo from Wikipedia / Wikimedia.
     On mobile a scroll-burst of hundreds of requests gets rate-limited (HTTP
     429), and the page caches those failures permanently. We (a) throttle and
     retry Wikimedia requests, and (b) drop stale negative-cache entries on
     launch so missing images get another chance. */
  (function installFetchThrottle(){
    var _fetch = window.fetch.bind(window);
    var active = 0, queue = [], MAX = 4;
    function isWiki(u){ return /\/\/[a-z0-9.-]*(wikipedia|wikimedia)\.org/i.test(u); }
    function delay(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    // done() MUST decrement before re-pumping: a slot is only free once its
    // job settles. (A past version passed pump directly here, never releasing
    // the 4 slots — every wiki fetch after the first 4 hung forever.)
    function done(){ active--; pump(); }
    function pump(){
      while (active < MAX && queue.length) {
        var job = queue.shift();
        active++;
        job().then(done, done);
      }
    }
    function withRetry(args){
      var attempt = 0;
      function go(){
        return _fetch.apply(null, args).then(function(r){
          if ((r.status === 429 || r.status >= 500) && attempt < 3) {
            attempt++;
            return delay(500 * attempt).then(go);
          }
          return r;
        }).catch(function(e){
          if (attempt < 3) { attempt++; return delay(500 * attempt).then(go); }
          throw e;
        });
      }
      return go();
    }
    window.fetch = function(){
      var args = arguments;
      var first = args[0];
      var u = (typeof first === 'string') ? first : (first && first.url) || '';
      if (!isWiki(u)) return _fetch.apply(null, args);
      return new Promise(function(resolve, reject){
        queue.push(function(){ return withRetry(args).then(resolve, reject); });
        pump();
      });
    };
  })();

  // Forget previous failures so images retry on this launch. Whenever a
  // wikiCache entry is deleted, its _wikiPending flag must be cleared too —
  // a stranded pending flag blocks every future fetchWiki(id) for that bird
  // (the "first 8 birds silhouetted all session" bug).
  (function sweepNegativeCache(){
    try {
      var pend = (typeof _wikiPending !== 'undefined') ? _wikiPending : null;
      var changed = false, k;
      for (k in state.wikiCache) {
        if (state.wikiCache[k] && state.wikiCache[k].ok === false) {
          delete state.wikiCache[k];
          if (pend) delete pend[k];
          changed = true;
        }
      }
      for (k in state.galleryCache) {
        if (state.galleryCache[k] && state.galleryCache[k].ok === false) { delete state.galleryCache[k]; changed = true; }
      }
      if (changed) { save(); if (window.render) render(); }
    } catch (e) {}
  })();

  /* ---- 0b. Lighter bird images ----
     The page's fetchWiki() prefers originalimage.source — the FULL-RESOLUTION
     Wikipedia photo (often several MB) — for every card thumbnail. Replace it
     (same contract: shares _wikiPending + state.wikiCache, then save() +
     upgradeBirdImages()) with a version that prefers the REST thumbnail
     (~330px, 10-30x smaller). The URL is used VERBATIM — as of 2026, Wikimedia's
     thumbnailer 400s widths outside an undocumented bucket list, so fabricating
     a "better" width risks permanently silhouetting a bird. Detail views get
     sharper 480px images from the Commons gallery API, which generates its
     thumb URLs server-side. Also adds native lazy-loading to every bird <img>
     and pre-warms the API/image-CDN connections. */
  (function installImagePipeline(){
    if (typeof fetchWiki !== 'function' || typeof birdImageHTML !== 'function' ||
        typeof upgradeBirdImages !== 'function') return;

    // Pre-warm TLS to the API + image hosts (first-image latency win).
    ['https://en.wikipedia.org', 'https://upload.wikimedia.org', 'https://commons.wikimedia.org']
      .forEach(function(origin){
        try {
          var l = document.createElement('link');
          l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
          document.head.appendChild(l);
        } catch (e) {}
      });

    fetchWiki = window.fetchWiki = async function(id){
      if (state.wikiCache[id] || _wikiPending[id]) return;
      _wikiPending[id] = true;
      var title = encodeURIComponent((BIRDS[id].wiki || BIRDS[id].name).replace(/ /g, '_'));
      try {
        var r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + title,
                            { headers: { Accept: 'application/json' } });
        if (r.ok) {
          var j = await r.json();
          var thumb = (j.thumbnail && j.thumbnail.source) ||
                      (j.originalimage && j.originalimage.source) || null;
          state.wikiCache[id] = {
            thumb: thumb,
            page: (j.content_urls && j.content_urls.desktop) ? j.content_urls.desktop.page : null,
            ok: !!thumb
          };
        } else { state.wikiCache[id] = { ok: false }; }
      } catch (e) { state.wikiCache[id] = { ok: false }; }
      save();
      upgradeBirdImages(id);
    };

    // Same behaviour as the page's upgradeBirdImages, plus lazy/async attrs.
    upgradeBirdImages = window.upgradeBirdImages = function(id){
      var wc = state.wikiCache[id]; if (!wc || !wc.ok || !wc.thumb) return;
      document.querySelectorAll('[data-birdimg="' + id + '"]').forEach(function(box){
        if (state.birdPhotos[id] || (state.birdThumb && state.birdThumb[id])) return;
        box.innerHTML = '<img loading="lazy" decoding="async" src="' + esc(wc.thumb) +
          '" alt="' + esc(BIRDS[id].name) +
          '" onerror="this.outerHTML=birdSVG(\'' + id + '\')"/>';
      });
    };

    // Every <img> birdImageHTML produces gains native lazy-loading.
    var _obih = birdImageHTML;
    birdImageHTML = window.birdImageHTML = function(id, cls){
      var html = (cls === undefined) ? _obih(id) : _obih(id, cls);
      if (html && html.indexOf('<img ') === 0 && html.indexOf('loading=') === -1) {
        html = '<img loading="lazy" decoding="async" ' + html.slice(5);
      }
      return html;
    };

    // Full-res sweep — EVERY launch, twice (was a one-time __thumbFix, which
    // let full-res entries re-enter permanently). Root cause: the page's boot
    // code prefetches the first ~8 birds BEFORE this inject replaces
    // fetchWiki, so those in-flight originals later write multi-MB
    // originalimage URLs into wikiCache (measured 15.4MB for 8 birds vs
    // ~0.3MB as thumbs) and can leave _wikiPending stranded (bird
    // silhouetted all session). Sweep now for damage from past sessions, and
    // again after the pre-inject fetches have landed.
    // (User-chosen gallery thumbs live in state.birdThumb and are untouched.)
    function sweepFullRes(){
      try {
        var pend = (typeof _wikiPending !== 'undefined') ? _wikiPending : null;
        var changed = false, k;
        for (k in state.wikiCache) {
          var wc2 = state.wikiCache[k];
          if (wc2 && wc2.ok && wc2.thumb &&
              /upload\.wikimedia\.org\//.test(wc2.thumb) &&
              wc2.thumb.indexOf('/thumb/') === -1) {
            delete state.wikiCache[k];
            if (pend) delete pend[k];
            changed = true;
          }
        }
        // Pending with no cache entry = stranded by a sweep or a fetch that
        // died pre-inject; clear it so the thumbnail path can retry.
        if (pend) {
          for (k in pend) {
            if (!state.wikiCache[k]) { delete pend[k]; changed = true; }
          }
        }
        if (changed) { save(); if (window.render) render(); }
      } catch (e) {}
    }
    sweepFullRes();
    setTimeout(sweepFullRes, 6000);
  })();

  /* ---- 0c. Batched thumbnail warm-up ----
     Instead of one REST summary round-trip per bird (~450 calls for the full
     catalog, ~30s at 4-concurrent), fetch thumbnails 50 titles at a time from
     the MediaWiki Action API (prop=pageimages) — the whole catalog lands in
     ~10 requests / ~5s. The returned thumbnail URLs are byte-identical to the
     REST summary's (same PageImages data, same thumbnailer buckets) and are
     used VERBATIM per the project rule. Batches run strictly sequentially
     (Wikimedia etiquette; also makes 429s essentially impossible). The
     single-bird fetchWiki stays as the on-demand fallback. */
  (function installBatchWarmup(){
    if (typeof BIRDS === 'undefined' || typeof state === 'undefined' ||
        typeof upgradeBirdImages !== 'function') return;
    var API = 'https://en.wikipedia.org/w/api.php';
    function titleFor(id){ return (BIRDS[id].wiki || BIRDS[id].name).replace(/ /g, '_'); }
    function pageUrl(title){
      return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
    }

    // One batch of <= 50 bird ids. Returns false on API failure (callers stop
    // batching; the lazy single-bird path still covers every bird).
    async function fetchBatch(ids){
      var pend = (typeof _wikiPending !== 'undefined') ? _wikiPending : {};
      var byTitle = {};                       // requested title -> [bird ids]
      ids.forEach(function(id){
        var t = titleFor(id);
        (byTitle[t] = byTitle[t] || []).push(id);
        pend[id] = true;                      // dedupe vs single fetchWiki
      });
      try {
        var url = API + '?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=330' +
                  '&format=json&formatversion=2&redirects=1&origin=*' +
                  '&titles=' + encodeURIComponent(Object.keys(byTitle).join('|'));
        var r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var j = await r.json();
        var q = (j && j.query) || {};
        // Response pages come back in pageid order under CANONICAL titles;
        // map a requested title through normalized (underscores -> spaces)
        // then redirects (chainable) to find its page.
        var norm = {}, redir = {};
        (q.normalized || []).forEach(function(n){ norm[n.from] = n.to; });
        (q.redirects  || []).forEach(function(n){ redir[n.from] = n.to; });
        function resolve(t){
          t = norm[t] || t;
          for (var i = 0; i < 5 && redir[t]; i++) t = redir[t];
          return t;
        }
        var pages = {};
        (q.pages || []).forEach(function(p){ if (p && p.title) pages[p.title] = p; });
        ids.forEach(function(id){ delete pend[id]; });
        Object.keys(byTitle).forEach(function(reqT){
          var p = pages[resolve(reqT)];
          var thumb = (p && !p.missing && p.thumbnail && p.thumbnail.source) || null;
          byTitle[reqT].forEach(function(id){
            if (state.wikiCache[id] && state.wikiCache[id].ok) return;  // never clobber a good entry
            state.wikiCache[id] = {
              thumb: thumb,
              page: (p && p.title) ? pageUrl(p.title) : null,
              ok: !!thumb
            };
            upgradeBirdImages(id);            // fill any on-screen card now
          });
        });
        save();
        return true;
      } catch (e) {
        ids.forEach(function(id){ delete pend[id]; });
        return false;
      }
    }

    window.__birdBatchWarmup = async function(){
      var pend = (typeof _wikiPending !== 'undefined') ? _wikiPending : {};
      var seen = {}, order = [];
      function add(id){
        if (seen[id] || !BIRDS[id] || pend[id]) return;
        var wc = state.wikiCache[id];
        if (wc && wc.ok) return;              // already resolved
        seen[id] = 1; order.push(id);
      }
      // Tracked regions first so the user's own birds resolve in batch 1-2.
      try {
        (state.loadedRegions || []).forEach(function(c){
          regionBirds(c).forEach(add);
        });
      } catch (e) {}
      Object.keys(BIRDS).forEach(add);
      for (var i = 0; i < order.length; i += 50) {
        if (!(await fetchBatch(order.slice(i, i + 50)))) break;
      }
    };
    // Kick off shortly after first paint; each batch is ~0.5s, sequential.
    setTimeout(function(){ window.__birdBatchWarmup().catch(function(){}); }, 1500);
  })();

  /* ---- 1. Safe-area insets: copy the values MainActivity pushes into
            window.__androidInsets onto CSS custom properties. ---- */
  window.__applyAndroidInsets = function(){
    var i = window.__androidInsets || {};
    var r = document.documentElement.style;
    r.setProperty('--android-inset-top',    (i.top    || 0) + 'px');
    r.setProperty('--android-inset-right',  (i.right  || 0) + 'px');
    r.setProperty('--android-inset-bottom', (i.bottom || 0) + 'px');
    r.setProperty('--android-inset-left',   (i.left   || 0) + 'px');
    // The header grew/shrank, so re-measure the sticky-header height var.
    try { if (window.syncHeaderHeight) window.syncHeaderHeight(); } catch (e) {}
  };
  window.__applyAndroidInsets();

  // The companion stylesheet can finish loading AFTER the page measured its
  // sticky-header height at boot, and its narrow-screen header wrap changes
  // that height — re-measure once the CSS is actually applied (plus a timed
  // fallback in case the <link> already loaded before this script ran).
  (function remeasureHeader(){
    function sync(){ try { if (window.syncHeaderHeight) syncHeaderHeight(); } catch (e) {} }
    try {
      var css = document.getElementById('android-inject-css');
      if (css) css.addEventListener('load', sync);
    } catch (e) {}
    setTimeout(sync, 600);
  })();

  /* ---- 2. Tell the native shell which theme is active so it can pick
            light vs. dark status-bar icons. ---- */
  function reportTheme(){
    try {
      if (window.AndroidShell && AndroidShell.setDarkTheme) {
        AndroidShell.setDarkTheme(document.body.classList.contains('dark'));
      }
    } catch (e) {}
  }
  reportTheme();
  try {
    new MutationObserver(reportTheme).observe(document.body,
      { attributes:true, attributeFilter:['class'] });
  } catch (e) {}

  /* ---- 3. Offline bird-image download manager ---- */
  if (!state.offlineImages) state.offlineImages = {};
  if (!state.birdThumb)     state.birdThumb = {};

  function offlineCount(){ return Object.keys(state.offlineImages || {}).length; }

  // Resolve a (preferably small) photo URL for a bird, caching the lookup.
  async function fetchThumbUrl(id){
    var wc = state.wikiCache[id];
    if (wc && wc.ok && wc.thumb) return wc.thumb;
    var title = encodeURIComponent((BIRDS[id].wiki || BIRDS[id].name).replace(/ /g,'_'));
    try {
      var r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + title,
                          { headers:{ Accept:'application/json' } });
      if (r.ok) {
        var j = await r.json();
        var thumb = (j.thumbnail && j.thumbnail.source) ||
                    (j.originalimage && j.originalimage.source) || null;
        state.wikiCache[id] = {
          thumb: thumb,
          page: (j.content_urls && j.content_urls.desktop) ? j.content_urls.desktop.page : null,
          ok: !!thumb
        };
        return thumb;
      }
    } catch (e) {}
    if (!state.wikiCache[id]) state.wikiCache[id] = { ok:false };
    return null;
  }

  async function downloadOne(id){
    if (state.offlineImages[id]) return 'skip';   // already saved
    if (state.birdPhotos[id])    return 'skip';   // user has their own photo
    var url = await fetchThumbUrl(id);
    if (!url) return 'fail';
    try {
      var resp = await fetch(url);
      if (!resp.ok) return 'fail';
      var blob = await resp.blob();
      if (!blob || blob.size === 0) return 'fail';
      var imgId = await imgPut(blob);
      state.offlineImages[id] = imgId;
      if (!state.birdThumb[id]) state.birdThumb[id] = { kind:'user', ref:imgId };
      return 'ok';
    } catch (e) { return 'fail'; }
  }

  // Download photos for an explicit list of bird ids (already-saved birds and
  // birds with a user photo are skipped inside downloadOne).
  async function downloadOfflineImages(ids, onProgress){
    var total = ids.length, done = 0, idx = 0;
    var CONC = 4;
    async function worker(){
      while (idx < ids.length) {
        var id = ids[idx++];
        await downloadOne(id);
        done++;
        if (done % 12 === 0) save();
        if (onProgress) onProgress(done, total);
      }
    }
    var workers = [];
    for (var k = 0; k < CONC; k++) workers.push(worker());
    await Promise.all(workers);
    save();
    return { total: total, saved: offlineCount() };
  }

  /* ---- Region helpers ----
     regionBirds(), regionName(), regionIcon() and REGION_NAMES all come from
     the page's own code, so we reuse them to keep region membership in sync. */
  function listedRegions(){
    return (state.loadedRegions && state.loadedRegions.length)
      ? state.loadedRegions.slice()
      : Object.keys(REGION_NAMES);
  }
  function regionIds(code){
    try { return regionBirds(code).filter(function(id){ return BIRDS[id]; }); }
    catch (e) { return []; }
  }
  // A bird's photo is available offline if we downloaded it or the user added
  // their own photo for it.
  function savedOffline(id){ return !!(state.offlineImages[id] || state.birdPhotos[id]); }
  function regionSaved(ids){
    var n = 0;
    for (var i = 0; i < ids.length; i++) if (savedOffline(ids[i])) n++;
    return n;
  }
  // Union of every listed region's birds (for the "Download all" action).
  function allRegionIds(){
    var set = Object.create(null);
    listedRegions().forEach(function(c){ regionIds(c).forEach(function(id){ set[id] = 1; }); });
    return Object.keys(set);
  }

  async function removeOfflineImages(){
    var map = state.offlineImages || {};
    for (var id in map) {
      var imgId = map[id];
      try { await imgDel(imgId); } catch (e) {}
      var t = state.birdThumb && state.birdThumb[id];
      if (t && t.kind === 'user' && t.ref === imgId) delete state.birdThumb[id];
    }
    state.offlineImages = {};
    save();
    render();
  }

  /* ---- 4. Add the offline controls into the Settings modal ---- */
  function injectOfflineSection(settingsEl){
    if (settingsEl.querySelector('.offline-row')) return;
    var danger = settingsEl.querySelector('.danger-zone');
    var row = document.createElement('div');
    row.className = 'set-row col offline-row';
    row.innerHTML =
      '<div class="set-label"><div class="set-title">Offline bird images</div>' +
      '<div class="set-desc">Download bird photos for the regions you track so they stay ' +
      'available in the field without a connection. Photos are fetched from Wikipedia and ' +
      'stored on your device.</div></div>' +
      '<div class="offline-bar"><span></span></div>' +
      '<div class="offline-status"></div>' +
      '<div class="offline-regions"></div>' +
      '<div class="offline-actions">' +
      '<button class="btn" id="offDownloadAll">Download all regions</button>' +
      '<button class="btn ghost" id="offRemove">Remove offline images</button>' +
      '</div>';
    if (danger) settingsEl.insertBefore(row, danger); else settingsEl.appendChild(row);

    var statusEl = row.querySelector('.offline-status');
    var bar    = row.querySelector('.offline-bar');
    var fill   = row.querySelector('.offline-bar > span');
    var regBox = row.querySelector('.offline-regions');
    var dlAll  = row.querySelector('#offDownloadAll');
    var rm     = row.querySelector('#offRemove');

    var busy = false;

    function allButtons(){ return row.querySelectorAll('button'); }
    function setBusy(on){
      busy = on;
      allButtons().forEach(function(b){ b.disabled = on; });
    }

    function refreshStatus(){
      var c = offlineCount();
      statusEl.textContent = c > 0
        ? (c + ' bird image' + (c === 1 ? '' : 's') + ' saved for offline use.')
        : 'No images downloaded yet.';
      rm.style.display = c > 0 ? '' : 'none';
    }

    // Build / rebuild the per-region rows with up-to-date saved counts.
    function renderRegions(){
      regBox.innerHTML = '';
      listedRegions().forEach(function(code){
        var ids   = regionIds(code);
        if (!ids.length) return;
        var saved = regionSaved(ids);
        var full  = saved >= ids.length;

        var r = document.createElement('div');
        r.className = 'offline-region';
        r.innerHTML =
          '<div class="offline-region-info">' +
          '<div class="offline-region-name">' + regionIcon(code) + ' ' + esc(regionName(code)) + '</div>' +
          '<div class="offline-region-count">' + saved + ' / ' + ids.length + ' photos saved</div>' +
          '</div>';

        var b = document.createElement('button');
        b.className = 'btn sm offline-region-dl';
        b.textContent = full ? 'Saved ✓' : 'Download';
        b.disabled = full || busy;
        b.onclick = function(){ runDownload(ids, regionName(code)); };
        r.appendChild(b);
        regBox.appendChild(r);
      });
    }

    function refresh(){ refreshStatus(); renderRegions(); }

    // Shared download runner: drives the progress bar and keeps the UI locked
    // while photos are being fetched.
    async function runDownload(ids, label){
      if (busy) return;
      if (!ids.length) { toast('Nothing to download for ' + label); return; }
      setBusy(true);
      bar.style.display = 'block'; fill.style.width = '0';
      statusEl.textContent = 'Downloading ' + label + '…';
      try {
        await downloadOfflineImages(ids, function(done, total){
          fill.style.width = Math.round(done / total * 100) + '%';
          statusEl.textContent = 'Downloading ' + label + '… ' + done + ' / ' + total;
        });
        toast(label + ' ready (' + offlineCount() + ' saved)');
        render();
      } catch (e) {
        toast('Download finished with some errors');
      }
      bar.style.display = 'none'; fill.style.width = '0';
      setBusy(false);
      refresh();
    }

    dlAll.onclick = function(){ runDownload(allRegionIds(), 'all regions'); };

    rm.onclick = async function(){
      if (busy) return;
      setBusy(true);
      await removeOfflineImages();
      toast('Offline images removed');
      setBusy(false);
      refresh();
    };

    refresh();
  }

  /* ---- 5. Extra colour themes ----
     The page stores its theme in state.prefs.theme ("light"/"dark") and applies
     it via the global applyTheme(). We widen that to "light"/"sepia"/"dark"/
     "nocturne" by wrapping applyTheme() (to add the extra body classes) and
     replacing the Settings dark-mode toggle with a 4-way theme picker. CSS for
     the palettes lives in android-inject.css. */
  var THEME_KEYS = ['light', 'sepia', 'dark', 'nocturne'];
  var THEME_META = {
    light:    { label: 'Classic',  color: '#2f4a3c' },
    sepia:    { label: 'Sepia',    color: '#4c5d36' },
    dark:     { label: 'Dark',     color: '#1c1a16' },
    nocturne: { label: 'Nocturne', color: '#10171b' }
  };
  function themePref(){
    var t = state.prefs && state.prefs.theme;
    return THEME_META[t] ? t : 'light';
  }

  if (typeof applyTheme === 'function') {
    var _applyTheme = applyTheme;
    // Reassign the page's global so inline handlers calling applyTheme() get this.
    applyTheme = function(){
      _applyTheme.apply(this, arguments);     // base: toggles .dark for theme==='dark'
      var t = themePref();
      var b = document.body;
      b.classList.remove('theme-sepia', 'theme-nocturne');
      if (t === 'sepia')         b.classList.add('theme-sepia');
      else if (t === 'nocturne') b.classList.add('dark', 'theme-nocturne');
      var tc = document.querySelector('meta[name="theme-color"]');
      if (tc) tc.setAttribute('content', THEME_META[t].color);
    };
    window.applyTheme = applyTheme;
    applyTheme();   // re-apply now (boot already ran the original before inject loaded)
  }

  function injectThemeSection(settingsEl){
    if (settingsEl.querySelector('.theme-row')) return;
    // Hide the page's built-in Dark-mode toggle; the picker supersedes it.
    var darkInput = settingsEl.querySelector('#setDark');
    var darkRow = darkInput && darkInput.closest('.set-row');
    if (darkRow) darkRow.style.display = 'none';

    var row = document.createElement('div');
    row.className = 'set-row col theme-row';
    var cur = themePref();
    row.innerHTML =
      '<div class="set-label"><div class="set-title">Theme</div>' +
      '<div class="set-desc">Pick a colour theme. Dark and Nocturne suit low light.</div></div>' +
      '<div class="seg" id="themePick">' +
      THEME_KEYS.map(function(k){
        return '<button data-theme="' + k + '" class="' + (k === cur ? 'active' : '') + '">' +
               THEME_META[k].label + '</button>';
      }).join('') +
      '</div>';
    if (darkRow && darkRow.parentNode) darkRow.parentNode.insertBefore(row, darkRow);
    else settingsEl.insertBefore(row, settingsEl.firstChild);

    row.querySelectorAll('#themePick button').forEach(function(btn){
      btn.onclick = function(){
        if (!state.prefs) state.prefs = { theme: 'light', nameMode: 'both' };
        state.prefs.theme = btn.dataset.theme;
        save();
        applyTheme();
        row.querySelectorAll('#themePick button').forEach(function(b){
          b.classList.toggle('active', b === btn);
        });
      };
    });
  }

  /* ---- 6. Family-specific bird silhouettes ----
     The page's birdSVG(id) draws ONE perched-songbird shape recoloured per
     species. We replace it (reusing the page's global, so every call site and
     onerror fallback benefits) with a silhouette chosen from the bird's family
     — a duck looks like a duck, a hawk like a hawk. Same contract: returns a
     100x100 <svg> string. Shading uses translucent overlays so we never need
     per-shade colour maths; body is tinted to the species colour. */
  (function installBirdSilhouettes(){
    if (typeof birdSVG !== 'function') return;

    // Map a family string to one of our silhouette archetypes.
    function groupFor(fam){
      var f = (fam || '').toLowerCase();
      if (/duck|geese|goose|swan|loon|grebe|merganser|teal|eider|scoter|wigeon|pintail|bufflehead|goldeneye|canvasback|scaup|smew/.test(f)) return 'waterfowl';
      if (/hawk|eagle|falcon|osprey|kite|harrier|owl|vulture|kestrel|gyrfalcon|merlin|goshawk|caracara/.test(f)) return 'raptor';
      if (/heron|egret|crane|spoonbill|ibis|stork|bittern|flamingo/.test(f)) return 'wader';
      if (/sandpiper|plover|godwit|curlew|yellowlegs|turnstone|dowitcher|snipe|phalarope|stint|knot|dunlin|tattler|oystercatcher|avocet|stilt|surfbird|sanderling|whimbrel|dotterel|ruff|killdeer/.test(f)) return 'shorebird';
      if (/hummingbird/.test(f)) return 'hummingbird';
      if (/woodpecker|sapsucker|flicker|wryneck/.test(f)) return 'woodpecker';
      if (/gull|tern|auk|puffin|murre|guillemot|kittiwake|jaeger|pelican|cormorant|albatross|fulmar|shearwater|petrel|gannet|skua|kingfisher/.test(f)) return 'seabird';
      if (/grouse|quail|turkey|pheasant|ptarmigan|partridge|chicken|fowl/.test(f)) return 'fowl';
      return 'passerine';
    }

    var DK = '#2b2117', BILL = '#8a6d3b', LEG = '#6b5333',
        WING = '#0000001f', HI = '#ffffff24', SHADOW = '#0000000f';
    function shadow(cx, rx){ return '<ellipse cx="' + cx + '" cy="86" rx="' + rx + '" ry="4" fill="' + SHADOW + '"/>'; }
    function eye(cx, cy){ return '<circle cx="' + cx + '" cy="' + cy + '" r="2.1" fill="' + DK + '"/>'; }

    var SIL = {
      // Plump perched songbird facing right, on a twig.
      passerine: function(c){ return shadow(50, 26) +
        '<path d="M32 64 q2 -22 22 -25 q17 -2 23 9 q5 9 -4 16 q-10 8 -24 7 q-14 -1 -17 -7z" fill="' + c + '"/>' +
        '<circle cx="66" cy="40" r="11" fill="' + c + '"/>' +
        '<path d="M39 60 q13 -5 26 0 q-9 8 -21 7 q-7 -1 -5 -7z" fill="' + HI + '"/>' +
        '<path d="M40 50 q15 -4 27 3 q-4 13 -21 12 q-10 -1 -6 -15z" fill="' + WING + '"/>' +
        eye(70, 38) + '<path d="M77 40 l11 -2 -10 5z" fill="' + BILL + '"/>' +
        '<path d="M50 78 l-2 9 m7 -9 l1 9" stroke="' + LEG + '" stroke-width="2" stroke-linecap="round" fill="none"/>' +
        '<path d="M20 86 q30 -7 60 0" stroke="' + BILL + '" stroke-width="2.4" fill="none" opacity=".5"/>'; },

      // Duck floating on a waterline.
      waterfowl: function(c){ return '<path d="M0 72 q50 -8 100 0 V100 H0z" fill="#00000010"/>' +
        '<path d="M22 66 q4 -16 30 -16 q24 0 32 9 q5 6 -2 9 q-22 6 -62 1 q-4 -1 2 -3z" fill="' + c + '"/>' +
        '<path d="M70 58 q12 -2 16 -10 q3 5 -1 11 q-6 5 -15 4z" fill="' + c + '"/>' +
        '<circle cx="80" cy="44" r="9" fill="' + c + '"/>' +
        '<path d="M30 62 q24 -6 48 0 q-12 6 -30 6 q-14 0 -18 -6z" fill="' + HI + '"/>' +
        eye(83, 42) + '<path d="M88 44 l11 0 -10 4z" fill="#caa24a"/>'; },

      // Upright raptor with a hooked bill.
      raptor: function(c){ return shadow(48, 22) +
        '<path d="M36 78 q-6 -28 8 -42 q9 -9 20 -5 q10 4 9 18 q-1 16 -9 29 q-5 7 -14 6 q-10 -1 -14 -6z" fill="' + c + '"/>' +
        '<path d="M44 40 q10 -10 22 -4 q-2 16 -12 22 q-9 -6 -10 -18z" fill="' + WING + '"/>' +
        '<circle cx="52" cy="28" r="12" fill="' + c + '"/>' +
        '<path d="M44 30 q8 -7 16 0 q-3 -10 -8 -10 q-6 0 -8 10z" fill="' + HI + '"/>' +
        eye(56, 26) + '<path d="M63 27 q7 0 7 6 q-4 -2 -8 -1z" fill="#d9a531"/>' +
        '<path d="M40 80 l-1 8 m12 -8 l1 8 m10 -9 l2 8" stroke="' + LEG + '" stroke-width="2.4" stroke-linecap="round" fill="none"/>'; },

      // Long-legged, long-necked wader (heron/crane).
      wader: function(c){ return shadow(50, 18) +
        '<path d="M40 64 q-3 -12 14 -14 q16 -2 22 6 q4 6 -3 10 q-10 5 -22 4 q-9 -1 -11 -6z" fill="' + c + '"/>' +
        '<path d="M52 52 q-2 -22 6 -34 q3 -4 6 -2 q2 2 0 6 q-6 14 -4 30z" fill="' + c + '"/>' +
        '<circle cx="60" cy="16" r="7" fill="' + c + '"/>' +
        eye(63, 14) + '<path d="M66 16 l16 -3 -15 6z" fill="#d6a23e"/>' +
        '<path d="M44 60 q14 -4 28 0 q-10 5 -22 4 q-7 -1 -6 -4z" fill="' + HI + '"/>' +
        '<path d="M46 66 l-3 22 m18 -22 l4 22" stroke="' + LEG + '" stroke-width="2.2" stroke-linecap="round" fill="none"/>'; },

      // Small shorebird: round body, long legs, straight bill.
      shorebird: function(c){ return shadow(50, 18) +
        '<path d="M36 60 q2 -16 20 -17 q16 -1 22 8 q4 7 -4 12 q-9 5 -22 4 q-13 -1 -16 -7z" fill="' + c + '"/>' +
        '<circle cx="66" cy="42" r="9" fill="' + c + '"/>' +
        '<path d="M41 56 q13 -5 25 0 q-9 7 -20 6 q-7 -1 -5 -6z" fill="' + HI + '"/>' +
        '<path d="M41 48 q14 -3 24 3 q-4 11 -19 10 q-9 -1 -5 -13z" fill="' + WING + '"/>' +
        eye(69, 40) + '<path d="M75 42 l18 -1 -18 3z" fill="' + DK + '"/>' +
        '<path d="M48 62 l-3 24 m14 -24 l3 24" stroke="' + LEG + '" stroke-width="1.8" stroke-linecap="round" fill="none"/>'; },

      // Hovering hummingbird with a needle bill and blurred wing.
      hummingbird: function(c){ return shadow(46, 14) +
        '<path d="M34 56 q4 -12 20 -12 q14 0 18 7 q3 6 -4 9 q-12 4 -26 1 q-9 -2 -8 -5z" fill="' + c + '"/>' +
        '<circle cx="58" cy="44" r="8" fill="' + c + '"/>' +
        '<path d="M40 52 q12 -4 22 0 q-8 6 -18 5 q-6 -1 -4 -5z" fill="' + HI + '"/>' +
        '<path d="M30 40 q22 0 34 8 q-16 6 -34 0z" fill="' + WING + '"/>' +
        eye(61, 42) + '<path d="M65 44 l22 6 -22 -1z" stroke="' + DK + '" stroke-width="1.5" fill="none"/>' +
        '<path d="M40 64 l-2 8 m8 -8 l1 8" stroke="' + LEG + '" stroke-width="1.5" stroke-linecap="round" fill="none"/>'; },

      // Woodpecker clinging vertically to a trunk (trunk on the left).
      woodpecker: function(c){ return '<rect x="14" y="0" width="13" height="100" fill="#00000014"/>' +
        '<rect x="24" y="0" width="3" height="100" fill="#0000001a"/>' +
        '<path d="M30 24 q-4 28 6 50 q6 13 16 11 q9 -2 7 -16 q-3 -24 -12 -42 q-7 -13 -17 -3z" fill="' + c + '"/>' +
        '<path d="M34 34 q10 -6 16 6 q-3 18 -10 28 q-9 -14 -6 -34z" fill="' + WING + '"/>' +
        '<circle cx="32" cy="22" r="9" fill="' + c + '"/>' +
        '<path d="M30 16 q4 -8 8 0 q-2 -8 -8 0z" fill="#c4392f"/>' +
        eye(34, 21) + '<path d="M27 23 l-13 -2 13 5z" fill="' + DK + '"/>'; },

      // Standing/swimming seabird (gull/auk) with a stout bill.
      seabird: function(c){ return '<path d="M0 74 q50 -7 100 0 V100 H0z" fill="#00000010"/>' +
        '<path d="M24 66 q2 -18 28 -18 q26 0 32 10 q4 7 -4 10 q-24 6 -58 1 q-4 -1 2 -3z" fill="' + c + '"/>' +
        '<path d="M52 50 q-2 -16 8 -22 q3 -2 5 1 q2 3 -1 6 q-7 6 -6 16z" fill="' + c + '"/>' +
        '<circle cx="63" cy="26" r="8" fill="' + c + '"/>' +
        '<path d="M32 62 q24 -6 46 0 q-12 6 -28 6 q-14 0 -18 -6z" fill="' + HI + '"/>' +
        eye(66, 24) + '<path d="M69 25 l13 -1 -12 5z" fill="#e0a32f"/>'; },

      // Plump ground bird (grouse/quail) with a short tail.
      fowl: function(c){ return shadow(50, 24) +
        '<path d="M28 70 q0 -24 26 -26 q22 -2 30 10 q6 9 -2 17 q-12 10 -34 9 q-18 -1 -20 -10z" fill="' + c + '"/>' +
        '<path d="M78 56 q14 -4 20 -2 q-6 8 -20 10z" fill="' + c + '"/>' +
        '<circle cx="38" cy="46" r="10" fill="' + c + '"/>' +
        '<path d="M37 38 q4 -10 9 -3 q-1 -7 -6 -7 q-5 1 -3 10z" fill="' + DK + '"/>' +
        '<path d="M36 66 q20 -6 38 0 q-12 7 -28 6 q-12 -1 -10 -6z" fill="' + HI + '"/>' +
        eye(35, 44) + '<path d="M28 46 l-10 1 10 3z" fill="' + BILL + '"/>' +
        '<path d="M42 78 l-2 9 m9 -9 l1 9" stroke="' + LEG + '" stroke-width="2.4" stroke-linecap="round" fill="none"/>'; }
    };

    function makeSVG(id){
      var b = BIRDS[id] || {};
      var c = b.col || '#6b7a8f';
      var gid = 'bsg-' + id;
      var inner = (SIL[groupFor(b.fam)] || SIL.passerine)(c);
      return '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#efe6cd"/><stop offset="1" stop-color="#e2d5b4"/></linearGradient></defs>' +
        '<rect width="100" height="100" fill="url(#' + gid + ')"/>' + inner + '</svg>';
    }
    var _origBirdSVG = birdSVG;
    window.birdSVG = function(id, opts){ try { return makeSVG(id); } catch (e) { return _origBirdSVG(id, opts); } };
    birdSVG = window.birdSVG;
  })();

  /* ---- 7. App updates (check for updates) ----
     Two layers, checked together from Settings -> "Check for updates":
     - WEB layer: the service worker normally applies a pushed site update on
       the SECOND launch after a push (stale-while-revalidate). The manual
       check revalidates every cached shell file NOW (ETag compare against
       GitHub Pages) and offers an instant restart when something changed.
     - APK layer: when running inside the Android shell (AndroidShell bridge
       with getAppVersion present), the latest GitHub release tag is compared
       against the installed versionName; a newer release is downloaded by the
       native side (progress via window.__updateEvent) and handed to the
       system installer. In a plain browser the APK check is skipped. */
  var UPDATE = {
    api: 'https://api.github.com/repos/ManxomeFoe/birdomania/releases/latest',
    apkUrl: 'https://github.com/ManxomeFoe/birdomania/releases/latest/download/Birdomania.apk',
    page: 'https://github.com/ManxomeFoe/birdomania/releases/latest',
    checkEveryMs: 24 * 3600 * 1000   // automatic APK checks at most once a day
  };

  // Installed APK versionName via the native bridge, or null in a browser /
  // an older shell that predates the updater.
  function nativeVersion(){
    try {
      if (window.AndroidShell && AndroidShell.getAppVersion) {
        var v = JSON.parse(AndroidShell.getAppVersion());
        if (v && v.versionName) return String(v.versionName);
      }
    } catch (e) {}
    return null;
  }

  // numeric per-component compare of "1.10" vs "v1.9" style strings
  function cmpVersions(a, b){
    var pa = String(a).replace(/^v/i, '').split('.');
    var pb = String(b).replace(/^v/i, '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }

  // Revalidate every cached shell file right now. Returns true if any file
  // actually changed (ETag / Last-Modified differs), meaning a reload would
  // start the new version immediately.
  async function refreshWebShell(){
    if (!('caches' in window) || location.protocol !== 'https:') return false;
    var changed = false;
    try {
      var names = await caches.keys();
      var name = names.filter(function(n){ return n.indexOf('birdomania-shell-') === 0; })
                      .sort().pop();
      if (!name) return false;
      var cache = await caches.open(name);
      var files = ['./', 'index.html', 'android-inject.css', 'android-inject.js'];
      for (var i = 0; i < files.length; i++) {
        try {
          var old = await cache.match(files[i]);
          // 'no-cache' bypasses the HTTP cache (GitHub Pages max-age=600) but
          // still sends conditional headers — an unchanged file costs a 304.
          var res = await fetch(files[i], { cache: 'no-cache' });
          if (!res || !res.ok || res.redirected) continue;
          var oldTag = old && (old.headers.get('etag') || old.headers.get('last-modified'));
          var newTag = res.headers.get('etag') || res.headers.get('last-modified');
          if (!old || !newTag || oldTag !== newTag) changed = true;
          await cache.put(files[i], res);
        } catch (e) {}
      }
      // Pick up a changed sw.js too (skipWaiting applies it right away).
      try {
        var reg = await navigator.serviceWorker.getRegistration();
        if (reg) reg.update();
      } catch (e) {}
    } catch (e) {}
    return changed;
  }

  // Latest GitHub release vs the installed APK. Resolves to
  // {tag, notes, current} when an update exists, else null.
  async function checkApkUpdate(){
    var cur = nativeVersion();
    if (!cur) return null;                    // not running in the Android shell
    var r = await fetch(UPDATE.api, { cache: 'no-store' });
    if (r.status === 404) return null;        // no releases published yet
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var rel = await r.json();
    var latest = rel && rel.tag_name;
    if (latest && cmpVersions(latest, cur) > 0) {
      return {
        tag: latest,
        current: cur,
        notes: String((rel && rel.body) || '').split('\n')[0].slice(0, 160)
      };
    }
    return null;
  }

  function injectUpdateSection(settingsEl){
    if (settingsEl.querySelector('.update-row')) return;
    var danger = settingsEl.querySelector('.danger-zone');
    var cur = nativeVersion();
    var row = document.createElement('div');
    row.className = 'set-row col update-row';
    row.innerHTML =
      '<div class="set-label"><div class="set-title">App updates</div>' +
      '<div class="set-desc">' +
      (cur ? 'You have Birdomania v' + esc(cur) + '. '
           : '') +
      'Checks for a newer version of the app and applies any pending website ' +
      'update immediately. Your birds and photos are untouched by updates.</div></div>' +
      '<div class="update-bar"><span></span></div>' +
      '<div class="update-status"></div>' +
      '<div class="update-actions">' +
      '<button class="btn" id="updCheck">Check for updates</button>' +
      '</div>';
    if (danger) settingsEl.insertBefore(row, danger); else settingsEl.appendChild(row);

    var statusEl = row.querySelector('.update-status');
    var bar      = row.querySelector('.update-bar');
    var fill     = row.querySelector('.update-bar > span');
    var actions  = row.querySelector('.update-actions');
    var checkBtn = row.querySelector('#updCheck');

    function extraButton(label, onTap){
      var old = row.querySelector('.update-extra');
      if (old) old.remove();
      if (!label) return;
      var b = document.createElement('button');
      b.className = 'btn update-extra';
      b.textContent = label;
      b.onclick = onTap;
      actions.appendChild(b);
    }

    function installApkUpdate(info){
      extraButton(null);
      checkBtn.disabled = true;
      bar.style.display = 'block'; fill.style.width = '0';
      statusEl.textContent = 'Downloading v' + info.tag.replace(/^v/i, '') + '…';
      window.__updateEvent = function(ev){
        if (!ev) return;
        if (ev.phase === 'progress') {
          if (isFinite(ev.pct) && ev.pct >= 0) fill.style.width = ev.pct + '%';
          statusEl.textContent = 'Downloading update… ' +
            (isFinite(ev.pct) && ev.pct >= 0 ? ev.pct + '%' : '');
        } else if (ev.phase === 'done') {
          bar.style.display = 'none';
          checkBtn.disabled = false;
          statusEl.textContent = 'Download complete — opening the installer…';
          toast('Opening the installer…');
        } else if (ev.phase === 'error') {
          bar.style.display = 'none';
          checkBtn.disabled = false;
          statusEl.textContent = 'Update failed: ' + (ev.message || 'download error') +
            '. You can retry, or download it from GitHub in a browser.';
          extraButton('Open GitHub', function(){ window.open(UPDATE.page, '_blank'); });
        }
      };
      var res = 'err:no bridge';
      try { res = AndroidShell.startUpdateDownload(UPDATE.apkUrl); } catch (e) { res = 'err:' + e.message; }
      if (String(res).indexOf('ok') !== 0) {
        bar.style.display = 'none';
        checkBtn.disabled = false;
        statusEl.textContent = 'Could not start the download (' + res + ')';
      }
    }

    checkBtn.onclick = async function(){
      checkBtn.disabled = true;
      extraButton(null);
      statusEl.textContent = 'Checking for updates…';
      var webChanged = false, apk = null, failed = false;
      try { webChanged = await refreshWebShell(); } catch (e) {}
      try { apk = await checkApkUpdate(); } catch (e) { failed = true; }
      checkBtn.disabled = false;
      if (apk) {
        statusEl.textContent = 'App update available: v' + apk.tag.replace(/^v/i, '') +
          ' (you have v' + apk.current + ').' + (apk.notes ? ' ' + apk.notes : '');
        extraButton('Download & install', function(){ installApkUpdate(apk); });
      } else if (webChanged) {
        statusEl.textContent = 'A website update was downloaded. Restart to apply it.';
        extraButton('Restart now', function(){ location.reload(); });
      } else if (failed) {
        statusEl.textContent = 'Could not reach GitHub to check for app updates.';
      } else {
        statusEl.textContent = 'Birdomania is up to date' + (cur ? ' (v' + esc(cur) + ')' : '') + '.';
      }
    };
  }

  // Automatic APK check, at most once a day, only inside the Android shell
  // (the web layer already updates itself via the service worker). Quiet
  // unless an update actually exists.
  (function autoCheckApk(){
    if (!nativeVersion()) return;
    var last = 0;
    try { last = +localStorage.getItem('birdomania:lastApkCheck') || 0; } catch (e) {}
    if (Date.now() - last < UPDATE.checkEveryMs) return;
    setTimeout(function(){
      try { localStorage.setItem('birdomania:lastApkCheck', String(Date.now())); } catch (e) {}
      checkApkUpdate().then(function(info){
        if (info) toast('Birdomania v' + info.tag.replace(/^v/i, '') +
                        ' is available — install it from Settings');
      }).catch(function(){});
    }, 5000);
  })();

  // Wrap the page's openSettings so the modal gains the theme picker + offline
  // section + update checker.
  if (typeof openSettings === 'function') {
    var orig = openSettings;
    window.openSettings = function(){
      orig.apply(this, arguments);
      var s = document.querySelector('#modal-root .settings');
      if (s) { injectThemeSection(s); injectOfflineSection(s); injectUpdateSection(s); }
    };
    var btn = document.getElementById('btnSettings');
    if (btn) btn.onclick = window.openSettings;
  }
})();
