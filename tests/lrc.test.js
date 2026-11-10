const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/lrc.js');

function close(actual, expected, epsilon = 1e-9) {
    assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test('parseLrc: milidetik 3 digit dibaca dengan benar', () => {
    const lines = Core.parseLrc('[00:12.345]Halo');
    assert.equal(lines.length, 1);
    close(lines[0].time, 12.345);
    assert.equal(lines[0].text, 'Halo');
});

test('parseLrc: milidetik 2 digit dan tanpa milidetik', () => {
    close(Core.parseLrc('[00:12.50]A')[0].time, 12.5);
    close(Core.parseLrc('[01:05]B')[0].time, 65);
});

test('parseLrc: banyak timestamp pada satu baris', () => {
    const lines = Core.parseLrc('[00:10.00][01:20.00]Reff');
    assert.equal(lines.length, 2);
    close(lines[0].time, 10);
    close(lines[1].time, 80);
    assert.equal(lines[0].text, 'Reff');
    assert.equal(lines[1].text, 'Reff');
});

test('parseLrc: baris diurutkan berdasarkan waktu', () => {
    const lines = Core.parseLrc('[00:30.00]C\n[00:10.00]A\n[00:20.00]B');
    assert.deepEqual(lines.map((line) => line.text), ['A', 'B', 'C']);
});

test('parseLrc: tag offset diterapkan', () => {
    const lines = Core.parseLrc('[offset:-500]\n[00:10.00]A');
    close(lines[0].time, 10.5);
});

test('parseLrc: tag metadata diabaikan', () => {
    const lines = Core.parseLrc('[ar:Artis]\n[ti:Judul]\n[by:Someone]\n[00:01.00]Isi');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'Isi');
});

test('parseLrc: teks kosong diganti not balok', () => {
    assert.equal(Core.parseLrc('[00:01.00]')[0].text, '♪');
});

test('parseLrc: enhanced LRC (timestamp per kata) dibersihkan', () => {
    const lines = Core.parseLrc("[00:18.00]<00:18.89>We're <00:19.25>no <00:19.53>strangers");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "We're no strangers");
});

test('parseLrc: input tidak valid aman', () => {
    assert.deepEqual(Core.parseLrc(null), []);
    assert.deepEqual(Core.parseLrc(''), []);
    assert.deepEqual(Core.parseLrc('bukan lrc sama sekali'), []);
});

test('findActiveIndex: binary search', () => {
    const lines = Core.parseLrc('[00:10.00]A\n[00:20.00]B\n[00:30.00]C');
    assert.equal(Core.findActiveIndex(lines, 5), -1);
    assert.equal(Core.findActiveIndex(lines, 10), 0);
    assert.equal(Core.findActiveIndex(lines, 25), 1);
    assert.equal(Core.findActiveIndex(lines, 99), 2);
});

