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

    function collectChapters() {
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

        return {
            videoId: getVideoId(player),
            chapters: normalizeMarkers(markers)
        };
    }

    function send(reason) {
        const data = collectChapters();
        // Kirim juga saat kosong supaya content script tidak menunggu terus.
        try {
            window.postMessage(
                {
                    source: SOURCE,
                    type: 'chapters',
                    videoId: data.videoId,
                    chapters: data.chapters,
                    reason: reason
                },
                '*'
            );
        } catch (error) {
            // abaikan
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
        document.addEventListener(name, () => queueSend(name));
    });

    // Chapters sering baru tersedia setelah player selesai dimuat.
    [0, 500, 1500, 3000, 6000, 10000].forEach((delay) => {
        setTimeout(() => send('retry'), delay);
    });
})();
