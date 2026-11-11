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

test('shouldUseLongVideoMode mendeteksi video panjang tanpa metadata lagu', () => {
    assert.equal(Segments.shouldUseLongVideoMode({ title: 'Dear God', duration: 240 }), false);
    assert.equal(
        Segments.shouldUseLongVideoMode({ title: 'Konser 2026', duration: 600 }),
        true
    );
    assert.equal(
        Segments.shouldUseLongVideoMode({ title: 'Kumpulan Lagu Nostalgia', duration: 420 }),
        true
    );
    // "Best of Me" bukan kompilasi kalau durasinya pendek.
    assert.equal(Segments.shouldUseLongVideoMode({ title: 'Best of Me', duration: 240 }), false);
});

test('buildLongVideoSegment membuat satu segmen tanpa judul', () => {
    const segment = Segments.buildLongVideoSegment(1800);
    assert.equal(segment.start, 0);
    assert.equal(segment.end, 1800);
    assert.equal(segment.title, '');
    assert.equal(segment.source, 'long-video');
    assert.equal(segment.offset, 0);
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

test('addSegment memecah video satu lagu menjadi dua segmen', () => {
    const result = Segments.addSegment([], {
        start: 180,
        title: 'Lagu Baru',
        artist: 'Artis Baru'
    }, { duration: 400, fallbackTitle: 'Judul Video', fallbackArtist: 'Channel' });

    assert.deepEqual(
        result.map((segment) => [segment.start, segment.end, segment.title, segment.artist]),
        [
            [0, 180, 'Judul Video', 'Channel'],
            [180, 400, 'Lagu Baru', 'Artis Baru']
        ]
    );
});

test('addSegment memecah segmen di tengah dan mempertahankan lirik lama', () => {
    const existing = [
        { id: 's0', start: 0, end: 200, title: 'Lagu A', artist: 'A', autoData: { trackName: 'A' }, autoCachedAt: 123 }
    ];
    const result = Segments.addSegment(existing, { start: 120, title: 'Lagu B', artist: 'B' }, { duration: 400 });

    assert.deepEqual(
        result.map((segment) => [segment.start, segment.end, segment.title]),
        [
            [0, 120, 'Lagu A'],
            [120, 200, 'Lagu B']
        ]
    );
    assert.equal(result[0].autoCachedAt, 123);
});

test('addSegment mengganti judul kalau titik terlalu dekat awal segmen', () => {
    const existing = [{ id: 's0', start: 0, end: 200, title: 'Lagu A', artist: 'A' }];
    const result = Segments.addSegment(existing, { start: 5, title: 'Lagu B', artist: 'B' }, { duration: 400 });
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Lagu B');
});

test('addSegment menambahkan lagu setelah segmen terakhir', () => {
    const existing = [{ id: 's0', start: 0, end: 200, title: 'Lagu A', artist: 'A' }];
    const result = Segments.addSegment(existing, { start: 260, title: 'Lagu B', artist: 'B' }, { duration: 400 });
    assert.deepEqual(
        result.map((segment) => [segment.start, segment.end]),
        [
            [0, 200],
            [260, 400]
        ]
    );
});

test('addSegment di batas segmen tidak membuat segmen berdurasi nol', () => {
    const existing = [
        { id: 's0', start: 0, end: 200, title: 'Lagu A', artist: 'A' },
        { id: 's1', start: 200, end: 400, title: 'Lagu B', artist: 'B' }
    ];
    const result = Segments.addSegment(existing, { start: 200, title: 'Lagu C', artist: 'C' }, { duration: 400 });
    assert.equal(result.length, 2);
    assert.deepEqual(
        result.map((segment) => [segment.start, segment.end, segment.title]),
        [
            [0, 200, 'Lagu A'],
            [200, 400, 'Lagu C']
        ]
    );
});

test('addSegment menyisipkan lagu di celah sesuai urutan waktu', () => {
    const existing = [
        { id: 's0', start: 100, end: 200, title: 'Lagu A', artist: 'A' },
        { id: 's1', start: 250, end: 300, title: 'Lagu B', artist: 'B' }
    ];
    const result = Segments.addSegment(existing, { start: 50, title: 'Intro', artist: 'C' }, { duration: 300 });
    assert.deepEqual(
        result.map((segment) => [segment.start, segment.end, segment.title]),
        [
            [50, 100, 'Intro'],
            [100, 200, 'Lagu A'],
            [250, 300, 'Lagu B']
        ]
    );
});

test('updateSegment menggeser awal tanpa menabrak segmen sebelumnya', () => {
    const list = [
        { id: 's0', start: 0, end: 100, title: 'A' },
        { id: 's1', start: 100, end: 200, title: 'B' }
    ];
    const result = Segments.updateSegment(list, 1, { start: 5, title: 'Baru' }, { minLength: 15 });
    assert.equal(result[1].start, 15);
    assert.equal(result[0].end, 15);
    assert.equal(result[1].title, 'Baru');
});

test('updateSegment membuang cache otomatis saat judul berubah', () => {
    const list = [
        {
            id: 's0',
            start: 0,
            end: 100,
            title: 'Lagu A',
            artist: 'A',
            autoData: { trackName: 'Lagu A' },
            autoCachedAt: 999,
            manualData: { trackName: 'Manual' }
        }
    ];
    const result = Segments.updateSegment(list, 0, { title: 'Lagu B' }, { minLength: 15 });
    assert.equal(result[0].autoData, null);
    assert.equal(result[0].autoCachedAt, 0);
    assert.deepEqual(result[0].manualData, { trackName: 'Manual' });
    assert.equal(result[0].edited, true);
});

test('updateSegment mempertahankan cache kalau judul/artis tidak berubah', () => {
    const list = [
        {
            id: 's0',
            start: 0,
            end: 100,
            title: 'Lagu A',
            artist: 'A',
            autoData: { trackName: 'Lagu A' },
            autoCachedAt: 999
        }
    ];
    const result = Segments.updateSegment(list, 0, { title: 'Lagu A', artist: 'A' });
    assert.deepEqual(result[0].autoData, { trackName: 'Lagu A' });
    assert.equal(result[0].autoCachedAt, 999);
    assert.equal(result[0].edited, undefined);
});

test('removeSegment menggabungkan waktu ke segmen sebelumnya', () => {
    const list = [
        { id: 's0', start: 0, end: 100, title: 'A' },
        { id: 's1', start: 100, end: 200, title: 'B' },
        { id: 's2', start: 200, end: 300, title: 'C' }
    ];
    const result = Segments.removeSegment(list, 1);
    assert.deepEqual(
        result.map((segment) => [segment.id, segment.start, segment.end, segment.title]),
        [
            ['s0', 0, 200, 'A'],
            ['s1', 200, 300, 'C']
        ]
    );
    assert.deepEqual(Segments.removeSegment(list, 0)[0].start, 0);
    assert.deepEqual(Segments.removeSegment([{ start: 0, end: 10 }], 0), []);
});
