'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Segments = require('../lib/segments.js');

test('parseTimeToken menerima format timestamp YouTube', () => {
    assert.equal(Segments.parseTimeToken('0:00'), 0);
    assert.equal(Segments.parseTimeToken('03:45'), 225);
    assert.equal(Segments.parseTimeToken('[10:30]'), 630);
    assert.equal(Segments.parseTimeToken('(1:02:03)'), 3723);
    assert.equal(Segments.parseTimeToken('1.02'), 62);
    assert.equal(Segments.parseTimeToken('2:03.5'), 123.5);
});

test('parseTimeToken menolak teks yang bukan waktu', () => {
    assert.equal(Segments.parseTimeToken(''), null);
    assert.equal(Segments.parseTimeToken('Lagu Satu'), null);
    assert.equal(Segments.parseTimeToken('2026-01-01'), null);
    assert.equal(Segments.parseTimeToken('1:99:00'), null);
});

test('parseTracklist membaca tracklist dari deskripsi', () => {
    const description = [
        'Tracklist:',
        '00:00 Lagu Pertama - Artis A',
        '03:45 Lagu Kedua - Artis B',
        '• 07:12 Lagu Ketiga - Artis C',
        '[10:30] Lagu Keempat - Artis D',
        '1:02:03 Lagu Kelima - Artis E',
        '',
        'Jangan lupa subscribe!',
        'Instagram: https://instagram.com/contoh'
    ].join('\n');

    const entries = Segments.parseTracklist(description);
    assert.deepEqual(
        entries.map((entry) => entry.start),
        [0, 225, 432, 630, 3723]
    );
    assert.equal(entries[2].title, 'Lagu Ketiga - Artis C');
});

test('parseTracklist mendukung format menit.detik dan nomor track', () => {
    const description = ['0.00 01. Intro', '3.45 02. Lagu Dua', '7.10 03. Lagu Tiga'].join('\n');
    const entries = Segments.parseTracklist(description);
    assert.deepEqual(
        entries.map((entry) => entry.start),
        [0, 225, 430]
    );
    assert.equal(entries[1].title, 'Lagu Dua');
});

test('parseTracklist mengurutkan, membuang duplikat, dan menolak daftar pendek', () => {
    const entries = Segments.parseTracklist(
        ['5:00 Lagu B', '0:00 Lagu A', '0:00 Lagu A duplikat', '9:30 Lagu C'].join('\n')
    );
    assert.deepEqual(
        entries.map((entry) => entry.title),
        ['Lagu A', 'Lagu B', 'Lagu C']
    );

    assert.deepEqual(Segments.parseTracklist('0:00 Satu\n3:00 Dua'), []);
});

test('parseTracklist membuang timestamp di luar durasi video', () => {
    const entries = Segments.parseTracklist(
        ['0:00 Lagu A', '3:00 Lagu B', '20:00 Lagu C'].join('\n'),
        { duration: 900, minEntries: 2 }
    );
    assert.deepEqual(
        entries.map((entry) => entry.title),
        ['Lagu A', 'Lagu B']
    );
});

test('normalizeChapters menerima data macroMarkers YouTube', () => {
    const chapters = Segments.normalizeChapters([
        {
            title: { simpleText: 'Lagu Dua - Artis B' },
            timeRangeStartMillis: 225000
        },
        { title: { runs: [{ text: 'Lagu Satu' }, { text: ' - Artis A' }] }, timeRangeStartMillis: 0 },
        { title: 'Tanpa waktu' }
    ]);

    assert.deepEqual(chapters, [
        { start: 0, title: 'Lagu Satu - Artis A', artist: '' },
        { start: 225, title: 'Lagu Dua - Artis B', artist: '' }
    ]);
});

test('buildSegments memakai awal lagu berikutnya dan durasi video', () => {
    const segments = Segments.buildSegments(
        [
            { start: 0, title: 'Artis A - Lagu Satu' },
            { start: 200, title: 'Artis B - Lagu Dua' },
            { start: 410, title: 'Artis C - Lagu Tiga' }
        ],
        600
    );

    assert.deepEqual(
        segments.map((segment) => [segment.start, segment.end]),
        [
            [0, 200],
            [200, 410],
            [410, 600]
        ]
    );
    assert.deepEqual(
        segments.map((segment) => segment.title),
        ['Lagu Satu', 'Lagu Dua', 'Lagu Tiga']
    );
});