test('escapeHtml: menetralkan markup', () => {
    assert.equal(
        Core.escapeHtml('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    assert.equal(Core.escapeHtml(null), '');
});

test('tokenScore: mirip dan tidak mirip', () => {
    assert.equal(Core.tokenScore('Dewa 19 Kangen', 'Kangen'), 0.9);
    assert.equal(Core.tokenScore('Dewa 19 Kangen', 'Dewa 19 Kangen'), 1);
    assert.equal(Core.tokenScore('Dewa 19 Kangen', 'Sheila On 7'), 0);
});

test('scoreTrack: judul, artis, dan durasi cocok menang', () => {
    const meta = { title: 'Kangen', artist: 'Dewa 19', duration: 300 };
    const right = {
        trackName: 'Kangen',
        artistName: 'Dewa 19',
        duration: 301,
        syncedLyrics: '[00:01.00]A'
    };
    const wrong = {
        trackName: 'Kangen (Cover)',
        artistName: 'Band Lain',
        duration: 240,
        syncedLyrics: '[00:01.00]B'
    };
    const best = Core.pickBestTrack([wrong, right], meta);
    assert.equal(best.track.artistName, 'Dewa 19');
    assert.ok(best.score > 0.8);
    assert.ok(Core.scoreTrack(wrong, meta).score < best.score);
});

test('scoreTrack: tanpa artis tetap memakai judul dan durasi', () => {
    const meta = { title: 'Kangen', artist: '', duration: 300 };
    const track = { trackName: 'Kangen', artistName: 'Dewa 19', duration: 300, syncedLyrics: null };
    const scored = Core.scoreTrack(track, meta);
    assert.ok(scored.score > 0.7);
});

test('detectScript: membedakan Jepang, Korea, China, Latin', () => {
    assert.equal(Core.detectScript('君の名は'), 'ja');
    assert.equal(Core.detectScript('사랑해'), 'ko');
    assert.equal(Core.detectScript('我爱你'), 'zh');
    assert.equal(Core.detectScript('I love you'), 'latin');
});

test('formatTime', () => {
    assert.equal(Core.formatTime(65), '1:05');
    assert.equal(Core.formatTime(0), '');
    assert.equal(Core.formatTime(NaN), '');
});

test('toLrcTimestamp: dua digit desimal dan menit', () => {
    assert.equal(Core.toLrcTimestamp(0), '[00:00.00]');
    assert.equal(Core.toLrcTimestamp(65.4), '[01:05.40]');
});

test('hashText: stabil dan berbeda untuk teks berbeda', () => {
    assert.equal(Core.hashText('abc'), Core.hashText('abc'));
    assert.notEqual(Core.hashText('abc'), Core.hashText('abd'));
    assert.equal(Core.hashText(null), Core.hashText(''));
});

test('stripArtistFromTitle: nama artis pendek tidak merusak judul', () => {
    assert.equal(Core.stripArtistFromTitle('Dear God', 'D'), 'Dear God');
});

test('stripArtistFromTitle: artis di awal atau akhir judul', () => {
    assert.equal(Core.stripArtistFromTitle('Avenged Sevenfold - Dear God', 'Avenged Sevenfold'), 'Dear God');
    assert.equal(Core.stripArtistFromTitle('Dear God - Avenged Sevenfold', 'Avenged Sevenfold'), 'Dear God');
    assert.equal(Core.stripArtistFromTitle('Avenged Sevenfold: Dear God', 'Avenged Sevenfold'), 'Dear God');
});

test('stripArtistFromTitle: hanya kata utuh, bukan potongan kata', () => {
    assert.equal(Core.stripArtistFromTitle('Queens of the Stone Age', 'Queen'), 'Queens of the Stone Age');
    assert.equal(Core.stripArtistFromTitle('Shape of You', 'Ed Sheeran'), 'Shape of You');
});

test('stripArtistFromTitle: judul sama dengan artis tidak dikosongkan', () => {
    assert.equal(Core.stripArtistFromTitle('Queen', 'Queen'), 'Queen');
});

test('parseOstTitle: seri di depan, belakang, dan dalam kurung', () => {
    assert.deepEqual(Core.parseOstTitle('Digimon OST - Butterfly'), {
        title: 'Butterfly',
        series: 'Digimon'
    });
    assert.deepEqual(Core.parseOstTitle('Butterfly - Digimon OST'), {
        title: 'Butterfly',
        series: 'Digimon'
    });
    assert.deepEqual(Core.parseOstTitle('Butterfly (Digimon OST)'), {
        title: 'Butterfly',
        series: 'Digimon'
    });
    assert.deepEqual(Core.parseOstTitle('Butterfly [Digimon Soundtrack]'), {
        title: 'Butterfly',
        series: 'Digimon'
    });
});

test('parseOstTitle: OST tanpa nama seri dan judul biasa', () => {
    assert.deepEqual(Core.parseOstTitle('OST - Butterfly'), {
        title: 'Butterfly',
        series: ''
    });
    assert.deepEqual(Core.parseOstTitle('Butterfly'), {
        title: 'Butterfly',
        series: ''
    });
    // Penanda non-OST tidak boleh dianggap seri.
    assert.deepEqual(Core.parseOstTitle('Song (Official Video)'), {
        title: 'Song (Official Video)',
        series: ''
    });
});

test('parseOstTitle: input kosong aman', () => {
    assert.deepEqual(Core.parseOstTitle(''), { title: '', series: '' });
    assert.deepEqual(Core.parseOstTitle(null), { title: '', series: '' });
});

test('isGenericArtistName: channel soundtrack dikenali', () => {
    assert.equal(Core.isGenericArtistName('Animania Soundtrack'), true);
    assert.equal(Core.isGenericArtistName('Various Artists'), true);
    assert.equal(Core.isGenericArtistName('Anime OST'), true);
    assert.equal(Core.isGenericArtistName('Wada Koji'), false);
    assert.equal(Core.isGenericArtistName(''), false);
});

test('parseChannelArtist: channel resmi memakai nama artisnya', () => {
    assert.deepEqual(Core.parseChannelArtist('FLOW Official YouTube Channel'), {
        artist: 'FLOW',
        generic: false
    });
    assert.deepEqual(Core.parseChannelArtist('FLOW - Topic'), {
        artist: 'FLOW',
        generic: false
    });
    assert.deepEqual(Core.parseChannelArtist('ArianaGrandeVEVO'), {
        artist: 'ArianaGrande',
        generic: false
    });
    assert.deepEqual(Core.parseChannelArtist('Wada Koji'), {
        artist: 'Wada Koji',
        generic: false
    });
});

test('parseChannelArtist: channel soundtrack tetap generik', () => {
    assert.deepEqual(Core.parseChannelArtist('Animania Soundtrack'), {
        artist: '',
        generic: true
    });
    assert.deepEqual(Core.parseChannelArtist('Anime OST'), {
        artist: '',
        generic: true
    });
    assert.deepEqual(Core.parseChannelArtist('Various Artists'), {
        artist: '',
        generic: true
    });
    assert.deepEqual(Core.parseChannelArtist(''), { artist: '', generic: false });
});


test('scoreTrack: nama seri menggantikan artis untuk channel OST', () => {
    const meta = { title: 'Butterfly', artist: '', series: 'Digimon', duration: 258 };
    const correct = {
        trackName: 'Butterfly',
        artistName: 'Wada Kōji',
        albumName: 'Digimon Adventure',
        duration: 258,
        syncedLyrics: '[00:01.00]x'
    };
    const cover = {
        trackName: 'Butterfly (Digimon Tri)',
        artistName: 'Animelmack',
        albumName: 'Butterfly (Digimon Tri)',
        duration: 227,
        syncedLyrics: '[00:01.00]x'
    };
    assert.ok(Core.scoreTrack(correct, meta).score > Core.scoreTrack(cover, meta).score);
    assert.ok(Core.scoreTrack(correct, meta).seriesScore >= 0.9);
    assert.equal(Core.scoreTrack(correct, meta).score, 1);
});
