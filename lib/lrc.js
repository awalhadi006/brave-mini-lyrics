/**
 * Modul inti Brave Mini Lyrics.
 * Berisi fungsi murni (tanpa DOM) agar bisa diuji dengan `node --test`.
 *
 * Di content script modul ini menempel ke `globalThis.BMLCore`.
 * Di Node, `module.exports` berisi API yang sama.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BMLCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // [mm:ss], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx]
    const TIME_TAG = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
    // Enhanced LRC: <mm:ss.xx> di tengah baris (timestamp per kata)
    const WORD_TAG = /<\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?>/g;
    const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

    function parseTimestamp(minutes, seconds, fraction) {
        let fractionSeconds = 0;
        if (fraction) {
            // "5" -> 0.5s, "50" -> 0.50s, "500" -> 0.500s
            fractionSeconds = parseInt(fraction, 10) / Math.pow(10, fraction.length);
        }
        return parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + fractionSeconds;
    }

    /**
     * Parse teks LRC menjadi array { time, text } yang terurut.
     * Mendukung banyak timestamp per baris dan tag [offset:...].
     */
    function parseLrc(lrcString, options) {
        if (!lrcString || typeof lrcString !== 'string') return [];
        const opts = options || {};
        const lines = lrcString.replace(/\r\n?/g, '\n').split('\n');
        const result = [];
        let offsetSeconds = 0;

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            const offsetMatch = line.match(OFFSET_TAG);
            if (offsetMatch) {
                offsetSeconds = parseInt(offsetMatch[1], 10) / 1000;
                continue;
            }

            TIME_TAG.lastIndex = 0;
            const timestamps = [];
            let match;
            while ((match = TIME_TAG.exec(line)) !== null) {
                timestamps.push(parseTimestamp(match[1], match[2], match[3]));
            }
            if (timestamps.length === 0) continue;

            let text = line.replace(TIME_TAG, '').replace(WORD_TAG, '').trim();
            if (!text) text = opts.keepEmpty ? '' : '♪';

            for (const time of timestamps) {
                result.push({
                    time: Math.max(0, time - offsetSeconds),
                    text: text
                });
            }
        }

        result.sort((a, b) => a.time - b.time);
        return result;
    }

    /** Cari index baris aktif dengan binary search (parsedLyrics harus terurut). */
    function findActiveIndex(lines, time) {
        let low = 0;
        let high = lines.length - 1;
        let found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (time >= lines[mid].time) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function normalizeText(value) {
        return String(value === null || value === undefined ? '' : value)
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ')
            .replace(/\b(official|lyrics?|music|video|audio|mv|m\/v|live|cover|performance|promotion|pv|hd|4k|full|ver|version)\b/g, ' ')
            .replace(/\b(feat|ft|featuring)\.?\b.*$/, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Skor kemiripan dua teks (F1 dari irisan kata), 0..1. */
    function tokenScore(a, b) {
        const left = normalizeText(a);
        const right = normalizeText(b);
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

    function durationScore(trackDuration, videoDuration) {
        if (!trackDuration || !videoDuration) return 0.5;
        const diff = Math.abs(trackDuration - videoDuration);
        if (diff <= 2) return 1;
        if (diff >= 15) return 0;
        return 1 - (diff - 2) / 13;
    }

    /**
     * Skor kecocokan satu hasil lrclib terhadap metadata video.
     * Judul 50%, artis 25%, durasi 25% (bobot judul naik jika artis kosong).
     */
    function scoreTrack(track, meta) {
        const titleScore = tokenScore(meta.title, track.trackName);
        const artistScore = meta.artist ? tokenScore(meta.artist, track.artistName) : 0;
        const durScore = durationScore(track.duration, meta.duration);

        let score;
        if (meta.artist) {
            score = titleScore * 0.5 + artistScore * 0.25 + durScore * 0.25;
        } else {
            score = titleScore * 0.75 + durScore * 0.25;
        }

        // Sedikit preferensi untuk lirik sinkron saat skor hampir sama.
        if (track.syncedLyrics) score += 0.03;

        return {
            score: Math.min(1, score),
            titleScore: titleScore,
            artistScore: artistScore,
            durationScore: durScore
        };
    }

    /** Pilih hasil terbaik; mengembalikan null jika daftar kosong. */
    function pickBestTrack(tracks, meta) {
        if (!Array.isArray(tracks) || tracks.length === 0) return null;
        let best = null;
        for (const track of tracks) {
            const scored = scoreTrack(track, meta);
            if (!best || scored.score > best.score) {
                best = { track: track, score: scored.score, detail: scored };
            }
        }
        return best;
    }

    /** Deteksi sistem tulisan dominan untuk memilih strategi romanisasi. */
    function detectScript(text) {
        const value = String(text || '');
        if (/[\u3040-\u309f\u30a0-\u30ff]/.test(value)) return 'ja';
        if (/[\uac00-\ud7af\u1100-\u11ff]/.test(value)) return 'ko';
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(value)) return 'zh';
        if (/[\u0400-\u04ff]/.test(value)) return 'cyrillic';
        if (/[\u0600-\u06ff]/.test(value)) return 'arabic';
        if (/[a-z]/i.test(value)) return 'latin';
        return 'unknown';
    }

    function formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return '';
        const total = Math.max(0, Math.round(seconds));
        const minutes = Math.floor(total / 60);
        const rest = total % 60;
        return minutes + ':' + String(rest).padStart(2, '0');
    }

    /** Hash sederhana (djb2) untuk kunci cache teks lirik. */
    function hashText(value) {
        const text = String(value === null || value === undefined ? '' : value);
        let hash = 5381;
        for (let i = 0; i < text.length; i += 1) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        }
        return (hash >>> 0).toString(36);
    }

    /** Ubah detik menjadi timestamp LRC [mm:ss.xx]. */
    function toLrcTimestamp(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const minutes = Math.floor(value / 60);
        const rest = value - minutes * 60;
        return '[' + String(minutes).padStart(2, '0') + ':' + rest.toFixed(2).padStart(5, '0') + ']';
    }

    /**
     * Hapus nama artis dari judul video tanpa merusak judul.
     *
     * Nama artis yang sangat pendek (kurang dari 3 karakter) diabaikan karena
     * rawan menghapus huruf di dalam judul (mis. artis "D" pada "Dear God").
     * Nama artis hanya dihapus sebagai kata utuh, bukan potongan kata.
     */
    function stripArtistFromTitle(title, artist) {
        let result = String(title === null || title === undefined ? '' : title).trim();
        const name = String(artist === null || artist === undefined ? '' : artist).trim();
        if (!result || name.length < 3) return result;

        const lowerResult = result.toLowerCase().replace(/\s+/g, ' ');
        const lowerName = name.toLowerCase().replace(/\s+/g, ' ');
        // Judul yang sama persis dengan nama artis jangan dikosongkan.
        if (lowerResult === lowerName) return result;

        const escaped = escapeRegExp(name);
        result = result
            .replace(new RegExp('^\\s*' + escaped + '\\s*[-–—:]\\s*', 'i'), '')
            .replace(new RegExp('\\s*[-–—:]\\s*' + escaped + '\\s*$', 'i'), '');
        result = result.replace(
            new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?=$|[^\\p{L}\\p{N}])', 'giu'),
            '$1 '
        );

        return result.replace(/\s+/g, ' ').trim();
    }

    return {
        parseLrc: parseLrc,
        findActiveIndex: findActiveIndex,
        escapeHtml: escapeHtml,
        escapeRegExp: escapeRegExp,
        normalizeText: normalizeText,
        tokenScore: tokenScore,
        durationScore: durationScore,
        scoreTrack: scoreTrack,
        pickBestTrack: pickBestTrack,
        stripArtistFromTitle: stripArtistFromTitle,
        detectScript: detectScript,
        formatTime: formatTime,
        hashText: hashText,
        toLrcTimestamp: toLrcTimestamp
    };
});
