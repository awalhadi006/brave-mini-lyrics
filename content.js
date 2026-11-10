// Brave Mini Lyrics - content script
// Hanya berjalan di frame utama YouTube, bukan di iframe tersembunyi.
if (window === window.top) {
    'use strict';

    const Core = globalThis.BMLCore;
    const Kana = globalThis.BMLKana;
    if (!Core) {
        console.error('Brave Mini Lyrics: lib/lrc.js belum termuat.');
    } else {
        run();
    }

    function run() {
        const PIP_CSS_URL = chrome.runtime.getURL('pip.css');
        const STORAGE_PREFIX = 'bml:v2:video:';
        const SETTINGS_KEY = 'bml:v2:settings';
        const INDEX_KEY = 'bml:v2:index';
        const MIGRATION_KEY = 'bml:v2:migrated';
        const LEGACY_PREFIX = 'bml_data_';
        const MAX_VIDEOS = 200;
        const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
        const SEARCH_TIMEOUT_MS = 8000;
        const MAX_GOOGLE_CHARS = 3500;
        const DEFAULT_SETTINGS = {
            fontScale: 1,
            latinMode: false,
            theme: 'dark',
            opacity: 0.62,
            pipBounds: null
        };

        let pipWindow = null;
        let parsedLyrics = [];
        let lineElements = [];
        let videoElement = null;
        let currentHighlightIndex = -1;
        let isSyncedLyrics = false;
        let lyricsTimeOffset = 0;
        let settings = Object.assign({}, DEFAULT_SETTINGS);
        let menuOpen = false;
        let menuArmed = false;
        let menuHoverTimer = null;
        let autoScrollPausedUntil = 0;
        let isAutoScrolling = false;
        let scrollResetTimer = null;
        let toastTimer = null;
        let pageToastTimer = null;
        let loadToken = 0;
        let activeAbort = null;
        let searchStopRequested = false;
        let currentVideoData = { offset: 0, manualData: null, autoData: null, autoCachedAt: 0 };
        let lastLoadedVideoId = null;
        let pendingVideoId = null;
        let pendingVideoTimer = null;
        let videoWatchTimer = null;
        let rafId = null;
        let boundVideoElement = null;
        let latinState = createLatinState();
        let tapState = null;
        let pipBoundsSaveTimer = null;

        const kuroshiroPromise = { current: null };

        // ==========================================
        // UTIL
        // ==========================================
        const escapeHtml = Core.escapeHtml;

        function createLatinState() {
            return { original: [], latin: [], mode: false, done: false, busy: false, key: null };
        }

        function byId(id) {
            return pipWindow ? pipWindow.document.getElementById(id) : null;
        }

        function getVideoId() {
            // URL paling cepat berubah saat navigasi SPA YouTube. Atribut
            // ytd-watch-flexy[video-id] bisa masih berisi video lama ~1 detik,
            // jadi jadikan fallback saja.
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('v')) return urlParams.get('v');
            if (window.location.pathname.startsWith('/shorts/')) {
                return window.location.pathname.split('/')[2];
            }
            const watchFlexy = document.querySelector('ytd-watch-flexy');
            if (watchFlexy && watchFlexy.hasAttribute('video-id')) {
                return watchFlexy.getAttribute('video-id');
            }
            return null;
        }

        function getVideoElement() {
            return (
                document.querySelector('#movie_player video') ||
                document.querySelector('video[src]') ||
                null
            );
        }

        // ==========================================
        // PENYIMPANAN (chrome.storage.local)
        // ==========================================
        async function getVideoData(videoId) {
            const defaults = {
                offset: 0,
                manualData: null,
                autoData: null,
                autoCachedAt: 0,
                latinData: null
            };
            if (!videoId) return defaults;
            try {
                const key = STORAGE_PREFIX + videoId;
                const obj = await chrome.storage.local.get(key);
                return Object.assign(defaults, obj[key] || {});
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal membaca storage', error);
                return defaults;
            }
        }

        async function saveVideoData(videoId, patch) {
            if (!videoId) return;
            try {
                const key = STORAGE_PREFIX + videoId;
                const obj = await chrome.storage.local.get(key);
                const data = Object.assign(
                    {
                        offset: 0,
                        manualData: null,
                        autoData: null,
                        autoCachedAt: 0,
                        latinData: null
                    },
                    obj[key] || {},
                    patch,
                    { lastUpdated: Date.now() }
                );
                await chrome.storage.local.set({ [key]: data });
                if (videoId === getVideoId()) currentVideoData = data;
                await touchIndex(videoId);
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal menyimpan storage', error);
            }
        }

        async function touchIndex(videoId) {
            try {
                const obj = await chrome.storage.local.get(INDEX_KEY);
                const index = obj[INDEX_KEY] || {};
                index[videoId] = Date.now();

                const ids = Object.keys(index);
                if (ids.length > MAX_VIDEOS) {
                    ids.sort((a, b) => index[a] - index[b]);
                    const remove = ids.slice(0, ids.length - MAX_VIDEOS);
                    await chrome.storage.local.remove(remove.map((id) => STORAGE_PREFIX + id));
                    remove.forEach((id) => delete index[id]);
                }

                await chrome.storage.local.set({ [INDEX_KEY]: index });
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal memperbarui index', error);
            }
        }

        async function loadSettings() {
            try {
                const obj = await chrome.storage.local.get(SETTINGS_KEY);
                settings = Object.assign({}, DEFAULT_SETTINGS, obj[SETTINGS_KEY] || {});
                settings.fontScale = Math.min(1.8, Math.max(0.7, Number(settings.fontScale) || 1));
                settings.latinMode = Boolean(settings.latinMode);
                settings.theme = settings.theme === 'light' ? 'light' : 'dark';
                settings.opacity = Math.min(1, Math.max(0.3, Number(settings.opacity) || DEFAULT_SETTINGS.opacity));

                const bounds = settings.pipBounds;
                const validBounds =
                    bounds &&
                    isFinite(bounds.width) &&
                    isFinite(bounds.height) &&
                    isFinite(bounds.left) &&
                    isFinite(bounds.top) &&
                    bounds.width >= 240 &&
                    bounds.height >= 240;
                settings.pipBounds = validBounds
                    ? {
                          width: Math.round(bounds.width),
                          height: Math.round(bounds.height),
                          left: Math.round(bounds.left),
                          top: Math.round(bounds.top)
                      }
                    : null;
            } catch (error) {
                settings = Object.assign({}, DEFAULT_SETTINGS);
            }
        }

        async function saveSettings(patch) {
            settings = Object.assign({}, settings, patch);
            try {
                await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal menyimpan pengaturan', error);
            }
        }

        let migrationPromise = null;
        function migrateLegacyStorage() {
            if (migrationPromise) return migrationPromise;
            migrationPromise = (async () => {
                try {
                    const flag = await chrome.storage.local.get(MIGRATION_KEY);
                    if (flag[MIGRATION_KEY]) return;

                    const legacyKeys = [];
                    for (let i = 0; i < localStorage.length; i += 1) {
                        const key = localStorage.key(i);
                        if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
                    }

                    for (const key of legacyKeys) {
                        try {
                            const old = JSON.parse(localStorage.getItem(key));
                            const videoId = key.slice(LEGACY_PREFIX.length);
                            await saveVideoData(videoId, {
                                offset: Number(old.offset) || 0,
                                manualData: old.manualData || null
                            });
                            localStorage.removeItem(key);
                        } catch (error) {
                            // entri rusak: abaikan, jangan gagalkan migrasi
                        }
                    }

                    await chrome.storage.local.set({ [MIGRATION_KEY]: true });
                } catch (error) {
                    console.warn('Brave Mini Lyrics: migrasi storage gagal', error);
                }
            })();
            return migrationPromise;
        }

        // ==========================================
        // METADATA VIDEO
        // ==========================================
        function getPlayerDetails() {
            try {
                const app = document.querySelector('ytd-app');
                const raw = app && (app.__data || app.data);
                const appData = raw && (raw.data || raw);
                if (!appData) return null;

                if (
                    appData.player &&
                    appData.player.args &&
                    appData.player.args.raw_player_response
                ) {
                    return appData.player.args.raw_player_response.videoDetails || null;
                }
                if (appData.playerResponse) {
                    return appData.playerResponse.videoDetails || null;
                }
            } catch (error) {
                // struktur data YouTube bisa berubah: abaikan
            }
            return null;
        }

        function getVideoMetadata() {
            let title = '';
            let artist = '';
            let duration = 0;

            try {
                const details = getPlayerDetails();
                const currentId = getVideoId();
                // Abaikan player response milik video sebelumnya.
                const fresh = details && (!details.videoId || !currentId || details.videoId === currentId);

                if (fresh) {
                    title = details.title || '';
                    artist = details.author || '';
                    duration = Number(details.lengthSeconds) || 0;
                }
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal membaca metadata ytd-app', error);
            }

            if (!title) {
                const titleElement = document.querySelector(
                    'h1.ytd-watch-metadata yt-formatted-string, #title h1'
                );
                const channelElement = document.querySelector(
                    '.ytd-channel-name a.yt-simple-endpoint, #owner-name a'
                );
                title = titleElement ? titleElement.textContent.trim() : document.title.replace(' - YouTube', '');
                artist = channelElement ? channelElement.textContent.trim() : '';
            }

            title = title.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ');
            title = title.replace(
                /\b(official\s+)?(lyrics?\s+video|music\s+video|promotion\s+video|video|audio|live|cover|performance)\b/gi,
                ' '
            );
            title = title.replace(/\b(feat|ft)\.?\s+.*$/i, ' ');

            const dashParts = title.split(/\s+[-–—]\s+/);
            if (dashParts.length > 1) {
                const first = dashParts[0].trim();
                const rest = dashParts.slice(1).join(' - ').trim();
                if (!artist) {
                    artist = first;
                    title = rest;
                } else if (Core.tokenScore(artist, first) >= 0.5) {
                    title = rest;
                }
            }

            if (artist) {
                title = title.replace(new RegExp(Core.escapeRegExp(artist), 'gi'), ' ');
            }

            title = title.replace(/\s+/g, ' ').trim();
            title = title.replace(/[\s\-–—]+$/, '');
            artist = artist
                .replace(/-\s*topic/gi, '')
                .replace(/vevo/gi, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (!title) {
                title = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
            }

            if (!duration && videoElement && isFinite(videoElement.duration)) {
                duration = videoElement.duration;
            }

            return { title: title, artist: artist, duration: duration };
        }

        // ==========================================
        // LRCLIB
        // ==========================================
        async function fetchJson(url, signal) {
            try {
                const response = await fetch(url, {
                    signal: signal,
                    headers: { Accept: 'application/json' }
                });
                if (!response.ok) return null;
                return await response.json();
            } catch (error) {
                if (error && error.name === 'AbortError') throw error;
                return null;
            }
        }

        async function lrclibSearch(query, signal) {
            const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
            if (!cleanQuery) return [];
            const data = await fetchJson(
                'https://lrclib.net/api/search?q=' + encodeURIComponent(cleanQuery),
                signal
            );
            if (!Array.isArray(data)) return [];
            return data.filter((track) => track && (track.syncedLyrics || track.plainLyrics));
        }

        async function lrclibGet(meta, signal) {
            if (!meta.title || !meta.artist || !meta.duration) return null;
            const params = new URLSearchParams({
                artist_name: meta.artist,
                track_name: meta.title,
                duration: String(Math.round(meta.duration))
            });
            const data = await fetchJson('https://lrclib.net/api/get?' + params.toString(), signal);
            if (!data || !(data.syncedLyrics || data.plainLyrics)) return null;
            return data;
        }

        function dedupeTracks(tracks) {
            const seen = new Set();
            const unique = [];
            for (const track of tracks) {
                const key = [
                    track.source || 'lrclib',
                    track.id || '',
                    track.trackName || '',
                    track.artistName || '',
                    track.duration || ''
                ].join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(track);
            }
            return unique;
        }

        function fetchSource(source, payload) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                const timer = setTimeout(() => finish([]), SEARCH_TIMEOUT_MS);
                try {
                    chrome.runtime.sendMessage(
                        { action: 'lyrics_source', source: source, payload: payload },
                        (response) => {
                            clearTimeout(timer);
                            if (chrome.runtime.lastError || !response || !response.success) {
                                finish([]);
                                return;
                            }
                            finish(Array.isArray(response.tracks) ? response.tracks : []);
                        }
                    );
                } catch (error) {
                    clearTimeout(timer);
                    finish([]);
                }
            });
        }

        async function searchAuto(meta, signal, onProgress) {
            const report = typeof onProgress === 'function' ? onProgress : function () {};

            report('Mencoba pencocokan langsung…');
            const exact = await lrclibGet(meta, signal);
            if (exact) {
                return { track: exact, score: 1, source: 'get' };
            }

            const queries = [];
            if (meta.title && meta.artist) queries.push(meta.title + ' ' + meta.artist);
            if (meta.title) queries.push(meta.title);
            if (meta.title && /[|~]/.test(meta.title)) {
                const parts = meta.title.split(/[|~]/).map((part) => part.trim()).filter((part) => part.length > 2);
                for (let i = parts.length - 1; i >= 0; i -= 1) queries.push(parts[i]);
            }

            let collected = [];
            for (const query of queries) {
                report('Mencari di lrclib: ' + query);
                const results = await lrclibSearch(query, signal);
                collected = collected.concat(results);
                if (collected.length >= 12) break;
            }

            let best = Core.pickBestTrack(dedupeTracks(collected), meta);

            // Jika lrclib tidak yakin, coba sumber tambahan.
            if (!best || best.score < 0.6) {
                const fallbackQuery = queries[0] || meta.title;
                if (fallbackQuery) {
                    const sources = [
                        { id: 'netease', label: 'NetEase' },
                        { id: 'qq', label: 'QQ Music' }
                    ];
                    for (const source of sources) {
                        report('Mencari di ' + source.label + '…');
                        const tracks = await fetchSource(source.id, { query: fallbackQuery });
                        if (tracks.length > 0) collected = collected.concat(tracks);
                    }
                    const extra = Core.pickBestTrack(dedupeTracks(collected), meta);
                    if (extra && (!best || extra.score > best.score)) best = extra;
                }
            }

            if (!best) return null;
            return { track: best.track, score: best.score, source: best.track.source || 'search' };
        }

        function parseManualQuery(query) {
            const clean = String(query || '').trim();
            const parts = clean.split(/\s+[-–—]\s+/);
            if (parts.length >= 2) {
                return {
                    title: parts[0].trim(),
                    artist: parts.slice(1).join(' - ').trim(),
                    query: clean
                };
            }
            return { title: clean, artist: '', query: clean };
        }

        async function searchManual(query, signal, onProgress) {
            const report = typeof onProgress === 'function' ? onProgress : function () {};
            const parsed = parseManualQuery(query);
            const meta = { title: parsed.title, artist: parsed.artist, duration: 0 };

            const queries = [parsed.query];
            const alternative = parsed.artist ? parsed.title + ' ' + parsed.artist : parsed.title;
            if (alternative && alternative !== parsed.query) queries.push(alternative);

            let collected = [];
            for (const item of queries) {
                report('Mencari di lrclib: ' + item);
                const results = await lrclibSearch(item, signal);
                collected = collected.concat(results);
                if (collected.length >= 30) break;
            }

            const sources = [
                { id: 'netease', label: 'NetEase' },
                { id: 'qq', label: 'QQ Music' }
            ];
            for (const source of sources) {
                report('Mencari di ' + source.label + '…');
                const tracks = await fetchSource(source.id, { query: parsed.query });
                if (tracks.length > 0) collected = collected.concat(tracks);
            }

            const unique = dedupeTracks(collected);
            unique.sort((a, b) => Core.scoreTrack(b, meta).score - Core.scoreTrack(a, meta).score);
            return unique;
        }

        function isCacheFresh(timestamp) {
            return Boolean(timestamp) && Date.now() - timestamp < CACHE_TTL_MS;
        }

        // ==========================================
        // TOAST
        // ==========================================
        function toast(message) {
            const element = byId('toast');
            if (!element) return;
            element.textContent = message;
            element.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => element.classList.remove('show'), 2200);
        }

        function pageToast(message) {
            let element = document.getElementById('bml-page-toast');
            if (!element) {
                element = document.createElement('div');
                element.id = 'bml-page-toast';
                Object.assign(element.style, {
                    position: 'fixed',
                    left: '50%',
                    bottom: '24px',
                    transform: 'translateX(-50%)',
                    background: 'rgba(15, 23, 42, 0.96)',
                    color: '#f8fafc',
                    border: '1px solid #334155',
                    borderRadius: '999px',
                    padding: '8px 16px',
                    fontFamily: 'Segoe UI, Tahoma, sans-serif',
                    fontSize: '13px',
                    zIndex: '2147483647',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                    transition: 'opacity 0.2s',
                    pointerEvents: 'none',
                    maxWidth: '80vw'
                });
                document.body.appendChild(element);
            }
            element.textContent = message;
            element.style.opacity = '1';
            clearTimeout(pageToastTimer);
            pageToastTimer = setTimeout(() => {
                element.style.opacity = '0';
            }, 3000);
        }

        // ==========================================
        // MENU
        // ==========================================
        function setMenuOpen(open) {
            if (!pipWindow) return;
            menuOpen = Boolean(open);
            const body = pipWindow.document.body;
            body.classList.toggle('menu-open', menuOpen);
            const handle = byId('header-handle');
            if (handle) {
                handle.textContent = menuOpen ? '▴' : '▾';
                handle.setAttribute('aria-expanded', String(menuOpen));
            }
        }

        // Klik pertama "mengaktifkan" mode hover. Setelah itu menu muncul saat
        // kursor masuk ke area menu dan tertutup saat kursor keluar.
        function onMenuHandleClick() {
            if (!menuArmed) {
                menuArmed = true;
                setMenuOpen(true);
                return;
            }
            clearTimeout(menuHoverTimer);
            setMenuOpen(!menuOpen);
        }

        function onMenuPointerEnter() {
            if (!menuArmed) return;
            clearTimeout(menuHoverTimer);
            setMenuOpen(true);
        }

        function onMenuPointerLeave() {
            if (!menuArmed) return;
            clearTimeout(menuHoverTimer);
            menuHoverTimer = setTimeout(() => {
                setMenuOpen(false);
            }, 280);
        }

        function closeMenu() {
            clearTimeout(menuHoverTimer);
            setMenuOpen(false);
        }

        function applyFontScale() {
            if (!pipWindow) return;
            const body = pipWindow.document.body;
            body.style.setProperty('--lyric-scale', String(settings.fontScale));
            body.style.setProperty('--overlay-alpha', String(settings.opacity));
            body.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
        }

        function changeFontScale(delta) {
            const next = Math.min(1.8, Math.max(0.7, Math.round((settings.fontScale + delta) * 10) / 10));
            if (next === settings.fontScale) return;
            settings.fontScale = next;
            applyFontScale();
            saveSettings({ fontScale: next });
            toast('Ukuran font ' + Math.round(next * 100) + '%');
        }

        function toggleTheme() {
            settings.theme = settings.theme === 'light' ? 'dark' : 'light';
            applyFontScale();
            saveSettings({ theme: settings.theme });
            const button = byId('btn-theme');
            if (button) button.textContent = settings.theme === 'light' ? '☀' : '🌙';
            toast(settings.theme === 'light' ? 'Tema terang' : 'Tema gelap');
        }

        let opacitySaveTimer = null;
        function setOpacity(percent) {
            const next = Math.min(1, Math.max(0.3, Number(percent) / 100));
            settings.opacity = next;
            applyFontScale();
            clearTimeout(opacitySaveTimer);
            opacitySaveTimer = setTimeout(() => saveSettings({ opacity: settings.opacity }), 350);
        }

        // ==========================================
        // HIGHLIGHT & SCROLL
        // ==========================================
        function onTimeUpdate() {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                updateLyricsHighlight();
            });
        }

        function onPlayStateChange() {
            const button = byId('ctrl-pp');
            if (button && videoElement) {
                button.textContent = videoElement.paused ? '▶' : '⏸';
            }
        }

        function bindVideoEvents() {
            unbindVideoEvents();
            if (!videoElement) return;
            boundVideoElement = videoElement;
            boundVideoElement.addEventListener('timeupdate', onTimeUpdate);
            boundVideoElement.addEventListener('play', onPlayStateChange);
            boundVideoElement.addEventListener('pause', onPlayStateChange);
            boundVideoElement.addEventListener('loadedmetadata', onPlayStateChange);
            onPlayStateChange();
        }

        function unbindVideoEvents() {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            if (!boundVideoElement) return;
            boundVideoElement.removeEventListener('timeupdate', onTimeUpdate);
            boundVideoElement.removeEventListener('play', onPlayStateChange);
            boundVideoElement.removeEventListener('pause', onPlayStateChange);
            boundVideoElement.removeEventListener('loadedmetadata', onPlayStateChange);
            boundVideoElement = null;
        }

        function scrollLineIntoCenter(index) {
            const container = byId('lyrics-container');
            const element = lineElements[index];
            if (!container || !element) return;

            const target = element.offsetTop - container.clientHeight / 2 + element.offsetHeight / 2;
            isAutoScrolling = true;
            container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
            clearTimeout(scrollResetTimer);
            scrollResetTimer = setTimeout(() => {
                isAutoScrolling = false;
            }, 600);
        }

        function updateLyricsHighlight() {
            if (!pipWindow || !videoElement || !isSyncedLyrics || parsedLyrics.length === 0) return;

            const time = videoElement.currentTime - lyricsTimeOffset;
            const index = Core.findActiveIndex(parsedLyrics, time);
            if (index === currentHighlightIndex) return;

            currentHighlightIndex = index;
            for (let i = 0; i < lineElements.length; i += 1) {
                lineElements[i].classList.toggle('active', i === index);
            }

            const body = pipWindow.document.body;
            if (index >= 0 && !body.classList.contains('compact-mode') && Date.now() >= autoScrollPausedUntil) {
                scrollLineIntoCenter(index);
            }
        }

        // ==========================================
        // RENDER HEADER
        // ==========================================
        function offsetLabel() {
            return (lyricsTimeOffset > 0 ? '+' : '') + lyricsTimeOffset.toFixed(1) + 's';
        }

        function playerControlsMarkup() {
            return `
                <div class="player-controls">
                    <button type="button" class="ctrl-btn" id="ctrl-prev" title="Video sebelumnya">⏮</button>
                    <button type="button" class="ctrl-btn" id="ctrl-pp" title="Play / pause">⏸</button>
                    <button type="button" class="ctrl-btn" id="ctrl-next" title="Video berikutnya">⏭</button>
                    <button type="button" class="ctrl-btn" id="btn-edit" title="Edit / buat lirik">✎</button>
                </div>
            `;
        }

        function controlsMarkup(synced) {
            return `
                ${playerControlsMarkup()}
                <div class="sync-controls">
                    ${
                        synced
                            ? `
                        <button type="button" class="sync-btn" id="sync-minus" title="Lirik lebih cepat">-0.1s</button>
                        <span class="sync-display" id="sync-val">${escapeHtml(offsetLabel())}</span>
                        <button type="button" class="sync-btn" id="sync-plus" title="Lirik lebih lambat">+0.1s</button>
                        <button type="button" class="sync-btn karaoke-toggle" id="mode-toggle" title="Mode karaoke">🎤</button>
                    `
                            : ''
                    }
                    <button type="button" class="sync-btn" id="btn-latin" title="Ubah ke huruf Latin">🔤</button>
                    <button type="button" class="sync-btn" id="btn-search-toggle" title="Cari lirik manual">🔍</button>
                    <button type="button" class="sync-btn" id="btn-refresh" title="Cari ulang, abaikan cache">↻</button>
                    <button type="button" class="sync-btn" id="btn-font-minus" title="Perkecil font">A−</button>
                    <button type="button" class="sync-btn" id="btn-font-plus" title="Perbesar font">A+</button>
                    <button type="button" class="sync-btn" id="btn-maximize" title="Perbesar jendela">⛶</button>
                </div>
                <div class="display-controls">
                    <button type="button" class="sync-btn" id="btn-theme" title="Ganti tema">${settings.theme === 'light' ? '☀' : '🌙'}</button>
                    <label class="opacity-control" title="Opasitas latar menu">
                        <span>Latar</span>
                        <input type="range" id="opacity-range" min="30" max="100" step="5" value="${Math.round(settings.opacity * 100)}">
                    </label>
                    <button type="button" class="sync-btn" id="btn-export" title="Ekspor cache lirik">⬇ Ekspor</button>
                    <button type="button" class="sync-btn" id="btn-import" title="Impor cache lirik">⬆ Impor</button>
                    <input type="file" id="import-file" accept="application/json,.json" hidden>
                </div>
            `;
        }

        function searchBoxMarkup(value) {
            return `
                <div class="search-box" id="search-box" hidden>
                    <form id="search-form">
                        <input type="text" id="search-input" class="search-input"
                            placeholder="Judul Lagu - Nama Artis"
                            value="${escapeHtml(value || '')}"
                            autocomplete="off" spellcheck="false">
                        <button type="submit" class="search-btn-submit">Cari</button>
                        <button type="button" class="search-btn-cancel" id="btn-search-cancel">Batal</button>
                    </form>
                </div>
            `;
        }

        function bindHeaderEvents(options) {
            const opts = options || {};
            const body = pipWindow.document.body;

            const btnPrev = byId('ctrl-prev');
            const btnNext = byId('ctrl-next');
            const btnPp = byId('ctrl-pp');

            if (btnPrev) {
                btnPrev.addEventListener('click', () => {
                    const prevButton = document.querySelector('.ytp-prev-button');
                    if (
                        prevButton &&
                        window.getComputedStyle(prevButton).display !== 'none' &&
                        prevButton.getAttribute('aria-disabled') !== 'true'
                    ) {
                        prevButton.click();
                    } else {
                        window.history.back();
                    }
                });
            }

            if (btnNext) {
                btnNext.addEventListener('click', () => {
                    const nextButton = document.querySelector('.ytp-next-button');
                    if (nextButton) nextButton.click();
                });
            }

            if (btnPp) {
                btnPp.addEventListener('click', () => {
                    if (!videoElement) return;
                    if (videoElement.paused) videoElement.play();
                    else videoElement.pause();
                });
            }

            if (opts.synced) {
                const btnMinus = byId('sync-minus');
                const btnPlus = byId('sync-plus');
                const btnMode = byId('mode-toggle');

                if (btnMinus) {
                    btnMinus.addEventListener('click', () => {
                        lyricsTimeOffset -= 0.1;
                        updateSyncDisplay();
                        saveOffset();
                    });
                }
                if (btnPlus) {
                    btnPlus.addEventListener('click', () => {
                        lyricsTimeOffset += 0.1;
                        updateSyncDisplay();
                        saveOffset();
                    });
                }
                if (btnMode) {
                    btnMode.addEventListener('click', () => {
                        body.classList.toggle('compact-mode');
                        currentHighlightIndex = -1;
                        updateLyricsHighlight();
                        setTimeout(() => {
                            currentHighlightIndex = -1;
                            updateLyricsHighlight();
                        }, 350);
                    });
                }
            }

            const btnLatin = byId('btn-latin');
            if (btnLatin) btnLatin.addEventListener('click', toggleLatin);

            const btnSearchToggle = byId('btn-search-toggle');
            if (btnSearchToggle) {
                btnSearchToggle.addEventListener('click', () => {
                    const searchBox = byId('search-box');
                    const input = byId('search-input');
                    if (!searchBox || !input) return;
                    searchBox.hidden = false;
                    body.classList.add('search-active');
                    input.focus();
                    input.select();
                });
            }

            const btnCancel = byId('btn-search-cancel');
            if (btnCancel) {
                btnCancel.addEventListener('click', () => {
                    const searchBox = byId('search-box');
                    const input = byId('search-input');
                    if (searchBox) searchBox.hidden = true;
                    body.classList.remove('search-active');
                    if (input) input.value = opts.fallbackSearchText || '';
                });
            }

            const form = byId('search-form');
            if (form) {
                form.addEventListener('submit', (event) => {
                    event.preventDefault();
                    const input = byId('search-input');
                    const query = input ? input.value.trim() : '';
                    if (query) loadLyricsToPiP(query);
                });
            }

            const btnRefresh = byId('btn-refresh');
            if (btnRefresh) {
                btnRefresh.addEventListener('click', () => {
                    loadLyricsToPiP(null, null, { force: true });
                });
            }

            const btnFontMinus = byId('btn-font-minus');
            if (btnFontMinus) btnFontMinus.addEventListener('click', () => changeFontScale(-0.1));

            const btnFontPlus = byId('btn-font-plus');
            if (btnFontPlus) btnFontPlus.addEventListener('click', () => changeFontScale(0.1));

            const btnMaximize = byId('btn-maximize');
            if (btnMaximize) btnMaximize.addEventListener('click', toggleMaximize);

            const btnTheme = byId('btn-theme');
            if (btnTheme) btnTheme.addEventListener('click', toggleTheme);

            const opacityRange = byId('opacity-range');
            if (opacityRange) {
                opacityRange.value = String(Math.round(settings.opacity * 100));
                opacityRange.addEventListener('input', (event) => setOpacity(event.target.value));
            }

            const btnExport = byId('btn-export');
            if (btnExport) btnExport.addEventListener('click', exportCache);

            const btnImport = byId('btn-import');
            const importFile = byId('import-file');
            if (btnImport && importFile) {
                btnImport.addEventListener('click', () => importFile.click());
                importFile.addEventListener('change', () => {
                    const file = importFile.files && importFile.files[0];
                    importFile.value = '';
                    importCacheFile(file);
                });
            }

            const btnEdit = byId('btn-edit');
            if (btnEdit) btnEdit.addEventListener('click', openEditor);

            const btnStop = byId('btn-stop-search');
            if (btnStop) {
                btnStop.addEventListener('click', () => {
                    searchStopRequested = true;
                    loadToken += 1;
                    if (activeAbort) activeAbort.abort();
                    renderStopped(opts.fallbackSearchText || '');
                });
            }

            onPlayStateChange();
        }

        function updateSyncDisplay() {
            const display = byId('sync-val');
            if (display) display.textContent = offsetLabel();
            updateLyricsHighlight();
        }

        function saveOffset() {
            const videoId = getVideoId();
            if (videoId) saveVideoData(videoId, { offset: lyricsTimeOffset });
        }

        function toggleMaximize() {
            if (!pipWindow) return;
            const button = byId('btn-maximize');

            if (!pipWindow.isMaximized) {
                pipWindow.originalWidth = pipWindow.outerWidth;
                pipWindow.originalHeight = pipWindow.outerHeight;
                try {
                    pipWindow.moveTo(0, 0);
                    pipWindow.resizeTo(window.screen.availWidth, window.screen.availHeight);
                    pipWindow.isMaximized = true;
                    if (button) {
                        button.textContent = '🗗';
                        button.title = 'Kembalikan ukuran';
                    }
                } catch (error) {
                    console.warn('Brave Mini Lyrics: gagal memperbesar jendela', error);
                    toast('Browser menolak memperbesar jendela');
                }
            } else {
                try {
                    const width = pipWindow.originalWidth || 360;
                    const height = pipWindow.originalHeight || 560;
                    pipWindow.resizeTo(width, height);
                    pipWindow.moveTo(window.screen.availWidth - width - 50, 50);
                    pipWindow.isMaximized = false;
                    if (button) {
                        button.textContent = '⛶';
                        button.title = 'Perbesar jendela';
                    }
                } catch (error) {
                    console.warn('Brave Mini Lyrics: gagal mengembalikan ukuran jendela', error);
                }
            }
        }

        // ==========================================
        // POSISI & UKURAN JENDELA
        // ==========================================
        function currentPipBounds() {
            if (!pipWindow || pipWindow.isMaximized) return null;
            const bounds = {
                width: Math.round(pipWindow.outerWidth),
                height: Math.round(pipWindow.outerHeight),
                left: Math.round(pipWindow.screenX),
                top: Math.round(pipWindow.screenY)
            };
            if (
                !isFinite(bounds.width) ||
                !isFinite(bounds.height) ||
                !isFinite(bounds.left) ||
                !isFinite(bounds.top) ||
                bounds.width < 240 ||
                bounds.height < 240
            ) {
                return null;
            }
            return bounds;
        }

        function savePipBounds(force) {
            const bounds = currentPipBounds();
            if (!bounds) return;
            const previous = settings.pipBounds;
            const same =
                previous &&
                previous.width === bounds.width &&
                previous.height === bounds.height &&
                previous.left === bounds.left &&
                previous.top === bounds.top;
            if (same && !force) return;
            settings.pipBounds = bounds;
            saveSettings({ pipBounds: bounds });
        }

        // ==========================================
        // EKSPOR / IMPOR CACHE
        // ==========================================
        async function exportCache() {
            if (!pipWindow) return;
            try {
                const all = await chrome.storage.local.get(null);
                const data = {};
                for (const key of Object.keys(all)) {
                    if (key.indexOf('bml:v2:') === 0) data[key] = all[key];
                }
                const payload = {
                    app: 'brave-mini-lyrics',
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    data: data
                };
                const blob = new pipWindow.Blob([JSON.stringify(payload, null, 2)], {
                    type: 'application/json'
                });
                const url = pipWindow.URL.createObjectURL(blob);
                const link = pipWindow.document.createElement('a');
                const stamp = new Date().toISOString().slice(0, 10);
                link.href = url;
                link.download = 'brave-mini-lyrics-' + stamp + '.json';
                pipWindow.document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => {
                    if (pipWindow) pipWindow.URL.revokeObjectURL(url);
                }, 10000);
                toast('Cache lirik diekspor');
            } catch (error) {
                console.error('Brave Mini Lyrics: gagal mengekspor cache', error);
                toast('Gagal mengekspor cache');
            }
        }

        async function importCacheFile(file) {
            if (!file) return;
            try {
                const payload = JSON.parse(await file.text());
                if (
                    !payload ||
                    payload.app !== 'brave-mini-lyrics' ||
                    !payload.data ||
                    typeof payload.data !== 'object'
                ) {
                    toast('File backup tidak dikenali');
                    return;
                }

                const data = {};
                let count = 0;
                for (const key of Object.keys(payload.data)) {
                    if (key.indexOf('bml:v2:') !== 0) continue;
                    const value = payload.data[key];
                    if (!value || typeof value !== 'object') continue;
                    data[key] = value;
                    count += 1;
                }
                if (count === 0) {
                    toast('Tidak ada data untuk diimpor');
                    return;
                }

                await chrome.storage.local.set(data);
                await loadSettings();
                applyFontScale();
                loadLyricsToPiP(null, null, { force: true });
                toast(count + ' entri diimpor');
            } catch (error) {
                console.error('Brave Mini Lyrics: gagal mengimpor cache', error);
                toast('File backup tidak valid');
            }
        }

        // ==========================================
        // RENDER STATE
        // ==========================================
        function renderLoading(titleText, artistText, fallbackSearchText, statusText) {
            const body = pipWindow.document.body;
            body.classList.remove('results-mode', 'showing-results', 'search-active');
            body.classList.add('is-loading');
            setMenuOpen(true);

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            currentHighlightIndex = -1;
            latinState = createLatinState();

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title">${escapeHtml(titleText)}</p>
                    <p class="artist">${escapeHtml(artistText)}</p>
                    ${playerControlsMarkup()}
                    <div class="loading-controls">
                        <button type="button" class="sync-btn" id="btn-stop-search" title="Hentikan pencarian">⏹ Hentikan</button>
                    </div>
                    ${searchBoxMarkup(fallbackSearchText)}
                </div>
            `;
            container.innerHTML = `<p class="loading" id="loading-status">${escapeHtml(
                statusText || 'Menghubungkan ke database lirik…'
            )}</p>`;
            bindHeaderEvents({ synced: false, fallbackSearchText: fallbackSearchText });
        }

        function updateLoadingStatus(message) {
            const element = byId('loading-status');
            if (element) element.textContent = message;
        }

        function renderStopped(fallbackSearchText) {
            const body = pipWindow.document.body;
            body.classList.remove('is-loading', 'results-mode', 'showing-results');
            setMenuOpen(true);

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            currentHighlightIndex = -1;

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title">Pencarian dihentikan</p>
                    <p class="artist">Kamu bisa cari manual atau buat lirik sendiri.</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup(fallbackSearchText)}
                </div>
            `;
            container.innerHTML =
                '<p class="loading">Pencarian dihentikan. Tekan 🔍 untuk mencari manual atau ✎ untuk membuat lirik sendiri.</p>';

            bindHeaderEvents({ synced: false, fallbackSearchText: fallbackSearchText });
            const searchBox = byId('search-box');
            if (searchBox) searchBox.hidden = false;
            applyFontScale();
        }

        function renderFound(data, fallbackSearchText, usedCache) {
            const body = pipWindow.document.body;
            body.classList.remove('results-mode', 'showing-results', 'search-active', 'is-loading');

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            let lines = data.isSynced ? Core.parseLrc(data.lrc) : [];
            let synced = Boolean(data.isSynced) && lines.length > 0;
            if (!synced) {
                lines = [];
            }

            isSyncedLyrics = synced;
            parsedLyrics = lines;
            lineElements = [];
            currentHighlightIndex = -1;
            latinState = createLatinState();

            const badge = synced
                ? '<span class="badge badge-green">✔ Sinkron</span>'
                : '<span class="badge badge-yellow">⚠ Statis</span>';
            const cacheBadge = usedCache ? '<span class="badge badge-blue">cache</span>' : '';

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title" title="${escapeHtml(data.trackName)}">${escapeHtml(data.trackName)}</p>
                    <p class="artist">${escapeHtml(data.artistName)} ${badge} ${cacheBadge}</p>
                    ${controlsMarkup(synced)}
                    ${synced ? '<p class="hint">Klik kiri: lompat lagu · Klik kanan: kalibrasi offset</p>' : ''}
                    ${searchBoxMarkup(fallbackSearchText)}
                </div>
            `;

            container.innerHTML = '';
            container.scrollTop = 0;

            if (synced) {
                const fragment = pipWindow.document.createDocumentFragment();
                lines.forEach((line, index) => {
                    const element = pipWindow.document.createElement('p');
                    element.className = 'lyrics-line';
                    element.id = 'line-' + index;
                    element.textContent = line.text;
                    element.title = 'Klik: lompat · Klik kanan: kalibrasi';

                    element.addEventListener('click', () => {
                        if (videoElement) {
                            videoElement.currentTime = Math.max(0, line.time + lyricsTimeOffset);
                        }
                    });

                    element.addEventListener('contextmenu', (event) => {
                        event.preventDefault();
                        if (!videoElement) return;
                        lyricsTimeOffset = videoElement.currentTime - line.time;
                        updateSyncDisplay();
                        saveOffset();
                        toast('Offset: ' + offsetLabel());
                    });

                    fragment.appendChild(element);
                    lineElements.push(element);
                });
                container.appendChild(fragment);
                bindVideoEvents();
                updateLyricsHighlight();
            } else {
                const text = data.text || '';
                const staticLines = text.split('\n');
                const fragment = pipWindow.document.createDocumentFragment();
                staticLines.forEach((line) => {
                    const element = pipWindow.document.createElement('p');
                    element.className = 'lyrics-line static-line';
                    element.textContent = line || ' ';
                    fragment.appendChild(element);
                    lineElements.push(element);
                });
                container.appendChild(fragment);
                bindVideoEvents();
            }

            bindHeaderEvents({ synced: synced, fallbackSearchText: fallbackSearchText });
            closeMenu();
            applyFontScale();
            maybeAutoLatin();
        }

        function renderResults(results, manualQuery, meta) {
            const body = pipWindow.document.body;
            body.classList.remove('is-loading', 'search-active');
            body.classList.add('results-mode', 'showing-results');

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            latinState = createLatinState();

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title">Hasil Pencarian</p>
                    <p class="artist">${results.length} versi ditemukan · pilih salah satu</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup(manualQuery)}
                </div>
            `;

            container.innerHTML = '';
            const list = pipWindow.document.createElement('div');
            list.className = 'search-results-list';

            results.forEach((track) => {
                const item = pipWindow.document.createElement('button');
                item.type = 'button';
                item.className = 'search-result-item';

                const info = pipWindow.document.createElement('div');
                info.className = 'sr-info';

                const title = pipWindow.document.createElement('div');
                title.className = 'sr-title';
                title.textContent = track.trackName || 'Tanpa judul';

                const artist = pipWindow.document.createElement('div');
                artist.className = 'sr-artist';
                const duration = track.duration ? ' · ' + Core.formatTime(track.duration) : '';
                const sourceLabel =
                    track.source === 'netease'
                        ? ' · NetEase'
                        : track.source === 'qq'
                          ? ' · QQ Music'
                          : '';
                artist.textContent = (track.artistName || 'Tanpa artis') + duration + sourceLabel;

                const badgeWrapper = pipWindow.document.createElement('div');
                badgeWrapper.className = 'sr-badge';
                const badge = pipWindow.document.createElement('span');
                badge.className = 'badge ' + (track.syncedLyrics ? 'badge-green' : 'badge-yellow');
                badge.textContent = track.syncedLyrics ? 'Sinkron' : 'Statis';
                badgeWrapper.appendChild(badge);

                info.appendChild(title);
                info.appendChild(artist);
                item.appendChild(info);
                item.appendChild(badgeWrapper);

                item.addEventListener('click', async () => {
                    const videoId = getVideoId();
                    if (videoId) await saveVideoData(videoId, { manualData: track });
                    loadLyricsToPiP(null, track);
                });

                list.appendChild(item);
            });

            container.appendChild(list);
            bindHeaderEvents({ synced: false, fallbackSearchText: manualQuery });
            setMenuOpen(true);
            applyFontScale();
        }

        function renderNotFound(fallbackSearchText) {
            const body = pipWindow.document.body;
            body.classList.remove('results-mode', 'showing-results', 'is-loading');
            setMenuOpen(true);

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            latinState = createLatinState();

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title">Lirik tidak ditemukan</p>
                    <p class="artist">${escapeHtml(fallbackSearchText)}</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup(fallbackSearchText)}
                </div>
            `;
            container.innerHTML =
                '<p class="loading">Lirik tidak tersedia di database. Coba cari manual dengan format <b>Judul Lagu - Nama Artis</b>.</p>';

            bindHeaderEvents({ synced: false, fallbackSearchText: fallbackSearchText });
            const searchBox = byId('search-box');
            if (searchBox) searchBox.hidden = false;
            applyFontScale();
        }

        // ==========================================
        // ROMANISASI
        // ==========================================
        function cleanupRomaji(text) {
            return String(text)
                .replace(/\n/g, ' ')
                .trim()
                .replace(/ō/g, 'ou')
                .replace(/Ō/g, 'Ou')
                .replace(/ū/g, 'uu')
                .replace(/Ū/g, 'Uu')
                .replace(/ā/g, 'aa')
                .replace(/Ā/g, 'Aa')
                .replace(/ī/g, 'ii')
                .replace(/Ī/g, 'Ii')
                .replace(/ē/g, 'ee')
                .replace(/Ē/g, 'Ee')
                .replace(/tch/g, 'cch');
        }

        function initKuroshiro() {
            if (typeof Kuroshiro === 'undefined' || typeof KuromojiAnalyzer === 'undefined') {
                return Promise.reject(new Error('Library Kuroshiro tidak tersedia'));
            }

            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                let target = url;
                if (
                    typeof target === 'string' &&
                    target.startsWith('chrome-extension:/') &&
                    !target.startsWith('chrome-extension://')
                ) {
                    target = target.replace('chrome-extension:/', 'chrome-extension://');
                }
                const args = Array.prototype.slice.call(arguments);
                args[1] = target;
                return originalOpen.apply(this, args);
            };

            const instance = new Kuroshiro.default();
            return instance
                .init(new KuromojiAnalyzer({ dictPath: chrome.runtime.getURL('dict/') }))
                .then(() => instance)
                .finally(() => {
                    XMLHttpRequest.prototype.open = originalOpen;
                });
        }

        function getKuroshiro() {
            if (!kuroshiroPromise.current) {
                kuroshiroPromise.current = initKuroshiro().catch((error) => {
                    kuroshiroPromise.current = null;
                    throw error;
                });
            }
            return kuroshiroPromise.current;
        }

        async function romanizeJapanese(instance, lines) {
            const results = [];
            const batchSize = 10;

            for (let start = 0; start < lines.length; start += batchSize) {
                const batch = lines.slice(start, start + batchSize);
                const converted = await Promise.all(
                    batch.map(async (line) => {
                        if (!line.trim() || line.trim() === '♪') return line;
                        try {
                            const romaji = await instance.convert(line, {
                                to: 'romaji',
                                mode: 'spaced',
                                romajiSystem: 'hepburn'
                            });
                            return cleanupRomaji(romaji);
                        } catch (error) {
                            return line;
                        }
                    })
                );
                results.push.apply(results, converted);
            }

            return results;
        }

        // Baris tanpa kanji bisa diubah dengan tabel kana lokal, tanpa memuat
        // kamus Kuromoji 17 MB. Kamus hanya dipakai kalau ada kanji.
        async function romanizeJapaneseSmart(lines) {
            const needsDictionary = !Kana || lines.some((line) => Kana.hasKanji(line));
            if (!needsDictionary) {
                return lines.map((line) => {
                    if (!line.trim() || line.trim() === '♪') return line;
                    return cleanupRomaji(Kana.romanize(line));
                });
            }
            const instance = await getKuroshiro();
            return romanizeJapanese(instance, lines);
        }

        function sendRomanize(text) {
            return new Promise((resolve) => {
                try {
                    chrome.runtime.sendMessage({ action: 'romanize', text: text }, (response) => {
                        if (chrome.runtime.lastError || !response || !response.success) {
                            resolve(null);
                        } else {
                            resolve(response.text);
                        }
                    });
                } catch (error) {
                    resolve(null);
                }
            });
        }

        async function romanizeWithGoogle(lines) {
            const output = [];
            let chunk = [];
            let size = 0;

            const flush = async () => {
                if (chunk.length === 0) return;
                const response = await sendRomanize(chunk.join('\n'));
                if (response) {
                    const parts = response.replace(/\r\n?/g, '\n').split('\n');
                    if (parts.length === chunk.length) {
                        output.push.apply(output, parts);
                    } else {
                        for (const line of chunk) {
                            output.push((await sendRomanize(line)) || line);
                        }
                    }
                } else {
                    for (const line of chunk) {
                        output.push((await sendRomanize(line)) || line);
                    }
                }
                chunk = [];
                size = 0;
            };

            for (const line of lines) {
                if (size + line.length + 1 > MAX_GOOGLE_CHARS) await flush();
                chunk.push(line);
                size += line.length + 1;
            }
            await flush();
            return output;
        }

        function applyTexts(texts) {
            lineElements.forEach((element, index) => {
                const value = texts[index] === undefined ? element.textContent : texts[index];
                element.textContent = value;
                if (isSyncedLyrics && parsedLyrics[index]) {
                    parsedLyrics[index].text = value;
                }
            });
        }

        async function toggleLatin(options) {
            const opts = options || {};
            if (!pipWindow || lineElements.length === 0) return;
            const button = byId('btn-latin');

            if (latinState.mode) {
                applyTexts(latinState.original);
                latinState.mode = false;
                if (button) {
                    button.classList.remove('active-latin');
                    button.textContent = '🔤';
                }
                saveSettings({ latinMode: false });
                if (!opts.silent) toast('Lirik asli');
                return;
            }

            if (latinState.done) {
                applyTexts(latinState.latin);
                latinState.mode = true;
                if (button) {
                    button.classList.add('active-latin');
                    button.textContent = '✔';
                }
                saveSettings({ latinMode: true });
                if (!opts.silent) toast('Huruf Latin');
                return;
            }

            if (latinState.busy) return;

            latinState.busy = true;
            if (button) button.disabled = true;
            latinState.original = lineElements.map((element) => element.textContent);
            const key = Core.hashText(latinState.original.join('\n'));
            latinState.key = key;

            // Gunakan hasil romanisasi yang pernah disimpan untuk video ini.
            const cached = currentVideoData && currentVideoData.latinData;
            if (
                cached &&
                cached.key === key &&
                Array.isArray(cached.lines) &&
                cached.lines.length === latinState.original.length
            ) {
                latinState.latin = cached.lines;
                latinState.done = true;
                latinState.mode = true;
                applyTexts(cached.lines);
                if (button) {
                    button.classList.add('active-latin');
                    button.textContent = '✔';
                    button.disabled = false;
                }
                latinState.busy = false;
                saveSettings({ latinMode: true });
                if (!opts.silent) toast('Huruf Latin (cache)');
                return;
            }

            const script = Core.detectScript(latinState.original.join('\n'));
            if (script === 'latin' || script === 'unknown') {
                latinState.busy = false;
                if (button) button.disabled = false;
                if (!opts.silent) toast('Lirik sudah memakai huruf Latin');
                return;
            }

            try {
                if (button) button.textContent = '⏳';
                let converted;

                if (script === 'ja') {
                    converted = await romanizeJapaneseSmart(latinState.original);
                } else {
                    converted = await romanizeWithGoogle(latinState.original);
                }

                const changed = converted.some(
                    (line, index) => line && line !== latinState.original[index]
                );
                if (!changed) {
                    if (!opts.silent) toast('Romanisasi tidak tersedia untuk lirik ini');
                    if (button) button.textContent = '🔤';
                    return;
                }

                latinState.latin = converted;
                latinState.done = true;
                latinState.mode = true;
                applyTexts(converted);
                if (button) {
                    button.classList.add('active-latin');
                    button.textContent = '✔';
                }
                saveSettings({ latinMode: true });

                const videoId = getVideoId();
                if (videoId) {
                    saveVideoData(videoId, {
                        latinData: { key: key, lines: converted }
                    });
                }
            } catch (error) {
                console.error('Brave Mini Lyrics: romanisasi gagal', error);
                if (!opts.silent) toast('Gagal memuat kamus romanisasi');
                if (button) {
                    button.textContent = '🔴';
                    setTimeout(() => {
                        if (button) button.textContent = '🔤';
                    }, 1500);
                }
            } finally {
                latinState.busy = false;
                if (button) button.disabled = false;
            }
        }

        function maybeAutoLatin() {
            if (!settings.latinMode) return;
            if (!pipWindow || lineElements.length === 0) return;
            if (latinState.mode || latinState.busy) return;
            const script = Core.detectScript(lineElements.map((element) => element.textContent).join('\n'));
            if (script === 'latin' || script === 'unknown') return;
            toggleLatin({ silent: true });
        }

        // ==========================================
        // EDITOR LIRIK & TAP SYNC
        // ==========================================
        function editorSeedText() {
            if (isSyncedLyrics && parsedLyrics.length > 0) {
                const texts =
                    latinState.mode && latinState.original.length === parsedLyrics.length
                        ? latinState.original
                        : parsedLyrics.map((line) => line.text);
                return parsedLyrics
                    .map((line, index) => Core.toLrcTimestamp(line.time) + (texts[index] || ''))
                    .join('\n');
            }
            if (lineElements.length > 0) {
                return lineElements.map((element) => element.textContent).join('\n');
            }
            return '';
        }

        function closeEditor() {
            if (!pipWindow) return;
            const panel = pipWindow.document.getElementById('editor-panel');
            if (panel) panel.remove();
            tapState = null;
        }

        function openEditor() {
            if (!pipWindow) return;
            closeMenu();
            closeEditor();

            const doc = pipWindow.document;
            const panel = doc.createElement('div');
            panel.id = 'editor-panel';
            panel.className = 'editor-panel';
            panel.innerHTML = `
                <div class="editor-head">
                    <span>Edit Lirik</span>
                    <button type="button" class="editor-close" id="editor-close" title="Tutup">✕</button>
                </div>
                <textarea id="editor-text" class="editor-text" spellcheck="false"
                    placeholder="Tempel lirik LRC ([mm:ss.xx] teks) atau teks biasa…"></textarea>
                <div class="tap-view" id="tap-view" hidden>
                    <p class="tap-count" id="tap-count"></p>
                    <p class="tap-line" id="tap-line"></p>
                    <div class="tap-actions">
                        <button type="button" class="sync-btn" id="tap-undo" title="Batalkan tap terakhir">↶</button>
                        <button type="button" class="tap-hit" id="tap-hit">TAP</button>
                        <button type="button" class="sync-btn" id="tap-finish">Selesai</button>
                    </div>
                    <p class="editor-hint">Putar lagu, lalu tekan TAP tepat saat baris di atas mulai dinyanyikan.</p>
                </div>
                <div class="editor-actions">
                    <button type="button" class="sync-btn" id="editor-tap">🎯 Tap Sinkron</button>
                    <button type="button" class="sync-btn" id="editor-reset">Hapus manual</button>
                    <button type="button" class="sync-btn editor-save" id="editor-save">Simpan</button>
                </div>
                <p class="editor-hint">Format LRC: <code>[01:23.45]Teks lirik</code>. Tanpa timestamp akan disimpan sebagai lirik statis.</p>
            `;
            doc.body.appendChild(panel);

            const textarea = doc.getElementById('editor-text');
            if (textarea) textarea.value = editorSeedText();

            const bind = (id, handler) => {
                const element = doc.getElementById(id);
                if (element) element.addEventListener('click', handler);
            };

            bind('editor-close', closeEditor);
            bind('editor-save', saveEditor);
            bind('editor-reset', resetManualLyrics);
            bind('editor-tap', startTapSync);
            bind('tap-hit', hitTap);
            bind('tap-undo', undoTap);
            bind('tap-finish', finishTapSync);

            if (textarea) textarea.focus();
        }

        async function saveEditor() {
            if (!pipWindow) return;
            const textarea = pipWindow.document.getElementById('editor-text');
            if (!textarea) return;
            const text = textarea.value.replace(/\r\n?/g, '\n').trim();
            if (!text) {
                toast('Lirik masih kosong');
                return;
            }

            const meta = getVideoMetadata();
            const videoId = getVideoId();
            const synced = /\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\]/.test(text);
            const manualData = {
                id: 'manual:' + (videoId || 'local'),
                trackName: meta.title || 'Lirik manual',
                artistName: meta.artist || '',
                duration: meta.duration || 0,
                syncedLyrics: synced ? text : null,
                plainLyrics: synced ? null : text,
                source: 'manual'
            };

            currentVideoData = Object.assign({}, currentVideoData, {
                manualData: manualData,
                latinData: null
            });
            if (videoId) {
                await saveVideoData(videoId, { manualData: manualData, latinData: null });
            }
            closeEditor();
            loadLyricsToPiP(null, manualData);
            toast(synced ? 'Lirik sinkron disimpan' : 'Lirik statis disimpan');
        }

        async function resetManualLyrics() {
            if (!pipWindow) return;
            if (!currentVideoData || !currentVideoData.manualData) {
                toast('Tidak ada lirik manual');
                return;
            }
            const videoId = getVideoId();
            currentVideoData = Object.assign({}, currentVideoData, {
                manualData: null,
                latinData: null
            });
            if (videoId) {
                await saveVideoData(videoId, { manualData: null, latinData: null });
            }
            closeEditor();
            loadLyricsToPiP(null, null, { force: true });
            toast('Lirik manual dihapus');
        }

        function startTapSync() {
            if (!pipWindow) return;
            const doc = pipWindow.document;
            const textarea = doc.getElementById('editor-text');
            if (!textarea) return;

            const lines = textarea.value
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .map((line) =>
                    line
                        .replace(/\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\]/g, '')
                        .replace(/<[^>]*>/g, '')
                        .trim()
                )
                .filter((line) => line.length > 0);

            if (lines.length === 0) {
                toast('Tidak ada baris untuk disinkronkan');
                return;
            }

            tapState = { lines: lines, index: 0, times: [] };
            textarea.hidden = true;
            const view = doc.getElementById('tap-view');
            if (view) view.hidden = false;

            if (videoElement && videoElement.paused) {
                const played = videoElement.play();
                if (played && typeof played.catch === 'function') played.catch(() => {});
            }
            renderTapState();
        }

        function renderTapState() {
            if (!pipWindow || !tapState) return;
            const doc = pipWindow.document;
            if (tapState.index >= tapState.lines.length) {
                finishTapSync();
                return;
            }
            const count = doc.getElementById('tap-count');
            const lineElement = doc.getElementById('tap-line');
            if (count) count.textContent = 'Baris ' + (tapState.index + 1) + ' / ' + tapState.lines.length;
            if (lineElement) lineElement.textContent = tapState.lines[tapState.index];
        }

        function hitTap() {
            if (!tapState || !videoElement) return;
            tapState.times[tapState.index] = videoElement.currentTime;
            tapState.index += 1;
            renderTapState();
        }

        function undoTap() {
            if (!tapState || tapState.index === 0) return;
            tapState.index -= 1;
            tapState.times.length = tapState.index;
            renderTapState();
        }

        function finishTapSync() {
            if (!pipWindow || !tapState) return;
            const doc = pipWindow.document;
            const textarea = doc.getElementById('editor-text');
            const lrc = tapState.lines
                .map((line, index) => Core.toLrcTimestamp(tapState.times[index] || 0) + line)
                .join('\n');
            if (textarea) {
                textarea.value = lrc;
                textarea.hidden = false;
            }
            const view = doc.getElementById('tap-view');
            if (view) view.hidden = true;
            tapState = null;
            toast('Tap sinkron selesai. Tekan Simpan.');
        }

        // ==========================================
        // LOAD LIRIK
        // ==========================================
        async function loadLyricsToPiP(manualQuery, directTrackData, options) {
            if (!pipWindow) return;

            const currentVideo = getVideoElement();
            if (currentVideo && currentVideo !== videoElement) {
                unbindVideoEvents();
                videoElement = currentVideo;
            }

            const opts = options || {};
            const token = ++loadToken;
            searchStopRequested = false;

            if (activeAbort) activeAbort.abort();
            const controller = new AbortController();
            activeAbort = controller;
            const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

            const meta = getVideoMetadata();
            const videoId = getVideoId();
            lastLoadedVideoId = videoId;

            const fallbackSearchText =
                manualQuery ||
                (meta.title ? meta.title + (meta.artist ? ' - ' + meta.artist : '') : meta.artist || '');

            let saved = {
                offset: 0,
                manualData: null,
                autoData: null,
                autoCachedAt: 0,
                latinData: null
            };
            if (videoId) saved = await getVideoData(videoId);
            if (token !== loadToken) {
                clearTimeout(timeoutId);
                return;
            }
            currentVideoData = saved;

            const report = (message) => {
                if (token === loadToken) updateLoadingStatus(message);
            };

            lyricsTimeOffset = Number(saved.offset) || 0;

            let sourceData = directTrackData;
            let usedCache = false;

            if (!manualQuery && !sourceData && !opts.force) {
                if (saved.manualData) {
                    sourceData = saved.manualData;
                } else if (saved.autoData && isCacheFresh(saved.autoCachedAt)) {
                    sourceData = saved.autoData;
                    usedCache = true;
                }
            }

            if (manualQuery) {
                renderLoading('Mencari manual…', manualQuery, manualQuery, 'Menyiapkan pencarian…');
            } else if (sourceData) {
                renderLoading(
                    usedCache ? 'Memuat lirik tersimpan…' : 'Memuat lirik…',
                    sourceData.trackName || meta.title,
                    fallbackSearchText,
                    'Memuat lirik…'
                );
            } else {
                renderLoading(
                    'Mencari lirik…',
                    meta.artist + ' • ' + meta.title,
                    fallbackSearchText,
                    'Menghubungkan ke database lirik…'
                );
            }

            try {
                if (sourceData) {
                    const lyricsData = {
                        found: true,
                        isSynced: Boolean(sourceData.syncedLyrics),
                        trackName: sourceData.trackName || meta.title,
                        artistName: sourceData.artistName || meta.artist,
                        lrc: sourceData.syncedLyrics,
                        text: sourceData.plainLyrics
                    };
                    if (token !== loadToken) return;
                    renderFound(lyricsData, fallbackSearchText, usedCache);
                    return;
                }

                if (manualQuery) {
                    const results = await searchManual(manualQuery, controller.signal, report);
                    if (token !== loadToken) return;
                    if (searchStopRequested) {
                        renderStopped(fallbackSearchText);
                    } else if (results.length > 0) {
                        renderResults(results, manualQuery, meta);
                    } else {
                        renderNotFound(fallbackSearchText);
                    }
                    return;
                }

                const found = await searchAuto(meta, controller.signal, report);
                if (token !== loadToken) return;
                if (searchStopRequested) {
                    renderStopped(fallbackSearchText);
                    return;
                }

                if (!found) {
                    renderNotFound(fallbackSearchText);
                    return;
                }

                // Simpan hanya kalau video tidak berubah selama pencarian,
                // supaya lirik lagu lama tidak tercatat untuk video baru.
                if (videoId && getVideoId() === videoId) {
                    const patch = {
                        autoData: found.track,
                        autoCachedAt: Date.now()
                    };
                    if (opts.force) patch.manualData = null;
                    await saveVideoData(videoId, patch);
                }
                if (token !== loadToken) return;

                renderFound(
                    {
                        found: true,
                        isSynced: Boolean(found.track.syncedLyrics),
                        trackName: found.track.trackName,
                        artistName: found.track.artistName,
                        lrc: found.track.syncedLyrics,
                        text: found.track.plainLyrics
                    },
                    fallbackSearchText,
                    false
                );
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    if (token === loadToken) {
                        if (searchStopRequested) renderStopped(fallbackSearchText);
                        else renderNotFound(fallbackSearchText);
                    }
                    return;
                }
                console.error('Brave Mini Lyrics: gagal memuat lirik', error);
                if (token === loadToken) renderNotFound(fallbackSearchText);
            } finally {
                clearTimeout(timeoutId);
                if (activeAbort === controller) activeAbort = null;
            }
        }

        // ==========================================
        // JENDELA PIP
        // ==========================================
        async function injectStyles(document_) {
            try {
                const response = await fetch(PIP_CSS_URL);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const css = await response.text();
                const style = document_.createElement('style');
                style.textContent = css;
                document_.head.appendChild(style);
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal memuat pip.css', error);
                const link = document_.createElement('link');
                link.rel = 'stylesheet';
                link.href = PIP_CSS_URL;
                document_.head.appendChild(link);

                const fallbackStyle = document_.createElement('style');
                fallbackStyle.textContent =
                    'html,body{margin:0;height:100%;background:#0f172a;color:#f8fafc;' +
                    'font-family:"Segoe UI",Tahoma,sans-serif;overflow:hidden}';
                document_.head.appendChild(fallbackStyle);
            }
        }

        async function setupPipDocument(win) {
            const document_ = win.document;

            await injectStyles(document_);

            const handle = document_.createElement('button');
            handle.type = 'button';
            handle.id = 'header-handle';
            handle.className = 'header-handle';
            handle.textContent = '▾';
            handle.title = 'Menu lirik';
            handle.setAttribute('aria-expanded', 'false');
            handle.addEventListener('click', onMenuHandleClick);
            handle.addEventListener('pointerenter', onMenuPointerEnter);
            handle.addEventListener('pointerleave', onMenuPointerLeave);

            const header = document_.createElement('div');
            header.id = 'header';
            header.className = 'header';
            header.addEventListener('pointerenter', onMenuPointerEnter);
            header.addEventListener('pointerleave', onMenuPointerLeave);

            const container = document_.createElement('div');
            container.id = 'lyrics-container';

            const toastElement = document_.createElement('div');
            toastElement.id = 'toast';

            document_.body.appendChild(handle);
            document_.body.appendChild(header);
            document_.body.appendChild(container);
            document_.body.appendChild(toastElement);

            container.addEventListener(
                'scroll',
                () => {
                    if (isAutoScrolling) return;
                    autoScrollPausedUntil = Date.now() + 3000;
                },
                { passive: true }
            );

            document_.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && document_.getElementById('editor-panel')) {
                    event.preventDefault();
                    closeEditor();
                    return;
                }

                const tag = event.target && event.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;

                if (event.key === 'Escape') {
                    closeMenu();
                } else if (event.code === 'Space') {
                    event.preventDefault();
                    if (videoElement) {
                        if (videoElement.paused) videoElement.play();
                        else videoElement.pause();
                    }
                } else if (event.key === 'ArrowLeft') {
                    lyricsTimeOffset -= 0.1;
                    updateSyncDisplay();
                    saveOffset();
                } else if (event.key === 'ArrowRight') {
                    lyricsTimeOffset += 0.1;
                    updateSyncDisplay();
                    saveOffset();
                } else if (event.key === '+' || event.key === '=') {
                    changeFontScale(0.1);
                } else if (event.key === '-') {
                    changeFontScale(-0.1);
                }
            });

            win.addEventListener('pagehide', () => {
                savePipBounds(true);
                clearTimeout(pipBoundsSaveTimer);
                pipBoundsSaveTimer = null;
                stopVideoWatcher();
                unbindVideoEvents();
                if (activeAbort) activeAbort.abort();
                loadToken += 1;
                clearTimeout(toastTimer);
                clearTimeout(scrollResetTimer);
                clearTimeout(menuHoverTimer);
                pipWindow = null;
                parsedLyrics = [];
                lineElements = [];
                currentHighlightIndex = -1;
                menuOpen = false;
                menuArmed = false;
                tapState = null;
            });

            win.addEventListener('resize', () => {
                clearTimeout(pipBoundsSaveTimer);
                pipBoundsSaveTimer = setTimeout(() => {
                    pipBoundsSaveTimer = null;
                    savePipBounds(false);
                }, 500);
            });

            applyFontScale();
        }

        function openFallbackWindow(width, height) {
            try {
                return window.open(
                    '',
                    'bml-lyrics-window',
                    'popup=yes,width=' + width + ',height=' + height
                );
            } catch (error) {
                return null;
            }
        }

        function clampBounds(bounds) {
            if (!bounds) return null;
            const maxWidth = Math.max(260, window.screen.availWidth - 40);
            const maxHeight = Math.max(260, window.screen.availHeight - 40);
            return {
                width: Math.min(maxWidth, Math.max(260, bounds.width)),
                height: Math.min(maxHeight, Math.max(260, bounds.height)),
                left: Math.min(Math.max(0, bounds.left), Math.max(0, window.screen.availWidth - 120)),
                top: Math.min(Math.max(0, bounds.top), Math.max(0, window.screen.availHeight - 120))
            };
        }

        async function bootLyricsWindow(win, savedBounds) {
            pipWindow = win;
            try {
                await setupPipDocument(win);
                await loadSettings();
                applyFontScale();
                await migrateLegacyStorage();

                if (savedBounds) {
                    try {
                        win.moveTo(savedBounds.left, savedBounds.top);
                    } catch (error) {
                        // browser bisa menolak memindahkan jendela
                    }
                }

                await loadLyricsToPiP(null);
                startVideoWatcher();
            } catch (error) {
                console.error('Brave Mini Lyrics: gagal menyiapkan jendela lirik', error);
                if (pipWindow === win) pipWindow = null;
                try {
                    win.close();
                } catch (closeError) {
                    // abaikan
                }
                pageToast('Gagal memuat jendela lirik.');
            }
        }

        function toggleLyricsPiP() {
            if (pipWindow) {
                pipWindow.close();
                return;
            }

            videoElement = getVideoElement();
            if (!videoElement) {
                pageToast('Tidak ada video yang sedang diputar.');
                return;
            }

            const savedBounds = clampBounds(settings.pipBounds);
            const width = savedBounds ? savedBounds.width : 360;
            const height = savedBounds ? savedBounds.height : 560;

            if ('documentPictureInPicture' in window) {
                let request;
                try {
                    // requestWindow harus dipanggil sinkron saat user activation masih aktif.
                    request = window.documentPictureInPicture.requestWindow({
                        width: width,
                        height: height
                    });
                } catch (error) {
                    console.error('Brave Mini Lyrics: gagal membuka PiP', error);
                    pageToast('Gagal membuka jendela lirik.');
                    return;
                }

                request
                    .then((win) => bootLyricsWindow(win, savedBounds))
                    .catch((error) => {
                        console.error('Brave Mini Lyrics: gagal membuka PiP', error);
                        pipWindow = null;
                        pageToast('Gagal membuka jendela lirik.');
                    });
                return;
            }

            // Fallback untuk browser tanpa Document PiP: jendela popup biasa.
            const win = openFallbackWindow(width, height);
            if (!win) {
                pageToast('Popup diblokir browser. Izinkan popup untuk YouTube lalu coba lagi.');
                return;
            }
            try {
                win.resizeTo(width, height);
            } catch (error) {
                // abaikan
            }
            bootLyricsWindow(win, savedBounds);
        }

        // ==========================================
        // EVENT GLOBAL
        // ==========================================
        chrome.runtime.onMessage.addListener((request) => {
            if (request && request.action === 'toggle_lyrics') {
                toggleLyricsPiP();
            }
        });

        // ==========================================
        // DETEKSI GANTI LAGU (navigasi SPA YouTube)
        // ==========================================
        // Metadata dianggap siap kalau sudah benar-benar milik video baru.
        // ytd-watch-flexy[video-id] dan player response bisa terlambat ~1 detik.
        function videoMetadataReady(videoId) {
            if (!videoId || getVideoId() !== videoId) return false;

            const details = getPlayerDetails();
            if (details && details.videoId) {
                return details.videoId === videoId;
            }

            const watchFlexy = document.querySelector('ytd-watch-flexy');
            if (watchFlexy && watchFlexy.hasAttribute('video-id')) {
                return watchFlexy.getAttribute('video-id') === videoId;
            }
            return true;
        }

        function scheduleVideoReload(videoId) {
            if (!pipWindow || !videoId) return;
            if (pendingVideoId === videoId) return;

            pendingVideoId = videoId;
            clearTimeout(pendingVideoTimer);

            // Jangan tampilkan lirik lagu sebelumnya selama lagu baru dimuat.
            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            currentHighlightIndex = -1;
            const container = byId('lyrics-container');
            if (container) {
                container.innerHTML = '<p class="loading">Mencari lirik lagu baru…</p>';
            }

            let attempts = 0;
            const attempt = () => {
                if (!pipWindow || pendingVideoId !== videoId) return;

                // User pindah lagi sebelum video ini siap: batalkan.
                if (getVideoId() !== videoId) {
                    pendingVideoId = null;
                    return;
                }

                // Tunggu metadata video baru (±4 detik), lalu lanjut juga
                // supaya tidak macet kalau struktur YouTube berubah.
                if (!videoMetadataReady(videoId) && attempts < 16) {
                    attempts += 1;
                    pendingVideoTimer = setTimeout(attempt, 250);
                    return;
                }

                pendingVideoId = null;
                unbindVideoEvents();
                videoElement = getVideoElement() || videoElement;
                loadLyricsToPiP(null);
            };
            attempt();
        }

        function checkVideoChange() {
            if (!pipWindow) return;
            const videoId = getVideoId();
            if (!videoId || videoId === lastLoadedVideoId) return;
            scheduleVideoReload(videoId);
        }

        function startVideoWatcher() {
            stopVideoWatcher();
            videoWatchTimer = setInterval(() => {
                checkVideoChange();
                savePipBounds(false);
            }, 1500);
        }

        function stopVideoWatcher() {
            clearInterval(videoWatchTimer);
            videoWatchTimer = null;
            clearTimeout(pendingVideoTimer);
            pendingVideoId = null;
        }

        ['yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated'].forEach((name) => {
            document.addEventListener(name, checkVideoChange);
        });
        window.addEventListener('popstate', checkVideoChange);

        loadSettings();

        console.log('Brave Mini Lyrics: content script siap.');
    }
}
