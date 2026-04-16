// ==UserScript==
// @name         YouTube Tab Sorter
// @namespace    https://github.com/Alioune05/tampermonkey-scripts
// @version      1.0.3
// @description  Track and sort your YouTube videos by duration via a floating panel
// @match        *://www.youtube.com/watch*
// @match        *://www.youtube.com/shorts/*
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
  function getDuration() {
    const video = document.querySelector('video');
    if (video && video.duration && isFinite(video.duration)) return Math.round(video.duration);

    const el = document.querySelector('.ytp-time-duration');
    if (el && el.textContent) {
      const parts = el.textContent.trim().split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }

    try {
      const seconds = window.ytInitialPlayerResponse?.videoDetails?.lengthSeconds;
      if (seconds) return parseInt(seconds, 10);
    } catch (_) {}

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

  // Fetch duration + title for a video ID by scraping the YouTube page
  function fetchVideoData(vid) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://www.youtube.com/watch?v=${vid}`,
        onload: (res) => {
          try {
            const seconds = res.responseText.match(/"lengthSeconds":"(\d+)"/)?.[1];
            const unescape = s => s
              ?.replace(/\\u0026/g, '&').replace(/\\u0027/g, "'")
              .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            const title   = unescape(res.responseText.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1]);
            const channel = unescape(res.responseText.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1]);
            resolve({
              duration: seconds ? parseInt(seconds, 10) : null,
              title: title || null,
              channel: channel || null,
            });
          } catch (_) { resolve({ duration: null, title: null }); }
        },
        onerror: () => resolve({ duration: null, title: null }),
      });
    });
  }

  function isAdPlaying() {
    const player = document.querySelector('.html5-video-player');
    return player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
  }

  function waitForAdToEnd(callback) {
    const player = document.querySelector('.html5-video-player');
    if (!player) { callback(); return; }
    const observer = new MutationObserver(() => {
      if (!player.classList.contains('ad-showing') && !player.classList.contains('ad-interrupting')) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  function registerCurrentVideo(attempt = 0) {
    const vid = currentVid();
    if (!vid) return;

    // Wait for ad to finish before reading duration
    if (isAdPlaying()) {
      waitForAdToEnd(() => registerCurrentVideo(0));
      return;
    }

    const duration = getDuration();
    const title = window.ytInitialPlayerResponse?.videoDetails?.title
      || document.title.replace(/ - YouTube$/, '').trim()
      || vid;
    const channel = window.ytInitialPlayerResponse?.videoDetails?.author
      || document.querySelector('#channel-name a, #owner-name a, .ytd-channel-name a')?.textContent?.trim()
      || '';

    const titleIsGeneric = !title || title === vid || title === 'YouTube';

    const store = loadStore();
    // Preserve isShort=true if already set — YouTube redirects /shorts/id to /watch?v=id
    const isShort = location.pathname.startsWith('/shorts/') || !!store[vid]?.isShort;
    // Don't overwrite a good title with a generic one
    if (!titleIsGeneric || !store[vid]?.title || store[vid].title === vid) {
      store[vid] = { vid, title, channel, duration, isShort, ts: Date.now() };
      saveStore(store);
    } else {
      store[vid].duration = duration;
      store[vid].isShort = isShort;
      if (channel) store[vid].channel = channel;
      saveStore(store);
    }

    if ((duration == null || titleIsGeneric) && attempt < 15) {
      setTimeout(() => registerCurrentVideo(attempt + 1), 1000);
    } else {
      updateDot();
    }
  }

  // Forward declaration so registerCurrentVideo can call it before buildUI runs
  function updateDot() {
    const dot = document.getElementById('yts-dot');
    if (!dot) return;
    const vid = currentVid();
    const inList = vid && !!loadStore()[vid];
    dot.style.background = inList ? '#4caf50' : '#f44336';
    dot.title = inList ? 'Vidéo suivie ✓' : 'Pas dans la liste — recharge si besoin';
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
            width:360px; background:#0f0f0f; color:#f1f1f1; border:1px solid #333; border-radius:10px;
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
      panel.style.display = 'block';
      btn.style.display   = 'none';
      renderList(true);
    });

    closeBtn.addEventListener('click', () => {
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

    btnSkipRemove.addEventListener('click', () => {
      const vid = currentVid();
      if (!vid) return;
      const store = loadStore();
      const items = sortedItems(store, GM_getValue(ORDER_KEY, 'asc'));
      const currentIndex = items.findIndex(v => v.vid === vid);
      const next = items[currentIndex + 1] ?? items[0];
      delete store[vid];
      saveStore(store);
      if (next && next.vid !== vid) location.href = `https://www.youtube.com/watch?v=${next.vid}`;
    });

    btnSkipKeep.addEventListener('click', () => {
      const vid = currentVid();
      if (!vid) return;
      const store = loadStore();
      const items = sortedItems(store, GM_getValue(ORDER_KEY, 'asc'));
      const currentIndex = items.findIndex(v => v.vid === vid);
      const next = items[currentIndex + 1] ?? items[0];
      if (next && next.vid !== vid) location.href = `https://www.youtube.com/watch?v=${next.vid}`;
    });

    btnPause.addEventListener('click', () => {
      GM_setValue('yt_sorter_pause', Date.now());
      document.querySelector('video')?.pause();
    });

    btnRefresh.addEventListener('click', async () => {
      const svg = btnRefresh.querySelector('svg');
      if (svg) svg.style.animation = 'yts-spin 0.8s linear infinite';
      btnRefresh.style.pointerEvents = 'none';

      const store = loadStore();
      const vids = Object.keys(store);

      for (const vid of vids) {
        const data = await fetchVideoData(vid);
        if (data.duration) store[vid].duration = data.duration;
        if (data.title)    store[vid].title    = data.title;
        if (data.channel)  store[vid].channel  = data.channel;
      }

      saveStore(store);
      renderList();
      if (svg) svg.style.animation = '';
      btnRefresh.style.pointerEvents = '';
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
  }

  // ---------------------------------------------------------------------------
  // Listen for pause signal from any tab
  // ---------------------------------------------------------------------------
  GM_addValueChangeListener('yt_sorter_pause', () => {
    document.querySelector('video')?.pause();
  });

  // ---------------------------------------------------------------------------
  // Autoplay next: when video ends, remove it and navigate to the next one
  // ---------------------------------------------------------------------------
  let endedListenerAttached = false;

  function attachEndedListener() {
    const video = document.querySelector('video');
    if (!video || endedListenerAttached) return;
    endedListenerAttached = true;

    video.addEventListener('ended', () => {
      if (!GM_getValue(AUTOPLAY_KEY, true)) return;

      const vid = currentVid();
      if (!vid) return;

      const store = loadStore();
      const order = GM_getValue(ORDER_KEY, 'asc');
      const items = sortedItems(store, order);
      const currentIndex = items.findIndex(v => v.vid === vid);
      const next = items[currentIndex + 1] ?? items[0]; // retour au début si dernière

      delete store[vid];
      saveStore(store);

      if (next && next.vid !== vid) {
        location.href = `https://www.youtube.com/watch?v=${next.vid}`;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Init + SPA navigation
  // ---------------------------------------------------------------------------
  let uiBtn = null, uiPanel = null;

  function attachUI() {
    if (uiBtn && !document.body.contains(uiBtn)) document.body.appendChild(uiBtn);
    if (uiPanel && !document.body.contains(uiPanel)) document.body.appendChild(uiPanel);
  }

  buildUI();
  uiBtn   = document.getElementById('yts-btn');
  uiPanel = document.getElementById('yts-panel');
  registerCurrentVideo();
  attachEndedListener();
  updateDot();

  document.addEventListener('yt-navigate-finish', () => {
    endedListenerAttached = false;
    attachUI();
    registerCurrentVideo();
    attachEndedListener();
    // Slight delay to let registerCurrentVideo save first
    setTimeout(updateDot, 500);
  });

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
      const currentIndex = items.findIndex(v => v.vid === vid);
      const next = items[currentIndex + 1] ?? items[0]; // retour au début si dernière

      delete store[vid];
      saveStore(store);

      if (next && next.vid !== vid) {
        location.href = `https://www.youtube.com/watch?v=${next.vid}`;
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
      const currentIndex = items.findIndex(v => v.vid === vid);
      const next = items[currentIndex + 1] ?? items[0];

      if (next && next.vid !== vid) {
        location.href = `https://www.youtube.com/watch?v=${next.vid}`;
      }
    }
  });

})();
