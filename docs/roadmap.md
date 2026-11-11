# Roadmap

Daftar ini berasal dari `rencana fitur.txt` dan disusun menjadi beberapa batch.
Status: `selesai`, `dikerjakan`, `rencana`.

## Batch 1 — Quick wins (v1.1.0)

| # | Fitur / perbaikan | Status |
|---|---|---|
| 1 | Perbesar / perkecil font lirik | selesai |
| 2 | Simpan hasil pencarian otomatis agar tidak mencari ulang | selesai |
| 9 | Format pencarian manual `Judul - Artis` | selesai |
| 11 | Menu panah dengan overlay hover (tidak menggeser lirik) | selesai |
| 12 | Pembatas antara menu dan hasil pencarian | selesai |
| 13 | Hasil pencarian bisa di-scroll sampai bawah | selesai |
| — | Perbaikan XSS, `parseLrc`, listener leak, race condition, akurasi pencocokan | selesai |

## Batch 2 — Fitur inti (v1.2.0)

| # | Fitur / perbaikan | Status |
|---|---|---|
| 4 | Edit lirik manual (perbaiki typo, hapus bagian) | selesai |
| 5 | Buat lirik manual dari nol (paste teks / LRC) | selesai |
| 6 | Progress pencarian + tombol stop | selesai |
| 7 | Ubah lirik statis menjadi sinkron (mode tap-sync) | selesai |
| 8 | Romanisasi Korea/China lewat Google Translate | selesai |
| 10 | Mode Latin tetap aktif untuk lagu berikutnya | selesai |
| 15 | Sumber lirik tambahan: NetEase / QQ Music | selesai |

## Batch 3 — Polish (v1.3.0)

| # | Fitur / perbaikan | Status |
|---|---|---|
| 3 | Popup window sebagai alternatif PiP (fallback) | selesai |
| 14 | Fast-path kana tanpa memuat kamus 17 MB | selesai |
| — | Tema, opasitas, dan ukuran font lanjutan | selesai |
| — | Ingat posisi & ukuran jendela PiP | selesai |
| — | Export / import cache lirik | selesai |
| — | GitHub Actions: lint, test, zip rilis | selesai |

## Batch 4 — Video kompilasi / multi-lagu (segments)

