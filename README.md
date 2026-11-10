# Brave Mini Lyrics (PiP)

Ekstensi browser Chromium (Brave/Chrome/Edge) yang menampilkan **lirik melayang
tersinkronisasi** untuk video musik YouTube menggunakan
[Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).

Lirik diambil dari [lrclib.net](https://lrclib.net) dan sumber tambahan
(NetEase Cloud Music, QQ Music), disimpan secara lokal, dan tetap terlihat di
atas jendela lain saat kamu berpindah aplikasi.

## Fitur

- **Lirik tersinkron (LRC)** dengan highlight baris aktif dan auto-scroll.
- **Otomatis mengikuti pergantian lagu** di YouTube (next, autoplay, back/forward).
- **Mode karaoke/ringkas** — hanya satu baris lirik besar di tengah.
- **Kalibrasi offset** `±0.1s` dan kalibrasi instan dengan klik kanan pada baris.
- **Pencarian otomatis & manual** dengan pencocokan judul, artis, dan durasi.
- **Sumber lirik tambahan** NetEase Cloud Music dan QQ Music, dipakai otomatis
  saat lrclib tidak yakin dan pada pencarian manual.
- **Progress pencarian** dengan sumber yang sedang dicari dan tombol ⏹ Hentikan.
- **Cache per video** — lirik yang sudah ditemukan tidak dicari ulang.
- **Edit lirik manual** (✎): perbaiki typo, hapus bagian, atau tempel LRC sendiri.
- **Buat lirik dari nol** dan ubah lirik statis menjadi sinkron dengan
  **Tap Sinkron** (tekan TAP tiap baris, lengkap dengan undo).
- **Romanisasi Jepang offline** (Kuroshiro + Kuromoji), toggle 🔤.
- **Fast-path kana**: baris tanpa kanji diromanisasi instan tanpa memuat kamus
  17 MB; kamus hanya dimuat kalau baris mengandung kanji.
- **Romanisasi Korea/China** lewat Google Translate, dengan cache per video.
- **Mode Latin persisten** — lirik non-Latin berikutnya otomatis diromanisasi.
- **Kontrol pemutar** play/pause, video sebelumnya/berikutnya.
- **Font lirik bisa diperbesar/diperkecil** dan tersimpan permanen.
- **Tema terang/gelap** dan **slider opasitas latar** yang tersimpan.
- **Posisi & ukuran jendela PiP diingat** dan dipulihkan saat dibuka lagi.
- **Ekspor / impor cache lirik** (JSON) untuk backup lirik manual dan offset.
- **Fallback popup window** kalau browser tidak mendukung Document PiP.
- **Shortcut keyboard** (lihat di bawah).

## Instalasi (Brave / Chrome / Edge)

1. Clone repo ini:

   ```bash
   git clone https://github.com/awalhadi006/brave-mini-lyrics.git
   ```

2. Buka `brave://extensions` (atau `chrome://extensions`).
3. Aktifkan **Developer mode**.
4. Klik **Load unpacked**, pilih folder hasil clone.
5. Buka video musik di YouTube, lalu klik icon ekstensi atau tekan `Alt+L`.

> **Catatan:** ukuran folder ±17 MB karena kamus Kuromoji untuk romanisasi
> Jepang offline. Kamus hanya dimuat saat tombol 🔤 pertama kali ditekan.

## Cara pakai

| Aksi | Hasil |
|---|---|
| Klik icon ekstensi / `Alt+L` | Buka atau tutup jendela lirik |
| Klik panah `▾` | Buka menu overlay; setelah itu cukup hover untuk membukanya |
| Klik panah lagi / `Esc` | Kunci atau tutup menu |
| Klik baris lirik | Lompat ke bagian lagu tersebut |
| Klik kanan baris lirik | Kalibrasi offset instan |
| `-0.1s` / `+0.1s` | Geser sinkronisasi lirik |
| 🎤 | Mode karaoke (satu baris besar) |
| 🔤 | Ubah lirik Jepang/Korea/China ke huruf Latin |
| ✎ | Edit lirik, tempel LRC sendiri, atau buat dari nol |
| 🎯 Tap Sinkron | Ubah lirik statis jadi LRC dengan menekan TAP tiap baris |
| ⏹ Hentikan | Stop pencarian yang sedang berjalan |
| 🔍 | Cari lirik manual (`Judul Lagu - Nama Artis`) |
| ↻ | Paksa cari ulang, melewati cache |
| ⛶ | Perbesar jendela |
| 🌙 / ☀ | Ganti tema gelap / terang |
| Slider **Latar** | Atur opasitas latar menu (30–100%) |
| ⬇ Ekspor / ⬆ Impor | Backup atau pulihkan cache lirik (JSON) |
| `Space` | Play / pause |
| `←` / `→` | Geser offset `-0.1s` / `+0.1s` |
| `+` / `-` | Perbesar / perkecil font |
| `Esc` | Tutup menu |

## Cara kerja

```
YouTube page (content script)
├── ambil metadata video (judul, artis, durasi)
├── cari lirik ke lrclib.net (search + get, dengan skor kecocokan)
├── fallback ke NetEase / QQ Music lewat service worker
├── simpan ke chrome.storage.local (per videoId)
├── parse LRC -> daftar {time, text}
├── ikuti timeupdate video -> highlight baris aktif
├── editor lirik manual + tap-sync (tersimpan per video)
└── render ke jendela Document PiP (HTML + CSS sendiri)

background service worker
├── adapter NetEase Cloud Music & QQ Music (menghindari CORS)
├── aturan declarativeNetRequest untuk header Referer QQ Music
└── romanisasi Korea/China via Google Translate
```

## Privasi

- Tidak ada server milik pengembang dan tidak ada analytics.
- Data lirik, offset, lirik manual, cache romanisasi, dan pengaturan disimpan
  **lokal** di `chrome.storage.local`.
- Tujuan jaringan hanya `lrclib.net`, `translate.googleapis.com`,
  `music.163.com` (NetEase), dan `c.y.qq.com` (QQ Music) — semuanya untuk
  mengambil lirik atau romanisasi.
- Tidak ada token, akun, atau data pribadi yang dikirim.

## Pengembangan

```bash
npm test        # unit test untuk parser LRC, skor kecocokan, dan kana
npm run check   # syntax check file JS
node scripts/make-icons.js   # regenerate icon PNG
```

Struktur:

```
.
├── manifest.json
├── background.js          # service worker
├── content.js             # logika utama + render PiP
├── pip.css                # style jendela PiP
├── lib/lrc.js             # parser LRC, skor kecocokan, escape HTML
├── lib/kana.js            # fast-path romaji kana (tanpa kamus)
├── dict/                  # kamus Kuromoji (romanisasi Jepang)
├── kuroshiro*.js          # library romanisasi
├── icons/                 # icon ekstensi (hasil generator)
├── scripts/make-icons.js  # generator icon tanpa dependency
├── tests/                 # unit test (node:test)
├── .github/workflows/     # CI: test, check, zip rilis
└── docs/roadmap.md        # rencana fitur per batch
```

Setelah mengubah `manifest.json`, reload ekstensi di `brave://extensions` dan
refresh halaman YouTube.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Jendela lirik tidak muncul | Pastikan Brave/Chrome versi 116+ dan ada video yang sedang diputar |
| Muncul popup biasa, bukan PiP | Browser tidak mendukung Document PiP; popup tetap berfungsi, izinkan popup untuk YouTube |
| Posisi jendela tidak kembali | Pindahkan/resize jendela, tutup, lalu buka lagi; posisi disimpan otomatis |
| Lirik tidak ditemukan | Gunakan 🔍 lalu ketik `Judul Lagu - Nama Artis` |
| Lirik tidak sinkron | Gunakan `-0.1s` / `+0.1s` atau klik kanan pada baris yang benar |
| Lirik salah versi | Klik 🔍 dan pilih versi lain, atau ↻ untuk cari ulang |
| Lirik salah ketik / ada bagian yang mau dihapus | Klik ✎, perbaiki, lalu **Simpan**. **Hapus manual** mengembalikan hasil otomatis |
| Lirik statis belum sinkron | Klik ✎ → **🎯 Tap Sinkron**, putar lagu, tekan TAP tepat di awal tiap baris |
| Lagu Korea/China tidak ditemukan | Cari manual dengan judul aslinya (mis. `周杰伦 晴天`); NetEase/QQ ikut dicari otomatis |
| Tombol 🔤 lama saat pertama klik | Normal jika lagu mengandung kanji; kamus 17 MB sedang dimuat (sekali saja) |

## Roadmap

Lihat [docs/roadmap.md](docs/roadmap.md).

## Kredit

- [lrclib.net](https://lrclib.net) — database lirik terbuka.
- [Kuroshiro](https://github.com/hexenq/kuroshiro) — romanisasi Jepang.
- [kuromoji.js](https://github.com/takuyaa/kuromoji.js) — tokenizer Jepang.
- [Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).

## Lisensi

[MIT](LICENSE) © 2026 Awal Hadi Wijaya
