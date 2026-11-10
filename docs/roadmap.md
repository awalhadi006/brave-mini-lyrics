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
| 4 | Edit lirik manual (perbaiki typo, hapus bagian) | rencana |
| 5 | Buat lirik manual dari nol (paste teks / LRC) | rencana |
| 6 | Progress pencarian + tombol stop | rencana |
| 7 | Ubah lirik statis menjadi sinkron (mode tap-sync) | rencana |
| 8 | Romanisasi Korea/China lewat Google Translate | rencana |
| 10 | Mode Latin tetap aktif untuk lagu berikutnya | rencana |
| 15 | Sumber lirik tambahan: NetEase / QQ Music | rencana |

## Batch 3 — Polish (v1.3.0)

| # | Fitur / perbaikan | Status |
|---|---|---|
| 3 | Popup window sebagai alternatif PiP (fallback) | rencana |
| 14 | Fast-path kana tanpa memuat kamus 17 MB | rencana |
| — | Tema, opasitas, dan ukuran font lanjutan | rencana |
| — | Ingat posisi & ukuran jendela PiP | rencana |
| — | Export / import cache lirik | rencana |
| — | GitHub Actions: lint, test, zip rilis | rencana |

## Catatan teknis

- **Poin 3 (popup biasa):** Document PiP sudah bisa di-resize dan selalu di atas
  jendela lain. Jendela `chrome.windows.create({ type: "popup" })` bisa di-resize
  bebas dan dipindah ke monitor lain, tetapi tidak selalu di atas. Rencana:
  PiP tetap menjadi mode utama, popup menjadi fallback.
- **Poin 14 (Wanakana):** Wanakana hanya mengubah kana ke romaji, tidak bisa
  kanji. Karena itu Wanakana dipakai sebagai fast-path untuk baris tanpa kanji,
  sedangkan Kuroshiro tetap dipakai saat ada kanji.
- **Poin 15 (sumber baru):** NetEase/QQ Music memerlukan request dari background
  service worker karena CORS. Setiap sumber akan dibuat sebagai adapter dengan
  skor kecocokan yang sama.