Rencana lengkap ada di [#1](https://github.com/awalhadi006/brave-mini-lyrics/issues/1).
Masalahnya: video kompilasi/mix berisi banyak lagu dalam satu video, sehingga
durasi video tidak bisa dipakai sebagai durasi lagu dan `videoId` tidak berubah
saat lagu berganti.

Status: **selesai** di [1.4.0](../CHANGELOG.md).

| # | Fitur / perbaikan | Status |
|---|---|---|
| — | Deteksi batas lagu dari Chapters YouTube / timestamp deskripsi | selesai |
| — | Chapters dari MAIN world lewat `page-bridge.js` (isolated world) | selesai |
| — | Mode video panjang untuk video tanpa daftar lagu | selesai |
| — | Model data `segments` (mulai/akhir, judul, artis, offset per lagu) | selesai |
| — | Timeline multi-lagu: lirik digeser per segmen dan dipotong di batas lagu | selesai |
| — | Penanda lagu manual (`＋ Tandai lagu`) untuk mix tanpa metadata | selesai |
| — | Daftar lagu: klik judul untuk melompat ke waktu lagu | selesai |
| — | Pencarian lazy + cache per segmen | selesai |
| — | Peringatan "video kompilasi terdeteksi" agar auto-search tidak salah lagu | selesai |

Audio recognition (Shazam/ACRCloud/AudD) **tidak** direncanakan: audio harus
dikirim ke pihak ketiga (melanggar janji privasi di README) dan menangkap audio
tab YouTube butuh `tabCapture` + offscreen document.

## Batch 5 — Perbaikan UX & pencocokan (1.4.0)

| # | Fitur / perbaikan | Status |
|---|---|---|
| — | Progress bar + persentase + waktu berjalan saat mencari lirik | selesai |
| — | Menu tidak lagi terbuka otomatis pada loading/not-found/hasil | selesai |
| — | Info pemakaian cache + tombol hapus cache otomatis | selesai |
| — | Draft editor otomatis + pintasan `Ctrl+Enter` | selesai |
| — | Deteksi `Judul OST - Lagu` dan skor berbasis seri | selesai |
| — | Deteksi channel resmi (`Official YouTube Channel`, `- Topic`, `VEVO`) | selesai |
| — | Ambang skor minimum agar tidak menampilkan lirik lagu lain | selesai |
| — | Perbaikan Tap Sinkron terhadap offset & baris yang belum ditandai | selesai |
| — | Pencarian NetEase/QQ paralel dan bisa dibatalkan | selesai |
| — | Debounce penulisan offset & pembersihan cache kedaluwarsa | selesai |

Detail aturan pencocokan ada di [matching.md](matching.md).

## Catatan teknis

- **Poin 3 (popup biasa):** Document PiP sudah bisa di-resize dan selalu di atas
  jendela lain. Jendela popup biasa dipakai sebagai fallback saat
  `documentPictureInPicture` tidak tersedia; popup bisa dipindah bebas tetapi
  tidak selalu di atas jendela lain.
- **Poin 14 (kana fast-path):** `lib/kana.js` mengubah hiragana/katakana ke
  romaji tanpa kamus. Kuroshiro (kamus 17 MB) hanya dimuat kalau baris mengandung
  kanji, karena kanji butuh analisis morfologi.
- **Poin 15 (sumber baru):** NetEase/QQ Music diakses dari background service
  worker karena CORS. QQ Music menolak permintaan lirik tanpa header `Referer`,
  dan `fetch()` tidak bisa mengatur header itu, jadi service worker memasang
  aturan `declarativeNetRequest` (`modifyHeaders`) untuk `c.y.qq.com` dan
  `music.163.com`. Kedua adapter memakai skor kecocokan yang sama dengan lrclib.
  NetEase memakai endpoint lama `/api/search/get` karena endpoint `/web`
  mengembalikan data terenkripsi.
- **Batch 4 (segments):** batas lagu diambil dari `playerResponse.engagementPanels`
  → `macroMarkersListRenderer` (Chapters), lalu fallback ke timestamp di
  deskripsi. Content script berjalan di isolated world, jadi data halaman
  dibaca `page-bridge.js` yang dipasang di MAIN world (`"world": "MAIN"`) dan
  dikirim lewat `window.postMessage`. Kalau tidak ada Chapters/tracklist dan
  durasi ≥ 10 menit (atau ≥ 5 menit dengan judul kompilasi), ekstensi masuk
  **mode video panjang**: satu segmen tanpa judul, tanpa pencarian memakai judul
  video, dan pengguna menandai lagu dengan `＋`. Placeholder ini tidak disimpan;
  menghapusnya memasang `segmentsDisabled` dan mengembalikan mode satu lagu.
  Segmen disimpan per video di `bml:v2:video:<videoId>` beserta
  lirik/offset masing-masing. Saat video dimuat ulang, hasil deteksi baru
  digabung dengan segmen tersimpan berdasarkan awal ±1,5 detik agar lirik dan
  offset tidak hilang. Begitu pengguna mengedit/menandai lagu, flag
  `segmentsEdited` mengunci hasil deteksi; menghapus semua segmen memasang
  `segmentsDisabled` supaya tidak muncul lagi. Semua waktu lirik dihitung
  relatif ke awal segmen (`currentTime - segmentBase - offset`), sehingga
  klik-lirik dan Tap Sinkron ikut bergeser per lagu.
- **Batch 5 (pencocokan):** judul OST diparsing sebelum tanda kurung dibersihkan,
  nama channel resmi diambil dari `parseChannelArtist`, dan hasil pencarian di
  bawah skor 0,5 tidak ditampilkan. Urutan lengkap ada di
  [matching.md](matching.md).
