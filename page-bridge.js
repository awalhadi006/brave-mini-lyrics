/**
 * Jembatan data halaman YouTube -> content script (Batch 4).
 *
 * Content script berjalan di isolated world sehingga tidak bisa membaca
 * `ytInitialData`, `ytd-app.__data`, atau `movie_player.getPlayerResponse()`.
 * Skrip ini berjalan di MAIN world (lihat manifest.json) dan mengirim daftar
 * Chapters lewat `window.postMessage`.
 *
 * Tidak memakai API ekstensi dan tidak mengirim data ke mana pun.
 */
(function () {
    'use strict';

    const SOURCE = 'bml-page-bridge';
    const REQUEST_SOURCE = 'bml-content';
    const MAX_NODES = 30000;
    const MAX_DEPTH = 16;
    const TIMELINE_PANEL_ID = 'engagement-panel-timeline-view-consolidated';
    const TIMELINE_MAX_OPEN = 3;

    function getVideoId(playerResponse) {
        const details = playerResponse && playerResponse.videoDetails;
        if (details && details.videoId) return details.videoId;
        try {
            const url = new URL(window.location.href);
            const fromQuery = url.searchParams.get('v');
            if (fromQuery) return fromQuery;
            const match = url.pathname.match(/^\/shorts\/([^/?#]+)/);
            if (match) return match[1];
        } catch (error) {
            // abaikan
        }
        return '';
    }

    function getPlayerResponse() {
        // 1. API player (paling stabil, tersedia setelah video dimuat).
        try {
            const player = document.getElementById('movie_player');
            if (player && typeof player.getPlayerResponse === 'function') {
                const response = player.getPlayerResponse();
                if (response) return response;
            }
        } catch (error) {
            // lanjut ke sumber berikutnya
        }

        // 2. Data Polymer ytd-app.
        try {
            const app = document.querySelector('ytd-app');
            const raw = app && (app.__data || app.data);
            const appData = raw && (raw.data || raw);
            if (appData) {
                if (
                    appData.player &&
                    appData.player.args &&
                    appData.player.args.raw_player_response
                ) {
                    return appData.player.args.raw_player_response;
                }
                if (appData.playerResponse) return appData.playerResponse;
            }
        } catch (error) {
            // lanjut ke sumber berikutnya
        }

        // 3. Global awal halaman.
        try {
            if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
        } catch (error) {
            // abaikan
        }

        return null;
    }

    function collectMarkers(root) {
        if (!root || typeof root !== 'object') return [];
        const found = [];
        const stack = [{ node: root, depth: 0 }];
        let visited = 0;

        while (stack.length > 0) {
            const item = stack.pop();
            if (!item.node || typeof item.node !== 'object') continue;
            if (item.depth > MAX_DEPTH) continue;
            visited += 1;
            if (visited > MAX_NODES) break;

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

    function fallbackReadText(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (typeof value.simpleText === 'string') return value.simpleText;
        if (Array.isArray(value.runs)) {
            return value.runs.map((run) => (run && run.text) || '').join('');
        }
        if (value.title) return fallbackReadText(value.title);
        return '';
    }

    function normalizeMarkers(markers) {
        const api = window.BMLSegments;
        if (api && typeof api.normalizeChapters === 'function') {
            return api.normalizeChapters(markers);
        }
        return markers
            .map((item) => {
                let start = null;
                if (Number.isFinite(item.start)) start = Number(item.start);
                else if (Number.isFinite(item.timeRangeStartMillis)) {
                    start = Number(item.timeRangeStartMillis) / 1000;
                } else if (Number.isFinite(item.startMillis)) {
                    start = Number(item.startMillis) / 1000;
                } else if (Number.isFinite(item.time)) {
                    start = Number(item.time);
                }
                if (start === null) return null;
                return { start: start, title: fallbackReadText(item.title), artist: '' };
            })
            .filter(Boolean)
            .sort((a, b) => a.start - b.start);
    }

    function waitFor(predicate, timeoutMs, intervalMs) {
        return new Promise((resolve) => {
            const started = Date.now();
            const tick = () => {
                let ok = false;
                try {
                    ok = Boolean(predicate());
                } catch (error) {
                    ok = false;
                }
                if (ok) {
                    resolve(true);
                    return;
                }
                if (Date.now() - started >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(tick, intervalMs || 250);
            };
            tick();
        });
    }

    // ==========================================
    // PANEL "In this video" (Timeline) YouTube baru
    // ==========================================

    function getAppRoot() {
        try {
            const app = document.querySelector('ytd-app');
            const raw = app && (app.__data || app.data);
            if (raw) return raw;
        } catch (error) {
            // abaikan
        }
        return null;
    }

    /** Node `engagementPanelSectionListRenderer` untuk panel Timeline. */
    function findTimelinePanel() {
        const root = getAppRoot();
        if (!root) return null;

        const data = root.data || root;
        const response = data && data.response;
        const panels = response && response.engagementPanels;
        if (Array.isArray(panels)) {
            for (const entry of panels) {
                const renderer = entry && entry.engagementPanelSectionListRenderer;
                if (renderer && renderer.identifier && renderer.identifier.tag === TIMELINE_PANEL_ID) {
                    return renderer;
                }
            }
        }

        // Jalur cepat di atas bisa gagal kalau struktur data berubah: telusuri.
        const stack = [{ node: root, depth: 0 }];
        let visited = 0;
        while (stack.length > 0) {
            const item = stack.pop();
            if (!item.node || typeof item.node !== 'object') continue;
            if (item.depth > MAX_DEPTH) continue;
            visited += 1;
            if (visited > MAX_NODES) break;

            if (Array.isArray(item.node)) {
                for (const child of item.node) {
                    if (child && typeof child === 'object') {
                        stack.push({ node: child, depth: item.depth + 1 });
                    }
                }
                continue;
            }

            const renderer = item.node.engagementPanelSectionListRenderer;
            if (renderer && renderer.identifier && renderer.identifier.tag === TIMELINE_PANEL_ID) {
                return renderer;
            }

            for (const key of Object.keys(item.node)) {
                const child = item.node[key];
                if (child && typeof child === 'object') {
                    stack.push({ node: child, depth: item.depth + 1 });
                }
            }
        }
        return null;
    }

    /**
     * Rangkum isi panel Timeline menjadi item netral:
     * `{kind:'card', title, subtitle}` atau `{kind:'cue', timestamp}`.
     */
    function collectTimelineItems(renderer) {
        const content = renderer && renderer.content;
        const sections =
            content && content.sectionListRenderer && content.sectionListRenderer.contents;
        if (!Array.isArray(sections)) return [];

        const items = [];
        for (const section of sections) {
            if (!section || typeof section !== 'object') continue;
            const list = Array.isArray(
                section.itemSectionRenderer && section.itemSectionRenderer.contents
            )
                ? section.itemSectionRenderer.contents
                : Array.isArray(section.contents)
                  ? section.contents
                  : [];

            for (const entry of list) {
                if (!entry || typeof entry !== 'object') continue;
                const wrapper = entry.macroMarkersPanelItemViewModel;
                if (!wrapper) continue;
                const node = wrapper.item || wrapper;

                const card = node.videoAttributeViewModel;
                if (card) {
                    items.push({
                        kind: 'card',
                        title: fallbackReadText(card.title),
                        subtitle: fallbackReadText(card.subtitle)
                    });
                    continue;
                }

                if (node.timelineItemViewModel) {
                    items.push({
                        kind: 'cue',
                        timestamp: node.timelineItemViewModel.timestamp
                    });
                }
            }
        }
        return items;
    }

    /** Tombol "In this video" di progress bar; hanya muncul kalau ada marker. */
    function timelineButton() {
        const candidates = document.querySelectorAll(
            '#movie_player .ytp-chapter-title, #movie_player .ytp-chapter-container button'
        );
        for (const button of candidates) {
            if (!button) continue;
            if (!button.getBoundingClientRect().width) continue;
            if (/in this video|dalam video/i.test(button.textContent || '')) return button;
        }
        return null;
    }

    // Sembunyikan panel selama pembacaan supaya tidak berkedip di layar.
    function hideTimelinePanel() {
        try {
            const style = document.createElement('style');
            style.setAttribute('data-bml-timeline', '1');
            style.textContent =
                'ytd-watch-flexy ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]{opacity:0 !important;}';
            (document.head || document.documentElement).appendChild(style);
            return style;
        } catch (error) {
            return null;
        }
    }

    function closeTimelinePanel() {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
        for (const panel of panels) {
            if (panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') continue;
            const header = panel.querySelector('ytd-engagement-panel-title-header-renderer');
            const button =
                (header && header.querySelector('#visibility-button button')) ||
                (header &&
                    header.querySelector(
                        'button[aria-label*="Close" i], button[aria-label*="Tutup" i]'
                    ));
            if (button) {
                button.click();
                return true;
            }
        }
        return false;
    }

    let timelineOpenCount = 0;
    let timelineCache = { videoId: '', chapters: [], at: 0 };

    /**
     * Buka panel Timeline sekali, baca kartu lagunya, lalu tutup lagi.
     * Panel hanya punya data setelah dibuka, jadi langkah ini perlu.
     */
    async function ensureTimelineLoaded() {
        const panel = findTimelinePanel();
        if (panel && collectTimelineItems(panel).length > 0) return true;

        const button = timelineButton();
        if (!button) return false;

        const style = hideTimelinePanel();
        try {
            button.click();
            const loaded = await waitFor(() => {
                const current = findTimelinePanel();
                return current ? collectTimelineItems(current).length > 0 : false;
            }, 6000, 300);
            return loaded;
        } finally {
            if (!closeTimelinePanel()) {
                const toggle = timelineButton();
                if (toggle) toggle.click();
            }
            setTimeout(() => {
                if (style && style.parentNode) style.parentNode.removeChild(style);
            }, 600);
        }
    }

    async function collectTimelineChapters(videoId, allowOpen) {
        if (timelineCache.videoId === videoId && timelineCache.chapters.length >= 2) {
            return timelineCache.chapters;
        }

        const panel = findTimelinePanel();
        let loaded = panel ? collectTimelineItems(panel).length > 0 : false;
        // Membuka panel membuat UI YouTube berkedip sebentar, jadi hanya
        // dilakukan kalau content script memintanya (jendela lirik dibuka).
        if (!loaded && !allowOpen) return [];
        if (!loaded) {
            if (timelineOpenCount >= TIMELINE_MAX_OPEN) return [];
            timelineOpenCount += 1;
            loaded = await ensureTimelineLoaded();
        }
        if (!loaded) return [];

        const items = collectTimelineItems(findTimelinePanel());
        const api = window.BMLSegments;
        const chapters =
            api && typeof api.parseTimelineMarkers === 'function'
                ? api.parseTimelineMarkers(items)
                : [];
        if (chapters.length < 2) return [];

        timelineCache = { videoId: videoId, chapters: chapters, at: Date.now() };
        return chapters;
    }

    // Panel Timeline juga ada di video satu lagu; batasi percobaan ke video
    // panjang/kompilasi supaya tidak membuka panel tanpa guna.
    function shouldProbeTimeline(player) {
        const details = player && player.videoDetails;
        let duration = Number(details && details.lengthSeconds) || 0;
        let title = String((details && details.title) || '');

        if (!duration) {
            const video = document.querySelector('#movie_player video, video');
            if (video && Number.isFinite(video.duration)) duration = Math.round(video.duration);
        }
        if (!title) {
            title = String(document.title || '').replace(/\s*-\s*YouTube\s*$/, '');
        }

        const api = window.BMLSegments;
        if (api && typeof api.shouldUseLongVideoMode === 'function') {
            if (api.shouldUseLongVideoMode({ title: title, duration: duration })) return true;
            // Durasi belum diketahui (player belum siap): biarkan dicoba.
            return duration <= 0;
        }
        return duration >= 600;
    }

    async function collectChapters(reason) {
        const player = getPlayerResponse();
        let markers = [];

        if (player) markers = collectMarkers(player.engagementPanels);
        if (markers.length === 0) {
            try {
                markers = collectMarkers(window.ytInitialData);
            } catch (error) {
                // ytInitialData bisa tidak tersedia
            }
        }

        const videoId = getVideoId(player);
        let chapters = normalizeMarkers(markers);
        let source = 'chapter';

        // Belum ada Chapters resmi: coba kartu lagu panel "In this video".
        if (chapters.length < 2 && shouldProbeTimeline(player)) {
            const timeline = await collectTimelineChapters(videoId, reason === 'request');
            if (timeline.length >= 2) {
                chapters = timeline;
                source = 'timeline';
            }
        }

        return { videoId: videoId, chapters: chapters, source: source };
    }

    let sending = false;
    let pendingReason = '';

    async function send(reason) {
        if (sending) {
            pendingReason = reason;
            return;
        }
        sending = true;
        try {
            const data = await collectChapters(reason);
            // Kirim juga saat kosong supaya content script tidak menunggu terus.
            window.postMessage(
                {
                    source: SOURCE,
                    type: 'chapters',
                    videoId: data.videoId,
                    chapters: data.chapters,
                    chapterSource: data.source,
                    reason: reason
                },
                '*'
            );
        } catch (error) {
            // abaikan
        } finally {
            sending = false;
            if (pendingReason) {
                const next = pendingReason;
                pendingReason = '';
                queueSend(next);
            }
        }
    }

    let sendTimer = null;
    function queueSend(reason) {
        clearTimeout(sendTimer);
        sendTimer = setTimeout(() => {
            sendTimer = null;
            send(reason);
        }, 250);
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== REQUEST_SOURCE || data.type !== 'chapters') return;
        send('request');
    });

    ['yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated'].forEach((name) => {
        document.addEventListener(name, () => {
            if (name === 'yt-navigate-finish') {
                timelineOpenCount = 0;
                timelineCache = { videoId: '', chapters: [], at: 0 };
            }
            queueSend(name);
        });
    });

    // Chapters sering baru tersedia setelah player selesai dimuat.
    [0, 500, 1500, 3000, 6000, 10000, 16000, 24000].forEach((delay) => {
        setTimeout(() => send('retry'), delay);
    });

    // Tombol "In this video" muncul belakangan (setelah YouTube menyiapkan
    // marker). Begitu muncul, langsung minta ulang supaya daftar lagu terisi.
    function watchTimelineButton() {
        if (typeof window.MutationObserver !== 'function') return;
        const player = document.getElementById('movie_player');
        if (!player) return;

        const observer = new MutationObserver(() => {
            if (!timelineButton()) return;
            observer.disconnect();
            queueSend('timeline-button');
        });
        try {
            observer.observe(player, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true
            });
        } catch (error) {
            return;
        }
        setTimeout(() => observer.disconnect(), 120000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchTimelineButton, { once: true });
    } else {
        watchTimelineButton();
    }
})();
