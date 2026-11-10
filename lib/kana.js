/**
 * Fast-path romanisasi kana tanpa kamus Kuromoji (17 MB).
 *
 * Hanya menangani hiragana/katakana. Teks yang mengandung kanji tetap harus
 * lewat Kuroshiro karena butuh analisis morfologi.
 *
 * Di content script modul ini menempel ke `globalThis.BMLKana`.
 * Di Node, `module.exports` berisi API yang sama.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BMLKana = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Dasar hiragana.
    const BASE = {
        あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
        か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
        が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
        さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
        ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
        た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
        だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
        な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
        は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
        ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
        ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
        ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
        や: 'ya', ゆ: 'yu', よ: 'yo',
        ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
        わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
        ゔ: 'vu',
        ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
        ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa'
    };

    // Kombinasi dua karakter (youon dan serapan asing).
    const COMBOS = {
        きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
        ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
        しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
        じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
        ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
        ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
        にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
        ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
        びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
        ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
        みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
        りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
        ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
        てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
        うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
        ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
        とぅ: 'tu', どぅ: 'du', つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
        しぇ: 'she', じぇ: 'je', ちぇ: 'che',
        すぃ: 'si', ずぃ: 'zi'
    };

    const VOWELS = 'aiueo';
    const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    const KANA = /[\u3040-\u30ff]/;

    function toHiragana(text) {
        let output = '';
        for (let i = 0; i < text.length; i += 1) {
            const code = text.charCodeAt(i);
            // Katakana ァ..ヶ -> hiragana ぁ..ゖ
            if (code >= 0x30a1 && code <= 0x30f6) {
                output += String.fromCharCode(code - 0x60);
            } else if (code === 0x30fc) {
                // ー (long vowel mark) dipertahankan
                output += '\u30fc';
            } else {
                output += text[i];
            }
        }
        return output;
    }

    function unitRomaji(hira, index) {
        const two = hira.slice(index, index + 2);
        if (COMBOS[two]) return COMBOS[two];
        const one = hira[index];
        return BASE[one] || null;
    }

    function lastVowel(text) {
        for (let i = text.length - 1; i >= 0; i -= 1) {
            const ch = text[i].toLowerCase();
            if (VOWELS.indexOf(ch) !== -1) return ch;
            if (/[a-z]/.test(ch)) return '';
        }
        return '';
    }

    /**
     * Romanisasi teks kana dengan aturan Hepburn sederhana.
     * Karakter non-kana (kanji, latin, tanda baca) dibiarkan apa adanya.
     */
    function romanize(text) {
        const hira = toHiragana(String(text === null || text === undefined ? '' : text));
        let output = '';
        let i = 0;

        while (i < hira.length) {
            const ch = hira[i];

            if (ch === 'っ') {
                const next = unitRomaji(hira, i + 1);
                if (next && !VOWELS.includes(next[0])) output += next[0];
                i += 1;
                continue;
            }

            if (ch === '\u30fc') {
                output += lastVowel(output);
                i += 1;
                continue;
            }

            const romaji = unitRomaji(hira, i);
            if (romaji) {
                output += romaji;
                i += COMBOS[hira.slice(i, i + 2)] ? 2 : 1;
                continue;
            }

            output += ch;
            i += 1;
        }

        return output;
    }

    function hasKanji(text) {
        return KANJI.test(String(text || ''));
    }

    function hasKana(text) {
        return KANA.test(String(text || ''));
    }

    return {
        romanize: romanize,
        hasKanji: hasKanji,
        hasKana: hasKana
    };
});
