// Service worker Brave Mini Lyrics.

// QQ Music menolak permintaan lirik tanpa header Referer. Header ini tidak bisa
// diatur lewat fetch(), jadi dipasang dengan aturan declarativeNetRequest.
function installSourceHeaderRules() {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
        return;
    }
    chrome.declarativeNetRequest
        .updateDynamicRules({
            removeRuleIds: [1001, 1002],
            addRules: [
                {
                    id: 1001,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: [
                            { header: 'referer', operation: 'set', value: 'https://y.qq.com/' },
                            { header: 'origin', operation: 'set', value: 'https://y.qq.com' }
                        ]
                    },
                    condition: {
                        urlFilter: '||c.y.qq.com/',
                        resourceTypes: ['xmlhttprequest', 'other']
                    }
                },
                {
                    id: 1002,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: [
                            { header: 'referer', operation: 'set', value: 'https://music.163.com/' }
                        ]
                    },
                    condition: {
                        urlFilter: '||music.163.com/',
                        resourceTypes: ['xmlhttprequest', 'other']
                    }
                }
            ]
        })
        .catch(() => {});
}

installSourceHeaderRules();
chrome.runtime.onInstalled.addListener(installSourceHeaderRules);
chrome.runtime.onStartup.addListener(installSourceHeaderRules);

chrome.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { action: 'toggle_lyrics' }, () => {
        // Halaman non-YouTube tidak punya content script; abaikan error-nya.
        void chrome.runtime.lastError;
    });
});

chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-lyrics' && command !== 'repin-lyrics') return;
    const action = command === 'repin-lyrics' ? 'repin_lyrics' : 'toggle_lyrics';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { action: action }, () => {
            void chrome.runtime.lastError;
        });
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'romanize') return undefined;

    const senderUrl = sender.url || (sender.tab && sender.tab.url) || '';
    if (!/^https:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(senderUrl)) {
        sendResponse({ success: false, error: 'Origin tidak diizinkan.' });
        return false;
    }

    const text = typeof request.text === 'string' ? request.text : '';
    if (!text.trim()) {
        sendResponse({ success: false, error: 'Teks kosong.' });
        return false;
    }
    if (text.length > 10000) {
        sendResponse({ success: false, error: 'Teks terlalu panjang.' });
        return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=rm&dj=1';

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'q=' + encodeURIComponent(text),
        signal: controller.signal
    })
        .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then((data) => {
            try {
                let romanized = '';
                if (data && Array.isArray(data.sentences)) {
                    data.sentences.forEach((sentence) => {
                        let part = sentence.src_translit || sentence.orig || '';

                        const originalNewlines =
                            typeof sentence.orig === 'string'
                                ? (sentence.orig.match(/\n/g) || []).length
                                : 0;
                        const partNewlines =
                            typeof part === 'string' ? (part.match(/\n/g) || []).length : 0;

                        // Google kadang membuang newline; kembalikan agar baris tetap sejajar.
                        if (originalNewlines > partNewlines) {
                            part += '\n'.repeat(originalNewlines - partNewlines);
                        }

                        if (
                            typeof sentence.orig === 'string' &&
                            sentence.orig.endsWith(' ') &&
                            !part.endsWith(' ') &&
                            !part.endsWith('\n')
                        ) {
                            part += ' ';
                        }

                        romanized += part;
                    });
                }

                if (romanized.trim() !== '') {
                    sendResponse({ success: true, text: romanized });
                } else {
                    sendResponse({ success: false, error: 'Tidak ada hasil transliterasi.' });
                }
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })
        .catch((error) => {
            sendResponse({ success: false, error: error.message });
        })
        .finally(() => clearTimeout(timeoutId));

    return true;
});

// ==========================================
// SUMBER LIRIK TAMBAHAN (NetEase / QQ Music)
// ==========================================
const SOURCE_TIMEOUT_MS = 8000;
const LRC_TIME = /\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\]/;

