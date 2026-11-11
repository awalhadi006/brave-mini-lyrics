/**
 * Deteksi batas lagu pada video kompilasi / mix YouTube.
 * Berisi fungsi murni (tanpa DOM) agar bisa diuji dengan `node --test`.
 *
 * Sumber batas lagu, berurutan:
 * 1. Chapters resmi YouTube (`macroMarkersListItemRenderer`).
 * 2. Timestamp tracklist di deskripsi video.
 *
 * Di content script modul ini menempel ke `globalThis.BMLSegments`.
 * Di Node, `module.exports` berisi API yang sama.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BMLSegments = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Segmen yang lebih pendek dari ini biasanya bukan lagu (intro, jeda,
    // atau salah deteksi), jadi tidak dipakai.
    const MIN_SEGMENT_SECONDS = 15;
    // Perkiraan panjang segmen terakhir kalau durasi video belum diketahui.
    const DEFAULT_LAST_SEGMENT_SECONDS = 240;
    const AREA_KEYWORDS =
        /\b(mix|mega\s*mix|megamix|compilation|kompilasi|full\s*album|album\s*penuh|nonstop|non-stop|playlist|best\s+of|greatest\s+hits|top\s+\d+|kumpulan|hits?\s+terbaru)\b/i;
    const HOUR_KEYWORDS = /\b(?:1|one)\s*hour\b|\b\d+\s*(?:jam|hours?)\b/i;
    const HEADER_LINE = /^(?:track\s*list|daftar\s*lagu|timestamps?|chapters?|setlist)\b/i;
    const URL_LIKE = /^(?:https?:\/\/|www\.)/i;

    // "0:00", "00:00", "1:02:03", "0.00" (menit.detik)
    const TIME_TOKEN = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:[.,](\d{1,3}))?$/;
    const DECIMAL_TOKEN = /^(\d{1,3})[.,](\d{2})$/;
    // Baris tracklist: timestamp di awal baris, boleh dibungkus [] atau ().
    const TRACKLIST_LINE =
        /^\s*(?:[•·*\-–—>»▪●]+\s*)?[\[(]?((?:\d{1,2}:)?\d{1,3}[:.]\d{2}(?::\d{2})?)[\])]?[\s.:\-–—|]*\s*(.*?)\s*$/;

    /** Ambil teks dari berbagai bentuk data YouTube ({simpleText}, {runs}). */
    function readText(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (typeof value.simpleText === 'string') return value.simpleText;
        if (Array.isArray(value.runs)) {
            return value.runs.map((run) => (run && run.text) || '').join('');
        }
        if (typeof value.content === 'string') return value.content;
        if (value.title) return readText(value.title);
        return '';
    }

    /** "1:02:03" / "3:45" / "3.45" -> detik, atau null kalau bukan waktu. */
    function parseTimeToken(value) {
        const text = String(value === null || value === undefined ? '' : value)
            .trim()
            .replace(/^[\[(]+/, '')
            .replace(/[\])]+$/, '');
        if (!text) return null;

        let match = text.match(TIME_TOKEN);
        if (match) {
            const hours = match[1] ? parseInt(match[1], 10) : 0;
            const minutes = parseInt(match[2], 10);
            const seconds = parseInt(match[3], 10);
            const fraction = match[4]
                ? parseInt(match[4].padEnd(3, '0').slice(0, 3), 10) / 1000
                : 0;
            // "99:00" valid sebagai menit, tapi "1:99:00" tidak.
            if (match[1] && minutes > 59) return null;
            return hours * 3600 + minutes * 60 + seconds + fraction;
        }

        match = text.match(DECIMAL_TOKEN);
        if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
        return null;
    }

    /** Bersihkan judul satu baris tracklist/chapter. */
    function cleanSegmentTitle(value) {
        let text = String(value === null || value === undefined ? '' : value)
            .replace(/\r?\n/g, ' ')
            .replace(/[*_`]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Nomor track di awal: "01.", "1)", "Track 3 -"
        text = text.replace(/^(?:track\s*)?\d{1,3}\s*[.)\-–—:]\s*/i, '');
        // Sisa tanda hubung / pemisah di ujung.
        text = text.replace(/^[\s\-–—:|.]+/, '').replace(/[\s\-–—:|.]+$/, '');
        return text.replace(/\s+/g, ' ').trim();
    }

    function normalizeForScore(value) {
        return String(value === null || value === undefined ? '' : value)
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Skor kemiripan kata 0..1 (F1), cukup untuk memilih urutan artis/judul. */
    function similarity(a, b) {
        const left = normalizeForScore(a);
        const right = normalizeForScore(b);
        if (!left || !right) return 0;
        if (left === right) return 1;
        if (left.includes(right) || right.includes(left)) return 0.9;

        const leftTokens = new Set(left.split(' ').filter(Boolean));
        const rightTokens = new Set(right.split(' ').filter(Boolean));
        if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

        let intersection = 0;
        for (const token of leftTokens) {
            if (rightTokens.has(token)) intersection += 1;
        }
        if (intersection === 0) return 0;

        const precision = intersection / leftTokens.size;
        const recall = intersection / rightTokens.size;
        return (2 * precision * recall) / (precision + recall);
    }

    /**
     * Pisahkan judul chapter menjadi judul lagu + artis.
     *
     * Urutan dideteksi dari nama channel kalau cocok. Kalau tidak ada petunjuk,
     * format yang dipakai adalah "Artis - Judul" (konvensi chapter YouTube).
     *
     * @param {string} rawTitle
     * @param {string} [channel]
     * @returns {{ title: string, artist: string }}
     */
    function parseSegmentTitle(rawTitle, channel) {
        const text = cleanSegmentTitle(rawTitle);
        if (!text) return { title: '', artist: '' };

        // "Judul by Artis"
        const byMatch = text.match(/^(.+?)\s+by\s+(.+)$/i);
        if (byMatch) {
            const title = cleanSegmentTitle(byMatch[1]);
            const artist = cleanSegmentTitle(byMatch[2]);
            if (title && artist) return { title: title, artist: artist };
        }

        const parts = text.split(/\s+[-–—]\s+/);
        if (parts.length < 2) return { title: text, artist: '' };

        const left = cleanSegmentTitle(parts[0]);
        const right = cleanSegmentTitle(parts.slice(1).join(' - '));
        if (!left || !right) return { title: text, artist: '' };

        const channelName = String(channel || '').trim();
        if (channelName) {
            const leftScore = similarity(channelName, left);
            const rightScore = similarity(channelName, right);
            if (rightScore >= 0.5 && rightScore > leftScore) {
                return { title: left, artist: right };
            }
            if (leftScore >= 0.5) {
                return { title: right, artist: left };
            }
        }

        return { title: right, artist: left };
    }

    /**
     * Parse tracklist dari deskripsi video. Baris yang tidak diawali timestamp
     * diabaikan, jadi aman dipakai pada deskripsi panjang/berisi promo.
     */
    function parseTracklist(text, options) {
        const opts = options || {};
        const minEntries = opts.minEntries === undefined ? 3 : opts.minEntries;
        const duration = Number(opts.duration) || 0;
        const source = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
        if (!source) return [];

        const entries = [];
        for (const rawLine of source.split('\n')) {
            const line = rawLine.trim();
            if (!line || HEADER_LINE.test(line)) continue;

            const match = line.match(TRACKLIST_LINE);
            if (!match) continue;

            const start = parseTimeToken(match[1]);
            if (start === null) continue;
            if (duration > 0 && start >= duration) continue;

            const rawTitle = match[2];
            if (!rawTitle || URL_LIKE.test(rawTitle)) continue;

            const title = cleanSegmentTitle(rawTitle);
            if (!title || title.length > 160) continue;

            entries.push({ start: start, title: title });
        }

        const unique = [];
        const seen = new Set();
        for (const entry of entries.sort((a, b) => a.start - b.start)) {
            const key = Math.round(entry.start * 10);
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(entry);
        }

        return unique.length >= minEntries ? unique : [];
    }

    /**
     * Normalisasi chapter YouTube menjadi `{ start, title }`.
     * Menerima `timeRangeStartMillis` (ms), `start`/`time` (detik), atau string.
     */
    function normalizeChapters(list) {
        if (!Array.isArray(list)) return [];

        const entries = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;

            let start = null;
            if (Number.isFinite(item.start)) start = Number(item.start);
            else if (Number.isFinite(item.timeRangeStartMillis)) start = Number(item.timeRangeStartMillis) / 1000;
            else if (Number.isFinite(item.startMillis)) start = Number(item.startMillis) / 1000;
            else if (Number.isFinite(item.time)) start = Number(item.time);
            else if (typeof item.time === 'string') start = parseTimeToken(item.time);

            if (start === null || !Number.isFinite(start) || start < 0) continue;
            entries.push({
                start: start,
                title: cleanSegmentTitle(readText(item.title)),
                artist: cleanSegmentTitle(readText(item.artist))
            });
        }

        entries.sort((a, b) => a.start - b.start);
        const unique = [];
        const seen = new Set();
        for (const entry of entries) {
            const key = Math.round(entry.start * 100);
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(entry);
        }
        return unique;
    }

    /**
     * Susun segmen dari daftar batas lagu.
     * `end` diambil dari awal segmen berikutnya; segmen terakhir memakai durasi
     * video. Segmen yang terlalu pendek dibuang (waktunya menjadi jeda kosong).
     *
     * @returns {Array<{id: string, start: number, end: number, title: string, artist: string, source: string}>}
     */
    function buildSegments(entries, duration, options) {
        const opts = options || {};
        const minLength = opts.minLength === undefined ? MIN_SEGMENT_SECONDS : opts.minLength;
        const source = opts.source || 'chapter';
        const total = Number(duration) || 0;

        const clean = normalizeChapters(entries).filter((entry) => total <= 0 || entry.start < total);
        const segments = [];

        for (let index = 0; index < clean.length; index += 1) {
            const entry = clean[index];
            const next = clean[index + 1];
            const end = next
                ? next.start
                : total > 0
                  ? total
                  : entry.start + DEFAULT_LAST_SEGMENT_SECONDS;

            if (!(end > entry.start)) continue;
            if (end - entry.start < minLength) continue;

            const parsed = entry.artist
                ? { title: entry.title, artist: entry.artist }
                : parseSegmentTitle(entry.title, opts.channel);

            segments.push({
                id: 's' + segments.length,
                start: entry.start,
                end: end,
                title: parsed.title,
                artist: parsed.artist || '',
                source: source
            });
        }

        return segments;
    }

    /** Apakah judul/deskripsi menandakan video kompilasi. */
    function isCompilationTitle(text) {
        const value = String(text === null || text === undefined ? '' : text);
        return AREA_KEYWORDS.test(value) || HOUR_KEYWORDS.test(value);
    }

    /**
     * Deteksi video kompilasi. Keyword di judul/deskripsi paling kuat; kalau
     * tidak ada keyword, dipakai heuristik jumlah dan panjang segmen supaya
     * video satu lagu yang punya chapter pendek tidak ikut terdeteksi.
     */
    function isCompilationVideo(options) {
        const opts = options || {};
        if (isCompilationTitle(opts.title) || isCompilationTitle(opts.description)) return true;

        const segments = Array.isArray(opts.segments) ? opts.segments : [];
        if (segments.length < 4) return false;

        const duration = Number(opts.duration) || 0;
        if (duration > 0 && duration < 600) return false;

        const lengths = segments
            .map((segment) => segment.end - segment.start)
            .filter((length) => length > 0)
            .sort((a, b) => a - b);
        if (lengths.length === 0) return false;

        const median = lengths[Math.floor(lengths.length / 2)];
        return median >= 60 && median <= 600;
    }

    /** Index segmen aktif, atau -1 kalau waktu berada di luar segmen mana pun. */
    function findSegmentIndex(segments, time) {
        if (!Array.isArray(segments) || segments.length === 0) return -1;
        const value = Number(time);
        if (!Number.isFinite(value)) return -1;

        let low = 0;
        let high = segments.length - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (value >= segments[mid].start) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (found < 0) return -1;
        return value < segments[found].end ? found : -1;
    }

    return {
        MIN_SEGMENT_SECONDS: MIN_SEGMENT_SECONDS,
        readText: readText,
        parseTimeToken: parseTimeToken,
        cleanSegmentTitle: cleanSegmentTitle,
        parseSegmentTitle: parseSegmentTitle,
        parseTracklist: parseTracklist,
        normalizeChapters: normalizeChapters,
        buildSegments: buildSegments,
        isCompilationTitle: isCompilationTitle,
        isCompilationVideo: isCompilationVideo,
        findSegmentIndex: findSegmentIndex
    };
});
