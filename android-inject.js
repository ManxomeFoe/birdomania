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
    }
  } catch (e) {}

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
    function pump(){
      while (active < MAX && queue.length) {
        var job = queue.shift();
        active++;
        job().then(pump, pump);
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

  // Forget previous failures so images retry on this launch.
  (function sweepNegativeCache(){
    try {
      var changed = false, k;
      for (k in state.wikiCache) {
        if (state.wikiCache[k] && state.wikiCache[k].ok === false) { delete state.wikiCache[k]; changed = true; }
      }
      for (k in state.galleryCache) {
        if (state.galleryCache[k] && state.galleryCache[k].ok === false) { delete state.galleryCache[k]; changed = true; }
      }
      if (changed) { save(); if (window.render) render(); }
    } catch (e) {}
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

  async function downloadOfflineImages(onProgress){
    var ids = Object.keys(BIRDS);
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
      '<div class="set-desc">Download bird photos so they stay available without a connection. ' +
      'Photos are fetched from Wikipedia and stored on your device.</div></div>' +
      '<div class="offline-bar"><span></span></div>' +
      '<div class="offline-status"></div>' +
      '<div class="offline-actions">' +
      '<button class="btn" id="offDownload">Download images for offline use</button>' +
      '<button class="btn ghost" id="offRemove">Remove offline images</button>' +
      '</div>';
    if (danger) settingsEl.insertBefore(row, danger); else settingsEl.appendChild(row);

    var statusEl = row.querySelector('.offline-status');
    var bar  = row.querySelector('.offline-bar');
    var fill = row.querySelector('.offline-bar > span');
    var dl   = row.querySelector('#offDownload');
    var rm   = row.querySelector('#offRemove');

    function refresh(){
      var c = offlineCount();
      statusEl.textContent = c > 0
        ? (c + ' bird image' + (c === 1 ? '' : 's') + ' saved for offline use.')
        : 'No images downloaded yet.';
      rm.style.display = c > 0 ? '' : 'none';
    }
    refresh();

    dl.onclick = async function(){
      dl.disabled = true; rm.disabled = true;
      bar.style.display = 'block'; dl.textContent = 'Downloading…';
      try {
        await downloadOfflineImages(function(done, total){
          fill.style.width = Math.round(done / total * 100) + '%';
          statusEl.textContent = 'Downloading… ' + done + ' / ' + total;
        });
        toast('Offline images ready (' + offlineCount() + ' saved)');
        render();
      } catch (e) {
        toast('Download finished with some errors');
      }
      dl.disabled = false; rm.disabled = false;
      dl.textContent = 'Download images for offline use';
      bar.style.display = 'none'; fill.style.width = '0';
      refresh();
    };

    rm.onclick = async function(){
      rm.disabled = true; dl.disabled = true;
      await removeOfflineImages();
      toast('Offline images removed');
      refresh();
      dl.disabled = false; rm.disabled = false;
    };
  }

  // Wrap the page's openSettings so the modal gains the offline section.
  if (typeof openSettings === 'function') {
    var orig = openSettings;
    window.openSettings = function(){
      orig.apply(this, arguments);
      var s = document.querySelector('#modal-root .settings');
      if (s) injectOfflineSection(s);
    };
    var btn = document.getElementById('btnSettings');
    if (btn) btn.onclick = window.openSettings;
  }
})();
