# Changelog

Semua perubahan penting pada proyek ini didokumentasikan di file ini.
Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/),
dan versi mengikuti [Semantic Versioning](https://semver.org/lang/id/).

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
