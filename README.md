# Web Chrome Render

Menjalankan desktop Chrome interaktif yang dapat dibuka dari browser melalui noVNC pada Render Web Service.

> **Penting:** konfigurasi ini ditujukan untuk Render Free. Render Free tidak menyediakan Persistent Disk dan filesystem container bersifat sementara. Chrome akan dibuat ulang otomatis saat service wake, restart, atau instance diganti, tetapi sesi Google, cookies, history, tab, dan profil **tidak dipulihkan**. Untuk menyimpan sesi, gunakan Persistent Disk pada service berbayar atau mekanisme storage eksternal yang dirancang dan diamankan secara khusus.

## Cara kerja

```text
Perangkat Anda
     | HTTPS + noVNC/WebSocket
     v
Render Web Service (satu public port)
     | Basic Auth
     v
noVNC -> websockify -> x11vnc -> Xvfb/Fluxbox -> Google Chrome
```

Service hanya membuka port HTTP Render. VNC dan Chrome DevTools tidak diekspos langsung ke internet.

## Deploy ke Render

1. Pastikan repository GitHub berisi proyek ini.
2. Di Render, pilih **New > Blueprint** atau **New > Web Service** dan hubungkan repository `Kavleri/web-chrome-render`.
3. Jika memakai Blueprint, Render akan membaca `render.yaml` dan memilih paket **Free**.
4. Isi environment variables berikut di Render Dashboard. Jangan commit nilainya.

| Variable | Wajib | Keterangan |
|---|---:|---|
| `BROWSER_AUTH_USER` | Ya | Username Basic Auth untuk membuka desktop. |
| `BROWSER_AUTH_PASSWORD` | Ya | Password panjang dan acak untuk endpoint publik. |
| `VNC_PASSWORD` | Tidak | Password VNC internal. Port VNC hanya bind ke localhost; tetap gunakan nilai privat. |

Render menetapkan `PORT` otomatis. Aplikasi mendengarkan pada `0.0.0.0` dan memakai nilai tersebut.

5. Tunggu build dan deploy selesai. Buka URL `https://<nama-service>.onrender.com`.
6. Masukkan `BROWSER_AUTH_USER` dan `BROWSER_AUTH_PASSWORD` pada dialog login.
7. noVNC akan tersambung otomatis dalam mode kontrol penuh dan memakai local scaling agar desktop menyesuaikan ukuran layar.
8. Login Google dilakukan manual di dalam Chrome. Google dapat meminta verifikasi tambahan atau menolak login dari IP/data center Render.

## Kontrol penuh di komputer dan HP

Input VNC dikonfigurasi dengan `KMBC`: keyboard, gerakan mouse, klik/tombol mouse, dan clipboard VNC diizinkan. `View Only` tidak diaktifkan.

- **Komputer:** klik canvas noVNC untuk memfokuskan keyboard; gunakan klik kiri/kanan, roda mouse, drag, dan shortcut seperti `Ctrl+C`, `Ctrl+V`, `Alt+Tab`, serta `Ctrl+Alt+Del` dari tombol Extra Keys.
- **HP:** ketuk canvas untuk fokus, geser untuk menggerakkan pointer, tap untuk klik, tekan lama untuk klik kanan, dan gunakan pinch/scroll sesuai dukungan browser. Buka handle di sisi layar untuk menampilkan toolbar.
- **Keyboard HP:** buka tombol keyboard pada toolbar noVNC untuk menampilkan keyboard virtual jika keyboard sistem tidak otomatis muncul.
- **Fullscreen:** tekan tombol fullscreen pada toolbar setelah koneksi; browser mensyaratkan tindakan klik/tap pengguna.
- **Scaling:** default `resize=scale` mengecilkan desktop 1280x800 agar terlihat pada layar HP. Ini adalah scaling lokal; ukuran display virtual tetap dan tidak meminta x11vnc melakukan remote resize.
- **Toolbar:** panel Settings menyediakan Clipboard, Extra Keys, fullscreen, quality/compression, dan reconnect. Jangan mencentang `View Only` jika ingin mengetik atau mengklik.

### Copy-paste

