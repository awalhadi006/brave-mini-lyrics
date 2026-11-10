# Brave Mini Lyrics (PiP)

Ekstensi browser Chromium (Brave/Chrome/Edge) yang menampilkan **lirik melayang
tersinkronisasi** untuk video musik YouTube menggunakan
[Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).

Lirik diambil dari [lrclib.net](https://lrclib.net), disimpan secara lokal, dan
tetap terlihat di atas jendela lain saat kamu berpindah aplikasi.

## Fitur

- **Lirik tersinkron (LRC)** dengan highlight baris aktif dan auto-scroll.
- **Mode karaoke/ringkas** — hanya satu baris lirik besar di tengah.
- **Kalibrasi offset** `±0.1s` dan kalibrasi instan dengan klik kanan pada baris.
- **Pencarian otomatis & manual** dengan pencocokan judul, artis, dan durasi.
- **Cache per video** — lirik yang sudah ditemukan tidak dicari ulang.
- **Romanisasi Jepang offline** (Kuroshiro + Kuromoji), toggle 🔤.
- **Kontrol pemutar** play/pause, video sebelumnya/berikutnya.
- **Font lirik bisa diperbesar/diperkecil** dan tersimpan permanen.
- **Shortcut keyboard** (lihat di bawah).
- **Tema gelap** yang menyatu dengan jendela PiP.

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
| Klik baris lirik | Lompat ke bagian lagu tersebut |
| Klik kanan baris lirik | Kalibrasi offset instan |
| `-0.1s` / `+0.1s` | Geser sinkronisasi lirik |
| 🎤 | Mode karaoke (satu baris besar) |
| 🔤 | Ubah lirik Jepang ke huruf Latin |
| 🔍 | Cari lirik manual (`Judul Lagu - Nama Artis`) |
| ↻ | Paksa cari ulang, melewati cache |
| ⛶ | Perbesar jendela |
| `Space` | Play / pause |
| `←` / `→` | Geser offset `-0.1s` / `+0.1s` |
| `+` / `-` | Perbesar / perkecil font |
| `Esc` | Tutup menu |

## Cara kerja

```
YouTube page (content script)
├── ambil metadata video (judul, artis, durasi)
├── cari lirik ke lrclib.net (search + get, dengan skor kecocokan)
├── simpan ke chrome.storage.local (per videoId)
├── parse LRC -> daftar {time, text}
├── ikuti timeupdate video -> highlight baris aktif
└── render ke jendela Document PiP (HTML + CSS sendiri)

background service worker
└── (disiapkan) romanisasi Korea/China via Google Translate
```

## Privasi

- Tidak ada server milik pengembang dan tidak ada analytics.
- Data lirik, offset, dan pengaturan disimpan **lokal** di `chrome.storage.local`.
- Hanya dua tujuan jaringan: `lrclib.net` (lirik) dan
  `translate.googleapis.com` (romanisasi, akan aktif di v1.2.0).
- Tidak ada token, akun, atau data pribadi yang dikirim.

## Pengembangan

```bash
npm test        # unit test untuk parser LRC dan skor kecocokan
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
├── dict/                  # kamus Kuromoji (romanisasi Jepang)
├── kuroshiro*.js          # library romanisasi
├── icons/                 # icon ekstensi (hasil generator)
├── scripts/make-icons.js  # generator icon tanpa dependency
├── tests/                 # unit test (node:test)
└── docs/roadmap.md        # rencana fitur per batch
```

Setelah mengubah `manifest.json`, reload ekstensi di `brave://extensions` dan
refresh halaman YouTube.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Jendela lirik tidak muncul | Pastikan Brave/Chrome versi 116+ dan ada video yang sedang diputar |
| Lirik tidak ditemukan | Gunakan 🔍 lalu ketik `Judul Lagu - Nama Artis` |
| Lirik tidak sinkron | Gunakan `-0.1s` / `+0.1s` atau klik kanan pada baris yang benar |
| Lirik salah versi | Klik 🔍 dan pilih versi lain, atau ↻ untuk cari ulang |
| Tombol 🔤 lama saat pertama klik | Normal, kamus 17 MB sedang dimuat (sekali saja) |

## Roadmap

Lihat [docs/roadmap.md](docs/roadmap.md).

## Kredit

- [lrclib.net](https://lrclib.net) — database lirik terbuka.
- [Kuroshiro](https://github.com/hexenq/kuroshiro) — romanisasi Jepang.
- [kuromoji.js](https://github.com/takuyaa/kuromoji.js) — tokenizer Jepang.
- [Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).

## Lisensi

[MIT](LICENSE) © 2026 Awal Hadi Wijaya
