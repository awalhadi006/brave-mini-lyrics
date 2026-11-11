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
- **Video kompilasi / mix multi-lagu** — batas lagu dideteksi dari Chapters
  YouTube atau timestamp di deskripsi. Lirik, offset, dan cache disimpan per
  lagu; lagu berganti otomatis mengikuti posisi video. Ada bar lagu `‹ ›`,
  tombol `＋` untuk menandai lagu baru secara manual, dan **daftar lagu** yang
  bisa diklik untuk melompat ke waktu mulainya.
- **Mode video panjang** — kalau video ≥ 10 menit tidak punya Chapters atau
  tracklist, ekstensi tidak menebak lirik dari judul video. PiP menampilkan
  panduan menandai lagu dengan `＋`, jadi video mix yang metadatanya kosong
  tetap bisa dipakai per lagu.
- **Mode karaoke/ringkas** — hanya satu baris lirik besar di tengah.
- **Kalibrasi offset** `±0.1s` dan kalibrasi instan dengan klik kanan pada baris.
- **Pencarian otomatis & manual** dengan pencocokan judul, artis, dan durasi.
- **Deteksi judul & channel OST** — judul seperti `Digimon OST - Butterfly`
  dipahami sebagai lagu *Butterfly* dari seri *Digimon*, dan channel soundtrack
  seperti `Animania Soundtrack` tidak dipakai sebagai nama artis. Channel resmi
  (`FLOW Official YouTube Channel`, `- Topic`, `VEVO`) tetap memakai nama
  artisnya.
- **Sumber lirik tambahan** NetEase Cloud Music dan QQ Music, dipakai otomatis
  saat lrclib tidak yakin dan pada pencarian manual.
- **Progress bar pencarian** dengan status sumber, persentase langkah, waktu
  berjalan, dan tombol ⏹ Hentikan.
- **Cache per video** — lirik yang sudah ditemukan tidak dicari ulang.
- **Manajemen cache** — lihat jumlah lagu/ukuran cache dan hapus cache otomatis
  dengan 🧹 tanpa menghapus lirik manual atau offset.
- **Edit lirik manual** (✎): perbaiki typo, hapus bagian, atau tempel LRC sendiri.
- **Draft otomatis + Ctrl+Enter** — ketikan tersimpan sementara dan dipulihkan
  saat editor dibuka lagi; simpan cepat dengan `Ctrl+Enter`.
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
| `‹` / `›` di bar lagu | Pindah ke lagu sebelumnya / berikutnya (video kompilasi) |
| Klik judul di bar lagu | Buka **daftar lagu**; klik salah satu lagu untuk melompat ke waktunya |
| `✎` di bar lagu | Edit judul, artis, atau waktu mulai lagu aktif |
| `＋` di bar lagu / header | Tandai lagu baru pada posisi video saat ini |
| `-0.1s` / `+0.1s` | Geser sinkronisasi lirik |
| 🎤 | Mode karaoke (satu baris besar) |
| 🔤 | Ubah lirik Jepang/Korea/China ke huruf Latin |
| ✎ | Edit lirik, tempel LRC sendiri, atau buat dari nol |
| `Ctrl+Enter` (di editor) | Simpan lirik tanpa menekan tombol |
| 🎯 Tap Sinkron | Ubah lirik statis jadi LRC dengan menekan TAP tiap baris |
| ⏹ Hentikan | Stop pencarian yang sedang berjalan |
| 🔍 | Cari lirik manual (`Judul Lagu - Nama Artis`) |
| ↻ | Paksa cari ulang, melewati cache |
| ⛶ | Perbesar jendela |
| 🌙 / ☀ | Ganti tema gelap / terang |
| Slider **Latar** | Atur opasitas latar menu (30–100%) |
| ⬇ Ekspor / ⬆ Impor | Backup atau pulihkan cache lirik (JSON) |
| 🧹 Hapus cache | Hapus cache otomatis & draft (lirik manual dan offset tetap) |
| `Space` | Play / pause |
| `Alt+L` | Buka / tutup jendela lirik |
| `Alt+Shift+L` | Pin ulang jendela lirik agar kembali di atas aplikasi lain |
| `←` / `→` | Geser offset `-0.1s` / `+0.1s` |
| `+` / `-` | Perbesar / perkecil font |
| `Esc` | Tutup menu |

**Mode video panjang:** kalau video tidak punya Chapters/tracklist, tekan `＋`
tepat saat lagu baru mulai lalu isi Judul/Artis. Lirik akan berganti otomatis
sesuai batas yang kamu tandai. Kalau ternyata video itu satu lagu panjang,
buka 🔍 (judul video sudah terisi) lalu tekan **Cari**.

## Cara kerja