function decodeEntities(text) {
    return String(text || '')
        .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function makeTrack(source, id, trackName, artistName, duration, lyric) {
    const text = decodeEntities(lyric || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return null;
    const synced = LRC_TIME.test(text);
    return {
        id: source + ':' + id,
        trackName: String(trackName || '').trim(),
        artistName: String(artistName || '').trim(),
        duration: Number(duration) || 0,
        syncedLyrics: synced ? text : null,
        plainLyrics: synced ? null : text,
        source: source
    };
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
        const response = await fetch(
            url,
            Object.assign({ signal: controller.signal }, options || {})
        );
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

const NETEASE_HEADERS = {
    Referer: 'https://music.163.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

async function searchNetease(query) {
    const searchUrl =
        'https://music.163.com/api/search/get?s=' +
        encodeURIComponent(query) +
        '&type=1&offset=0&limit=8';
    const data = await fetchWithTimeout(searchUrl, { headers: NETEASE_HEADERS });
    const songs =
        data && data.result && Array.isArray(data.result.songs) ? data.result.songs.slice(0, 6) : [];
    if (songs.length === 0) return [];

    const tracks = await Promise.all(
        songs.map(async (song) => {
            const lyricData = await fetchWithTimeout(
                'https://music.163.com/api/song/lyric?id=' +
                    encodeURIComponent(song.id) +
                    '&lv=1&kv=1&tv=-1',
                { headers: NETEASE_HEADERS }
            );
            const lyric = lyricData && lyricData.lrc && lyricData.lrc.lyric;
            const artists = Array.isArray(song.artists)
                ? song.artists.map((artist) => artist.name).filter(Boolean).join(', ')
                : song.artists && song.artists.name;
            return makeTrack(
                'netease',
                song.id,
                song.name,
                artists,
                song.duration ? song.duration / 1000 : 0,
                lyric
            );
        })
    );

    return tracks.filter(Boolean);
}

const QQ_HEADERS = {
    Referer: 'https://y.qq.com/',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
};

async function searchQQ(query) {
    const searchUrl =
        'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=8&p=1&cr=1&g_tk=5381&w=' +
        encodeURIComponent(query);
    const data = await fetchWithTimeout(searchUrl, { headers: QQ_HEADERS });
    const list =
        data && data.data && data.data.song && Array.isArray(data.data.song.list)
            ? data.data.song.list.slice(0, 6)
            : [];
    if (list.length === 0) return [];

    const tracks = await Promise.all(
        list.map(async (song) => {
            const lyricData = await fetchWithTimeout(
                'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' +
                    encodeURIComponent(song.songmid) +
                    '&format=json&nobase64=1&g_tk=5381',
                { headers: QQ_HEADERS }
            );
            const lyric = lyricData && (lyricData.lyric || lyricData.lyric_t);
            const artists = Array.isArray(song.singer)
                ? song.singer.map((artist) => artist.name).filter(Boolean).join(', ')
                : '';
            return makeTrack(
                'qq',
                song.songmid,
                song.songname,
                artists,
                song.interval,
                lyric
            );
        })
    );

    return tracks.filter(Boolean);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'lyrics_source') return undefined;

    const senderUrl = sender.url || (sender.tab && sender.tab.url) || '';
    if (!/^https:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(senderUrl)) {
        sendResponse({ success: false, error: 'Origin tidak diizinkan.' });
        return false;
    }

    const source = request.source;
    const query =
        request.payload && typeof request.payload.query === 'string'
            ? request.payload.query.trim().slice(0, 200)
            : '';
    if (!query) {
        sendResponse({ success: false, error: 'Query kosong.' });
        return false;
    }

    const handler = source === 'netease' ? searchNetease : source === 'qq' ? searchQQ : null;
    if (!handler) {
        sendResponse({ success: false, error: 'Sumber tidak dikenal.' });
        return false;
    }

    handler(query)
        .then((tracks) => sendResponse({ success: true, tracks: tracks }))
        .catch((error) => sendResponse({ success: false, error: error.message }));

    return true;
});
