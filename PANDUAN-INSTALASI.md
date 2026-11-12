# PANDUAN INSTALASI — TurboTap Live (GitHub Pages + Apps Script REST)

Arsitektur: **frontend statis** (GitHub Pages) → `fetch()` → **Apps Script Web App** (JSON) → Google Sheets/Drive.
Fisika balapan berjalan di browser; server hanya menerima paket batch ringkas tiap ±3 dtk, jadi UI tetap instan.

---
## BAGIAN A — BACKEND (Google Apps Script)

1. Buka <https://script.google.com> → **Proyek baru** → nama `TurboTap Live API`.
2. Ganti isi `Code.gs` dengan isi **Kode.gs** (ubah nama berkas jadi `Kode`). Tambah berkas Script baru `Migrasi` → isi **Migrasi.gs**.
3. Pilih fungsi **`setupAppEnvironment`** → ▶ Jalankan → izinkan akses Drive & Sheets. **Cukup sekali** (aman bila terulang, tidak menimpa rahasia).
4. Buka **Execution log**: catat **PIN admin 6 digit** (hanya tampil sekali). Dibuat otomatis: folder `Folder_TurboTapLive`, spreadsheet `DB_TurboTapLive`, data contoh `CONTOH-001`, dan `SESSION_SECRET` acak di **Script Properties** (Project Settings → Script Properties; jangan dibagikan).
5. Jalankan **`pasangPemanas`** sekali (pemanas cache tiap 5 menit → respons pertama tidak "dingin") dan **`pasangPembersihHarian`**.
6. **Terapkan → Deployment baru → Aplikasi web** — *Jalankan sebagai:* **Saya**, *Yang memiliki akses:* **Siapa saja**. Salin URL `/exec`.
7. Uji: buka `URL_EXEC?action=ping` di browser → harus muncul JSON `{"success":true,...}`.
8. Setiap kode backend diubah: **Kelola deployment → Edit → Versi baru** (URL tetap sama).

Lupa PIN? Isi Script Property `PIN_BARU` (4–12 digit) → jalankan `aturPinDariProperti`. Putus semua sesi admin: jalankan `rotasiSecretSesi`.

---
## BAGIAN B — FRONTEND (GitHub Pages)

Folder kerja = **hasil ekstrak ZIP `turbotap-live-frontend`** (di dalamnya langsung terlihat `index.html`, `css`, `js`). **Di folder inilah `git init` dijalankan** — jangan naik satu level, jangan masuk lebih dalam.

1. Ekstrak ZIP. Buka `js/config.js`, ganti `ISI_DENGAN_URL_EXEC_ANDA` dengan URL `/exec` (Bagian A langkah 6). Simpan.
2. Install Git (<https://git-scm.com/download/win>, Mac/Linux: `git --version`). Buat akun GitHub, lalu repository **Public** baru (jangan centang README/.gitignore).
3. Buka PowerShell **di folder hasil ekstrak** (File Explorer → klik address bar → ketik `powershell` → Enter). Cek `dir`: **`index.html` harus terlihat**.
4. Satu per satu:
```
git config --global user.name "Nama Anda"
git config --global user.email "email@akun-github.com"
git init
git add .
git commit -m "Upload pertama"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```
5. Saat diminta password, tempel **Personal Access Token** (github.com/settings/tokens → *Generate new token (classic)* → centang **repo**). Layar tampak kosong saat paste — itu normal.
6. Repo → **Settings → Pages** → *Deploy from a branch* → `main` / `(root)` → Save → centang **Enforce HTTPS**. Tunggu 1–2 menit: situs live di `https://USERNAME.github.io/NAMA-REPO/`.
7. Update berikutnya: `git add .` → `git commit -m "update"` → `git push`, lalu **Ctrl+Shift+R**.

Cek cepat: repo di GitHub harus menampilkan `index.html`, `css/`, `js/` di root (bukan folder induk).

---
## BAGIAN C — PEMAKAIAN
- **Siaran (OBS / TikTok LIVE Studio):** Window/Browser Capture ke URL situs → menu **Arena** → **Mode Siaran** (keluar: Esc).
- **Admin:** Kontrol Balapan, Boost, Game dikunci PIN. Arena & Riwayat publik.
- **Uji tanpa live:** Kontrol Balapan → **Simulator Penonton**.
- **TikTok Live (opsional):** `konektor/konektor.js` di PC host (`npm i ws tiktok-live-connector` → `node konektor.js HOST`) lalu **Sambung** di Kontrol Balapan.
  ⚠️ Pustaka itu tidak resmi dan dapat melanggar Ketentuan Layanan TikTok (PRD §8.4) — pemilik produk wajib memastikan kebolehannya.
- **Migrasi dari spreadsheet lama:** Pengaturan Game → Migrasi Data → **Pindai** (dry-run) → **Impor** (aman diulang).

## Keamanan & kuota (ringkas)
- Frontend hanya memuat `GAS_URL`; PIN di-hash iteratif + salt, token sesi HMAC 12 jam, dikirim lewat body POST (bukan URL), 5× salah → kunci 5 menit.
- Ubah PIN otomatis mematikan semua sesi lama.
- Server: cache berlapis (bootstrap 10 mnt + pemanas), batch idempoten, LockService pada tulis; interval sinkron bisa dinaikkan di Pengaturan Game bila mendekati kuota harian Apps Script.