```
YouTube page (content script)
├── ambil metadata video (judul, artis, durasi)
├── chapters dari page-bridge.js (MAIN world) via postMessage
├── deteksi segmen lagu (Chapters / timestamp deskripsi)
├── mode video panjang kalau tidak ada daftar lagu
├── normalisasi judul OST + nama channel resmi
├── cari lirik ke lrclib.net (search + get, dengan skor kecocokan)
├── fallback ke NetEase / QQ Music lewat service worker
├── simpan ke chrome.storage.local (per videoId, lirik per segmen)
├── parse LRC -> daftar {time, text}
├── ikuti timeupdate video -> highlight baris aktif (relatif ke awal segmen)
├── editor lirik manual + tap-sync + draft otomatis (per video/lagu)
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
npm test        # unit test untuk parser LRC, skor kecocokan, kana, dan segmen
npm run check   # syntax check file JS
npm run e2e     # smoke test PiP di Brave/Chromium headless
node scripts/make-icons.js   # regenerate icon PNG
```

`npm run e2e` membuka instance browser terpisah dengan profil sementara dan
`--mute-audio`, jadi Brave yang sedang kamu pakai tidak ikut ter-mute atau
terganggu. Butuh Node.js 22+. Contoh:

```bash
npm run e2e -- "https://www.youtube.com/watch?v=Dk4qOa4ivIM"
BML_EXPECT_TITLE="Dear God" npm run e2e
```

Variabel lain: `BML_BROWSER` (path browser), `BML_EXTENSION` (folder ekstensi),
`BML_PORT` (port debugging), `BML_HEADFUL=1` (tampilkan jendela).

Struktur:

```
.
├── manifest.json
├── background.js          # service worker
├── content.js             # logika utama + render PiP
├── page-bridge.js         # baca Chapters dari halaman (MAIN world)
├── pip.css                # style jendela PiP
├── lib/lrc.js             # parser LRC, skor kecocokan, escape HTML
├── lib/kana.js            # fast-path romaji kana (tanpa kamus)
├── lib/segments.js        # deteksi batas lagu video kompilasi (Batch 4)
├── dict/                  # kamus Kuromoji (romanisasi Jepang)
├── kuroshiro*.js          # library romanisasi
├── icons/                 # icon ekstensi (hasil generator)
├── scripts/make-icons.js  # generator icon tanpa dependency
├── scripts/e2e.js         # smoke test PiP (browser terpisah, audio mati)
├── tests/                 # unit test (node:test)
├── .github/workflows/     # CI: test, check, zip rilis
├── docs/roadmap.md        # rencana fitur per batch
└── docs/matching.md       # alur & aturan pencocokan lirik
```

Setelah mengubah `manifest.json`, reload ekstensi di `brave://extensions` dan
refresh halaman YouTube.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Jendela lirik tidak muncul | Pastikan Brave/Chrome versi 116+ dan ada video yang sedang diputar |
| Muncul popup biasa, bukan PiP | Browser tidak mendukung Document PiP; popup tetap berfungsi, izinkan popup untuk YouTube |
| Posisi jendela tidak kembali | Pindahkan/resize jendela, tutup, lalu buka lagi; posisi disimpan otomatis |
| Jendela lirik tertutup aplikasi lain | Chromium kadang menurunkan PiP dari "selalu di atas" (mis. setelah aplikasi lain fullscreen). Tekan `Alt+Shift+L` untuk pin ulang; jendela dibuka lagi di posisi yang sama tanpa kehilangan lirik. Kalau pintasan belum aktif, atur di `brave://extensions/shortcuts` |
| Lirik tidak ditemukan | Gunakan 🔍 lalu ketik `Judul Lagu - Nama Artis`; lihat juga [docs/matching.md](docs/matching.md) |
| Lirik yang muncul lagu lain | Ekstensi menolak skor di bawah 0,5; cari manual lewat 🔍 atau laporkan judul video di issue |
| Lirik tidak sinkron | Gunakan `-0.1s` / `+0.1s` atau klik kanan pada baris yang benar |
| Lagu di video kompilasi tidak terdeteksi | Gunakan `＋` pada bar lagu di posisi awal lagu, lalu isi Judul/Artis |
| Video panjang menampilkan "Mode video panjang" | Video tidak punya Chapters/tracklist. Tandai lagu dengan `＋`, atau tekan 🔍 (judul video sudah terisi) lalu **Cari** kalau ternyata satu lagu panjang |
| Chapters YouTube belum terbaca | Tunggu video selesai dimuat, lalu muat ulang halaman. Chapters dibaca `page-bridge.js`; kalau tetap kosong, tandai lagu manual dengan `＋` |
| Lirik kompilasi masih lagu sebelumnya | Pastikan bar lagu menunjukkan lagu yang benar; tekan `✎` untuk memperbaiki judul atau `＋` untuk menandai batas lagu |
| Offset berubah di lagu lain | Offset disimpan per lagu; atur ulang saat lagu tersebut aktif |
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
