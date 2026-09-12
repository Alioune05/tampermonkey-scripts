// ==UserScript==
// @name         YouTube Tab Sorter
// @namespace    https://github.com/Alioune05/tampermonkey-scripts
// @version      1.3.0
// @description  Track and sort your YouTube videos by duration via a floating panel
// @match        *://www.youtube.com/*
// @match        *://youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      www.youtube.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/youtube-tab-sorter.user.js
// @downloadURL  https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/youtube-tab-sorter.user.js
// @homepageURL  https://github.com/Alioune05/tampermonkey-scripts
// @supportURL   https://github.com/Alioune05/tampermonkey-scripts/issues
// @icon         https://www.youtube.com/favicon.ico
// ==/UserScript==

(function () {
  'use strict';

  // Guard against double-injection on SPA navigation
  if (document.getElementById('yts-btn')) return;

  // ---------------------------------------------------------------------------
  // Duration extraction
  // ---------------------------------------------------------------------------
  // Player metadata for the requested video, or null if the page still holds
  // the previous video's data (SPA navigation updates it asynchronously).
  function videoDetails(vid) {
    try {
      const details = window.ytInitialPlayerResponse?.videoDetails;
      if (!details) return null;
      if (vid && details.videoId && details.videoId !== vid) return null;
      return details;
    } catch (_) { return null; }
  }

  // While an ad plays, the <video> element and the progress bar describe the
  // ad, not the video: metadata is then the only trustworthy source.
  function getDuration(vid) {
    if (!isAdPlaying()) {
      const video = document.querySelector('video');
      if (video && video.duration && isFinite(video.duration)) return Math.round(video.duration);

      const el = document.querySelector('.ytp-time-duration');
      if (el && el.textContent) {
        const parts = el.textContent.trim().split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
      }
    }

    const seconds = videoDetails(vid)?.lengthSeconds;
    if (seconds) return parseInt(seconds, 10);

    return null;
  }

  function formatDuration(s) {
    if (s == null) return '?:??';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function isVideoPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
  }

  function currentVid() {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/shorts/')[1].split('/')[0] || null;
      return url.searchParams.get('v');
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const STORE_KEY    = 'yt_sorter_v1';
  const ORDER_KEY    = 'yt_sorter_order';
  const AUTOPLAY_KEY = 'yt_sorter_autoplay';
  const PANEL_KEY    = 'yt_sorter_panel_open';
  const CURSOR_KEY   = 'yt_sorter_cursor';
  const SYNC_KEY     = 'yt_sorter_sync';

  function loadStore() {
    try { return JSON.parse(GM_getValue(STORE_KEY, '{}')); } catch (_) { return {}; }
  }

  function saveStore(data) {
    GM_setValue(STORE_KEY, JSON.stringify(data));
  }

  function sortedItems(store, order) {
    return Object.values(store).sort((a, b) => {
      if (order === 'asc') {
        // Shorts first, then regular videos, each group sorted by duration asc
        const aIsShort = !!a.isShort;
        const bIsShort = !!b.isShort;
        if (aIsShort !== bIsShort) return aIsShort ? -1 : 1;
      }
      if (a.duration == null && b.duration == null) return 0;
      if (a.duration == null) return 1;
      if (b.duration == null) return -1;
      return order === 'asc' ? a.duration - b.duration : b.duration - a.duration;
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation: find where we are in the sorted list
  // ---------------------------------------------------------------------------

  // Remember the slot the current video occupies so we can resume from there
  // even after it disappears from the list.
  function saveCursor(items, vid) {
    const index = items.findIndex(v => v.vid === vid);
    if (index !== -1) GM_setValue(CURSOR_KEY, JSON.stringify({ vid, index }));
  }

  function readCursor(vid) {
    try {
      const cursor = JSON.parse(GM_getValue(CURSOR_KEY, 'null'));
      return cursor && cursor.vid === vid ? cursor.index : null;
    } catch (_) { return null; }
  }

  // Returns the slot of the current video, plus whether it is still listed.
  // A video absent from the list (already removed, or not registered yet)
  // falls back to its last known slot: without it, navigation would restart
  // at the top of the list.
  function locate(items, vid) {
    const index = items.findIndex(v => v.vid === vid);
    if (index !== -1) return { index, present: true };
    const saved = readCursor(vid);
    if (saved == null) return { index: -1, present: false };
    return { index: Math.min(saved, items.length), present: false };
  }

  function nextItem(items, vid) {
    if (items.length === 0) return null;
    const { index, present } = locate(items, vid);
    if (index === -1) return items[0];
    // When the video is gone from the list, its old slot already holds the
    // one that came after it.
    return items[present ? index + 1 : index] ?? items[0];
  }

  function prevItem(items, vid) {
    if (items.length === 0) return null;
    const { index } = locate(items, vid);
    if (index === -1) return items[items.length - 1];
    return items[index - 1] ?? items[items.length - 1];
  }

  // Parse duration + title + channel out of a (possibly partial) watch page
  function parseVideoData(html) {
    try {
      const unescape = s => s
        ?.replace(/\\u0026/g, '&').replace(/\\u0027/g, "'")
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const seconds = html.match(/"lengthSeconds":"(\d+)"/)?.[1];
      return {
        duration: seconds ? parseInt(seconds, 10) : null,
        title: unescape(html.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1]) || null,
        channel: unescape(html.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1]) || null,
      };
    } catch (_) { return { duration: null, title: null, channel: null }; }
  }

  // Simultaneous refresh requests. YouTube is HTTP/2 so this isn't capped by
  // the 6-connections-per-host limit, but going much higher risks 429s.
  const REFRESH_CONCURRENCY = 20;

  // Re-scanning the buffer on every chunk is O(n²) over a download, so only
  // retry the match once this much new text has arrived.
  const SCAN_STEP = 128 * 1024;

  // Transient failures (network, timeout, 429, 5xx) are retried with backoff.
  // A 200 without lengthSeconds means the video is gone or private, so it is
  // not retried.
  const REFRESH_RETRIES = 5;
  const RETRY_BASE_DELAY = 600;
  const RETRY_MAX_DELAY = 5000;

  const failedData = (retryable) => ({ duration: null, title: null, channel: null, retryable });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Fetch duration + title for a video ID by scraping the YouTube page.
  // The player response sits near the top of the HTML, so the request is
  // aborted as soon as the three fields are found instead of downloading
  // the whole (multi-MB) page.
  function fetchVideoData(vid) {
    return new Promise((resolve) => {
      let settled = false;
      let handle = null;
      let scanned = 0;
      const finish = (data, abort) => {
        if (settled) return;
        settled = true;
        if (abort) { try { handle?.abort?.(); } catch (_) {} }
        resolve(data);
      };
      handle = GM_xmlhttpRequest({
        method: 'GET',
        url: `https://www.youtube.com/watch?v=${vid}`,
        timeout: 20000,
        onreadystatechange: (res) => {
          if (settled || res.readyState !== 3) return;
          const text = res.responseText;
          if (!text || text.length - scanned < SCAN_STEP) return;
          scanned = text.length;
          const data = parseVideoData(text);
          if (data.duration != null && data.title && data.channel) {
            finish({ ...data, retryable: false }, true);
          }
        },
        onload: (res) => {
          const data = parseVideoData(res.responseText || '');
          finish({ ...data, retryable: data.duration == null && res.status !== 200 });
        },
        onerror:   () => finish(failedData(true)),
        ontimeout: () => finish(failedData(true)),
      });
    });
  }

  async function fetchVideoDataRetrying(vid) {
    for (let attempt = 0; ; attempt++) {
      const data = await fetchVideoData(vid);
      if (!data.retryable || attempt >= REFRESH_RETRIES) return data;
      const delay = Math.min(RETRY_BASE_DELAY * (2 ** attempt), RETRY_MAX_DELAY);
      await sleep(delay + Math.random() * 300);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync: resumable, progressive duration refresh
  // ---------------------------------------------------------------------------
  // A page load tears the script down, so the queue lives in shared storage and
  // every result is written to the store as soon as it arrives. Whichever page
  // comes next picks the queue back up where it stopped, and other tabs see the
  // durations appear live instead of waiting for the whole run.
  //
  // Shape of the shared record:
  //   { pending: [vid], total: n, failed: n, owner: tabId|null, beat: ms }
  // `pending` empty means the run is over; `owner` + `beat` are the lock that
  // keeps two tabs from fetching the same queue.
  const SYNC_COMMIT_DELAY = 400;
  const SYNC_HEARTBEAT = 2000;
  // Jittered so two tabs don't grab the same abandoned queue on the same tick.
  const SYNC_STALE = 6000 + Math.floor(Math.random() * 2000);

  const TAB_ID = Math.random().toString(36).slice(2);

  let syncUiFn = null;   // set by buildUI, refreshes the sync button
  let syncState = null;  // this tab's copy of the queue, while it owns it
  let syncRunning = false;
  let syncResults = {};  // fetched data not written to the store yet
  let commitTimer = null;

  function loadSync() {
    try {
      const state = JSON.parse(GM_getValue(SYNC_KEY, 'null'));
      return state && Array.isArray(state.pending) ? state : null;
    } catch (_) { return null; }
  }

  function syncProgress() {
    const state = loadSync();
    if (!state) return null;
    return {
      total: state.total,
      done: state.total - state.pending.length,
      failed: state.failed,
      running: state.pending.length > 0,
    };
  }

  function writeSync() {
    GM_setValue(SYNC_KEY, JSON.stringify(syncState));
    syncUiFn && syncUiFn();
  }

  // Another tab may have queued videos on top of ours; adopt them so its click
  // isn't silently dropped by our next write.
  function adoptQueuedVideos() {
    const stored = loadSync();
    if (!stored) return;
    const known = new Set(syncState.pending.concat(Object.keys(syncResults)));
    const added = stored.pending.filter(vid => !known.has(vid));
    if (added.length === 0) return;
    syncState.pending = syncState.pending.concat(added);
    syncState.total += added.length;
  }

  // Merge into a freshly read store instead of a snapshot: videos added or
  // deleted while the fetch runs (possibly from another tab) would otherwise
  // be resurrected or wiped.
  function commitSync() {
    clearTimeout(commitTimer);
    commitTimer = null;

    const results = syncResults;
    syncResults = {};
    const store = loadStore();
    for (const [vid, data] of Object.entries(results)) {
      if (!store[vid]) continue;
      if (data.duration) store[vid].duration = data.duration;
      if (data.title)    store[vid].title    = data.title;
      if (data.channel)  store[vid].channel  = data.channel;
    }
    saveStore(store);

    adoptQueuedVideos();
    const settled = new Set(Object.keys(results));
    syncState.pending = syncState.pending.filter(vid => !settled.has(vid) && store[vid]);
    writeSync();

    renderListFn && renderListFn();
    updateTotal();
  }

  function scheduleCommit() {
    if (!commitTimer) commitTimer = setTimeout(commitSync, SYNC_COMMIT_DELAY);
  }

  async function runSync() {
    if (syncRunning || !syncState || syncState.pending.length === 0) return;
    syncRunning = true;
    syncState.owner = TAB_ID;
    syncState.beat = Date.now();
    writeSync();

    const beat = setInterval(() => {
      syncState.beat = Date.now();
      writeSync();
    }, SYNC_HEARTBEAT);

    // The queue can grow mid-run, so lanes read it live rather than iterating
    // a fixed list, and the outer loop restarts them if anything was added.
    const inFlight = new Set();
    const take = () => syncState.pending.find(vid => !inFlight.has(vid) && !(vid in syncResults));

    do {
      await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, async () => {
        for (;;) {
          const vid = take();
          if (!vid) {
            if (inFlight.size === 0) return;
            await sleep(100);
            continue;
          }
          inFlight.add(vid);
          const data = await fetchVideoDataRetrying(vid);
          inFlight.delete(vid);
          syncResults[vid] = data;
          if (data.duration == null) syncState.failed++;
          scheduleCommit();
        }
      }));
      commitSync();
    } while (syncState.pending.length > 0);

    clearInterval(beat);
    syncState.owner = null;
    syncRunning = false;
    writeSync();
  }

  // Queue `vids`, merging with a run already in progress, and start fetching
  // unless another tab is on it.
  function startSync(vids) {
    const stored = loadSync();
    if (syncRunning) {
      adoptQueuedVideos();
    } else if (stored && stored.pending.length > 0) {
      syncState = stored;
    } else {
      syncState = { pending: [], total: 0, failed: 0, owner: null, beat: 0 };
    }

    const known = new Set(syncState.pending.concat(Object.keys(syncResults)));
    const added = vids.filter(vid => !known.has(vid));
    syncState.pending = syncState.pending.concat(added);
    syncState.total += added.length;
    writeSync();

    resumeSync();
  }

  // Take over a queue whose owner went away: page reloaded, or tab closed.
  function resumeSync() {
    if (syncRunning) return;
    const stored = loadSync();
    if (!stored || stored.pending.length === 0) return;
    if (stored.owner && stored.owner !== TAB_ID && Date.now() - (stored.beat || 0) < SYNC_STALE) return;
    syncState = stored;
    runSync();
  }

  // Hand the queue over immediately on navigation instead of waiting for the
  // lock to go stale, and keep the results already fetched.
  window.addEventListener('pagehide', () => {
    if (!syncRunning) return;
    syncState.owner = null;
    syncState.beat = 0;
    commitSync();
  });

  function isAdPlaying() {
    const player = document.querySelector('.html5-video-player');
    return player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
  }

  function waitForAdToEnd(callback) {
    const player = document.querySelector('.html5-video-player');
    if (!player || !isAdPlaying()) { callback(); return; }
    const observer = new MutationObserver(() => {
      if (!player.classList.contains('ad-showing') && !player.classList.contains('ad-interrupting')) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  // A pre-roll ad must not delay registration, so the video is stored right
  // away from metadata and re-read once the ad is over, in case the player
  // had not exposed its metadata yet.
  let waitingForAd = false;

  function registerAfterAd() {
    if (waitingForAd || !isAdPlaying()) return;
    waitingForAd = true;
    waitForAdToEnd(() => {
      waitingForAd = false;
      registerCurrentVideo(0);
    });
  }

  // Each fresh call supersedes the retry chain of the previous one, so several
  // navigation signals for the same page don't stack up retry loops.
  let registerRun = 0;

  function registerCurrentVideo(attempt = 0, run = ++registerRun) {
    if (run !== registerRun) return;
    if (!isVideoPage()) return;
    const vid = currentVid();
    if (!vid) return;

    registerAfterAd();

    const details = videoDetails(vid);
    const duration = getDuration(vid);
    const title = details?.title
      || document.title.replace(/ - YouTube$/, '').trim()
      || vid;
    const channel = details?.author
      || document.querySelector('#channel-name a, #owner-name a, .ytd-channel-name a')?.textContent?.trim()
      || '';

    const titleIsGeneric = !title || title === vid || title === 'YouTube';

    const store = loadStore();
    // Preserve isShort=true if already set — YouTube redirects /shorts/id to /watch?v=id
    const isShort = location.pathname.startsWith('/shorts/') || !!store[vid]?.isShort;
    // The player may not expose the duration yet: keep the known one rather
    // than nulling it, which would send the video to the end of the list
    const knownDuration = duration ?? store[vid]?.duration ?? null;
    // Don't overwrite a good title with a generic one
    if (!titleIsGeneric || !store[vid]?.title || store[vid].title === vid) {
      store[vid] = { vid, title, channel, duration: knownDuration, isShort, ts: Date.now() };
      saveStore(store);
    } else {
      store[vid].duration = knownDuration;
      store[vid].isShort = isShort;
      if (channel) store[vid].channel = channel;
      saveStore(store);
    }

    saveCursor(sortedItems(store, GM_getValue(ORDER_KEY, 'asc')), vid);
    updateDot();

    if ((duration == null || titleIsGeneric) && attempt < 15) {
      setTimeout(() => registerCurrentVideo(attempt + 1, run), 1000);
    }
  }

  // Forward declaration so registerCurrentVideo can call it before buildUI runs
  function updateDot() {
    const dot = document.getElementById('yts-dot');
    if (!dot) return;
    const vid = isVideoPage() ? currentVid() : null;
    if (!vid) {
      dot.style.background = '#555';
      dot.title = 'Pas sur une vidéo';
      return;
    }
    const inList = !!loadStore()[vid];
    dot.style.background = inList ? '#4caf50' : '#f44336';
    dot.title = inList ? 'Vidéo suivie ✓' : 'Pas dans la liste';
  }

  function updateTotal() {
    const el = document.getElementById('yts-total');
    if (!el) return;
    const items = Object.values(loadStore());
    const known = items.filter(v => v.duration != null);
    if (known.length === 0) { el.textContent = ''; return; }
    const total = known.reduce((sum, v) => sum + v.duration, 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const fmt = h > 0
      ? `${h}h ${String(m).padStart(2, '0')}m`
      : `${m}m ${String(s).padStart(2, '0')}s`;
    el.textContent = `· ${fmt} (${items.length} vidéos)`;
  }

  // ---------------------------------------------------------------------------
  // Inline styles — immune to YouTube's CSS overrides
  // ---------------------------------------------------------------------------
  const Z = '2147483647';

  const S = {
    btn: `all:unset; box-sizing:border-box; position:fixed; top:70px; right:16px; z-index:${Z};
          display:flex; align-items:center; gap:5px; padding:6px 12px; border-radius:6px;
          background:#ff0000; color:#fff; font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
          cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.4); white-space:nowrap;`,

    panel: `all:unset; box-sizing:border-box; position:fixed; top:120px; right:20px; z-index:${Z};
            width:380px; background:#0f0f0f; color:#f1f1f1; border:1px solid #333; border-radius:10px;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
            box-shadow:0 8px 28px rgba(0,0,0,0.7); overflow:hidden; display:none;`,

    header: `display:flex; align-items:center; justify-content:space-between;
             padding:12px 14px; border-bottom:1px solid #272727;`,

    title: `font-size:14px; font-weight:600; color:#f1f1f1; margin:0;`,

    closeBtn: `all:unset; cursor:pointer; color:#888; font-size:18px; line-height:1; padding:2px;`,

    controls: `display:flex; gap:8px; padding:10px 14px;`,

    sortBtnBase: `all:unset; box-sizing:border-box; flex:1; padding:8px 0; text-align:center;
                  border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;`,

    clearBtn: `all:unset; box-sizing:border-box; padding:8px 10px; border-radius:6px;
               background:#1a1a1a; color:#888; font-size:13px; cursor:pointer;`,

    list: `max-height:340px; overflow-y:auto; border-top:1px solid #272727;`,

    item: `display:flex; align-items:center; gap:10px; padding:8px 14px;
           border-bottom:1px solid #1a1a1a; text-decoration:none; color:#f1f1f1;`,

    itemCurrent: `display:flex; align-items:center; gap:10px; padding:8px 14px;
                  border-bottom:1px solid #1a1a1a; text-decoration:none; color:#f1f1f1; background:#1e1e1e;`,

    thumb: `width:48px; height:27px; border-radius:3px; object-fit:cover; flex-shrink:0; background:#272727;`,

    info: `flex:1; min-width:0; overflow:hidden;`,

    itemTitle: `font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#f1f1f1;`,

    duration: `font-size:11px; color:#aaa; margin-top:2px;`,

    durationUnknown: `font-size:11px; color:#555; margin-top:2px; font-style:italic;`,

    empty: `padding:16px; text-align:center; color:#555; font-size:12px; line-height:1.5;`,
  };

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // Inject keyframe animation (textContent = safe, no Trusted Types issue)
  // ---------------------------------------------------------------------------
  const styleTag = document.createElement('style');
  styleTag.textContent = '@keyframes yts-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(styleTag);

  // ---------------------------------------------------------------------------
  // Build UI
  // ---------------------------------------------------------------------------
  function buildUI() {
    // ── Toggle button ─────────────────────────────────────────────────────────
    const btn = document.createElement('button');
    btn.id = 'yts-btn';
    btn.setAttribute('style', S.btn);

    const btnIcon = document.createElement('img');
    btnIcon.src = 'https://www.youtube.com/favicon.ico';
    btnIcon.setAttribute('style', 'width:14px; height:14px; flex-shrink:0; vertical-align:middle;');
    btnIcon.alt = '';

    const btnLabel = document.createElement('span');
    btnLabel.textContent = 'Sort tabs';

    const btnDot = document.createElement('span');
    btnDot.id = 'yts-dot';
    btnDot.setAttribute('style', `display:inline-block; width:7px; height:7px; border-radius:50%;
      background:#555; margin-left:4px; vertical-align:middle; flex-shrink:0;`);
    btnDot.title = 'Checking...';

    btn.appendChild(btnIcon);
    btn.appendChild(btnLabel);
    btn.appendChild(btnDot);

    // ── Panel ─────────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'yts-panel';
    panel.setAttribute('style', S.panel);

    // Header
    const header = document.createElement('div');
    header.setAttribute('style', S.header);

    const headerLeft = document.createElement('div');
    headerLeft.setAttribute('style', 'display:flex;align-items:center;gap:8px;');

    const headerTitle = document.createElement('span');
    headerTitle.setAttribute('style', S.title);
    headerTitle.textContent = 'YouTube Tab Sorter';

    const headerTotal = document.createElement('span');
    headerTotal.id = 'yts-total';
    headerTotal.setAttribute('style', 'font-size:11px; color:#888; white-space:nowrap;');

    headerLeft.appendChild(headerTitle);
    headerLeft.appendChild(headerTotal);
    header.appendChild(headerLeft);

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('style', S.closeBtn);
    closeBtn.textContent = '✕';
    header.appendChild(closeBtn);

    // Controls — icon bar
    const controls = document.createElement('div');
    controls.setAttribute('style', 'display:flex; align-items:center; gap:4px; padding:8px 14px;');

    const iconBtnStyle = (active) => `all:unset; box-sizing:border-box; width:34px; height:34px;
      display:flex; align-items:center; justify-content:center; border-radius:6px; cursor:pointer;
      font-size:16px; transition:background 0.15s;
      background:${active ? '#ff0000' : '#1e1e1e'}; color:${active ? '#fff' : '#aaa'};`;

    function makeSvgIcon(pathD) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'currentColor');
      svg.style.pointerEvents = 'none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathD);
      svg.appendChild(path);
      return svg;
    }

    // ASC  = lignes croissantes + flèche vers le bas (court → long)
    const ICON_ASC  = 'M4 6h8v2H4zm0 4h12v2H4zm0 4h16v2H4zm11 4l4-4h-3v-3h-2v3h-3z';
    // DESC = lignes décroissantes + flèche vers le haut (long → court)
    const ICON_DESC = 'M4 6h16v2H4zm0 4h12v2H4zm0 4h8v2H4zm11-6l-4 4h3v3h2v-3h3z';

    const btnSort = document.createElement('button');
    btnSort.setAttribute('style', iconBtnStyle(true));
    btnSort.title = 'Plus courtes en premier';
    btnSort.appendChild(makeSvgIcon(ICON_ASC));

    const btnPause = document.createElement('button');
    btnPause.setAttribute('style', iconBtnStyle(false));
    btnPause.title = 'Pause tous les onglets';
    btnPause.appendChild(makeSvgIcon('M6 19h4V5H6v14zm8-14v14h4V5h-4z'));

    // Prev (Shift+P): go to previous video without removing current
    const btnPrev = document.createElement('button');
    btnPrev.setAttribute('style', iconBtnStyle(false));
    btnPrev.title = 'Previous (Shift+P)';
    btnPrev.appendChild(makeSvgIcon('M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z'));

    // Skip+Remove (Shift+N): go to next and remove current from list
    const btnSkipRemove = document.createElement('button');
    btnSkipRemove.setAttribute('style', iconBtnStyle(false));
    btnSkipRemove.title = 'Next & remove (Shift+N)';
    btnSkipRemove.appendChild(makeSvgIcon('M4 18l8.5-6L4 6v12zm9 0l8.5-6L13 6v12z'));

    // Skip Keep (Ctrl+N): go to next without removing current from list
    const btnSkipKeep = document.createElement('button');
    btnSkipKeep.setAttribute('style', iconBtnStyle(false));
    btnSkipKeep.title = 'Next (keep in list, Ctrl+N)';
    btnSkipKeep.appendChild(makeSvgIcon('M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'));

    const btnRefresh = document.createElement('button');
    btnRefresh.setAttribute('style', iconBtnStyle(false));
    btnRefresh.title = 'Refresh les durées';
    btnRefresh.appendChild(makeSvgIcon('M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'));

    const btnClear = document.createElement('button');
    btnClear.setAttribute('style', iconBtnStyle(false));
    btnClear.title = 'Vider la liste';
    btnClear.appendChild(makeSvgIcon('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'));

    const btnUpdate = document.createElement('button');
    btnUpdate.setAttribute('style', iconBtnStyle(false));
    btnUpdate.title = 'Mettre à jour le script';
    btnUpdate.appendChild(makeSvgIcon('M5 20h14v-2H5v2zm7-18L5.33 9h4.84v4h3.66V9h4.84z'));

    let autoplayEnabled = GM_getValue(AUTOPLAY_KEY, true);
    const btnAutoplay = document.createElement('button');
    btnAutoplay.setAttribute('style', iconBtnStyle(autoplayEnabled));
    btnAutoplay.title = autoplayEnabled ? 'Autoplay activé' : 'Autoplay désactivé';
    // Skip-next icon
    btnAutoplay.appendChild(makeSvgIcon('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'));

    controls.appendChild(btnSort);

    // Spacer
    const spacer = document.createElement('div');
    spacer.setAttribute('style', 'flex:1;');
    controls.appendChild(spacer);

    controls.appendChild(btnAutoplay);
    controls.appendChild(btnPrev);
    controls.appendChild(btnSkipRemove);
    controls.appendChild(btnSkipKeep);
    controls.appendChild(btnPause);
    controls.appendChild(btnRefresh);
    controls.appendChild(btnClear);
    controls.appendChild(btnUpdate);

    // Keep pauseRow as empty placeholder (referenced in assembly below)
    const pauseRow = document.createElement('div');

    // Search bar
    const searchRow = document.createElement('div');
    searchRow.setAttribute('style', 'padding:0 14px 10px;');
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 Rechercher une vidéo...';
    searchInput.setAttribute('style', `all:unset; box-sizing:border-box; width:100%; padding:7px 10px;
      border-radius:6px; background:#1a1a1a; color:#f1f1f1; font-size:12px;
      border:1px solid #333; outline:none;`);
    searchRow.appendChild(searchInput);

    // List
    const listEl = document.createElement('div');
    listEl.setAttribute('style', S.list);

    // Assemble
    panel.appendChild(header);
    panel.appendChild(controls);
    panel.appendChild(searchRow);
    panel.appendChild(listEl);

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // ── State & events ────────────────────────────────────────────────────────
    let order = GM_getValue(ORDER_KEY, 'asc');
    let searchQuery = '';

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.toLowerCase().trim();
      renderList();
    });

    function updateSortButtons() {
      btnSort.replaceChildren(makeSvgIcon(order === 'asc' ? ICON_ASC : ICON_DESC));
      btnSort.title = order === 'asc' ? 'Plus courtes en premier' : 'Plus longues en premier';
    }

    function renderList(scrollToCurrent = false) {
      const store = loadStore();
      const vid = currentVid();
      const items = sortedItems(store, order).filter(v =>
        !searchQuery ||
        v.title.toLowerCase().includes(searchQuery) ||
        (v.channel || '').toLowerCase().includes(searchQuery)
      );

      listEl.textContent = '';
      updateTotal();
      let currentItemEl = null;

      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.setAttribute('style', S.empty);
        empty.textContent = 'No videos tracked yet. Watch a YouTube video to track it.';
        listEl.appendChild(empty);
        return;
      }

      for (const v of items) {
        const isCurrent = v.vid === vid;
        const a = document.createElement('a');
        a.href = `https://www.youtube.com/watch?v=${v.vid}`;
        a.setAttribute('style', isCurrent ? S.itemCurrent : S.item);
        a.addEventListener('mouseover', () => { a.style.background = '#1e1e1e'; });
        a.addEventListener('mouseout',  () => { a.style.background = isCurrent ? '#1e1e1e' : ''; });

        const img = document.createElement('img');
        img.src = `https://i.ytimg.com/vi/${v.vid}/default.jpg`;
        img.setAttribute('style', S.thumb);
        img.alt = '';

        const info = document.createElement('div');
        info.setAttribute('style', S.info);

        const titleEl = document.createElement('div');
        titleEl.setAttribute('style', S.itemTitle);
        titleEl.textContent = v.title;

        const durEl = document.createElement('div');
        durEl.setAttribute('style', v.duration == null ? S.durationUnknown : S.duration);
        durEl.textContent = formatDuration(v.duration);

        const delBtn = document.createElement('button');
        delBtn.setAttribute('style', `all:unset; box-sizing:border-box; flex-shrink:0; padding:4px 7px;
          border-radius:4px; color:#555; font-size:14px; cursor:pointer; line-height:1;`);
        delBtn.textContent = '✕';
        delBtn.title = 'Remove from list';
        delBtn.addEventListener('mouseover', () => { delBtn.style.color = '#f1f1f1'; delBtn.style.background = '#333'; });
        delBtn.addEventListener('mouseout',  () => { delBtn.style.color = '#555';   delBtn.style.background = ''; });
        delBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const store = loadStore();
          delete store[v.vid];
          saveStore(store);
          renderList();
        });

        info.appendChild(titleEl);
        if (v.channel) {
          const channelEl = document.createElement('div');
          channelEl.setAttribute('style', 'font-size:10px; color:#666; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;');
          channelEl.textContent = v.channel;
          info.appendChild(channelEl);
        }
        info.appendChild(durEl);
        a.appendChild(img);
        a.appendChild(info);
        a.appendChild(delBtn);
        listEl.appendChild(a);
        if (isCurrent) currentItemEl = a;
      }

      if (scrollToCurrent && currentItemEl) {
        requestAnimationFrame(() => {
          listEl.scrollTop = currentItemEl.offsetTop - listEl.offsetTop;
        });
      }
    }

    btn.addEventListener('click', () => {
      GM_setValue(PANEL_KEY, true);
      panel.style.display = 'block';
      btn.style.display   = 'none';
      renderList(true);
    });

    closeBtn.addEventListener('click', () => {
      GM_setValue(PANEL_KEY, false);
      panel.style.display = 'none';
      btn.style.display   = 'flex';
    });

    btnSort.addEventListener('click', () => {
      order = order === 'asc' ? 'desc' : 'asc';
      GM_setValue(ORDER_KEY, order);
      updateSortButtons();
      renderList();
    });

    btnClear.addEventListener('click', () => {
      saveStore({});
      renderList();
    });

    btnPrev.addEventListener('click', () => {
      const vid = currentVid();
      if (!vid) return;
      const store = loadStore();
      const items = sortedItems(store, GM_getValue(ORDER_KEY, 'asc'));
      const prev = prevItem(items, vid);
      if (prev && prev.vid !== vid) goToVideo(prev.vid);
    });

    btnSkipRemove.addEventListener('click', () => {
      const vid = currentVid();
      if (!vid) return;
      const store = loadStore();
      const items = sortedItems(store, GM_getValue(ORDER_KEY, 'asc'));
      const next = nextItem(items, vid);
      delete store[vid];
      saveStore(store);
      if (next && next.vid !== vid) goToVideo(next.vid);
    });

    btnSkipKeep.addEventListener('click', () => {
      const vid = currentVid();
      if (!vid) return;
      const store = loadStore();
      const items = sortedItems(store, GM_getValue(ORDER_KEY, 'asc'));
      const next = nextItem(items, vid);
      if (next && next.vid !== vid) goToVideo(next.vid);
    });

    btnPause.addEventListener('click', () => {
      GM_setValue('yt_sorter_pause', Date.now());
      document.querySelector('video')?.pause();
    });

    const REFRESH_TITLE = 'Refresh les durées (shift = tout refetch)';
    btnRefresh.title = REFRESH_TITLE;

    // Reflects the shared queue, so the spinner and the counter survive a page
    // load and show what another tab is fetching.
    function updateRefreshUi() {
      const svg = btnRefresh.querySelector('svg');
      const progress = syncProgress();
      if (progress && progress.running) {
        if (svg) svg.style.animation = 'yts-spin 0.8s linear infinite';
        btnRefresh.title = `Sync ${progress.done}/${progress.total}`;
        return;
      }
      if (svg) svg.style.animation = '';
      btnRefresh.title = progress && progress.failed
        ? `${progress.failed} échec(s) : reclique pour réessayer`
        : REFRESH_TITLE;
    }

    btnRefresh.addEventListener('click', (e) => {
      const store = loadStore();
      const force = e.shiftKey;
      const vids = Object.keys(store).filter(vid => {
        if (force) return true;
        const v = store[vid];
        return v.duration == null || !v.title || v.title === vid || !v.channel;
      });

      if (vids.length === 0) { renderList(); return; }
      startSync(vids);
    });

    btnUpdate.addEventListener('click', () => {
      window.open('https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/main/youtube-tab-sorter.user.js', '_blank');
    });

    btnAutoplay.addEventListener('click', () => {
      autoplayEnabled = !autoplayEnabled;
      GM_setValue(AUTOPLAY_KEY, autoplayEnabled);
      btnAutoplay.setAttribute('style', iconBtnStyle(autoplayEnabled));
      btnAutoplay.title = autoplayEnabled ? 'Autoplay activé' : 'Autoplay désactivé';
    });

    // Escape key closes the panel.
    // In fullscreen the browser exits fullscreen first — re-enter it so only the panel closes.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && GM_getValue(PANEL_KEY, false)) {
        GM_setValue(PANEL_KEY, false);
        panel.style.display = 'none';
        btn.style.display = 'flex';
        if (document.fullscreenElement) {
          document.addEventListener('fullscreenchange', function reenter() {
            document.removeEventListener('fullscreenchange', reenter);
            if (!document.fullscreenElement) {
              document.querySelector('.ytp-fullscreen-button')?.click();
            }
          });
        }
      }
    }, true);

    // Restore panel state from previous navigation
    if (GM_getValue(PANEL_KEY, false)) {
      panel.style.display = 'block';
      btn.style.display   = 'none';
      renderList(true);
    }

    renderListFn = renderList;
    syncUiFn = updateRefreshUi;
    updateRefreshUi();
  }

  // ---------------------------------------------------------------------------
  // Listen for pause signal from any tab
  // ---------------------------------------------------------------------------
  GM_addValueChangeListener('yt_sorter_pause', () => {
    document.querySelector('video')?.pause();
  });

  // ---------------------------------------------------------------------------
  // Mirror what the tab running the sync writes, entry by entry
  // ---------------------------------------------------------------------------
  GM_addValueChangeListener(STORE_KEY, (key, oldValue, newValue, remote) => {
    if (!remote) return;
    renderListFn && renderListFn();
    updateTotal();
    updateDot();
  });

  GM_addValueChangeListener(SYNC_KEY, (key, oldValue, newValue, remote) => {
    if (remote) syncUiFn && syncUiFn();
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  // Assigning location.href reloads the whole page, which kills an in-flight
  // sync. YouTube's own SPA navigation keeps the script (and the sync) alive,
  // so it is asked first; if the URL hasn't changed shortly after, the internal
  // event was ignored and a plain reload takes over.
  const SPA_NAV_TIMEOUT = 900;

  function goToVideo(vid) {
    const url = `/watch?v=${vid}`;
    const app = document.querySelector('ytd-app');
    if (!app) { location.href = url; return; }
    const from = location.href;
    try {
      app.dispatchEvent(new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            watchEndpoint: { videoId: vid },
            commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH' } },
          },
        },
      }));
    } catch (_) {
      location.href = url;
      return;
    }
    // A URL that moved elsewhere means the user navigated meanwhile: leave it.
    setTimeout(() => { if (location.href === from) location.href = url; }, SPA_NAV_TIMEOUT);
  }

  // ---------------------------------------------------------------------------
  // Autoplay next: when video ends, remove it and navigate to the next one
  // ---------------------------------------------------------------------------
  // The element is tracked instead of a boolean: YouTube can swap the <video>
  // on navigation, and hover previews on the home page use their own element
  // whose 'ended' must not trigger navigation.
  let endedListenerTarget = null;

  function attachEndedListener() {
    if (!isVideoPage()) return;
    const video = document.querySelector('video');
    if (!video || video === endedListenerTarget) return;
    endedListenerTarget = video;

    video.addEventListener('ended', () => {
      if (!GM_getValue(AUTOPLAY_KEY, true)) return;

      const vid = currentVid();
      if (!vid) return;

      const store = loadStore();
      const order = GM_getValue(ORDER_KEY, 'asc');
      const items = sortedItems(store, order);
      const next = nextItem(items, vid); // retour au début si dernière

      delete store[vid];
      saveStore(store);

      if (next && next.vid !== vid) {
        goToVideo(next.vid);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Init + SPA navigation
  // ---------------------------------------------------------------------------
  let uiBtn = null, uiPanel = null, renderListFn = null;

  function attachUI() {
    if (uiBtn && !document.body.contains(uiBtn)) document.body.appendChild(uiBtn);
    if (uiPanel && !document.body.contains(uiPanel)) document.body.appendChild(uiPanel);
    const open = GM_getValue(PANEL_KEY, false);
    if (uiPanel) uiPanel.style.display = open ? 'block' : 'none';
    if (uiBtn) uiBtn.style.display = open ? 'none' : 'flex';
  }

  buildUI();
  uiBtn   = document.getElementById('yts-btn');
  uiPanel = document.getElementById('yts-panel');

  function onPage() {
    attachUI();
    registerCurrentVideo();
    attachEndedListener();
    resumeSync();
    // Slight delay to let registerCurrentVideo save first
    setTimeout(() => {
      updateDot();
      // Re-render and scroll to current video if panel is open
      if (GM_getValue(PANEL_KEY, false)) {
        renderListFn && renderListFn(true);
      }
    }, 500);
  }

  onPage();

  // yt-navigate-finish covers YouTube's own SPA navigation, but it is missed
  // when the script loads while a navigation is already in flight, and it does
  // not always fire on back/forward. Polling the URL catches the rest.
  document.addEventListener('yt-navigate-finish', onPage);
  window.addEventListener('popstate', onPage);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPage();
      return;
    }
    // The button stays on every YouTube page, so put it back whenever YouTube
    // wipes the part of the DOM it lives in.
    if (uiBtn && !document.body.contains(uiBtn)) attachUI();
    // Also covers the tab that owned the queue being closed mid-sync.
    resumeSync();
  }, 1000);

  // ---------------------------------------------------------------------------
  // Shortcut: Shift+N → skip to next video and remove current from list
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'N') {
      const vid = currentVid();
      if (!vid) return;

      const store = loadStore();
      const order = GM_getValue(ORDER_KEY, 'asc');
      const items = sortedItems(store, order);
      const next = nextItem(items, vid); // retour au début si dernière

      delete store[vid];
      saveStore(store);

      if (next && next.vid !== vid) {
        goToVideo(next.vid);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Shortcut: Ctrl+N → skip to next video WITHOUT removing current from list
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') {
      const vid = currentVid();
      if (!vid) return;

      const store = loadStore();
      const order = GM_getValue(ORDER_KEY, 'asc');
      const items = sortedItems(store, order);
      const next = nextItem(items, vid);

      if (next && next.vid !== vid) {
        goToVideo(next.vid);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Shortcut: Shift+P → go to previous video without removing current from list
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'P') {
      const vid = currentVid();
      if (!vid) return;

      const store = loadStore();
      const order = GM_getValue(ORDER_KEY, 'asc');
      const items = sortedItems(store, order);
      const prev = prevItem(items, vid);

      if (prev && prev.vid !== vid) {
        goToVideo(prev.vid);
      }
    }
  });

})();
