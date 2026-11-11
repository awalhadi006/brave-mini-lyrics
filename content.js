// Brave Mini Lyrics - content script
// Hanya berjalan di frame utama YouTube, bukan di iframe tersembunyi.
if (window === window.top) {
    'use strict';

    const Core = globalThis.BMLCore;
    const Kana = globalThis.BMLKana;
    const Segments = globalThis.BMLSegments;
    if (!Core) {
        console.error('Brave Mini Lyrics: lib/lrc.js belum termuat.');
    } else {
        if (!Segments) console.warn('Brave Mini Lyrics: lib/segments.js belum termuat.');
        run();
    }

    function run() {
        const PIP_CSS_URL = chrome.runtime.getURL('pip.css');
        const STORAGE_PREFIX = 'bml:v2:video:';
        const DRAFT_PREFIX = 'bml:v2:draft:';
        const SETTINGS_KEY = 'bml:v2:settings';
        const INDEX_KEY = 'bml:v2:index';
        const MIGRATION_KEY = 'bml:v2:migrated';
        const LEGACY_PREFIX = 'bml_data_';
        const MAX_VIDEOS = 200;
        const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
        const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
        const SEARCH_TIMEOUT_MS = 12000;
        const SOURCE_TIMEOUT_MS = 8000;
        // Skor minimum untuk hasil pencarian otomatis. Di bawah ini hasil
        // dianggap bukan lagu yang sedang diputar.
        const AUTO_MIN_SCORE = 0.5;
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
        let offsetSaveTimer = null;
        let pendingOffset = null;
        let editorInitialText = '';
        let editorCloseArmed = false;
        let editorCloseTimer = null;
        let editorDraftTimer = null;
        let loadingTimer = null;
        let loadingStartedAt = 0;
        let cacheClearArmed = false;
        let cacheClearTimer = null;
        // Batch 4: segmen lagu untuk video kompilasi.
        let segments = [];
        let segmentsEdited = false;
        let segmentsDisabled = false;
        let activeSegmentIndex = -1;
        let segmentBase = 0;
        let segmentSwitchTimer = null;
        let prefetchInFlight = {};

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
                latinData: null,
                segments: []
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
                        latinData: null,
                        segments: []
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

        async function pruneExpiredCache() {
            try {
                const all = await chrome.storage.local.get(null);
                const index = all[INDEX_KEY] || {};
                let indexChanged = false;
                const removals = [];
                const updates = {};
                const draftRemovals = [];

                for (const key of Object.keys(all)) {
                    if (key.indexOf(DRAFT_PREFIX) === 0) {
                        const draft = all[key];
                        const fresh =
                            draft &&
                            draft.updatedAt &&
                            Date.now() - draft.updatedAt < DRAFT_TTL_MS;
                        if (!fresh) draftRemovals.push(key);
                        continue;
                    }
                    if (!key.startsWith(STORAGE_PREFIX)) continue;
                    const videoId = key.slice(STORAGE_PREFIX.length);
                    const data = all[key];
                    if (!data || typeof data !== 'object') continue;
                    // Lirik manual buatan user jangan pernah dihapus otomatis.
                    if (data.manualData) continue;
                    if (!data.autoData || isCacheFresh(data.autoCachedAt)) continue;

                    // Cache otomatis sudah lewat 30 hari. Offset tetap
                    // dipertahankan; latinData dibuang karena kuncinya
                    // bergantung pada lirik yang sudah kedaluwarsa.
                    const next = Object.assign({}, data, {
                        autoData: null,
                        autoCachedAt: 0,
                        latinData: null
                    });
                    if (next.offset) {
                        updates[key] = next;
                    } else {
                        removals.push(key);
                        if (index[videoId] !== undefined) {
                            delete index[videoId];
                            indexChanged = true;
                        }
                    }
                }

                if (removals.length > 0) await chrome.storage.local.remove(removals);
                if (draftRemovals.length > 0) await chrome.storage.local.remove(draftRemovals);
                if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
                if (indexChanged) await chrome.storage.local.set({ [INDEX_KEY]: index });
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal membersihkan cache kedaluwarsa', error);
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

            // Channel soundtrack/OST ("Animania Soundtrack") bukan nama
            // penyanyi. Channel resmi seperti "FLOW Official YouTube Channel"
            // tetap memakai nama artisnya ("FLOW").
            const channelInfo = Core.parseChannelArtist(artist);
            const genericArtist = channelInfo.generic;

            // Parsing OST dilakukan sebelum tanda kurung dibersihkan karena
            // penanda seri sering berada di dalam kurung, mis.
            // "Butterfly (Digimon OST)".
            const ost = Core.parseOstTitle(title.replace(/【[^】]*】/g, ' '));
            if (ost.series) title = ost.title;

            title = title.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ');
            // Tanda kutip CJK dipakai sebagai pemisah judul, bukan bagian lagu.
            title = title.replace(/[「」『』]/g, ' ');
            // Buang penanda tayangan yang bukan bagian judul lagu.
            title = title.replace(/\b(?:special\s+)?anime\s+(?:movie|special|version|ver)\b/gi, ' ');
            title = title.replace(/\b(?:special|animated)\s+movie\b/gi, ' ');
            title = title.replace(/\b(?:movie|anime)\s+(?:version|ver|size)\b/gi, ' ');
            title = title.replace(
                /\b(official\s+)?(lyrics?\s+video|music\s+video|promotion\s+video|video|audio|live|cover|performance)\b/gi,
                ' '
            );
            title = title.replace(/\b(feat|ft)\.?\s+.*$/i, ' ');

            const dashParts = title.split(/\s+[-–—]\s+/);
            // Judul yang diawali nama artis ("FLOW - GO!!!" atau
            // "FLOW「GO!!!」") dipangkas supaya pencarian memakai judul lagu.
            const knownArtist = channelInfo.artist;
            if (knownArtist && !ost.series) {
                const prefix = new RegExp(
                    '^\\s*' + Core.escapeRegExp(knownArtist) + '\\b[\\s:\\-–—|]*',
                    'i'
                );
                const stripped = title.replace(prefix, '').trim();
                if (stripped) title = stripped;
            }
            // Untuk channel OST, potongan sebelum tanda hubung biasanya nama
            // seri, bukan artis. Jangan jadikan artis palsu.
            if (!ost.series && !genericArtist && dashParts.length > 1) {
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
                title = Core.stripArtistFromTitle(title, artist);
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

            return {
                title: title,
                artist: artist,
                // Nama artis yang dipakai untuk pencarian. Kosong untuk
                // channel soundtrack supaya skor memakai nama seri.
                searchArtist: genericArtist ? '' : channelInfo.artist || artist,
                series: ost.series,
                duration: duration
            };
        }

        // ==========================================
        // SEGMEN VIDEO KOMPILASI (Batch 4)
        // ==========================================
        // Video kompilasi/mix berisi banyak lagu dalam satu video. Batas lagu
        // diambil dari Chapters YouTube, lalu fallback ke timestamp di deskripsi.
        // Hasil deteksi dipakai untuk berpindah lagu otomatis, offset per lagu,
        // dan penandaan lagu manual dari PiP.
        const CHAPTER_NODE_LIMIT = 20000;
        const PAGE_BRIDGE_SOURCE = 'bml-page-bridge';
        let segmentsCache = { key: '', segments: [] };
        // Chapters dari MAIN-world bridge (lihat page-bridge.js).
        let chapterBridge = { videoId: '', chapters: [], at: 0 };
        let chapterRequestedFor = '';
        let bridgeUpgradeSignature = '';

        function getPlayerResponse() {
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
                    return appData.player.args.raw_player_response;
                }
                return appData.playerResponse || null;
            } catch (error) {
                // struktur data YouTube bisa berubah: abaikan
                return null;
            }
        }

        // Cari node `macroMarkersListItemRenderer` (Chapters) tanpa menelusuri
        // seluruh objek raksasa YouTube.
        function collectChapterEntries(root) {
            if (!Segments || !root || typeof root !== 'object') return [];
            const found = [];
            const stack = [{ node: root, depth: 0 }];
            let visited = 0;

            while (stack.length > 0) {
                const item = stack.pop();
                if (!item.node || typeof item.node !== 'object') continue;
                if (item.depth > 14) continue;
                visited += 1;
                if (visited > CHAPTER_NODE_LIMIT) break;

                if (Array.isArray(item.node)) {
                    for (const child of item.node) {
                        if (child && typeof child === 'object') {
                            stack.push({ node: child, depth: item.depth + 1 });
                        }
                    }
                    continue;
                }

                if (item.node.macroMarkersListItemRenderer) {
                    found.push(item.node.macroMarkersListItemRenderer);
                    continue;
                }

                for (const key of Object.keys(item.node)) {
                    const child = item.node[key];
                    if (child && typeof child === 'object') {
                        stack.push({ node: child, depth: item.depth + 1 });
                    }
                }
            }

            return found;
        }

        function getVideoChapterData() {
            if (!Segments) return [];

            // Utamakan data dari page-bridge: content script tidak bisa membaca
            // playerResponse/ytInitialData milik halaman (isolated world).
            const videoId = getVideoId();
            if (
                chapterBridge.videoId &&
                chapterBridge.videoId === videoId &&
                chapterBridge.chapters.length >= 2
            ) {
                return chapterBridge.chapters;
            }

            const player = getPlayerResponse();
            if (player) {
                const fromPlayer = Segments.normalizeChapters(
                    collectChapterEntries(player.engagementPanels)
                );
                if (fromPlayer.length >= 2) return fromPlayer;
            }

            try {
                const fromPage = Segments.normalizeChapters(
                    collectChapterEntries(window.ytInitialData)
                );
                if (fromPage.length >= 2) return fromPage;
            } catch (error) {
                // ytInitialData bisa berubah/ tidak tersedia: abaikan
            }

            return [];
        }

        function getVideoDescriptionText() {
            const element = document.querySelector(
                '#description-inline-expander, ytd-text-inline-expander#description-inline-expander, #description'
            );
            const fromPage = element ? element.innerText || element.textContent || '' : '';
            if (fromPage.trim()) return fromPage;

            const player = getPlayerResponse();
            const details = player && player.videoDetails;
            return (details && details.shortDescription) || '';
        }

        function segmentsSignature(segments) {
            return (segments || [])
                .map((segment) =>
                    [
                        segment.id,
                        Math.round(Number(segment.start) * 10) / 10,
                        Math.round(Number(segment.end) * 10) / 10,
                        segment.title || '',
                        segment.artist || '',
                        segment.source || ''
                    ].join('|')
                )
                .join('\n');
        }

        // ==========================================
        // JEMBATAN CHAPTERS (MAIN WORLD)
        // ==========================================
        function requestPageChapters() {
            try {
                window.postMessage({ source: 'bml-content', type: 'chapters' }, '*');
            } catch (error) {
                // abaikan
            }
        }

        function bridgeDataReady(videoId) {
            return Boolean(videoId) && chapterBridge.videoId === videoId;
        }

        // Tunggu jawaban page-bridge sekali per video. Untuk video yang tidak
        // punya chapters, bridge tetap mengirim daftar kosong.
        async function ensureChapterData(videoId, timeoutMs) {
            if (!videoId) return;
            if (bridgeDataReady(videoId)) return;
            if (chapterRequestedFor === videoId) return;
            chapterRequestedFor = videoId;
            requestPageChapters();

            await new Promise((resolve) => {
                let settled = false;
                let timer = null;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    window.removeEventListener('message', listener);
                    resolve();
                };
                const listener = (event) => {
                    if (event.source !== window) return;
                    const data = event.data;
                    if (!data || data.source !== PAGE_BRIDGE_SOURCE) return;
                    if (data.type !== 'chapters') return;
                    if (data.videoId && data.videoId !== videoId) return;
                    finish();
                };
                window.addEventListener('message', listener);
                timer = setTimeout(finish, timeoutMs || 700);
            });
        }

        // Kalau chapters baru datang setelah mode video panjang aktif, ganti
        // placeholder dengan segmen lagu sebenarnya tanpa menimpa hasil edit.
        function maybeUpgradeLongVideo(chapters) {
            if (!pipWindow) return;
            if (!Array.isArray(chapters) || chapters.length < 2) return;
            if (segmentsEdited || segmentsDisabled) return;
            if (!(segments.length === 1 && segments[0] && segments[0].source === 'long-video')) {
                return;
            }
            if (
                tapState ||
                byId('editor-panel') ||
                byId('segment-panel') ||
                byId('segment-list-panel')
            ) {
                return;
            }

            const signature = chapters
                .map((chapter) => Math.round(Number(chapter.start) * 10) + '|' + (chapter.title || ''))
                .join('\n');
            if (signature === bridgeUpgradeSignature) return;
            bridgeUpgradeSignature = signature;

            segmentsCache = { key: '', segments: [] };
            loadLyricsToPiP(null, null);
            toast('Chapters terdeteksi: memuat daftar lagu');
        }

        function setupChapterBridge() {
            window.addEventListener('message', (event) => {
                if (event.source !== window) return;
                const data = event.data;
                if (!data || data.source !== PAGE_BRIDGE_SOURCE || data.type !== 'chapters') {
                    return;
                }

                const current = getVideoId();
                if (data.videoId && current && data.videoId !== current) return;

                chapterBridge = {
                    videoId: data.videoId || current || '',
                    chapters: Array.isArray(data.chapters) ? data.chapters : [],
                    at: Date.now()
                };
                segmentsCache.key = '';
                maybeUpgradeLongVideo(chapterBridge.chapters);
            });
        }

        function normalizeStoredSegments(list) {
            if (!Array.isArray(list)) return [];
            return list
                .filter(
                    (segment) =>
                        segment &&
                        Number.isFinite(Number(segment.start)) &&
                        Number.isFinite(Number(segment.end))
                )
                .map((segment) => ({
                    start: Number(segment.start),
                    end: Number(segment.end),
                    title: typeof segment.title === 'string' ? segment.title : '',
                    artist: typeof segment.artist === 'string' ? segment.artist : '',
                    source: segment.source || 'auto',
                    offset: Number(segment.offset) || 0,
                    manualData: segment.manualData || null,
                    autoData: segment.autoData || null,
                    autoCachedAt: Number(segment.autoCachedAt) || 0,
                    latinData: segment.latinData || null,
                    edited: Boolean(segment.edited)
                }))
                .sort((a, b) => a.start - b.start)
                .map((segment, index) => Object.assign(segment, { id: 's' + index }));
        }

        // Pertahankan lirik/offset segmen lama saat batas lagu dideteksi ulang.
        function mergeSegments(previous, fresh) {
            const stored = normalizeStoredSegments(previous);
            const normalize = (value) => String(value || '').trim().toLowerCase();
            return fresh.map((segment) => {
                const match =
                    stored.find((item) => Math.abs(item.start - segment.start) <= 1.5) ||
                    (segment.title
                        ? stored.find(
                              (item) =>
                                  normalize(item.title) === normalize(segment.title) &&
                                  normalize(item.artist) === normalize(segment.artist)
                          )
                        : null) ||
                    null;
                if (!match) {
                    return Object.assign(
                        {
                            offset: 0,
                            manualData: null,
                            autoData: null,
                            autoCachedAt: 0,
                            latinData: null
                        },
                        segment
                    );
                }

                const merged = Object.assign({}, segment, {
                    offset: match.offset,
                    manualData: match.manualData,
                    autoData: match.autoData,
                    autoCachedAt: match.autoCachedAt,
                    latinData: match.latinData
                });
                if (match.edited) {
                    merged.title = match.title;
                    merged.artist = match.artist;
                    merged.edited = true;
                }
                return merged;
            });
        }

        function getVideoSegments(meta, saved) {
            if (!Segments) return [];

            const stored = saved && Array.isArray(saved.segments) ? saved.segments : [];
            if (saved && saved.segmentsDisabled) return [];
            // Kalau pengguna sudah pernah menandai/mengedit, jangan ditimpa
            // hasil deteksi otomatis.
            if (saved && saved.segmentsEdited) {
                return normalizeStoredSegments(stored);
            }

            const videoId = getVideoId() || '';
            const duration = Math.round(Number(meta && meta.duration) || 0);
            const key = videoId + ':' + duration;

            if (segmentsCache.key !== key) {
                const chapterEntries = getVideoChapterData();
                const description = getVideoDescriptionText();

                let entries = chapterEntries;
                let source = 'chapter';
                if (entries.length < 2) {
                    entries = Segments.parseTracklist(description, { duration: duration });
                    source = 'description';
                }

                let detected =
                    entries.length >= 2
                        ? Segments.buildSegments(entries, duration, {
                              source: source,
                              channel: (meta && (meta.searchArtist || meta.artist)) || ''
                          })
                        : [];

                if (
                    detected.length > 0 &&
                    !Segments.isCompilationVideo({
                        title: (meta && meta.title) || '',
                        description: description,
                        duration: duration,
                        segments: detected
                    })
                ) {
                    detected = [];
                }

                segmentsCache = { key: key, segments: detected, source: source };
                if (detected.length > 0) {
                    console.info(
                        'Brave Mini Lyrics: ' +
                            detected.length +
                            ' segmen lagu terdeteksi (' +
                            source +
                            ').'
                    );
                }
            }

            if (segmentsCache.segments.length === 0) {
                const storedSegments = normalizeStoredSegments(stored);
                if (storedSegments.length > 0) return storedSegments;

                // Video panjang tanpa Chapters/tracklist: jangan cari lirik
                // memakai judul video (hampir pasti lagu yang salah). Masuk
                // mode penandaan lagu manual; placeholder sengaja tanpa judul.
                if (Segments.shouldUseLongVideoMode(meta)) {
                    console.info(
                        'Brave Mini Lyrics: mode video panjang aktif (tanpa daftar lagu).'
                    );
                    return [Segments.buildLongVideoSegment(meta && meta.duration)];
                }
                return [];
            }
            return mergeSegments(stored, segmentsCache.segments);
        }

        function saveSegmentsNow(options) {
            const opts = options || {};
            const videoId = getVideoId();
            if (!videoId) return;
            if (opts.edited) segmentsEdited = true;
            if (opts.disabled !== undefined) {
                segmentsDisabled = Boolean(opts.disabled);
            } else if (segments.length > 0) {
                segmentsDisabled = false;
            }
            currentVideoData = Object.assign({}, currentVideoData, {
                segments: segments,
                segmentsEdited: segmentsEdited,
                segmentsDisabled: segmentsDisabled
            });
            saveVideoData(videoId, {
                segments: segments,
                segmentsEdited: segmentsEdited,
                segmentsDisabled: segmentsDisabled,
                segmentsUpdatedAt: Date.now()
            });
        }

        function activeSegment() {
            if (activeSegmentIndex < 0) return null;
            return segments[activeSegmentIndex] || null;
        }

        function segmentDisplayTitle(segment) {
            if (!segment) return '';
            const title = segment.title || '';
            const artist = segment.artist || '';
            if (title && artist) return title + ' — ' + artist;
            return title || artist || '';
        }

        function currentSegmentSaved() {
            const segment = activeSegment();
            if (!segment) return null;
            return {
                offset: Number(segment.offset) || 0,
                manualData: segment.manualData || null,
                autoData: segment.autoData || null,
                autoCachedAt: Number(segment.autoCachedAt) || 0,
                // Cache romanisasi disimpan per lagu; fallback ke cache video
                // untuk data lama sebelum Batch 4.
                latinData:
                    segment.latinData ||
                    (currentVideoData && currentVideoData.latinData) ||
                    null
            };
        }

        function activeLatinData() {
            const segment = activeSegment();
            if (segment) return segment.latinData || null;
            return (currentVideoData && currentVideoData.latinData) || null;
        }

        // Simpan perubahan lirik ke segmen aktif (atau ke video untuk single-track).
        function applyLyricsPatch(patch) {
            const segment = activeSegment();
            const videoId = getVideoId();
            if (!segment || !videoId) {
                currentVideoData = Object.assign({}, currentVideoData, patch);
                if (videoId) return saveVideoData(videoId, patch);
                return Promise.resolve();
            }
            Object.assign(segment, patch);
            currentVideoData = Object.assign({}, currentVideoData, { segments: segments });
            return saveVideoData(videoId, { segments: segments });
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

        function fetchSource(source, payload, signal) {
            return new Promise((resolve) => {
                let settled = false;
                let timer = null;

                function cleanup() {
                    if (timer !== null) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    if (signal) signal.removeEventListener('abort', onAbort);
                }

                function finish(value) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(value);
                }

                function onAbort() {
                    finish([]);
                }

                if (signal) {
                    if (signal.aborted) {
                        finish([]);
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }

                timer = setTimeout(() => finish([]), SOURCE_TIMEOUT_MS);
                try {
                    chrome.runtime.sendMessage(
                        { action: 'lyrics_source', source: source, payload: payload },
                        (response) => {
                            if (chrome.runtime.lastError || !response || !response.success) {
                                finish([]);
                                return;
                            }
                            finish(Array.isArray(response.tracks) ? response.tracks : []);
                        }
                    );
                } catch (error) {
                    finish([]);
                }
            });
        }

        async function searchAuto(meta, signal, onProgress) {
            const report = typeof onProgress === 'function' ? onProgress : function () {};

            report('Mencoba pencocokan langsung…', 0.05);
            const exact = await lrclibGet(meta, signal);
            if (exact) {
                return { track: exact, score: 1, source: 'get' };
            }

            const queries = [];
            // Prioritas: artis asli, lalu nama seri (untuk channel OST),
            // baru judul saja. Contoh "Digimon OST - Butterfly" harus
            // dicari sebagai "Butterfly Digimon".
            if (meta.title && meta.artist) queries.push(meta.title + ' ' + meta.artist);
            if (meta.title && meta.series) queries.push(meta.title + ' ' + meta.series);
            if (meta.title) queries.push(meta.title);
            if (meta.title && /[|~]/.test(meta.title)) {
                const parts = meta.title.split(/[|~]/).map((part) => part.trim()).filter((part) => part.length > 2);
                for (let i = parts.length - 1; i >= 0; i -= 1) queries.push(parts[i]);
            }

            let collected = [];
            for (let i = 0; i < queries.length; i += 1) {
                const query = queries[i];
                report(
                    'Mencari di lrclib: ' + query,
                    0.1 + ((i + 1) / queries.length) * 0.45
                );
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
                    // Jalankan paralel: kalau satu sumber lambat, sumber lain
                    // tidak ikut menunggu dan total waktu pencarian lebih pendek.
                    report('Mencari di NetEase & QQ Music…', 0.7);
                    const fallbackTracks = await Promise.all(
                        sources.map((source) =>
                            fetchSource(source.id, { query: fallbackQuery }, signal)
                        )
                    );
                    fallbackTracks.forEach((tracks) => {
                        if (tracks.length > 0) collected = collected.concat(tracks);
                    });
                    const extra = Core.pickBestTrack(dedupeTracks(collected), meta);
                    if (extra && (!best || extra.score > best.score)) best = extra;
                }
            }

            if (!best) return null;
            // Jangan tampilkan hasil yang jelas bukan lagu ini. Lebih baik
            // "tidak ditemukan" daripada lirik lagu lain (mis. GO! - Cortis).
            if (best.score < AUTO_MIN_SCORE) {
                console.warn(
                    'Brave Mini Lyrics: skor pencocokan rendah (' +
                        best.score.toFixed(2) +
                        '), hasil diabaikan: ' +
                        (best.track.trackName || '?')
                );
                return null;
            }
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
            for (let i = 0; i < queries.length; i += 1) {
                report(
                    'Mencari di lrclib: ' + queries[i],
                    0.1 + ((i + 1) / queries.length) * 0.45
                );
                const results = await lrclibSearch(queries[i], signal);
                collected = collected.concat(results);
                if (collected.length >= 30) break;
            }

            const sources = [
                { id: 'netease', label: 'NetEase' },
                { id: 'qq', label: 'QQ Music' }
            ];
            report('Mencari di NetEase & QQ Music…', 0.7);
            const fallbackTracks = await Promise.all(
                sources.map((source) =>
                    fetchSource(source.id, { query: parsed.query }, signal)
                )
            );
            fallbackTracks.forEach((tracks) => {
                if (tracks.length > 0) collected = collected.concat(tracks);
            });

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
                maybeSwitchSegment();
                updateLyricsHighlight();
            });
        }

        // Pindah lagu otomatis saat waktu video melewati batas segmen.
        function maybeSwitchSegment() {
            if (!videoElement || segments.length === 0) return;
            if (segmentSwitchTimer !== null) return;
            // Jangan rebut editor/tap-sync yang sedang dipakai pengguna.
            if (tapState || byId('editor-panel') || byId('segment-panel')) return;

            const index = Segments.findSegmentIndex(segments, videoElement.currentTime);
            if (index === activeSegmentIndex) return;

            if (index < 0) {
                if (activeSegmentIndex !== -1) {
                    activeSegmentIndex = -1;
                    segmentBase = 0;
                    renderSegmentWaiting();
                }
                return;
            }

            clearTimeout(segmentSwitchTimer);
            segmentSwitchTimer = setTimeout(() => {
                segmentSwitchTimer = null;
                if (!videoElement || segments.length === 0) return;
                const resolved = Segments.findSegmentIndex(segments, videoElement.currentTime);
                if (resolved === activeSegmentIndex) return;
                if (resolved < 0) {
                    activeSegmentIndex = -1;
                    segmentBase = 0;
                    renderSegmentWaiting();
                    return;
                }
                loadLyricsToPiP(null, null, { segmentIndex: resolved });
            }, 260);
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
            boundVideoElement.addEventListener('seeked', onTimeUpdate);
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
            boundVideoElement.removeEventListener('seeked', onTimeUpdate);
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

            const time = videoElement.currentTime - segmentBase - lyricsTimeOffset;
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
                    <button type="button" class="ctrl-btn" id="ctrl-segment" title="Tandai lagu baru di posisi ini">＋</button>
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
                    <button type="button" class="sync-btn" id="btn-clear-cache" title="Hapus cache lirik otomatis (lirik manual & offset tetap)">🧹 Hapus cache</button>
                    <span class="cache-usage" id="cache-usage"></span>
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

            const btnClearCache = byId('btn-clear-cache');
            if (btnClearCache) btnClearCache.addEventListener('click', clearAutoCache);

            if (byId('cache-usage')) updateCacheUsage();

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

            const btnSegment = byId('ctrl-segment');
            if (btnSegment) btnSegment.addEventListener('click', openNewSegmentDialog);

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

        // ==========================================
        // SEGMEN: BAR, NAVIGASI, DAN EDITOR
        // ==========================================
        function renderSegmentBar() {
            if (!pipWindow) return;
            const bar = byId('segment-bar');
            if (!bar) return;

            if (segments.length === 0) {
                bar.hidden = true;
                bar.innerHTML = '';
                return;
            }

            bar.hidden = false;
            const segment = activeSegment();
            const counter =
                activeSegmentIndex >= 0
                    ? 'Lagu ' + (activeSegmentIndex + 1) + '/' + segments.length
                    : segments.length + ' lagu';
            const label = segment
                ? segmentDisplayTitle(segment) ||
                  (segments.length === 1 && segment.source === 'long-video'
                      ? 'Tandai lagu dengan ＋'
                      : 'Tanpa judul')
                : 'Menunggu lagu…';
            const prevDisabled = activeSegmentIndex <= 0 ? ' disabled' : '';
            const nextDisabled =
                activeSegmentIndex >= segments.length - 1 ? ' disabled' : '';

            bar.innerHTML = `
                <button type="button" class="seg-btn" id="seg-prev" title="Lagu sebelumnya"${prevDisabled}>‹</button>
                <button type="button" class="seg-label" id="seg-open" title="Daftar lagu">
                    <span class="seg-counter">${escapeHtml(counter)}</span>
                    <span class="seg-title">${escapeHtml(label)}</span>
                    <span class="seg-caret" aria-hidden="true">▾</span>
                </button>
                <button type="button" class="seg-btn" id="seg-edit" title="Edit lagu ini">✎</button>
                <button type="button" class="seg-btn" id="seg-next" title="Lagu berikutnya"${nextDisabled}>›</button>
                <button type="button" class="seg-btn" id="seg-add" title="Tandai lagu baru di posisi ini">＋</button>
            `;

            const bind = (id, handler) => {
                const element = byId(id);
                if (element) element.addEventListener('click', handler);
            };
            bind('seg-prev', () => segmentGoTo(Math.max(0, activeSegmentIndex - 1)));
            bind('seg-next', () =>
                segmentGoTo(Math.min(segments.length - 1, activeSegmentIndex + 1))
            );
            bind('seg-open', openSegmentList);
            bind('seg-edit', openSegmentEditor);
            bind('seg-add', openNewSegmentDialog);
            updateSegmentListActive();
        }

        // Daftar lagu: klik judul lagu untuk melompat ke waktu mulainya.
        function openSegmentList() {
            if (!pipWindow) return;
            closeSegmentList();
            closeSegmentDialog();

            const doc = pipWindow.document;
            const panel = doc.createElement('div');
            panel.id = 'segment-list-panel';
            panel.className = 'editor-panel segment-panel segment-list-panel';
            panel.innerHTML = `
                <div class="editor-head">
                    <span>Daftar Lagu (${segments.length})</span>
                    <button type="button" class="editor-close" id="segment-list-close" title="Tutup">✕</button>
                </div>
                <div class="seg-list" id="seg-list"></div>
                <div class="editor-actions">
                    <button type="button" class="sync-btn" id="segment-list-add">＋ Tandai lagu di posisi ini</button>
                </div>
                <p class="editor-hint">Klik lagu untuk melompat ke waktunya.</p>
            `;
            doc.body.appendChild(panel);
            renderSegmentList();

            const list = doc.getElementById('seg-list');
            if (list) {
                list.querySelectorAll('.seg-item').forEach((row) => {
                    row.addEventListener('click', () => {
                        const index = Number(row.dataset.index);
                        closeSegmentList();
                        segmentGoTo(index);
                    });
                });
            }

            const closeButton = doc.getElementById('segment-list-close');
            if (closeButton) closeButton.addEventListener('click', closeSegmentList);

            const addButton = doc.getElementById('segment-list-add');
            if (addButton) {
                addButton.addEventListener('click', () => {
                    closeSegmentList();
                    openNewSegmentDialog();
                });
            }
        }

        function renderSegmentList() {
            if (!pipWindow) return;
            const list = byId('seg-list');
            if (!list) return;

            list.innerHTML = segments
                .map((segment, index) => {
                    const title =
                        segment.title ||
                        (segment.source === 'long-video'
                            ? 'Lagu belum ditandai'
                            : 'Tanpa judul');
                    const artist = segment.artist || '';
                    const active = index === activeSegmentIndex;
                    return `
                        <button type="button" class="seg-item${active ? ' is-active' : ''}"
                            data-index="${index}"${active ? ' aria-current="true"' : ''}>
                            <span class="seg-item-index">${active ? '▶' : index + 1}</span>
                            <span class="seg-item-text">
                                <span class="seg-item-title">${escapeHtml(title)}</span>
                                ${
                                    artist
                                        ? `<span class="seg-item-artist">${escapeHtml(artist)}</span>`
                                        : ''
                                }
                            </span>
                            <span class="seg-item-time">${escapeHtml(
                                Core.formatTime(segment.start)
                            )}</span>
                        </button>
                    `;
                })
                .join('');
        }

        function updateSegmentListActive() {
            if (!pipWindow) return;
            const panel = byId('segment-list-panel');
            if (!panel) return;

            const rows = panel.querySelectorAll('.seg-item');
            rows.forEach((row) => {
                const active = Number(row.dataset.index) === activeSegmentIndex;
                row.classList.toggle('is-active', active);
                if (active) row.setAttribute('aria-current', 'true');
                else row.removeAttribute('aria-current');
                const indexLabel = row.querySelector('.seg-item-index');
                if (indexLabel) {
                    indexLabel.textContent = active ? '▶' : String(Number(row.dataset.index) + 1);
                }
            });
        }

        function closeSegmentList() {
            if (!pipWindow) return;
            const panel = byId('segment-list-panel');
            if (panel) panel.remove();
        }

        function segmentGoTo(index) {
            if (index < 0 || index >= segments.length) return;
            if (videoElement) videoElement.currentTime = Math.max(0, segments[index].start + 0.05);
            loadLyricsToPiP(null, null, { segmentIndex: index });
        }

        function renderSegmentWaiting() {
            if (!pipWindow) return;
            stopLoadingProgress();
            const body = pipWindow.document.body;
            body.classList.remove('is-loading', 'results-mode', 'showing-results');

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            currentHighlightIndex = -1;

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            header.innerHTML = `
                <div class="header-inner">
                    <p class="title">Menunggu lagu berikutnya…</p>
                    <p class="artist">Video ini berisi ${segments.length} lagu</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup('')}
                </div>
            `;
            container.innerHTML =
                '<p class="loading">Lirik muncul otomatis saat lagu berikutnya dimulai.</p>';

            bindHeaderEvents({ synced: false, fallbackSearchText: '' });
            renderSegmentBar();
            applyFontScale();

            // Siapkan lirik lagu berikutnya selagi menunggu.
            const time = videoElement ? videoElement.currentTime : 0;
            for (let i = 0; i < segments.length; i += 1) {
                if (segments[i].start >= time) {
                    prefetchSegment(i);
                    break;
                }
            }
        }

        function renderSegmentUntitled() {
            if (!pipWindow) return;
            stopLoadingProgress();
            const body = pipWindow.document.body;
            body.classList.remove('is-loading', 'results-mode', 'showing-results');

            isSyncedLyrics = false;
            parsedLyrics = [];
            lineElements = [];
            currentHighlightIndex = -1;

            const header = byId('header');
            const container = byId('lyrics-container');
            if (!header || !container) return;

            const meta = getVideoMetadata();
            const longVideo =
                segments.length === 1 && segments[0] && !segments[0].title;
            const videoSearchText = meta.title
                ? meta.title + (meta.artist ? ' - ' + meta.artist : '')
                : '';

            header.innerHTML = longVideo
                ? `
                <div class="header-inner">
                    <p class="title">Mode video panjang</p>
                    <p class="artist">Durasi ${escapeHtml(
                        Core.formatTime(meta.duration) || 'video ini'
                    )} terlalu panjang untuk satu lagu</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup(videoSearchText)}
                </div>
            `
                : `
                <div class="header-inner">
                    <p class="title">Lagu tanpa judul</p>
                    <p class="artist">Isi judul lagu supaya liriknya bisa dicari</p>
                    ${playerControlsMarkup()}
                    ${searchBoxMarkup('')}
                </div>
            `;
            container.innerHTML = longVideo
                ? '<p class="loading">Tandai tiap lagu dengan <b>＋</b> tepat saat lagu baru dimulai, lalu isi judulnya. Lirik akan diganti otomatis per lagu.<br><br>Kalau video ini ternyata satu lagu panjang, buka 🔍 (judul video sudah terisi) lalu tekan <b>Cari</b>.</p>'
                : '<p class="loading">Tekan ✎ pada bar lagu untuk mengisi judul dan artis, atau 🔍 untuk mencari manual.</p>';

            bindHeaderEvents({
                synced: false,
                fallbackSearchText: longVideo ? videoSearchText : ''
            });
            renderSegmentBar();
            applyFontScale();
        }

        function openNewSegmentDialog() {
            if (!pipWindow || !videoElement) return;
            openSegmentDialog({ mode: 'new', start: videoElement.currentTime });
        }

        function openSegmentEditor() {
            if (!pipWindow) return;
            closeSegmentList();
            if (!activeSegment()) {
                openNewSegmentDialog();
                return;
            }
            openSegmentDialog({ mode: 'edit', index: activeSegmentIndex });
        }

        function closeSegmentDialog() {
            if (!pipWindow) return;
            const panel = byId('segment-panel');
            if (panel) panel.remove();
        }

        function openSegmentDialog(options) {
            if (!pipWindow) return;
            closeEditor(true);
            closeSegmentDialog();
            closeSegmentList();

            const opts = options || {};
            const isNew = opts.mode !== 'edit';
            const index = isNew ? -1 : Number(opts.index);
            const segment = isNew ? null : segments[index];
            if (!isNew && !segment) return;

            const startSeconds = isNew
                ? Number(opts.start) || (videoElement ? videoElement.currentTime : 0)
                : segment.start;

            const doc = pipWindow.document;
            const panel = doc.createElement('div');
            panel.id = 'segment-panel';
            panel.className = 'editor-panel segment-panel';
            panel.dataset.mode = isNew ? 'new' : 'edit';
            panel.dataset.index = String(index);
            panel.dataset.start = String(startSeconds);
            panel.innerHTML = `
                <div class="editor-head">
                    <span>${isNew ? 'Tandai Lagu Baru' : 'Edit Lagu ' + (index + 1)}</span>
                    <button type="button" class="editor-close" id="segment-close" title="Tutup">✕</button>
                </div>
                <label class="seg-field">Judul
                    <input type="text" id="segment-title" class="seg-input" autocomplete="off"
                        spellcheck="false" placeholder="Judul lagu"
                        value="${escapeHtml(segment ? segment.title : '')}">
                </label>
                <label class="seg-field">Artis
                    <input type="text" id="segment-artist" class="seg-input" autocomplete="off"
                        spellcheck="false" placeholder="Nama artis (opsional)"
                        value="${escapeHtml(segment ? segment.artist : '')}">
                </label>
                <label class="seg-field">Mulai
                    <input type="text" id="segment-start" class="seg-input" autocomplete="off"
                        spellcheck="false" placeholder="mm:ss"
                        value="${escapeHtml(Core.formatTime(startSeconds))}">
                </label>
                <div class="editor-actions">
                    ${
                        isNew
                            ? ''
                            : '<button type="button" class="sync-btn seg-delete" id="segment-delete">Hapus</button>'
                    }
                    <button type="button" class="sync-btn editor-save" id="segment-save">Simpan</button>
                </div>
                <p class="editor-hint">${
                    isNew
                        ? 'Lagu baru dimulai di posisi ini; segmen sebelumnya otomatis dipotong. Judul dipakai untuk mencari lirik.'
                        : 'Ubah "Mulai" untuk menggeser batas lagu. Hapus akan menggabungkan waktunya ke lagu sebelumnya.'
                }</p>
            `;
            doc.body.appendChild(panel);

            const bind = (id, handler) => {
                const element = doc.getElementById(id);
                if (element) element.addEventListener('click', handler);
            };
            bind('segment-close', closeSegmentDialog);
            bind('segment-save', saveSegmentDialog);
            if (!isNew) bind('segment-delete', deleteSegmentDialog);

            panel.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    saveSegmentDialog();
                }
            });

            const titleInput = doc.getElementById('segment-title');
            if (titleInput) {
                titleInput.focus();
                titleInput.select();
            }
        }

        function saveSegmentDialog() {
            if (!pipWindow) return;
            const doc = pipWindow.document;
            const panel = doc.getElementById('segment-panel');
            if (!panel) return;

            const isNew = panel.dataset.mode === 'new';
            const index = Number(panel.dataset.index);
            const titleInput = doc.getElementById('segment-title');
            const artistInput = doc.getElementById('segment-artist');
            const startInput = doc.getElementById('segment-start');
            const title = titleInput ? titleInput.value.trim() : '';
            const artist = artistInput ? artistInput.value.trim() : '';

            if (!title) {
                toast('Judul lagu masih kosong');
                if (titleInput) titleInput.focus();
                return;
            }

            const duration =
                videoElement && isFinite(videoElement.duration) ? videoElement.duration : 0;
            const parsedStart = Segments.parseTimeToken(startInput ? startInput.value : '');
            const fallbackStart = isNew
                ? videoElement
                    ? videoElement.currentTime
                    : 0
                : segments[index]
                  ? segments[index].start
                  : 0;
            const start = parsedStart === null ? fallbackStart : parsedStart;

            if (isNew) {
                const meta = getVideoMetadata();
                segments = Segments.addSegment(
                    segments,
                    { start: start, title: title, artist: artist, source: 'manual' },
                    {
                        duration: duration,
                        fallbackTitle: meta.title,
                        fallbackArtist: meta.artist
                    }
                );
                const target = Segments.findSegmentIndex(
                    segments,
                    duration > 0 ? Math.min(start, Math.max(0, duration - 1)) : start
                );
                const targetSegment = target >= 0 ? segments[target] : null;
                saveSegmentsNow({ edited: true });
                closeSegmentDialog();
                if (videoElement) {
                    const seekTo = targetSegment ? targetSegment.start : start;
                    videoElement.currentTime = Math.max(0, seekTo + 0.05);
                }
                loadLyricsToPiP(null, null, { segmentIndex: target >= 0 ? target : 0 });
                toast('Lagu ditandai');
                return;
            }

            const originalStart = Number(panel.dataset.start);
            const patch = { title: title, artist: artist };
            if (
                !Number.isFinite(originalStart) ||
                Math.abs(start - originalStart) > 0.05
            ) {
                patch.start = start;
            }

            segments = Segments.updateSegment(segments, index, patch, { minLength: 1 });
            const updated = segments[index];
            saveSegmentsNow({ edited: true });
            closeSegmentDialog();
            if (updated && videoElement) {
                videoElement.currentTime = Math.max(0, updated.start + 0.05);
            }
            loadLyricsToPiP(null, null, { segmentIndex: index });
            toast('Lagu diperbarui');
        }

        function deleteSegmentDialog() {
            if (!pipWindow) return;
            const panel = byId('segment-panel');
            if (!panel || panel.dataset.mode !== 'edit') return;
            const index = Number(panel.dataset.index);
            if (!segments[index]) return;

            segments = Segments.removeSegment(segments, index);
            closeSegmentDialog();

            if (segments.length === 0) {
                saveSegmentsNow({ edited: false, disabled: true });
                loadLyricsToPiP(null, null, { force: true });
                toast('Semua segmen dihapus');
                return;
            }

            saveSegmentsNow({ edited: true });
            const target = Math.min(index, segments.length - 1);
            loadLyricsToPiP(null, null, { segmentIndex: target });
            toast('Segmen dihapus');
        }

        // Cari lirik lagu berikutnya di belakang layar supaya pergantian lagu
        // berikutnya tidak menunggu.
        async function prefetchSegment(index) {
            if (!Segments || segments.length === 0) return;
            if (index < 0 || index >= segments.length) return;
            const segment = segments[index];
            if (!segment || !segment.title) return;
            if (segment.manualData) return;
            if (segment.autoData && isCacheFresh(segment.autoCachedAt)) return;
            if (prefetchInFlight[index]) return;

            const videoId = getVideoId();
            const capturedSegments = segments;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
            prefetchInFlight[index] = true;
            try {
                const found = await searchAuto(
                    {
                        title: segment.title,
                        artist: segment.artist || '',
                        series: '',
                        duration: Math.max(1, Math.round(segment.end - segment.start))
                    },
                    controller.signal,
                    null
                );
                // Hanya simpan kalau video dan daftar segmen belum berubah.
                if (
                    found &&
                    getVideoId() === videoId &&
                    segments === capturedSegments
                ) {
                    segment.autoData = found.track;
                    segment.autoCachedAt = Date.now();
                    saveVideoData(videoId, { segments: capturedSegments });
                }
            } catch (error) {
                // prefetch bersifat best-effort: kegagalan diabaikan
            } finally {
                clearTimeout(timer);
                prefetchInFlight[index] = false;
            }
        }

        function updateSyncDisplay() {
            const display = byId('sync-val');
            if (display) display.textContent = offsetLabel();
            updateLyricsHighlight();
        }

        function saveOffset() {
            const videoId = getVideoId();
            if (!videoId) return;
            // Tahan sebentar: tombol offset sering ditekan beruntun. Tulis
            // sekali saja setelah berhenti, supaya tidak membanjiri storage.
            const segment = activeSegment();
            pendingOffset = {
                videoId: videoId,
                offset: lyricsTimeOffset,
                segment: segment,
                segmentStart: segment ? segment.start : null,
                segments: segments.length > 0 ? segments : null
            };
            clearTimeout(offsetSaveTimer);
            offsetSaveTimer = setTimeout(() => {
                offsetSaveTimer = null;
                flushOffset();
            }, 400);
        }

        async function flushOffset() {
            clearTimeout(offsetSaveTimer);
            offsetSaveTimer = null;
            const pending = pendingOffset;
            pendingOffset = null;
            if (!pending) return;
            // Offset disimpan per lagu kalau video memakai segmen.
            if (pending.segment && pending.segments) {
                if (pending.videoId === getVideoId() && segments.length > 0) {
                    // Segmen bisa sudah diganti (tambah/edit) selama debounce;
                    // cari ulang berdasarkan waktu mulai agar tidak menimpa edit.
                    let target = null;
                    if (pending.segmentStart !== null) {
                        target = segments.find(
                            (item) => Math.abs(item.start - pending.segmentStart) <= 0.5
                        );
                    }
                    if (!target) target = activeSegment();
                    if (!target) return;
                    target.offset = pending.offset;
                    await saveVideoData(pending.videoId, { segments: segments });
                    return;
                }
                pending.segment.offset = pending.offset;
                await saveVideoData(pending.videoId, { segments: pending.segments });
                return;
            }
            await saveVideoData(pending.videoId, { offset: pending.offset });
        }

        function toggleMaximize() {
            if (!pipWindow) return;
            const button = byId('btn-maximize');

            if (!pipWindow.isMaximized) {
                pipWindow.originalBounds = {
                    width: pipWindow.outerWidth,
                    height: pipWindow.outerHeight,
                    left: pipWindow.screenX,
                    top: pipWindow.screenY
                };
                try {
                    // Gunakan layar tempat jendela PiP berada, bukan selalu
                    // layar utama, supaya perilaku multi-monitor tetap benar.
                    const screenInfo = pipWindow.screen || window.screen;
                    const left = Number.isFinite(screenInfo.availLeft) ? screenInfo.availLeft : 0;
                    const top = Number.isFinite(screenInfo.availTop) ? screenInfo.availTop : 0;
                    pipWindow.moveTo(left, top);
                    pipWindow.resizeTo(screenInfo.availWidth, screenInfo.availHeight);
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
                    const bounds = pipWindow.originalBounds;
                    const width = (bounds && bounds.width) || 360;
                    const height = (bounds && bounds.height) || 560;
                    const screenInfo = pipWindow.screen || window.screen;
                    const left =
                        bounds && Number.isFinite(bounds.left)
                            ? bounds.left
                            : Math.max(0, screenInfo.availWidth - width - 50);
                    const top =
                        bounds && Number.isFinite(bounds.top)
                            ? bounds.top
                            : 50;
                    pipWindow.resizeTo(width, height);
                    pipWindow.moveTo(left, top);
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
                await flushOffset();
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
                await updateCacheUsage();
                toast(count + ' entri diimpor');
            } catch (error) {
                console.error('Brave Mini Lyrics: gagal mengimpor cache', error);
                toast('File backup tidak valid');
            }
        }

        // ==========================================
        // MANAJEMEN CACHE
        // ==========================================
        function formatBytes(bytes) {
            const value = Number(bytes) || 0;
            if (value < 1024) return value + ' B';
            if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
            return (value / (1024 * 1024)).toFixed(1) + ' MB';
        }

        async function getCacheStats() {
            const stats = { entries: 0, bytes: 0 };
            try {
                const all = await chrome.storage.local.get(null);
                const encoder = new TextEncoder();
                for (const key of Object.keys(all)) {
                    if (key.indexOf(STORAGE_PREFIX) !== 0) continue;
                    const data = all[key];
                    if (data && (data.autoData || data.manualData || data.latinData)) {
                        stats.entries += 1;
                    }
                    try {
                        stats.bytes += encoder.encode(JSON.stringify(all[key])).length;
                    } catch (error) {
                        // nilai tidak bisa diserialisasi: abaikan ukurannya
                    }
                }
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal menghitung cache', error);
            }
            return stats;
        }

        async function updateCacheUsage() {
            const element = byId('cache-usage');
            if (!element) return;
            const stats = await getCacheStats();
            element.textContent =
                stats.entries > 0
                    ? stats.entries + ' lagu · ' + formatBytes(stats.bytes)
                    : 'cache kosong';
        }

        async function clearAutoCache() {
            if (!pipWindow) return;
            // Hapus cache itu permanen, jadi minta konfirmasi kedua.
            if (!cacheClearArmed) {
                cacheClearArmed = true;
                toast('Tekan 🧹 sekali lagi untuk menghapus cache lirik otomatis.');
                clearTimeout(cacheClearTimer);
                cacheClearTimer = setTimeout(() => {
                    cacheClearArmed = false;
                }, 4000);
                return;
            }
            clearTimeout(cacheClearTimer);
            cacheClearArmed = false;

            try {
                await flushOffset();
                const all = await chrome.storage.local.get(null);
                const index = all[INDEX_KEY] || {};
                const removals = [];
                const updates = {};
                const draftRemovals = [];
                let cleared = 0;
                let indexChanged = false;

                for (const key of Object.keys(all)) {
                    if (key.indexOf(DRAFT_PREFIX) === 0) {
                        draftRemovals.push(key);
                        continue;
                    }
                    if (key.indexOf(STORAGE_PREFIX) !== 0) continue;
                    const data = all[key];
                    if (!data || typeof data !== 'object') continue;
                    if (!data.autoData && !data.latinData) continue;

                    cleared += 1;
                    const next = Object.assign({}, data, {
                        autoData: null,
                        autoCachedAt: 0,
                        latinData: null
                    });
                    // Lirik manual dan offset tetap disimpan.
                    if (next.manualData || next.offset) {
                        updates[key] = next;
                    } else {
                        removals.push(key);
                        const videoId = key.slice(STORAGE_PREFIX.length);
                        if (index[videoId] !== undefined) {
                            delete index[videoId];
                            indexChanged = true;
                        }
                    }
                }

                if (removals.length > 0) await chrome.storage.local.remove(removals);
                if (draftRemovals.length > 0) await chrome.storage.local.remove(draftRemovals);
                if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
                if (indexChanged) await chrome.storage.local.set({ [INDEX_KEY]: index });

                toast(
                    cleared > 0
                        ? cleared + ' cache lirik dihapus'
                        : 'Tidak ada cache lirik otomatis'
                );
                await updateCacheUsage();
            } catch (error) {
                console.error('Brave Mini Lyrics: gagal menghapus cache', error);
                toast('Gagal menghapus cache');
            }
        }

        // ==========================================
        // RENDER STATE
        // ==========================================
        function renderLoading(titleText, artistText, fallbackSearchText, statusText) {
            const body = pipWindow.document.body;
            body.classList.remove('results-mode', 'showing-results', 'search-active');
            body.classList.add('is-loading');

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
            container.innerHTML = `
                <div class="loading-box">
                    <div class="loading-bar indeterminate" id="loading-bar">
                        <div class="loading-bar-fill" id="loading-bar-fill"></div>
                    </div>
                    <p class="loading" id="loading-status">${escapeHtml(
                        statusText || 'Menghubungkan ke database lirik…'
                    )}</p>
                    <p class="loading-elapsed" id="loading-elapsed">0:00</p>
                </div>
            `;
            startLoadingProgress();
            bindHeaderEvents({ synced: false, fallbackSearchText: fallbackSearchText });
            renderSegmentBar();
        }

        function startLoadingProgress() {
            stopLoadingProgress();
            loadingStartedAt = Date.now();
            updateLoadingElapsed();
            loadingTimer = setInterval(updateLoadingElapsed, 500);
        }

        function stopLoadingProgress() {
            if (loadingTimer !== null) {
                clearInterval(loadingTimer);
                loadingTimer = null;
            }
        }

        function updateLoadingElapsed() {
            const element = byId('loading-elapsed');
            if (!element) return;
            const seconds = Math.floor((Date.now() - loadingStartedAt) / 1000);
            element.textContent = Core.formatTime(seconds) || '0:00';
        }

        function updateLoadingStatus(message, progress) {
            const element = byId('loading-status');
            if (element) element.textContent = message;

            const bar = byId('loading-bar');
            const fill = byId('loading-bar-fill');
            if (!bar || !fill) return;
            if (typeof progress === 'number' && isFinite(progress)) {
                const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
                bar.classList.remove('indeterminate');
                fill.style.width = percent + '%';
            } else {
                bar.classList.add('indeterminate');
                fill.style.width = '';
            }
        }

        function renderStopped(fallbackSearchText) {
            stopLoadingProgress();
            const body = pipWindow.document.body;
            body.classList.remove('is-loading', 'results-mode', 'showing-results');

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
            renderSegmentBar();
            applyFontScale();
        }

        function renderFound(data, fallbackSearchText, usedCache) {
            stopLoadingProgress();
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
                            videoElement.currentTime = Math.max(
                                0,
                                line.time + segmentBase + lyricsTimeOffset
                            );
                        }
                    });

                    element.addEventListener('contextmenu', (event) => {
                        event.preventDefault();
                        if (!videoElement) return;
                        lyricsTimeOffset = videoElement.currentTime - segmentBase - line.time;
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
            renderSegmentBar();
            applyFontScale();
            maybeAutoLatin();
            if (segments.length > 0 && activeSegmentIndex >= 0) {
                prefetchSegment(activeSegmentIndex + 1);
            }
        }

        function renderResults(results, manualQuery, meta) {
            stopLoadingProgress();
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
                    await applyLyricsPatch({ manualData: track });
                    loadLyricsToPiP(null, track);
                });

                list.appendChild(item);
            });

            container.appendChild(list);
            bindHeaderEvents({ synced: false, fallbackSearchText: manualQuery });
            renderSegmentBar();
            applyFontScale();
        }

        function renderNotFound(fallbackSearchText) {
            stopLoadingProgress();
            const body = pipWindow.document.body;
            body.classList.remove('results-mode', 'showing-results', 'is-loading');

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
            renderSegmentBar();
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

            // Gunakan hasil romanisasi yang pernah disimpan untuk lagu ini.
            const cached = activeLatinData();
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
                    const latinData = { key: key, lines: converted };
                    if (activeSegment()) {
                        await applyLyricsPatch({ latinData: latinData });
                    } else {
                        currentVideoData = Object.assign({}, currentVideoData, {
                            latinData: latinData
                        });
                        await saveVideoData(videoId, { latinData: latinData });
                    }
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

        function closeEditor(force) {
            if (!pipWindow) return;
            const panel = pipWindow.document.getElementById('editor-panel');
            if (!panel) {
                tapState = null;
                return;
            }

            const textarea = pipWindow.document.getElementById('editor-text');
            const changed = Boolean(textarea) && textarea.value !== editorInitialText;
            // Cegah edit hilang karena tidak sengaja menekan ✕ atau Esc.
            if (!force && (changed || tapState)) {
                if (!editorCloseArmed) {
                    editorCloseArmed = true;
                    toast(
                        'Perubahan belum disimpan. Tekan ✕ atau Esc sekali lagi untuk menutup.'
                    );
                    clearTimeout(editorCloseTimer);
                    editorCloseTimer = setTimeout(() => {
                        editorCloseArmed = false;
                    }, 3000);
                    return;
                }
            }

            clearTimeout(editorCloseTimer);
            editorCloseArmed = false;
            // Simpan draft terakhir saat editor ditutup tanpa menyimpan.
            if (!force && textarea) {
                clearTimeout(editorDraftTimer);
                editorDraftTimer = null;
                saveEditorDraft(textarea.value);
            }
            editorInitialText = '';
            panel.remove();
            tapState = null;
        }

        function editorDraftKey(videoId) {
            // Draft dipisah per lagu supaya draft kompilasi tidak bocor ke lagu lain.
            const segment = activeSegment();
            return DRAFT_PREFIX + (videoId || 'local') + (segment ? ':' + segment.id : '');
        }

        async function loadEditorDraft(videoId) {
            try {
                const key = editorDraftKey(videoId);
                const obj = await chrome.storage.local.get(key);
                const draft = obj[key];
                if (!draft || typeof draft.text !== 'string' || !draft.text) return null;
                if (!draft.updatedAt || Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
                    await chrome.storage.local.remove(key);
                    return null;
                }
                return draft;
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal membaca draft editor', error);
                return null;
            }
        }

        async function saveEditorDraft(text) {
            const videoId = getVideoId();
            if (!videoId) return;
            const key = editorDraftKey(videoId);
            try {
                if (!text || text === editorInitialText) {
                    await chrome.storage.local.remove(key);
                    return;
                }
                await chrome.storage.local.set({
                    [key]: { text: text, updatedAt: Date.now() }
                });
            } catch (error) {
                console.warn('Brave Mini Lyrics: gagal menyimpan draft editor', error);
            }
        }

        function scheduleEditorDraft(textarea) {
            clearTimeout(editorDraftTimer);
            editorDraftTimer = setTimeout(() => {
                editorDraftTimer = null;
                if (textarea) saveEditorDraft(textarea.value);
            }, 800);
        }

        async function clearEditorDraft(videoId) {
            clearTimeout(editorDraftTimer);
            editorDraftTimer = null;
            try {
                await chrome.storage.local.remove(editorDraftKey(videoId));
            } catch (error) {
                // abaikan: draft hanya cadangan
            }
        }

        function openEditor() {
            if (!pipWindow) return;
            closeMenu();
            closeSegmentDialog();
            closeEditor(true);

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
                <p class="editor-hint">Format LRC: <code>[01:23.45]Teks lirik</code>. Tanpa timestamp akan disimpan sebagai lirik statis.
                    <br>Ctrl+Enter untuk menyimpan. Draft tersimpan otomatis.</p>
            `;
            doc.body.appendChild(panel);

            const textarea = doc.getElementById('editor-text');
            const videoId = getVideoId();
            if (textarea) textarea.value = editorSeedText();
            editorInitialText = textarea ? textarea.value : '';
            editorCloseArmed = false;

            loadEditorDraft(videoId).then((draft) => {
                if (!draft || !textarea || !pipWindow) return;
                if (!pipWindow.document.getElementById('editor-panel')) return;
                // Jangan timpa kalau pengguna sudah mulai mengetik.
                if (textarea.value !== editorInitialText) return;
                textarea.value = draft.text;
                editorInitialText = draft.text;
                toast('Draft lirik dipulihkan');
            });

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

            if (textarea) {
                // Simpan draft otomatis supaya edit tidak hilang kalau
                // jendela PiP tertutup paksa.
                textarea.addEventListener('input', () => scheduleEditorDraft(textarea));
                textarea.addEventListener('keydown', (event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.preventDefault();
                        saveEditor();
                    }
                });
                textarea.focus();
            }
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

            const segment = activeSegment();
            const meta = getVideoMetadata();
            const videoId = getVideoId();
            const synced = /\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\]/.test(text);
            const manualData = {
                id: 'manual:' + (videoId || 'local') + (segment ? ':' + segment.id : ''),
                trackName: (segment && segment.title) || meta.title || 'Lirik manual',
                artistName: (segment && segment.artist) || meta.artist || '',
                duration: segment ? Math.round(segment.end - segment.start) : meta.duration || 0,
                syncedLyrics: synced ? text : null,
                plainLyrics: synced ? null : text,
                source: 'manual'
            };

            currentVideoData = Object.assign({}, currentVideoData, { latinData: null });
            await applyLyricsPatch({ manualData: manualData, latinData: null });
            await clearEditorDraft(videoId);
            closeEditor(true);
            loadLyricsToPiP(null, manualData);
            toast(synced ? 'Lirik sinkron disimpan' : 'Lirik statis disimpan');
        }

        async function resetManualLyrics() {
            if (!pipWindow) return;
            const segment = activeSegment();
            const existing = segment
                ? segment.manualData
                : currentVideoData && currentVideoData.manualData;
            if (!existing) {
                toast('Tidak ada lirik manual');
                return;
            }
            const videoId = getVideoId();
            currentVideoData = Object.assign({}, currentVideoData, { latinData: null });
            await applyLyricsPatch({ manualData: null, latinData: null });
            await clearEditorDraft(videoId);
            closeEditor(true);
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
            // Simpan waktu relatif terhadap offset. Saat render, waktu lirik
            // dihitung sebagai currentTime - lyricsTimeOffset, jadi kalau
            // offset tidak dikurangi di sini hasil tap akan bergeser.
            tapState.times[tapState.index] = Math.max(
                0,
                videoElement.currentTime - segmentBase - lyricsTimeOffset
            );
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
            const tapped = tapState.lines
                .map((line, index) => ({ line: line, time: tapState.times[index] }))
                .filter((item) => typeof item.time === 'number' && isFinite(item.time));
            const missed = tapState.lines.length - tapped.length;

            if (tapped.length === 0) {
                toast('Belum ada baris yang ditandai.');
                return;
            }

            // Baris yang belum ditandai jangan diberi timestamp 0: kalau
            // diberi 0, semuanya menumpuk di awal lagu dan merusak urutan.
            const lrc = tapped
                .map((item) => Core.toLrcTimestamp(item.time) + item.line)
                .join('\n');
            if (textarea) {
                textarea.value = lrc;
                textarea.hidden = false;
            }
            const view = doc.getElementById('tap-view');
            if (view) view.hidden = true;
            tapState = null;
            toast(
                missed > 0
                    ? missed + ' baris belum ditandai dan tidak disimpan. Tekan Simpan.'
                    : 'Tap sinkron selesai. Tekan Simpan.'
            );
        }

        // ==========================================
        // LOAD LIRIK
        // ==========================================
        async function loadLyricsToPiP(manualQuery, directTrackData, options) {
            if (!pipWindow) return;

            closeSegmentDialog();
            clearTimeout(segmentSwitchTimer);
            segmentSwitchTimer = null;

            // Simpan offset video sebelumnya sebelum membaca data video baru.
            await flushOffset();

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
            if (videoId !== lastLoadedVideoId) prefetchInFlight = {};
            lastLoadedVideoId = videoId;

            // Metadata untuk pencarian: artis asli, atau nama seri kalau
            // channel-nya soundtrack. Nilainya bisa diganti ke metadata lagu
            // saat video berupa kompilasi (lihat di bawah).
            let searchMeta = {
                title: meta.title,
                artist: meta.searchArtist || '',
                series: meta.series || '',
                duration: meta.duration
            };
            let artistLabel = meta.searchArtist || meta.series || meta.artist || '';

            let fallbackSearchText =
                manualQuery ||
                (meta.title
                    ? meta.title + (artistLabel ? ' - ' + artistLabel : '')
                    : artistLabel);

            let saved = {
                offset: 0,
                manualData: null,
                autoData: null,
                autoCachedAt: 0,
                latinData: null
            };
            if (videoId) saved = await getVideoData(videoId);

            // Video panjang tanpa daftar lagu: beri kesempatan page-bridge
            // mengirim Chapters sebelum memutuskan mode video panjang.
            if (videoId && Segments && Segments.shouldUseLongVideoMode(meta)) {
                await ensureChapterData(videoId, 700);
            }

            if (token !== loadToken) {
                clearTimeout(timeoutId);
                return;
            }
            currentVideoData = saved;

            // Deteksi segmen video kompilasi. Kalau ada, konteks lirik pindah
            // dari "satu video" ke "satu lagu di dalam video".
            segments = videoId ? getVideoSegments(meta, saved) : [];
            segmentsEdited = Boolean(saved.segmentsEdited);
            segmentsDisabled = Boolean(saved.segmentsDisabled);

            if (segments.length > 0) {
                const onlyLongVideoPlaceholder =
                    segments.length === 1 &&
                    segments[0] &&
                    segments[0].source === 'long-video' &&
                    !segments[0].title;
                if (
                    !segmentsEdited &&
                    !onlyLongVideoPlaceholder &&
                    segmentsSignature(saved.segments) !== segmentsSignature(segments)
                ) {
                    saveVideoData(videoId, { segments: segments });
                }

                let index = Number.isInteger(opts.segmentIndex) ? opts.segmentIndex : -1;
                if (index < 0) {
                    index = Segments.findSegmentIndex(
                        segments,
                        videoElement ? videoElement.currentTime : 0
                    );
                }
                // Pencarian manual saat berada di jeda (sebelum lagu pertama)
                // tetap diarahkan ke segmen terdekat supaya tidak mentok.
                if (index < 0 && manualQuery) {
                    const time = videoElement ? videoElement.currentTime : 0;
                    index = 0;
                    for (let i = 0; i < segments.length; i += 1) {
                        if (time >= segments[i].start) index = i;
                    }
                }
                if (index < 0) {
                    activeSegmentIndex = -1;
                    segmentBase = 0;
                    clearTimeout(timeoutId);
                    if (activeAbort === controller) activeAbort = null;
                    renderSegmentWaiting();
                    return;
                }
                if (index >= segments.length) index = segments.length - 1;

                activeSegmentIndex = index;
                segmentBase = segments[index].start;
                saved = currentSegmentSaved() || saved;

                const segment = segments[index];
                searchMeta = {
                    title: segment.title || '',
                    artist: segment.artist || '',
                    series: '',
                    duration: Math.max(1, Math.round(segment.end - segment.start))
                };
                artistLabel = segment.artist || '';
                fallbackSearchText =
                    manualQuery ||
                    (segment.title
                        ? segment.title + (artistLabel ? ' - ' + artistLabel : '')
                        : artistLabel);

                if (!manualQuery && !directTrackData && !saved.manualData && !searchMeta.title) {
                    clearTimeout(timeoutId);
                    if (activeAbort === controller) activeAbort = null;
                    renderSegmentUntitled();
                    return;
                }
            } else {
                activeSegmentIndex = -1;
                segmentBase = 0;
            }

            const report = (message, progress) => {
                if (token === loadToken) updateLoadingStatus(message, progress);
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
                    activeSegment()
                        ? segmentDisplayTitle(activeSegment())
                        : sourceData.trackName || meta.title,
                    fallbackSearchText,
                    'Memuat lirik…'
                );
            } else {
                renderLoading(
                    'Mencari lirik…',
                    searchMeta.artist
                        ? searchMeta.artist + ' • ' + searchMeta.title
                        : searchMeta.title,
                    fallbackSearchText,
                    'Menghubungkan ke database lirik…'
                );
            }

            try {
                if (sourceData) {
                    const contextSegment = activeSegment();
                    const lyricsData = {
                        found: true,
                        isSynced: Boolean(sourceData.syncedLyrics),
                        trackName:
                            (contextSegment && contextSegment.title) ||
                            sourceData.trackName ||
                            meta.title,
                        artistName:
                            (contextSegment && contextSegment.artist) ||
                            sourceData.artistName ||
                            meta.artist,
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

                const found = await searchAuto(searchMeta, controller.signal, report);
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
                    await applyLyricsPatch(patch);
                }
                if (token !== loadToken) return;

                const contextSegment = activeSegment();
                renderFound(
                    {
                        found: true,
                        isSynced: Boolean(found.track.syncedLyrics),
                        trackName:
                            (contextSegment && contextSegment.title) ||
                            found.track.trackName,
                        artistName:
                            (contextSegment && contextSegment.artist) ||
                            found.track.artistName,
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

            const segmentBar = document_.createElement('div');
            segmentBar.id = 'segment-bar';
            segmentBar.className = 'segment-bar';
            segmentBar.hidden = true;

            const toastElement = document_.createElement('div');
            toastElement.id = 'toast';

            document_.body.appendChild(handle);
            document_.body.appendChild(header);
            document_.body.appendChild(segmentBar);
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
                if (
                    event.key === 'Escape' &&
                    (document_.getElementById('editor-panel') ||
                        document_.getElementById('segment-panel') ||
                        document_.getElementById('segment-list-panel'))
                ) {
                    event.preventDefault();
                    closeSegmentList();
                    closeSegmentDialog();
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
                // Tulis offset yang masih tertahan debounce.
                flushOffset();
                // Simpan draft editor sebelum dokumen PiP dibuang.
                const editorText = win.document.getElementById('editor-text');
                if (editorText && editorText.value !== editorInitialText) {
                    clearTimeout(editorDraftTimer);
                    editorDraftTimer = null;
                    saveEditorDraft(editorText.value);
                }
                stopLoadingProgress();
                stopVideoWatcher();
                unbindVideoEvents();
                if (activeAbort) activeAbort.abort();
                loadToken += 1;
                clearTimeout(toastTimer);
                clearTimeout(scrollResetTimer);
                clearTimeout(menuHoverTimer);
                clearTimeout(segmentSwitchTimer);
                segmentSwitchTimer = null;
                prefetchInFlight = {};
                pipWindow = null;
                parsedLyrics = [];
                lineElements = [];
                currentHighlightIndex = -1;
                segments = [];
                activeSegmentIndex = -1;
                segmentBase = 0;
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
                await pruneExpiredCache();

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

        setupChapterBridge();
        loadSettings();

        console.log('Brave Mini Lyrics: content script siap.');
    }
}
