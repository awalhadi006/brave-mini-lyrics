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
