# TurboTap Live — Frontend (GitHub Pages)

Game balap interaktif untuk TikTok Live. Frontend statis (HTML/CSS/JS murni) yang memanggil backend REST Google Apps Script.

```
index.html
css/style.css
js/config.js   ← satu-satunya yang diedit: isi GAS_URL
js/app.js
```

1. Isi `GAS_URL` di `js/config.js` dengan URL `/exec` dari deployment Apps Script.
2. Deploy folder ini ke GitHub Pages (lihat PANDUAN-INSTALASI.md).

Berkas ini publik: **jangan** menaruh PIN, token, atau API key di sini. Semua rahasia ada di Script Properties backend.
