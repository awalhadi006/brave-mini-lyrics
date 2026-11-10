# Cara Ekstensi Mencocokkan Lirik

Dokumen ini menjelaskan alur pencarian lirik di `content.js` dan
`lib/lrc.js`, termasuk aturan normalisasi judul/artis serta dua kasus nyata
yang pernah gagal (Digimon dan Naruto).

## Alur pencarian otomatis

1. **Baca metadata video** dari `ytd-app` (fallback ke DOM):
   judul, nama channel, dan durasi.
2. **Normalisasi judul** (`getVideoMetadata`):
   - parsing OST sebelum tanda kurung dibersihkan;
   - buang penanda tayangan (`Special Anime Movie`, `Movie Version`, dsb.);
   - buang `(Official Video)`, `[MV]`, `feat. …`, dan sejenisnya;
   - pisahkan `Artis - Judul` bila nama artis belum diketahui.
3. **Normalisasi channel** (`Core.parseChannelArtist`):
   - channel soundtrack/OST dianggap generik → `searchArtist` kosong;
   - channel resmi memakai nama artisnya (`FLOW Official YouTube Channel` →
     `FLOW`, `FLOW - Topic` → `FLOW`, `ArianaGrandeVEVO` → `ArianaGrande`).
4. **Pencocokan langsung** `lrclibGet` dengan `artist_name`, `track_name`, dan
   `duration`. Kalau cocok, lirik langsung dipakai (skor 1).
5. **Pencarian lrclib** dengan urutan kueri:
   1. `judul + artis`
   2. `judul + seri` (untuk channel OST)
   3. `judul` saja
   4. potongan judul yang dipisah `|` atau `~`
6. **Sumber cadangan** NetEase & QQ Music dijalankan paralel jika skor lrclib
   masih di bawah `0.6`.
7. **Skor akhir** dihitung `Core.scoreTrack`, lalu hasil di bawah
   `AUTO_MIN_SCORE` (0,5) dianggap bukan lagu yang diputar dan tidak
   ditampilkan.

## Aturan `parseOstTitle`

Fungsi ini memisahkan judul lagu dari nama seri.

| Judul video | `title` | `series` |
|---|---|---|
| `Digimon OST - Butterfly` | `Butterfly` | `Digimon` |
| `Butterfly - Digimon OST` | `Butterfly` | `Digimon` |
| `Butterfly (Digimon OST)` | `Butterfly` | `Digimon` |
| `Butterfly [Digimon Soundtrack]` | `Butterfly` | `Digimon` |
| `OST - Butterfly` | `Butterfly` | *(kosong)* |
| `Song (Official Video)` | `Song (Official Video)` | *(kosong)* |

Penanda `OST`, `Soundtrack`, dan `Theme Song` dikenali. Penanda non-OST seperti
`Official Video` tidak dianggap sebagai nama seri.

## Aturan `parseChannelArtist`

| Nama channel | `artist` | `generic` |
|---|---|---|
| `Animania Soundtrack` | *(kosong)* | `true` |
| `Anime OST` | *(kosong)* | `true` |
| `Various Artists` | *(kosong)* | `true` |
| `FLOW Official YouTube Channel` | `FLOW` | `false` |
| `FLOW - Topic` | `FLOW` | `false` |
| `ArianaGrandeVEVO` | `ArianaGrande` | `false` |
| `Wada Koji` | `Wada Koji` | `false` |

Channel generik membuat pencarian memakai `series` sebagai pengganti artis,
sehingga nama channel seperti “Animania” tidak dianggap penyanyi.

## Bobot skor

`Core.scoreTrack(track, meta)`:

| Kondisi | Judul | Artis | Seri | Durasi |
|---|---|---|---|---|
| Artis diketahui | 50% | 25% | — | 25% |
| Artis kosong, seri diketahui | 50% | — | 25% | 25% |
| Artis & seri kosong | 75% | — | — | 25% |

- `syncedLyrics` mendapat bonus kecil `+0.03`.
- Durasi dianggap cocok penuh jika selisih ≤ 2 detik, dan 0 jika ≥ 15 detik.
- Seri dicocokkan ke judul, album, **atau** artis track (ambil skor tertinggi),
  supaya `Digimon` tetap cocok dengan album `Digimon Adventure`.

## Studi kasus

### 1. Digimon — `Digimon OST - Butterfly`

- Video: `MuhkUzGAeHA`, channel `Animania Soundtrack`, durasi 258 detik.
- Metadata lama: `{ title: "Digimon OST - Butterfly", artist: "Animania Soundtrack" }`.
- Kueri lama tidak pernah menghasilkan apa pun karena lrclib tidak mengenali
  string `Digimon OST - Butterfly`.
- Setelah normalisasi:
  - `title = "Butterfly"`, `series = "Digimon"`;
  - `searchArtist = ""` karena channel OST generik;
  - kueri kedua menjadi `Butterfly Digimon`.
- Hasil terbaik: **Butterfly** oleh `Wada Kōji (和田 光司)`, album
  `Digimon Adventure`, durasi 258 detik — skor 1.

### 2. Naruto — `FLOW - GO!!! Special Anime Movie`

- Video: `733J7oUR904`, channel `FLOW Official YouTube Channel`, durasi 239 detik.
- Sebelum diperbaiki, channel resmi FLOW ikut dianggap generik karena kata
  “Channel”, sehingga pencarian kehilangan artis dan memilih `GO! - Cortis`
  dari sumber cadangan.
- Setelah normalisasi:
  - `parseChannelArtist` menghasilkan `FLOW`;
  - `Special Anime Movie` dibuang dari judul → `GO!!!`;
  - `lrclibGet` langsung menemukan **GO!!!** oleh **FLOW** (durasi 239 detik).

## Verifikasi

Kedua kasus diuji ulang memakai harness E2E (browser terpisah, audio dimatikan):

```bash
BML_EXPECT_TITLE="Butterfly" npm run e2e -- "https://www.youtube.com/watch?v=MuhkUzGAeHA"
# Judul: Butterfly · Artis: Wada Kōji (和田 光司) · Sinkron · 58 baris

BML_EXPECT_TITLE="GO" npm run e2e -- "https://www.youtube.com/watch?v=733J7oUR904"
# Judul: GO!!! · Artis: FLOW · Sinkron · 61 baris
```

Unit test terkait:

```bash
npm test   # termasuk parseOstTitle, parseChannelArtist, scoreTrack
```

## Debug

- Buka DevTools halaman YouTube, lalu cari log
  `Brave Mini Lyrics: skor pencocokan rendah` untuk melihat hasil yang ditolak.
- Untuk memaksa pencarian ulang: tombol ↻ atau 🔍 dengan format
  `Judul Lagu - Nama Artis`.
- Unit test terkait ada di `tests/lrc.test.js`
  (`parseOstTitle`, `parseChannelArtist`, `scoreTrack`).