Clipboard dua arah VNC diaktifkan melalui x11vnc `-input KMBC`. Pada Chrome/Edge desktop, izinkan clipboard ketika diminta dan klik canvas terlebih dahulu. Pada HP atau browser yang menolak akses clipboard otomatis:

1. Buka toolbar noVNC.
2. Buka panel **Clipboard**.
3. Tempel teks dari perangkat ke panel tersebut, lalu kirim ke Chrome remote.
4. Untuk menyalin teks keluar, salin dari Chrome remote ke panel Clipboard lalu gunakan tombol salin pada panel atau tekan lama teksnya.

Clipboard native browser tetap tunduk pada HTTPS, izin browser, gesture pengguna, dan kebijakan OS. Teks ASCII paling konsisten melalui jalur x11vnc legacy; gunakan panel Clipboard untuk teks Unicode atau jika copy-paste otomatis tidak bekerja.

> **Catatan resize:** pilih **Local Scaling**, bukan **Remote Resizing**. x11vnc mempertahankan display 1280x800 dan tidak menjamin dukungan SetDesktopSize dari noVNC.

## Pemulihan setelah sleep atau crash

- Entrypoint menyalakan Xvfb, Fluxbox, x11vnc, noVNC, dan Chrome setiap kali container mulai.
- Monitor internal memeriksa proses Chrome setiap lima detik. Jika Chrome crash, profil sementara dihapus dan Chrome dijalankan kembali pada halaman kosong.
- Render Free dapat sleep setelah periode tanpa traffic. Request HTTP atau WebSocket baru akan membangunkan service; startup dapat memerlukan waktu sekitar satu menit. Refresh setelah service aktif.
- Saat container dibuat ulang, data pada `/tmp/chrome-profile` ikut hilang. Ini disengaja agar tidak ada cookies/token login yang tertinggal pada filesystem ephemeral.

## Batasan Render Free

- Tidak ada Persistent Disk pada paket Free.
- Service dapat sleep dan memiliki batas jam instance bulanan sesuai kebijakan Render.
- Startup browser GUI membutuhkan RAM dan CPU; banyak tab atau situs berat dapat menyebabkan Chrome lambat atau dihentikan.
- Hanya satu public HTTP port yang digunakan. WebSocket noVNC berjalan melalui port yang sama.
- Jangan menjalankan aktivitas yang melanggar ketentuan Google, Render, atau hukum setempat.

## Keamanan

- Gunakan password Basic Auth minimal 20 karakter, unik, dan simpan hanya pada Render Environment Variables.
- Jangan masukkan password, cookies, token, atau file profil Chrome ke repository.
- Endpoint ini internet-facing. Basic Auth bukan pengganti VPN atau allowlist jaringan.
- Render menangani TLS pada URL publik; koneksi noVNC menggunakan HTTPS/WSS melalui proxy.
- Jangan menambahkan port `9222`, VNC, atau DevTools ke konfigurasi publik.
- Logout dari Google sebelum membagikan akses dan jangan memakai akun dengan akses sensitif pada endpoint yang dibagikan.

## Menjalankan secara lokal (opsional)

Memerlukan Docker Desktop.

```bash
docker build -t web-chrome-render .
docker run --rm -p 10000:10000 \
  -e BROWSER_AUTH_USER=admin \
  -e BROWSER_AUTH_PASSWORD='change-this-long-password' \
  -e VNC_PASSWORD='change-this-vnc-password' \
  web-chrome-render
```

Lalu buka <http://localhost:10000>.

## Health check

`GET /health` mengembalikan JSON status tanpa Basic Auth agar Render dapat memeriksa service:

```json
{"ok":true,"service":"web-chrome-render"}
```

## Troubleshooting

- **502 atau layar belum tampil:** container mungkin baru wake. Tunggu 30–90 detik lalu refresh.
- **401:** periksa `BROWSER_AUTH_USER` dan `BROWSER_AUTH_PASSWORD` di Render.
- **Layar hitam:** tunggu beberapa detik; jika tetap hitam, lakukan redeploy dan periksa log `xvfb`, `x11vnc`, serta `chrome`.
- **Chrome tertutup:** kurangi jumlah tab atau gunakan instance yang lebih besar. Monitor akan membuat Chrome baru.
- **Login hilang:** ini perilaku yang diharapkan pada Render Free karena tidak ada disk persisten.