test('buildSegments membuang segmen pendek dan memberi id berurutan', () => {
    const segments = Segments.buildSegments(
        [
            { start: 0, title: 'Intro' },
            { start: 5, title: 'Artis A - Lagu Satu' },
            { start: 200, title: 'Artis B - Lagu Dua' },
            { start: 500, title: 'Outro' }
        ],
        520
    );

    assert.deepEqual(
        segments.map((segment) => segment.id),
        ['s0', 's1', 's2']
    );
    assert.deepEqual(
        segments.map((segment) => [segment.start, segment.end]),
        [
            [5, 200],
            [200, 500],
            [500, 520]
        ]
    );
});

test('buildSegments memakai perkiraan untuk segmen terakhir tanpa durasi', () => {
    const segments = Segments.buildSegments(
        [
            { start: 0, title: 'Lagu A' },
            { start: 180, title: 'Lagu B' }
        ],
        0
    );
    assert.equal(segments[1].start, 180);
    assert.equal(segments[1].end, 420);
});

test('parseSegmentTitle memakai nama channel untuk menentukan urutan', () => {
    assert.deepEqual(Segments.parseSegmentTitle('Artis A - Lagu Satu', 'Artis A'), {
        title: 'Lagu Satu',
        artist: 'Artis A'
    });
    assert.deepEqual(Segments.parseSegmentTitle('Lagu Satu - Artis A', 'Artis A'), {
        title: 'Lagu Satu',
        artist: 'Artis A'
    });
});

test('parseSegmentTitle memakai format artis-judul kalau channel tidak cocok', () => {
    assert.deepEqual(Segments.parseSegmentTitle('Artis B - Lagu Dua', 'Channel Kompilasi'), {
        title: 'Lagu Dua',
        artist: 'Artis B'
    });
});

test('parseSegmentTitle membersihkan nomor track dan format "by"', () => {
    assert.deepEqual(Segments.parseSegmentTitle('01. Lagu Tiga - Artis C', 'Artis C'), {
        title: 'Lagu Tiga',
        artist: 'Artis C'
    });
    assert.deepEqual(Segments.parseSegmentTitle('Lagu Empat by Artis D'), {
        title: 'Lagu Empat',
        artist: 'Artis D'
    });
    assert.deepEqual(Segments.parseSegmentTitle('Lagu Tanpa Artis'), {
        title: 'Lagu Tanpa Artis',
        artist: ''
    });
});

test('isCompilationTitle mendeteksi kata kunci kompilasi', () => {
    assert.equal(Segments.isCompilationTitle('Top 20 Lagu Nostalgia'), true);
    assert.equal(Segments.isCompilationTitle('Full Album Nonstop 2026'), true);
    assert.equal(Segments.isCompilationTitle('1 Hour Lofi Mix'), true);
    assert.equal(Segments.isCompilationTitle('Dear God'), false);
    assert.equal(Segments.isCompilationTitle('Remix Kangen Band'), false);
});

test('isCompilationVideo memakai heuristik segmen kalau tanpa keyword', () => {
    const segments = [0, 200, 400, 600, 800].map((start, index, list) => ({
        start: start,
        end: index + 1 < list.length ? list[index + 1] : 1000
    }));

    assert.equal(
        Segments.isCompilationVideo({ title: 'Konser 2026', duration: 1000, segments: segments }),
        true
    );
    assert.equal(
        Segments.isCompilationVideo({ title: 'Dear God', duration: 240, segments: segments }),
        false
    );
    assert.equal(Segments.isCompilationVideo({ title: 'Dear God', duration: 240 }), false);
});

test('findSegmentIndex menghormati batas segmen dan jeda', () => {
    const segments = [
        { start: 10, end: 100 },
        { start: 100, end: 200 }
    ];
    assert.equal(Segments.findSegmentIndex(segments, 5), -1);
    assert.equal(Segments.findSegmentIndex(segments, 10), 0);
    assert.equal(Segments.findSegmentIndex(segments, 99.9), 0);
    assert.equal(Segments.findSegmentIndex(segments, 100), 1);
    assert.equal(Segments.findSegmentIndex(segments, 200), -1);
    assert.equal(Segments.findSegmentIndex([], 10), -1);
});
