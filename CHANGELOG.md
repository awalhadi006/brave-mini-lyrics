# Changelog

Semua perubahan penting pada proyek ini didokumentasikan di file ini.
Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/),
dan versi mengikuti [Semantic Versioning](https://semver.org/lang/id/).

## [1.3.1] - 2026-11-10

### Diperbaiki
- Judul video tidak lagi rusak saat nama channel sangat pendek. Sebelumnya nama
  artis dihapus dari judul dengan pencarian global tanpa batas kata, sehingga
  channel bernama **D** mengubah judul **Dear God** menjadi **ear Go** dan
  pencarian lirik memakai kata kunci yang salah.
- Nama artis sekarang hanya dihapus sebagai kata utuh, dan nama artis yang
  kurang dari 3 karakter diabaikan agar tidak memotong huruf di dalam judul.

## [1.3.0] - 2026-11-10

### Ditambahkan
- **Tema terang/gelap** (🌙/☀) yang tersimpan dan langsung berlaku di jendela
  lirik.
- **Slider opasitas latar** untuk mengatur transparansi panel menu (30–100%).
- **Ingat posisi & ukuran jendela PiP** — jendela dibuka lagi di tempat dan
  ukuran terakhir, termasuk setelah browser ditutup.
- **Ekspor / impor cache lirik** (JSON) untuk membackup lirik manual, offset,
  dan pengaturan antar perangkat.
- **Fast-path kana** (`lib/kana.js`): baris Jepang tanpa kanji diubah ke romaji
  tanpa memuat kamus Kuromoji 17 MB; kamus hanya dipakai saat ada kanji.
- **Fallback popup window** saat browser tidak mendukung Document PiP.
- **GitHub Actions** untuk unit test, syntax check, validasi manifest, dan
  packaging zip otomatis. Zip juga diunggah ke GitHub Release untuk tag `v*`.

### Diubah
- Pengaturan sekarang mencakup `theme`, `opacity`, dan `pipBounds`, dengan
  normalisasi nilai saat dimuat.
- Style PiP memakai variabel CSS agar tema terang/gelap konsisten di header,
  tombol, input, hasil pencarian, editor, dan toast.

## [1.2.1] - 2026-11-10

### Diperbaiki
- Lirik sekarang ikut berganti saat kamu pindah lagu di YouTube (termasuk
  tombol **next** dan autoplay). Sebelumnya lirik lagu lama tetap tampil karena
  deteksi pergantian lagu membaca atribut `ytd-watch-flexy[video-id]` yang
  masih berisi ID lama selama ±1 detik, sehingga perubahan dianggap tidak ada.
- Deteksi video baru kini memakai URL, menunggu metadata video benar-benar siap
  (maksimal ±4 detik), dan mengulang pengecekan lewat event
  `yt-navigate-finish`, `yt-page-data-updated`, `yt-player-updated`, `popstate`,
  serta pengaman interval.
- Lirik lagu lama tidak lagi tersimpan untuk video baru kalau video berganti
  saat pencarian masih berjalan.

## [1.2.0] - 2026-11-10

### Ditambahkan
- **Edit lirik manual** (✎): perbaiki typo, hapus bagian, atau tempel LRC sendiri.
  Lirik manual disimpan per video dan dipakai lagi saat video dibuka.
- **Buat lirik dari nol**: tombol ✎ juga tersedia saat lirik tidak ditemukan.
- **Tap Sinkron**: putar lagu lalu tekan TAP setiap baris untuk mengubah lirik
  statis menjadi LRC tersinkron, lengkap dengan tombol undo.
- **Progress pencarian** menampilkan sumber dan kata kunci yang sedang dicari,
  plus tombol **⏹ Hentikan**.
- **Sumber lirik tambahan**: NetEase Cloud Music dan QQ Music, dipakai otomatis
  saat lrclib tidak yakin dan pada pencarian manual.
- **Romanisasi Korea/China** lewat Google Translate, dengan cache per video.
- **Mode Latin persisten**: setelah diaktifkan, lirik non-Latin berikutnya
  otomatis diromanisasi saat dimuat.

### Diperbaiki
- Hasil pencarian manual menampilkan asal sumber (NetEase / QQ Music).
- Header QQ Music memakai aturan `declarativeNetRequest` karena header
  `Referer` tidak bisa diatur lewat `fetch()`.

## [1.1.1] - 2026-11-10

### Diubah
- Menu lirik kembali muncul saat hover, tetapi hover baru aktif setelah tombol
  panah diklik sekali. Menu tampil sebagai overlay di atas lirik dengan latar
  semi-transparan dan efek blur, sehingga lirik tidak terdorong ke bawah dan
  ukuran jendela tidak perlu di-resize lagi.
- Klik tombol panah sekali lagi mengunci menu tetap terbuka; klik berikutnya
  menutupnya. `Esc` juga menutup menu.

## [1.1.0] - 2026-11-10

### Keamanan
- Semua data dari API lrclib dan metadata YouTube di-escape sebelum dirender.
  Sebelumnya `innerHTML` menerima judul video/response API apa adanya, sehingga
  judul video berbahaya bisa menjalankan script di origin YouTube lewat jendela PiP.

### Diperbaiki
- `parseLrc` kini mendukung banyak timestamp per baris, milidetik 2/3 digit,
  `[mm:ss]` tanpa milidetik, tag `[offset:]`, dan mengurutkan baris berdasarkan waktu.
  Sebelumnya `[00:12.345]` terbaca 3,45 detik (seharusnya 0,345 detik).
- Header tidak lagi menutupi daftar hasil pencarian. Layout PiP diubah menjadi
  flex column sehingga daftar hasil bisa diklik dan di-scroll sampai bawah.
- Listener `play`/`pause` tidak lagi menumpuk setiap ganti video.
- Hasil pencarian lagu lama tidak bisa lagi menimpa lagu baru (request token +
  `AbortController`, timeout 8 detik).
- Auto-scroll berhenti sementara saat pengguna scroll manual.
- Pemilihan lirik otomatis memakai skor judul + artis + kedekatan durasi,
  bukan sekadar hasil sinkron pertama.
- `alert()` diganti toast di dalam jendela PiP.
- Selector video memprioritaskan `#movie_player` agar tidak salah mengambil
  video preview.

### Ditambahkan
- Cache hasil pencarian otomatis per video (lirik tidak dicari ulang setiap hari).
- Tombol perbesar/perkecil font lirik yang tersimpan permanen.
- Shortcut keyboard: `Alt+L` buka/tutup, `Space` play/pause, `←/→` offset,
  `+/-` ukuran font.
- Format pencarian manual menjadi **Judul Lagu - Nama Artis**.
- Tombol refresh untuk memaksa pencarian ulang (melewati cache).
- Icon ekstensi dan `minimum_chrome_version`.

### Diubah
- Penyimpanan pindah dari `localStorage` YouTube ke `chrome.storage.local`,
  dengan migrasi otomatis data lama.
- CSS jendela PiP dipisah ke `pip.css`.

## [1.0.0] - 2026-05-17

### Ditambahkan
- Rilis awal: lirik melayang via Document Picture-in-Picture.
- Pencarian otomatis dan manual ke lrclib.net.
- Sinkronisasi lirik LRC, kalibrasi offset, mode karaoke.
- Romanisasi Jepang offline dengan Kuroshiro + Kuromoji.
- Kontrol play/pause/prev/next dan tombol maximize.
