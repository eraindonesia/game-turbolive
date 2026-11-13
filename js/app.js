/**
 * ============================================================
 * TurboTap Live — JavaScript.html (seluruh logika sisi klien)
 *  1. Engine balap (tanpa DOM, bisa diuji terpisah)
 *  2. Utilitas, API, Outbox (antrean sinkron batch + localStorage)
 *  3. UI: Arena, Podium, Kontrol, Boost, Game, Riwayat
 *  4. Konektor TikTok Live (WebSocket lokal) & Simulator
 * Frontend statis (GitHub Pages) → memanggil backend REST Apps Script
 * lewat fetch(). Navigasi 100% di sisi klien (SPA): tanpa reload/redirect.
 * Satu-satunya konfigurasi: js/config.js (GAS_URL). Tanpa rahasia di sini.
 * ============================================================
 */

//#ENGINE_START
const SKALA = 6;                       // 1 m/s = 6 km/h (skala tampilan)
const WARNA = ['#2D7DFF', '#FF4D2E', '#FFD23F', '#2EE59D', '#B57CFF', '#FF7AD9', '#4DE1FF', '#FF9F43'];
const DEFAULT_CONFIG = {
  tap_tiket_masuk: 100, panjang_lintasan: 1000, kecepatan_per_tap: 0.8, peluruhan: 'sedang',
  maks_kecepatan_alami: 120, batas_kecepatan_maks: 380, jumlah_jalur: 6, tema_lintasan: 'cyber',
  mode_bergabung_terlambat: 'antrean', hitung_mundur_detik: 5, durasi_podium_detik: 20,
  gift_langsung_masuk: 'ya', interval_sync_detik: 3, auto_bersihkan_log: 'ya', terapkan_langsung: 'tidak',
  username_host: '', maks_peserta_arena: 300, logo_url: ''
};
const DEFAULT_BOOSTS = [
  { id: 'b1', jenis_gift: 'Rose|Mawar', nilai_koin: 1, tambahan_kecepatan: 15, durasi_detik: 3, efek: 'spark', aktif: 'ya' },
  { id: 'b2', jenis_gift: 'Donut|Donat', nilai_koin: 10, tambahan_kecepatan: 35, durasi_detik: 5, efek: 'flame', aktif: 'ya' },
  { id: 'b3', jenis_gift: 'Cowboy Hat|Topi Koboi', nilai_koin: 99, tambahan_kecepatan: 80, durasi_detik: 8, efek: 'plasma', aktif: 'ya' },
  { id: 'b4', jenis_gift: 'Train|Kereta Ekspres', nilai_koin: 899, tambahan_kecepatan: 145, durasi_detik: 12, efek: 'rainbow', aktif: 'ya' },
  { id: 'b5', jenis_gift: 'Whale diving|Paus Selam', nilai_koin: 2150, tambahan_kecepatan: 120, durasi_detik: 10, efek: 'vortex', aktif: 'ya' },
  { id: 'b6', jenis_gift: 'Lion|Singa', nilai_koin: 29999, tambahan_kecepatan: 200, durasi_detik: 15, efek: 'solar', aktif: 'ya' }
];
const DECAY_PCT = { lambat: 0.05, sedang: 0.15, agresif: 0.30 };

function decayK(mode) {
  if (mode === 'instan') return 4.6;                       // berhenti ±1 detik
  const p = DECAY_PCT[mode] || 0.15;
  return -Math.log(1 - p) / 2;                             // "turun p% per 2 detik"
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function normCfg(raw) {
  const c = Object.assign({}, DEFAULT_CONFIG, raw || {});
  return {
    L: +c.panjang_lintasan, m: +c.kecepatan_per_tap, k: decayK(c.peluruhan),
    capNat: c.maks_kecepatan_alami / SKALA, capTot: c.batas_kecepatan_maks / SKALA, capNatKmh: +c.maks_kecepatan_alami,
    tiket: +c.tap_tiket_masuk, lanes: +c.jumlah_jalur, late: c.mode_bergabung_terlambat, cd: +c.hitung_mundur_detik,
    pod: +c.durasi_podium_detik, giftEntry: c.gift_langsung_masuk === 'ya', maxCars: +c.maks_peserta_arena, tema: c.tema_lintasan
  };
}

function createEngine(opt) {
  opt = opt || {};
  const now = opt.now || function () { return Date.now(); };
  const emit = opt.emit || function () {};
  const uuid = opt.uuid || function () { return 'S' + now().toString(36) + Math.random().toString(36).slice(2, 8); };
  const E = {
    cfg: normCfg(), pcfg: null, boosts: DEFAULT_BOOSTS.slice(), pboosts: null,
    state: 'idle', t: 0, cdLeft: 0, grace: 0, viewers: new Map(), cars: [], results: null, highlights: null,
    sesiNo: 1, idSesi: null, wallStart: 0, carSeq: 0, giftCount: 0, giftCoins: 0, frenzyUntil: 0,
    minutes: [], bTs: new Array(60).fill(-1e9), bV: new Array(60).fill(0), peak: 0, lastJoin: null, demo: false
  };

  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function viewer(u, n) {
    u = norm(u).replace(/^@+/, '');
    if (!u) return null;
    let v = E.viewers.get(u);
    if (!v) {
      v = { u: u, n: n || u, ticket: 0, booked: false, bookedAt: 0, car: null, like: 0, gift: 0, nitro: 0, taps: 0, color: hashStr(u) % WARNA.length, seen: now() };
      E.viewers.set(u, v);
    } else if (n) v.n = n;
    v.seen = now();
    return v;
  }
  function isRacing() { return E.state === 'running' || E.state === 'finishing' || E.state === 'paused'; }
  function noteTap(c) {
    const s = Math.floor(now() / 1000), i = s % 60;
    if (E.bTs[i] !== s) { E.bTs[i] = s; E.bV[i] = 0; }
    E.bV[i] += c;
  }
  function pace() {
    const s = Math.floor(now() / 1000); let sum = 0;
    for (let i = 0; i < 60; i++) { const d = s - E.bTs[i]; if (d >= 0 && d < 60) sum += E.bV[i]; }
    if (sum > E.peak) E.peak = sum;
    return sum;
  }
  function addMinute(c) {
    if (E.state === 'idle' || E.state === 'finished') return;
    const idx = Math.max(0, Math.floor((now() - E.wallStart) / 60000));
    if (idx > 239) return;
    while (E.minutes.length <= idx) E.minutes.push(0);
    E.minutes[idx] += c;
  }
  function spawnCar(v) {
    if (v.car) return v.car;
    if (E.cars.length >= E.cfg.maxCars) return null;
    const car = { v: v, no: ++E.carSeq, d: 0, vel: 0, rate: 0, burst: 0, nitros: [], held: [], finishAt: null, done: false, nitroN: 0, joinT: E.t };
    v.car = car; E.cars.push(car);
    emit('spawn', car);
    return car;
  }
  function fillGrid() {
    const q = [];
    E.viewers.forEach(function (v) { if (v.booked && !v.car) q.push(v); });
    q.sort(function (a, b) { return a.bookedAt - b.bookedAt; });
    for (let i = 0; i < q.length && E.cars.length < E.cfg.maxCars; i++) spawnCar(q[i]);
  }
  function matchBoost(name, coins) {
    const n = norm(name); let range = null;
    for (let i = 0; i < E.boosts.length; i++) {
      const b = E.boosts[i];
      if (b.aktif === 'tidak') continue;
      const txt = norm(b.jenis_gift);
      const mr = /^(\d+)\s*-\s*(\d+)$/.exec(txt), mg = /^[>≥]=?\s*(\d+)$/.exec(txt);
      if (mr) { if (!range && coins >= +mr[1] && coins <= +mr[2]) range = b; continue; }
      if (mg) { if (!range && coins >= +mg[1]) range = b; continue; }
      const alias = txt.split(/[|,]/).map(function (x) { return x.trim(); });
      if (n && alias.indexOf(n) > -1) return b;
    }
    return range;
  }
  function addNitro(car, kmh, dur) { car.nitros.push({ kmh: kmh, end: E.t + dur }); }

  function like(u, nm, c) {
    c = Math.max(0, Math.floor(c) || 0);
    if (!c) return;
    const v = viewer(u, nm);
    if (!v) return;
    v.like += c; noteTap(c); addMinute(c);
    emit('like', { v: v, c: c });
    if (v.car) {
      if (E.state === 'running' || E.state === 'finishing') { if (!v.car.done) v.car.burst += c; v.taps += c; }
      return;
    }
    v.ticket += c;
    if (!v.booked && v.ticket >= E.cfg.tiket) {
      v.booked = true; v.bookedAt = now(); E.lastJoin = v;
      if (E.state === 'idle' || E.state === 'countdown') spawnCar(v);
      else if (isRacing() && E.cfg.late === 'langsung') spawnCar(v);
      emit('join', v);
    }
  }
  function gift(u, nm, name, coins, rep) {
    const v = viewer(u, nm);
    if (!v) return null;
    rep = Math.max(1, Math.floor(rep) || 1); coins = Math.max(0, Math.floor(coins) || 0);
    const total = coins * rep;
    v.gift += total; E.giftCoins += total;
    const rule = matchBoost(name, coins);
    let car = v.car;
    if (!car && E.cfg.giftEntry && E.state !== 'finished') {
      v.booked = true; v.bookedAt = v.bookedAt || now(); E.lastJoin = v;
      car = spawnCar(v);
    }
    const info = { v: v, name: name, coins: coins, rep: rep, rule: rule, car: car, kmh: 0, dur: 0, mult: 1 };
    if (rule) {
      const fr = E.frenzyUntil > E.t && isRacing() ? 2 : 1, mult = Math.min(rep, 10);
      info.kmh = Math.round(rule.tambahan_kecepatan * mult * fr); info.dur = rule.durasi_detik; info.mult = mult * fr;
      if (car && !car.done) {
        if (E.state === 'running' || E.state === 'finishing') addNitro(car, info.kmh, info.dur);
        else car.held.push({ kmh: info.kmh, dur: info.dur });
        car.nitroN++; v.nitro++;
      }
      E.giftCount++;
    }
    emit('gift', info);
    return info;
  }

  function ranking() {
    const a = E.cars.slice();
    a.sort(function (x, y) {
      if (x.done && y.done) return x.finishAt - y.finishAt;
      if (x.done) return -1; if (y.done) return 1;
      if (y.d !== x.d) return y.d - x.d;
      return (x.joinT - y.joinT) || (x.no - y.no);
    });
    return a;
  }
  function buildPayload(rank) {
    const pemain = []; let totalLike = 0;
    E.viewers.forEach(function (v) { if (v.like || v.gift) { pemain.push({ u: v.u, n: v.n, l: v.like, g: v.gift }); totalLike += v.like; } });
    const w = rank[0] && rank[0].done ? rank[0].v.u : '';
    return {
      idSesi: E.idSesi, waktuMulai: E.wallStart, waktuSelesai: now(), pemenang: w, jumlahPeserta: rank.length,
      totalLike: totalLike, totalGift: E.giftCoins, menit: E.minutes.slice(),
      hasil: E.results.slice(0, 100).map(function (r) { return { r: r.r, u: r.u, j: Math.round(r.j * 10) / 10, nt: r.nt, tp: r.tp, tg: r.tg }; }),
      pemain: pemain.slice(0, 2000)
    };
  }
  function endRace(reason) {
    const rank = ranking();
    E.results = rank.map(function (c, i) {
      return { r: i + 1, u: c.v.u, n: c.v.n, j: Math.min(c.d, E.cfg.L), nt: c.nitroN, tp: c.v.taps, tg: c.v.gift, t: c.finishAt, color: c.v.color, no: c.no, done: c.done, vel: c.vel };
    });
    let vip = null, tapper = null;
    E.viewers.forEach(function (v) {
      if (v.gift > 0 && (!vip || v.gift > vip.gift)) vip = v;
      if (v.taps > 0 && (!tapper || v.taps > tapper.taps)) tapper = v;
    });
    E.highlights = { vip: vip ? { u: vip.u, n: vip.n, gift: vip.gift, nitro: vip.nitro } : null, tapper: tapper ? { u: tapper.u, n: tapper.n, taps: tapper.taps } : null };
    const payload = buildPayload(rank);
    const stats = { taps: payload.totalLike, gifts: E.giftCoins, time: E.t };
    E.state = 'finished'; E.cars = [];
    E.viewers.forEach(function (v) {
      if (v.car) { v.car = null; v.booked = false; v.ticket = 0; }
      v.like = 0; v.gift = 0; v.nitro = 0; v.taps = 0;
    });
    E.giftCoins = 0; E.giftCount = 0;
    emit('end', { results: E.results, payload: payload, highlights: E.highlights, reason: reason, stats: stats, demo: E.demo });
    emit('state', E.state);
  }
  function step(dt) {
    E.t += dt;
    const c = E.cfg;
    for (let i = 0; i < E.cars.length; i++) {
      const car = E.cars[i];
      if (car.done) continue;
      const inst = car.burst / dt; car.burst = 0;
      car.rate += (inst - car.rate) * (1 - Math.exp(-dt / 0.7));
      let nsum = 0;
      if (car.nitros.length) {
        car.nitros = car.nitros.filter(function (x) { return x.end > E.t; });
        for (let j = 0; j < car.nitros.length; j++) nsum += car.nitros[j].kmh;
      }
      const nms = nsum / SKALA;
      const target = Math.min(Math.min(car.rate * c.m, c.capNat) + nms, c.capTot);
      if (car.vel < target) car.vel += (target - car.vel) * (1 - Math.exp(-dt / 0.5));
      else if (car.vel > target) {
        const kk = car.vel > c.capNat + 0.001 ? Math.max(c.k * 5, 0.5) : c.k;   // kelebihan nitro meluruh lebih cepat
        car.vel = target + (car.vel - target) * Math.exp(-kk * dt);
      }
      const prev = car.d; car.d += car.vel * dt;
      if (car.d >= c.L) {
        car.finishAt = E.t - dt + (c.L - prev) / Math.max(car.d - prev, 1e-9) * dt;
        car.d = c.L; car.done = true; car.vel = 0;
        emit('finish', car);
        if (E.state === 'running') { E.state = 'finishing'; E.grace = 2.2; emit('state', E.state); }
      }
    }
    if (E.state === 'finishing') {
      E.grace -= dt;
      if (E.grace <= 0 || E.cars.every(function (x) { return x.done; })) endRace('finish');
    }
  }
  function beginRace() {
    E.state = 'running'; E.t = 0;
    E.cars.forEach(function (car) { car.held.forEach(function (h) { addNitro(car, h.kmh, h.dur); }); car.held = []; });
    emit('state', E.state);
  }
  function applyPending() {
    if (E.pcfg) { E.cfg = E.pcfg; E.pcfg = null; }
    if (E.pboosts) { E.boosts = E.pboosts; E.pboosts = null; }
  }

  const api = {
    E: E,
    get state() { return E.state; },
    get cfg() { return E.cfg; },
    like: like, gift: gift, ranking: ranking, pace: pace, matchBoost: matchBoost,
    tick: function (dt) {
      if (E.state === 'countdown') { E.cdLeft -= dt; if (E.cdLeft <= 0) beginRace(); return; }
      if (E.state === 'running' || E.state === 'finishing') step(dt);
    },
    setConfig: function (raw, immediate) {
      E.pcfg = normCfg(raw);
      if (immediate || E.state === 'idle') { E.cfg = E.pcfg; E.pcfg = null; emit('cfg', E.cfg); }
    },
    setBoosts: function (list, immediate) {
      E.pboosts = list.slice();
      if (immediate || E.state === 'idle') { E.boosts = E.pboosts; E.pboosts = null; }
    },
    startCountdown: function (demo) {
      if (E.state !== 'idle') return { ok: false, why: 'state' };
      fillGrid();
      if (!E.cars.length) return { ok: false, why: 'nocars' };
      E.idSesi = uuid(); E.wallStart = now(); E.minutes = []; E.demo = !!demo; E.t = 0;
      E.cdLeft = E.cfg.cd; E.state = 'countdown';
      emit('session', { idSesi: E.idSesi, waktuMulai: E.wallStart, no: E.sesiNo });
      emit('state', E.state);
      return { ok: true };
    },
    pause: function () { if (E.state === 'running') { E.state = 'paused'; emit('state', E.state); return true; } return false; },
    resume: function () { if (E.state === 'paused') { E.state = 'running'; emit('state', E.state); return true; } return false; },
    stop: function () {
      if (E.state === 'running' || E.state === 'paused' || E.state === 'finishing') { endRace('manual'); return true; }
      return false;
    },
    reset: function (hard) {
      const aktif = E.state === 'countdown' || isRacing();
      if (aktif) { emit('cancel', { idSesi: E.idSesi }); E.cars = []; E.viewers.forEach(function (v) { v.car = null; }); }
      if (hard) E.viewers.forEach(function (v) { v.car = null; v.booked = false; v.ticket = 0; });
      if (E.state === 'finished') E.sesiNo++;
      E.cars = []; E.viewers.forEach(function (v) { v.car = null; });
      E.state = 'idle'; E.t = 0; E.idSesi = null; E.results = null; E.carSeq = 0; E.frenzyUntil = 0; E.demo = false;
      applyPending();
      if (E.viewers.size > 5000) {
        const lim = now() - 600000;
        E.viewers.forEach(function (v, k) { if (!v.booked && v.seen < lim) E.viewers.delete(k); });
      }
      fillGrid();
      emit('state', E.state);
    },
    clearTrack: function () { api.reset(true); },
    markDemo: function () { E.demo = true; },
    frenzy: function (sec) { E.frenzyUntil = E.t + sec; },
    boostAll: function (pct, sec) {
      const kmh = Math.round(E.cfg.capNatKmh * pct / 100);
      E.cars.forEach(function (c) { if (!c.done) addNitro(c, kmh, sec); });
      return kmh;
    },
    packTighten: function () {
      const r = ranking(), half = Math.ceil(r.length / 2);
      r.slice(half).forEach(function (c) { if (!c.done) addNitro(c, 45, 6); });
      return r.length - half;
    },
    stats: function () {
      const t = now(); let active = 0, booked = 0, waiting = 0;
      E.viewers.forEach(function (v) {
        if (t - v.seen < 120000) { active++; if (v.booked) booked++; }
        if (v.booked && !v.car) waiting++;
      });
      return { cars: E.cars.length, waiting: waiting, active: active, booked: booked, giftCount: E.giftCount };
    }
  };
  return api;
}
//#ENGINE_END

(function () {
'use strict';

// ════════════════════════════════════════════════════════
// BAGIAN 1: UTILITAS
// ════════════════════════════════════════════════════════
const $ = function (id) { return document.getElementById(id); };
const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
const nf = function (n) { return Math.round(Number(n) || 0).toLocaleString('id-ID'); };
const clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
const uid = function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); };
const ls = {
  get: function (k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* penyimpanan penuh/diblokir */ } }
};
const ss = {
  get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* abaikan */ } }
};
function debounce(fn, ms) { let t; return function () { const a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
function fmtTime(sec) { sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function fmtDate(iso) { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function setText(el, v) { if (el && el.textContent !== String(v)) el.textContent = v; }

function toast(msg, type, ttl) {
  const box = $('toasts'), el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, ttl || 4200);
}

function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
function confirmBox(title, msg, okLabel) {
  return new Promise(function (res) {
    $('confirm-title').textContent = title; $('confirm-msg').textContent = msg;
    $('confirm-ok').textContent = okLabel || 'Ya, lanjutkan';
    openModal('m-confirm');
    const done = function (v) { closeModal('m-confirm'); $('confirm-ok').onclick = null; $('confirm-cancel').onclick = null; res(v); };
    $('confirm-ok').onclick = function () { done(true); };
    $('confirm-cancel').onclick = function () { done(false); };
    $('confirm-cancel').focus();
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 2: STATE, API, AUTH
// ════════════════════════════════════════════════════════
const S = {
  view: 'arena', config: Object.assign({}, DEFAULT_CONFIG), draft: {}, boosts: DEFAULT_BOOSTS.map(function (b) { return Object.assign({}, b); }),
  token: ss.get('tt_tok'), latency: null, lastSync: 0, conn: 'off', connSrc: '—', demo: false,
  rw: ls.get('tt_rw', null), rwTab: 'peringkat', rwSort: 'menang', hasilRows: [], serverInfo: null,
  beSel: null, beDraft: null, boostFilter: 'all', boostQ: '', acc: new Map(), feed: [], boostFeed: [], podiumLeft: 0, auto: !!ls.get('tt_auto', false),
  fps: 0, charts: {}, libs: {}
};
const API_URL = (window.TT_CONFIG && window.TT_CONFIG.GAS_URL) || '';
const HAS_API = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(API_URL);
const AKSI_BACA = /^(get|ping)/;          // aksi baca: boleh berbagi request yang sedang berjalan
const _inflight = {};
let _epochTulis = 0;                      // aksi tulis menaikkan epoch → tidak ada data basi yang dibagikan

/** POST text/plain (tanpa preflight CORS). Selalu resolve {success, ...}; tidak pernah reject. */
function kirimRaw(body, opt) {
  opt = opt || {};
  const ctl = ('AbortController' in window) ? new AbortController() : null;
  const tm = ctl ? setTimeout(function () { ctl.abort(); }, opt.timeout || 30000) : null;
  const t0 = performance.now();
  return fetch(API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
    redirect: 'follow', credentials: 'omit', keepalive: !!opt.keepalive, signal: ctl ? ctl.signal : undefined
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then(function (txt) {
    let r; try { r = JSON.parse(txt); } catch (e) { throw new Error('Respons server bukan JSON. Pastikan Web App di-deploy: Jalankan sebagai "Saya", akses "Siapa saja".'); }
    S.latency = Math.round(performance.now() - t0);
    return r || { success: false, message: 'Respons kosong.', code: 'NET' };
  }).catch(function (e) {
    const msg = (e && e.name === 'AbortError') ? 'Server terlalu lama merespons.' : ((e && e.message) || String(e));
    return { success: false, message: msg, code: 'NET' };
  }).then(function (r) { if (tm) clearTimeout(tm); return r; });
}

function sesiHabis(r) {
  if (r && r.code === 'AUTH') { setToken(null); toast(r.message || 'Sesi admin berakhir.', 'warning'); }
  return r;
}

/** Panggil aksi server. api('kirimBatch', token, paket) → {success, data, message, code}. */
function api(fn) {
  const args = Array.prototype.slice.call(arguments, 1).map(function (a) { return a === undefined ? null : JSON.parse(JSON.stringify(a)); });
  if (!HAS_API) return Promise.resolve({ success: false, message: 'Server belum dikonfigurasi (isi GAS_URL di js/config.js). Mode offline.', code: 'OFFLINE' });
  const baca = AKSI_BACA.test(fn);
  const key = baca ? _epochTulis + '|' + fn + '|' + JSON.stringify(args) : null;
  if (key && _inflight[key]) return _inflight[key];
  if (!baca) _epochTulis++;
  const p = kirimRaw({ action: fn, args: args }).then(sesiHabis);
  if (key) { _inflight[key] = p; const bersih = function () { delete _inflight[key]; }; p.then(bersih, bersih); }
  return p;
}

/** Beberapa aksi dalam SATU round-trip (maks. 8). Mengembalikan array hasil sejajar. */
function apiBatch(calls) {
  const gagal = function (r) { return calls.map(function () { return r; }); };
  if (!HAS_API) return Promise.resolve(gagal({ success: false, message: 'Server belum dikonfigurasi (isi GAS_URL di js/config.js). Mode offline.', code: 'OFFLINE' }));
  return kirimRaw({ action: 'batch', calls: calls }).then(function (r) {
    if (r && r.success && Array.isArray(r.data)) return r.data.map(sesiHabis);
    return gagal(r || { success: false, message: 'Respons kosong.', code: 'NET' });
  });
}

function setToken(t) { S.token = t; ss.set('tt_tok', t); updateAuthUI(); }
function updateAuthUI() {
  const ok = !!S.token;
  $('auth-ico').textContent = ok ? 'lock_open' : 'lock';
  $('auth-txt').textContent = ok ? 'Admin · Keluar' : 'Masuk Admin';
  $$('.nav-item .lock').forEach(function (el) { el.style.visibility = ok ? 'hidden' : 'visible'; });
}

let loginResolve = null;
function ensureAdmin() {
  if (S.token) return Promise.resolve(true);
  return new Promise(function (res) {
    loginResolve = res; $('login-pin').value = ''; $('login-err').textContent = '';
    openModal('m-login'); setTimeout(function () { $('login-pin').focus(); }, 30);
  });
}
function finishLogin(ok) { closeModal('m-login'); if (loginResolve) { const r = loginResolve; loginResolve = null; r(ok); } }

// ════════════════════════════════════════════════════════
// BAGIAN 3: ENGINE + OUTBOX (sinkron batch berantai, tahan offline)
// ════════════════════════════════════════════════════════
const eng = createEngine({ emit: onEngine, uuid: uid });
const Outbox = { q: ls.get('tt_out', []), busy: false, backoff: 0, nextAt: 0 };
function outPersist() { ls.set('tt_out', Outbox.q); }
function outPush(fn, arg) {
  Outbox.q.push({ id: uid(), fn: fn, arg: arg, fails: 0 });
  while (Outbox.q.length > 150) { const i = Outbox.q.findIndex(function (x) { return x.fn === 'kirimBatch'; }); Outbox.q.splice(i > -1 ? i : 0, 1); }
  outPersist(); outKick();
}
function outKick() {
  if (Outbox.busy || !Outbox.q.length || !S.token || Date.now() < Outbox.nextAt) return;
  Outbox.busy = true;
  const it = Outbox.q[0];
  api(it.fn, S.token, it.arg).then(function (r) {
    Outbox.busy = false;
    if (r.success) { Outbox.q.shift(); Outbox.backoff = 0; S.lastSync = Date.now(); outPersist(); setTimeout(outKick, 0); return; }
    if (r.code === 'AUTH') { outPersist(); return; }                       // tunggu login ulang
    if (r.code === 'NET' || r.code === 'OFFLINE' || r.code === 'BUSY') {   // sementara: coba lagi dengan backoff
      Outbox.backoff = Math.min(30000, (Outbox.backoff || 1500) * 2); Outbox.nextAt = Date.now() + Outbox.backoff;
      setTimeout(outKick, Outbox.backoff); return;
    }
    it.fails++;
    if (it.fails >= 3) { Outbox.q.shift(); toast('Sinkron ' + it.fn + ' gagal: ' + r.message, 'danger'); }
    outPersist(); setTimeout(outKick, 800);
  });
}
function collectBatch() {
  if (!S.acc.size) return;
  const pemain = [];
  S.acc.forEach(function (x) { pemain.push(x); });
  S.acc.clear();
  if (S.demo || eng.E.demo) return;                                         // data demo tidak disimpan
  outPush('kirimBatch', { idPaket: uid(), idSesi: eng.E.idSesi || 'PRA', pemain: pemain });
}
let syncTimer = null;
function armSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(function () { collectBatch(); outKick(); }, clamp(+S.config.interval_sync_detik || 3, 2, 30) * 1000);
}
function accAdd(v, l, g) {
  let x = S.acc.get(v.u);
  if (!x) { x = { u: v.u, n: v.n, l: 0, g: 0 }; S.acc.set(v.u, x); }
  x.l += l; x.g += g;
}

function onEngine(type, d) {
  switch (type) {
    case 'like': accAdd(d.v, d.c, 0); break;
    case 'gift': onGift(d); break;
    case 'join': logEvent('sports_motorsports', '@' + d.u + ' selesai ' + eng.cfg.tiket + ' tap', 'Mobil masuk grid', 'ok'); S.joinedAt = Date.now(); break;
    case 'session':
      logEvent('flag', 'Sesi #' + d.no + ' dimulai', 'Hitung mundur ' + eng.cfg.cd + ' detik', 'ok');
      if (!(S.demo || eng.E.demo)) outPush('mulaiSesi', { idSesi: d.idSesi, waktuMulai: d.waktuMulai });
      break;
    case 'state': onState(d); break;
    case 'finish': logEvent('sports_score', '@' + d.v.u + ' melewati garis finis', fmtTime(eng.E.t), 'ok'); break;
    case 'end': onEnd(d); break;
    case 'cancel':
      if (d.idSesi && !(S.demo || eng.E.demo)) { collectBatch(); outPush('batalkanSesi', d.idSesi); }
      logEvent('cancel', 'Sesi dibatalkan', 'Lintasan dikosongkan', 'warn');
      break;
    case 'cfg': buildLanes(); break;
  }
}
function onGift(info) {
  accAdd(info.v, 0, info.coins * info.rep);
  const nama = info.rule ? info.rule.jenis_gift.split('|')[0] : info.name;
  if (info.rule) {
    logEvent('redeem', '@' + info.v.u + ' kirim ' + (info.rep > 1 ? info.rep + '× ' : '') + nama,
      'Nitro +' + info.kmh + ' km/h selama ' + info.dur + ' dtk' + (info.car ? '' : ' (tanpa mobil)'), 'gift');
    S.boostFeed.unshift({ u: info.v.u, nama: nama, koin: info.coins * info.rep, kmh: info.kmh, dur: info.dur, no: info.car ? info.car.no : null });
    S.boostFeed.length = Math.min(S.boostFeed.length, 6);
    S.tick = '@' + info.v.u + ' kirim ' + (info.rep > 1 ? info.rep + '× ' : '') + nama + (info.car ? ' ke Mobil #' + pad2(info.car.no) : '!');
    showNitroToast(info);
    if (S.view === 'boost') renderBoostFeed();
  } else {
    logEvent('redeem', '@' + info.v.u + ' kirim ' + nama, 'Gift tidak terpetakan di Pengaturan Boost — tanpa nitro', 'warn');
  }
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function onState(st) {
  if (st === 'running') S.paceStart = Date.now();
  if (st === 'idle') { $('arena-race').hidden = false; $('arena-podium').hidden = true; stopConfetti(); buildLanes(); }
  renderSideSession();
  syncButtons();
}
function onEnd(d) {
  collectBatch();
  if (!d.demo && !S.demo) outPush('selesaiSesi', d.payload);
  logEvent('emoji_events', d.results[0] ? '@' + d.results[0].u + ' memenangkan sesi' : 'Sesi selesai', d.reason === 'manual' ? 'Dihentikan manual' : 'Waktu ' + fmtTime(d.stats.time), 'ok');
  renderPodium(d);
  $('arena-race').hidden = true; $('arena-podium').hidden = false;
  S.podiumLeft = eng.cfg.pod; setText($('pd-count'), fmtTime(S.podiumLeft));
  startConfetti();
  if (S.view !== 'arena') toast('Sesi selesai — pemenang: @' + (d.results[0] ? d.results[0].u : '—'), 'success');
}

// ════════════════════════════════════════════════════════
// BAGIAN 4: NAVIGASI SPA (instan, tanpa panggilan server)
// ════════════════════════════════════════════════════════
const LOCKED = { race: true, boost: true, game: true };
function go(view) {
  if (LOCKED[view] && !S.token) {
    ensureAdmin().then(function (ok) { if (ok) go(view); });
    return;
  }
  S.view = view;
  $$('.view').forEach(function (el) { el.classList.toggle('active', el.id === 'v-' + view); });
  $$('[data-view]').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
  if (view === 'race') { renderRace(); refreshServerInfo(); }
  if (view === 'boost') { renderBoostAll(); }
  if (view === 'game') { syncControls(); }
  if (view === 'riwayat') loadRiwayat(false);
  if (view === 'arena') { measureTrack(); }
  window.scrollTo(0, 0);
}

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t); ls.set('tt_theme', t);
  $('theme-ico').textContent = t === 'dark' ? 'light_mode' : 'dark_mode';
  Object.keys(S.charts).forEach(function (k) { if (S.charts[k]) S.charts[k].destroy(); }); S.charts = {};
  if (S.view === 'riwayat' && S.rwTab === 'grafik') renderCharts();
}

// ── Dock kontrol Mode Siaran: tombol meneruskan klik ke kontrol Race Control (handler & konfirmasi sama) ──
const DOCK_MAP = { 'dk-start': 'btn-start', 'dk-pause': 'btn-pause', 'dk-stop': 'btn-stop', 'dk-reset': 'btn-reset', 'dk-clear': 'btn-clear', 'dk-all': 'qb-all', 'dk-pack': 'qb-pack', 'dk-frenzy': 'qb-frenzy', 'dk-auto': 'auto-toggle', 'dk-sim': 'sim-toggle', 'dk-login': 'btn-auth' };
let dockTimer = 0;
function dockShow() {
  const d = $('obs-dock'); if (!d) return;
  d.classList.remove('hide'); clearTimeout(dockTimer);
  dockTimer = setTimeout(function () {
    if (!document.body.classList.contains('obs')) return;
    if (d.matches(':hover') || d.contains(document.activeElement) || document.querySelector('.modal-back.show')) { dockShow(); return; }
    d.classList.add('hide');
  }, 3500);
}
function syncDock() {
  if (!document.body.classList.contains('obs')) return;
  const E = eng.E, label = { idle: 'Siap', countdown: 'Bersiap', running: 'Balapan', paused: 'Dijeda', finishing: 'Finis', finished: 'Selesai' }[E.state] || '—';
  setText($('dock-state'), label); setText($('dock-cars'), eng.stats().cars);
  $('dock-led').className = 'led ' + (E.state === 'running' ? 'ok' : 'warn');
  Object.keys(DOCK_MAP).forEach(function (k) {
    const src = $(DOCK_MAP[k]), b = $(k); if (!src || !b) return;
    if (k === 'dk-auto' || k === 'dk-sim') { b.setAttribute('aria-pressed', src.getAttribute('aria-checked') === 'true' ? 'true' : 'false'); return; }
    if (k === 'dk-login') { b.hidden = !!S.token; return; }
    b.disabled = src.disabled;
  });
  const t = $('dk-start').querySelector('.dk-t'); if (t) t.textContent = E.state === 'paused' ? 'Lanjut' : 'Mulai';
}
function initDock() {
  Object.keys(DOCK_MAP).forEach(function (k) {
    $(k).addEventListener('click', function () { $(DOCK_MAP[k]).click(); setTimeout(syncDock, 60); dockShow(); });
  });
  $('dk-exit').addEventListener('click', function () { setObs(false); });
  ['mousemove', 'pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (document.body.classList.contains('obs')) dockShow(); }, { passive: true });
  });
}

function setObs(on) {
  document.body.classList.toggle('obs', on);
  if (on) { syncDock(); dockShow(); }
  if (on) {
    go('arena'); $('obs-hint').style.display = 'block'; setTimeout(function () { $('obs-hint').style.display = 'none'; }, 4000);
    if (document.documentElement.requestFullscreen) { try { document.documentElement.requestFullscreen().catch(function () {}); } catch (e) { /* abaikan */ } }
  } else if (document.fullscreenElement && document.exitFullscreen) { try { document.exitFullscreen(); } catch (e) { /* abaikan */ } }
  setTimeout(measureTrack, 80);
}

// ════════════════════════════════════════════════════════
// BAGIAN 5: ARENA 3D SEMU — kamera pengejar, jalan melengkung/berbukit, HUD balap
//   Semua digambar di <canvas> (satu elemen DOM) → ringan untuk siaran OBS.
//   Dunia: 1 satuan = 1 m sepanjang lintasan; lebar & tinggi dilebihkan agar terbaca di layar.
// ════════════════════════════════════════════════════════
const SEGL = 3, ROAD_W = 15, CAM_H = 6, CAR_UNITS = 4.3, HK = 2.2, NMAX = 160;
let LANES_V = 6;                         // diikuti dari pengaturan jumlah jalur
const TEMA = {
  cyber:   { sky: ['#0a0630', '#2a1478', '#c43c8c'], sun: '#ffd23f', far: '#34228a', near: '#241a66', g1: '#0d3b4a', g2: '#0b3341', r1: '#2c2c42', r2: '#27273b', rum1: '#ff3d71', rum2: '#f4f4ff', lane: '#8fe3ff', haze: '#3b2390', obj: 'pine',   c1: '#2EE59D', c2: '#0f7f5c' },
  desert:  { sky: ['#f59e5b', '#ffc98a', '#ffeccc'], sun: '#fff7d6', far: '#c9794b', near: '#a95c38', g1: '#e6b06c', g2: '#dca55f', r1: '#4b4541', r2: '#453f3b', rum1: '#d6402d', rum2: '#ffffff', lane: '#fff1c0', haze: '#ffd9a0', obj: 'cactus', c1: '#5b8f3d', c2: '#3f6a2a' },
  rainbow: { sky: ['#3a1a8c', '#d6479f', '#ffd166'], sun: '#fff3b0', far: '#7b4fd6', near: '#5b36b5', g1: '#2f9e8f', g2: '#2a8f82', r1: '#3a2d63', r2: '#352858', rum1: '#ff6b6b', rum2: '#ffe66d', lane: '#ffffff', haze: '#e08ad0', obj: 'candy',  c1: '#ff7ad9', c2: '#4de1ff' },
  circuit: { sky: ['#030812', '#0a2036', '#14405a'], sun: '#9ff3ff', far: '#123252', near: '#0c2540', g1: '#08141f', g2: '#0a1a28', r1: '#1a2230', r2: '#161d2a', rum1: '#2EE59D', rum2: '#0b1220', lane: '#2EE59D', haze: '#14405a', obj: 'pylon',  c1: '#4de1ff', c2: '#2EE59D' }
};
const roadWrap = $('track'), roadCv = $('road'), rctx = roadCv ? roadCv.getContext('2d') : null;
const REDUCE = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
let course_turns = 0, RW = 800, RH = 450, DPR = 1, course = null, camZ = -18, camLat = 0, fovD = 1.15, lastRT = 0, avgDt = 0.016, peakKmh = 0, focusNo = 0;
const Q = { n: 150 };
const PX = new Float32Array(NMAX + 2), PY = new Float32Array(NMAX + 2), PW = new Float32Array(NMAX + 2), SC = new Float32Array(NMAX + 2), PZ = new Float32Array(NMAX + 2);
const fr_ = function (x) { return x - Math.floor(x); };
const hsh_ = function (i) { return fr_(Math.sin(i * 12.9898 + 78.233) * 43758.5453); };
const lp_ = function (a, b, t) { return a + (b - a) * t; };
const sm_ = function (t) { return t * t * (3 - 2 * t); };
function rng_(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Bangun lintasan: kelengkungan, bukit, arah (untuk peta mini). Deterministik per panjang. */
function buildCourse(L) {
  const total = Math.ceil((L + 900) / SEGL) + 4, r = rng_(20261111 + Math.round(L));
  const curve = new Float32Array(total), hill = new Float32Array(total), heading = new Float32Array(total);
  // 5–10 tikungan (≈1 per 125 m) tersebar merata; start & finis tetap lurus. Arah berselang-seling, maks 2 searah berturut-turut.
  const nTurn = clamp(Math.round(L / 125), 5, 10), s0 = 22, s1 = Math.max(s0 + nTurn * 14, Math.floor((L - 130) / SEGL));
  const slot = (s1 - s0) / nTurn;
  let dir = r() < 0.5 ? -1 : 1, same = 0;
  for (let j = 0; j < nTurn; j++) {
    if (j > 0) { if (same >= 2 || r() < 0.65) { dir = -dir; same = 1; } else same++; } else same = 1;
    const a = (0.02 + r() * 0.02) * dir, len = Math.max(10, Math.floor(slot * (0.72 + r() * 0.12))), st = Math.floor(s0 + j * slot + (slot - len) * r() * 0.6);
    const e1 = Math.max(3, Math.round(len * 0.28)), e2 = Math.max(3, Math.round(len * 0.28));
    for (let k = 0; k < len; k++) {
      const idx = st + k; if (idx >= total) break;
      curve[idx] = k < e1 ? a * sm_(k / e1) : k >= len - e2 ? a * sm_((len - 1 - k) / e2) : a;
    }
  }
  course_turns = nTurn;
  let h = 0, x = 0, y = 0, minX = 0, maxX = 0, minY = 0, maxY = 0; const pts = [];
  for (let k = 0; k < total; k++) {
    const z = k * SEGL, tail = clamp((z - (L - 130)) / 90, 0, 1);       // lurus & datar menjelang finis
    curve[k] *= 1 - tail;
    hill[k] = (5 * Math.sin(k * 0.05) + 3.2 * Math.sin(k * 0.021 + 1.7)) * Math.min(1, z / 90) * (1 - clamp((z - (L - 110)) / 80, 0, 1));
    h += curve[k] * HK; heading[k] = h;
    if (z <= L + SEGL) { x += Math.cos(h) * SEGL; y += Math.sin(h) * SEGL; pts.push(x, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  const span = Math.max(maxX - minX, maxY - minY, 1), path = new Path2D();
  const ox = (1 - (maxX - minX) / span) / 2, oy = (1 - (maxY - minY) / span) / 2, npt = [];
  for (let k = 0; k < pts.length; k += 2) {
    const nx = ox + (pts[k] - minX) / span, ny = oy + (pts[k + 1] - minY) / span; npt.push(nx, ny);
    if (k === 0) path.moveTo(nx, ny); else path.lineTo(nx, ny);
  }
  course = { L: L, turns: nTurn, curve: curve, hill: hill, heading: heading, total: total, path: path, pts: npt };
}
function curveAt(i) { return i < 0 ? 0 : course.curve[Math.min(i, course.total - 1)]; }
function hillAt(i) { return i < 0 ? 0 : course.hill[Math.min(i, course.total - 1)]; }
function groundAt(z) { const k = z / SEGL, i = Math.floor(k); return lp_(hillAt(i), hillAt(i + 1), k - i); }
function headingAt(z) { const i = clamp(Math.floor(z / SEGL), 0, course.total - 1); return course.heading[i]; }
function miniAt(z) {                                                    // posisi di peta mini (0..1)
  const n = course.pts.length / 2 - 1, k = clamp(z / course.L, 0, 1) * n, i = Math.floor(k), f = k - i, a = i * 2, b = Math.min(n, i + 1) * 2;
  return [lp_(course.pts[a], course.pts[b], f), lp_(course.pts[a + 1], course.pts[b + 1], f)];
}

function buildLanes() {                                                 // dipanggil saat konfigurasi/sesi berubah
  setText($('stage-title'), 'Lintasan ' + nf(eng.cfg.L) + ' m');
  course = null; camZ = -18; camLat = 0; peakKmh = 0; resizeRoad();
}
function resizeRoad() {
  if (!roadWrap || !roadCv) return;
  const w = roadWrap.clientWidth, h = roadWrap.clientHeight; if (w < 50 || h < 50) return;
  DPR = Math.min(window.devicePixelRatio || 1, 1.5); RW = w; RH = h;
  roadCv.width = Math.round(w * DPR); roadCv.height = Math.round(h * DPR);
}
const measureTrack = resizeRoad;
if (window.ResizeObserver && roadWrap) new ResizeObserver(resizeRoad).observe(roadWrap);

// ── Posisi mobil di dunia ──
function laneOf(c) { return (c.no - 1) % LANES_V; }
function latOf(c, tSec) { return ((laneOf(c) / Math.max(1, LANES_V - 1)) * 2 - 1) * 0.82 + Math.sin(tSec * 0.8 + c.no * 1.7) * 0.035; }
function worldZ(c, E, cfg) {
  if (c.done) return cfg.L + 24 * (1 - Math.exp(-Math.max(0, E.t - (c.finishAt || E.t)) / 1.1)) + ((c.no * 7) % 5) * 0.8;
  const row = Math.floor((c.no - 1) / LANES_V) % 7;                    // grid start berbaris; menyatu ke jalur setelah ±35 m
  return c.d - row * 7 * Math.max(0, 1 - c.d / 35);
}

// ── Sprite ──
const sh_ = {};
function shade(hex, f) {
  const k = hex + f; if (sh_[k]) return sh_[k];
  const n = parseInt(hex.slice(1), 16), c = function (v) { return Math.max(0, Math.min(255, Math.round(v * f))); };
  return (sh_[k] = 'rgb(' + c(n >> 16) + ',' + c((n >> 8) & 255) + ',' + c(n & 255) + ')');
}
function drawCar(ctx, x, y, w, col, nitro, tSec, no, lead) {
  const h = w * 0.56;
  ctx.fillStyle = 'rgba(0,0,0,.34)'; ctx.beginPath(); ctx.ellipse(x, y, w * 0.6, Math.max(1.5, w * 0.08), 0, 0, 6.3); ctx.fill();
  if (w < 9) { ctx.fillStyle = col; ctx.fillRect(x - w / 2, y - h, w, h); return; }
  if (nitro) {                                                         // api nitro
    const fl = 0.75 + 0.25 * Math.sin(tSec * 60 + no), L2 = h * (0.5 + 0.4 * fl);
    [-1, 1].forEach(function (s) {
      const fx = x + s * w * 0.27;
      ctx.fillStyle = 'rgba(77,195,255,.9)'; ctx.beginPath(); ctx.moveTo(fx - w * 0.07, y - h * 0.1); ctx.lineTo(fx, y - h * 0.1 + L2); ctx.lineTo(fx + w * 0.07, y - h * 0.1); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(fx - w * 0.035, y - h * 0.1); ctx.lineTo(fx, y - h * 0.1 + L2 * 0.55); ctx.lineTo(fx + w * 0.035, y - h * 0.1); ctx.fill();
    });
  }
  ctx.fillStyle = '#07070f';                                           // roda
  ctx.fillRect(x - w * 0.5, y - h * 0.38, w * 0.17, h * 0.38); ctx.fillRect(x + w * 0.33, y - h * 0.38, w * 0.17, h * 0.38);
  ctx.fillStyle = col;                                                 // bodi
  ctx.beginPath(); ctx.moveTo(x - w * 0.46, y - h * 0.08); ctx.lineTo(x + w * 0.46, y - h * 0.08); ctx.lineTo(x + w * 0.42, y - h * 0.56); ctx.lineTo(x - w * 0.42, y - h * 0.56); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(x - w * 0.46, y - h * 0.22, w * 0.92, h * 0.14);
  ctx.fillStyle = shade(col, 0.72);                                    // kabin
  ctx.beginPath(); ctx.moveTo(x - w * 0.3, y - h * 0.55); ctx.lineTo(x + w * 0.3, y - h * 0.55); ctx.lineTo(x + w * 0.21, y - h * 0.92); ctx.lineTo(x - w * 0.21, y - h * 0.92); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(190,230,255,.88)';
  ctx.beginPath(); ctx.moveTo(x - w * 0.25, y - h * 0.59); ctx.lineTo(x + w * 0.25, y - h * 0.59); ctx.lineTo(x + w * 0.18, y - h * 0.86); ctx.lineTo(x - w * 0.18, y - h * 0.86); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(col, 0.55); ctx.fillRect(x - w * 0.42, y - h * 1.02, w * 0.84, h * 0.09);     // spoiler
  ctx.fillRect(x - w * 0.3, y - h * 0.93, w * 0.05, h * 0.09); ctx.fillRect(x + w * 0.25, y - h * 0.93, w * 0.05, h * 0.09);
  ctx.fillStyle = '#ff2d4d'; ctx.fillRect(x - w * 0.42, y - h * 0.46, w * 0.2, h * 0.1); ctx.fillRect(x + w * 0.22, y - h * 0.46, w * 0.2, h * 0.1);   // lampu belakang
  if (w > 28) { ctx.fillStyle = 'rgba(255,45,77,.28)'; ctx.fillRect(x - w * 0.48, y - h * 0.52, w * 0.32, h * 0.22); ctx.fillRect(x + w * 0.16, y - h * 0.52, w * 0.32, h * 0.22); }
  if (w > 60) {                                                        // pelat nomor
    ctx.fillStyle = '#f4f4ff'; ctx.fillRect(x - w * 0.12, y - h * 0.34, w * 0.24, h * 0.13);
    ctx.fillStyle = '#0e0533'; ctx.font = '800 ' + Math.round(h * 0.11) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(no), x, y - h * 0.275);
  }
  if (lead) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = Math.max(1, w * 0.02); ctx.strokeRect(x - w * 0.47, y - h * 1.03, w * 0.94, h * 1.03); }
}
function drawObj(ctx, th, x, y, h, v) {                                // objek tepi jalan per tema
  if (h < 3) return;
  if (th.obj === 'pine') {
    ctx.fillStyle = '#5a3a22'; ctx.fillRect(x - h * 0.04, y - h * 0.2, h * 0.08, h * 0.2);
    for (let k = 0; k < 3; k++) { ctx.fillStyle = k % 2 ? th.c2 : th.c1; const bw = h * (0.34 - k * 0.07), by = y - h * (0.18 + k * 0.26); ctx.beginPath(); ctx.moveTo(x - bw, by); ctx.lineTo(x, by - h * 0.4); ctx.lineTo(x + bw, by); ctx.fill(); }
  } else if (th.obj === 'cactus') {
    ctx.fillStyle = th.c1; ctx.fillRect(x - h * 0.06, y - h * 0.75, h * 0.12, h * 0.75); ctx.fillRect(x - h * 0.22, y - h * 0.5, h * 0.16, h * 0.07); ctx.fillRect(x - h * 0.22, y - h * 0.6, h * 0.07, h * 0.17); ctx.fillRect(x + h * 0.06, y - h * 0.4, h * 0.16, h * 0.07); ctx.fillRect(x + h * 0.15, y - h * 0.52, h * 0.07, h * 0.19);
  } else if (th.obj === 'candy') {
    ctx.fillStyle = '#fff'; ctx.fillRect(x - h * 0.025, y - h * 0.6, h * 0.05, h * 0.6);
    ctx.fillStyle = v > 0.5 ? th.c1 : th.c2; ctx.beginPath(); ctx.arc(x, y - h * 0.72, h * 0.24, 0, 6.3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(x - h * 0.07, y - h * 0.78, h * 0.07, 0, 6.3); ctx.fill();
  } else {
    ctx.fillStyle = '#1b2638'; ctx.fillRect(x - h * 0.025, y - h * 0.85, h * 0.05, h * 0.85);
    ctx.fillStyle = v > 0.5 ? th.c1 : th.c2; ctx.fillRect(x - h * 0.06, y - h * 0.88, h * 0.12, h * 0.06);
    ctx.fillStyle = 'rgba(77,225,255,.18)'; ctx.beginPath(); ctx.arc(x, y - h * 0.85, h * 0.14, 0, 6.3); ctx.fill();
  }
}
function ridge_(x, s) { return 0.55 * Math.sin(x * 1.3 + s) + 0.3 * Math.sin(x * 2.9 + s * 2.1) + 0.15 * Math.sin(x * 6.1 + s * 3.7); }
function drawSky(ctx, th, W, H, hz, hd) {
  const g = ctx.createLinearGradient(0, 0, 0, hz); g.addColorStop(0, th.sky[0]); g.addColorStop(0.62, th.sky[1]); g.addColorStop(1, th.sky[2]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz + 2);
  const off = hd * W * 0.55;
  if (th.obj === 'candy') {                                            // pelangi
    ['#ff5d5d', '#ffa23f', '#ffe14d', '#5fe38a', '#4dc3ff', '#9a7bff'].forEach(function (c, k) { ctx.strokeStyle = c; ctx.globalAlpha = 0.5; ctx.lineWidth = H * 0.016; ctx.beginPath(); ctx.arc(W * 0.3 - off * 0.15, hz + H * 0.08, H * (0.36 - k * 0.017), Math.PI, 0); ctx.stroke(); });
    ctx.globalAlpha = 1;
  }
  const sx = ((W * 0.72 - off * 0.2) % W + W) % W;
  const sg = ctx.createRadialGradient(sx, hz * 0.62, 0, sx, hz * 0.62, H * 0.17); sg.addColorStop(0, th.sun); sg.addColorStop(0.35, th.sun); sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalAlpha = 0.9; ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, hz * 0.62, H * 0.17, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
  [[th.far, 0.5, H * 0.2, 150, 1.3], [th.near, 0.9, H * 0.13, 95, 4.1]].forEach(function (L) {
    ctx.fillStyle = L[0]; ctx.beginPath(); ctx.moveTo(0, hz + 2);
    for (let x = 0; x <= W + 10; x += 10) ctx.lineTo(x, hz - L[2] * (0.45 + 0.55 * (0.5 + 0.5 * ridge_((x + off * L[1]) / L[3], L[4]))));
    ctx.lineTo(W + 10, hz + 2); ctx.closePath(); ctx.fill();
  });
}
function quad(ctx, x1, y1, w1, x2, y2, w2) { ctx.beginPath(); ctx.moveTo(x1 - w1, y1); ctx.lineTo(x1 + w1, y1); ctx.lineTo(x2 + w2, y2); ctx.lineTo(x2 - w2, y2); ctx.closePath(); ctx.fill(); }
function checker(ctx, x1, y1, w1, x2, y2, w2) {                        // garis start/finis berkotak
  const cols = 14;
  for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
    if (((r + c) & 1) === 0) continue;
    const ta = r / 2, tb = (r + 1) / 2, ua = c / cols * 2 - 1, ub = (c + 1) / cols * 2 - 1;
    const xa1 = lp_(x1, x2, ta), ya = lp_(y1, y2, ta), wa = lp_(w1, w2, ta), xb = lp_(x1, x2, tb), yb = lp_(y1, y2, tb), wb = lp_(w1, w2, tb);
    ctx.beginPath(); ctx.moveTo(xa1 + ua * wa, ya); ctx.lineTo(xa1 + ub * wa, ya); ctx.lineTo(xb + ub * wb, yb); ctx.lineTo(xb + ua * wb, yb); ctx.closePath(); ctx.fill();
  }
}
function ordinal(n) { const s = ['TH', 'ST', 'ND', 'RD'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

function adaptQuality(dt) {
  avgDt += (dt - avgDt) * 0.05;
  if (avgDt > 0.034 && Q.n > 70) Q.n -= 5; else if (avgDt < 0.02 && Q.n < 150) Q.n += 2;
}

function renderFrame(ms) {
  if (!rctx) return;
  const dt = clamp((ms - lastRT) / 1000, 0.001, 0.1); lastRT = ms; adaptQuality(dt);
  const E = eng.E, cfg = eng.cfg, rank = eng.ranking(), ctx = rctx, tSec = ms / 1000;
  if (!course || course.L !== cfg.L) buildCourse(cfg.L);
  LANES_V = clamp(+cfg.lanes || 6, 3, 8);
  const th = TEMA[cfg.tema] || TEMA.cyber, W = RW, H = RH, hz = H * 0.42, N = Q.n;
  if (E.state === 'idle' && !rank.length) peakKmh = 0;

  // ── Kamera: ikuti pembalap sorotan (default juara 1), mundur lebih jauh bila barisan melebar ──
  let focus = focusNo ? rank.find(function (c) { return c.no === focusNo; }) : null;
  if (!focus) { focusNo = 0; focus = rank[0] || null; }
  const fz = focus ? worldZ(focus, E, cfg) : 0;
  let back = 13;
  if (focus && focus === rank[0] && rank.length > 1) { const k = Math.min(rank.length, 6); back += Math.min(8, (rank[0].d - rank[k - 1].d) * 0.1); }
  const target = clamp(fz - back, -18, cfg.L - 24);       // kamera berhenti sebelum garis finis → gerbang tetap terlihat
  if (Math.abs(target - camZ) > 160) camZ = target;
  else { if (focus && !focus.done) camZ += focus.vel * dt; camZ += (target - camZ) * (1 - Math.exp(-dt * 5)); }   // + prediksi kecepatan: kamera tidak tertinggal
  camLat += ((focus ? latOf(focus, tSec) * 0.55 : 0) - camLat) * (1 - Math.exp(-dt * 4));
  const fNitro = !!(focus && focus.nitros.length);
  fovD += ((fNitro ? 0.98 : 1.15) - fovD) * (1 - Math.exp(-dt * 6));
  const camX = camLat * ROAD_W, camY = CAM_H + groundAt(camZ);
  const shake = (fNitro && !REDUCE) ? (Math.random() - 0.5) * 2.2 : 0;

  ctx.setTransform(DPR, 0, 0, DPR, 0, shake * DPR);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  drawSky(ctx, th, W, H, hz, headingAt(camZ));
  ctx.fillStyle = th.g1; ctx.fillRect(0, hz, W, H - hz + 4);

  // ── Proyeksi segmen (dekat → jauh) ──
  const base = Math.floor(camZ / SEGL), pct = (camZ - base * SEGL) / SEGL, hw = W / 2;
  let x = 0, dx = -curveAt(base) * pct, n0 = 0;
  for (let n = 0; n <= N; n++) {
    const i = base + n, pz = i * SEGL - camZ, sc = fovD / Math.max(pz, 0.01);
    PZ[n] = pz; SC[n] = sc; PX[n] = hw + sc * (x - camX) * hw; PY[n] = hz - sc * (hillAt(i) - camY) * hw; PW[n] = sc * ROAD_W * hw;
    if (pz < 0.6) n0 = n + 1;
    x += dx; dx += curveAt(i);
  }

  // ── Kelompokkan mobil per segmen ──
  const buckets = new Array(N + 1);
  for (let k = 0; k < rank.length; k++) {
    const c = rank[k], z = worldZ(c, E, cfg), n = Math.floor(z / SEGL) - base;
    if (n < n0 || n >= N) continue;
    (buckets[n] || (buckets[n] = [])).push({ c: c, z: z, i: k });
  }
  const tags = [], startSeg = Math.floor(0 / SEGL) - base, finSeg = Math.floor(cfg.L / SEGL) - base;

  // ── Gambar jauh → dekat (algoritma pelukis) ──
  for (let n = N - 1; n >= n0; n--) {
    const i = base + n, y1 = PY[n], y2 = PY[n + 1];
    if (y1 <= y2) continue;                                            // sisi belakang bukit
    const alt = (Math.floor(i / 3)) & 1, x1 = PX[n], x2 = PX[n + 1], w1 = PW[n], w2 = PW[n + 1];
    ctx.fillStyle = alt ? th.g1 : th.g2; ctx.fillRect(0, y2 - 0.5, W, y1 - y2 + 1.5);
    ctx.fillStyle = alt ? th.rum1 : th.rum2; quad(ctx, x1, y1 + 0.5, w1 * 1.13, x2, y2, w2 * 1.13);
    ctx.fillStyle = alt ? th.r1 : th.r2; quad(ctx, x1, y1 + 0.5, w1, x2, y2, w2);
    if ((i % 6 + 6) % 6 < 3) { ctx.fillStyle = th.lane; ctx.globalAlpha = 0.75; quad(ctx, x1, y1, w1 * 0.018, x2, y2, w2 * 0.018); ctx.globalAlpha = 1; }
    if (n === startSeg || n === finSeg) { ctx.fillStyle = '#f4f4ff'; checker(ctx, x1, y1, w1, x2, y2, w2); }
    // objek tepi jalan
    if (i > 2 && i % 4 === 0 && i * SEGL < cfg.L + 400) {
      const sc = SC[n], hh = (9 + hsh_(i) * 6) * sc * hw;
      drawObj(ctx, th, x1 - (ROAD_W + 5 + hsh_(i + 7) * 15) * sc * hw, y1, hh, hsh_(i + 3));
      drawObj(ctx, th, x1 + (ROAD_W + 5 + hsh_(i + 11) * 15) * sc * hw, y1, hh, hsh_(i + 5));
    }
    // gerbang finis
    if (n === finSeg) {
      const sc = SC[n], gh = 11 * sc * hw, gx1 = x1 - w1 * 1.18, gx2 = x1 + w1 * 1.18;
      ctx.fillStyle = '#e8e8f5'; ctx.fillRect(gx1 - gh * 0.05, y1 - gh, gh * 0.1, gh); ctx.fillRect(gx2 - gh * 0.05, y1 - gh, gh * 0.1, gh);
      const bw = gx2 - gx1, bh = gh * 0.28, bs = Math.max(2, bh / 2);
      for (let r = 0; r < 2; r++) for (let c = 0, cn = Math.max(6, Math.round(bw / bs)); c < cn; c++) { ctx.fillStyle = ((r + c) & 1) ? '#0b0b14' : '#f4f4ff'; ctx.fillRect(gx1 + c * bw / cn, y1 - gh - bh + r * bh / 2, bw / cn + 0.5, bh / 2 + 0.5); }
      if (bh > 14) { ctx.fillStyle = '#ffd23f'; ctx.font = '800 ' + Math.round(bh * 0.5) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('FINISH', x1, y1 - gh - bh * 1.8); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; }
    }
    // mobil pada segmen ini
    const bk = buckets[n];
    if (bk) {
      bk.sort(function (a, b) { return b.z - a.z; });
      for (let q = 0; q < bk.length; q++) {
        const o = bk[q], t = (o.z - i * SEGL) / SEGL, sc = lp_(SC[n], SC[n + 1], t);
        const cx = lp_(x1, x2, t) + latOf(o.c, tSec) * ROAD_W * sc * hw, cy = lp_(y1, y2, t), cw = CAR_UNITS * sc * hw;
        drawCar(ctx, cx, cy, cw, WARNA[o.c.v.color], o.c.nitros.length > 0, tSec, o.c.no, o.i === 0 && E.state !== 'idle');
        if (cw > 26) tags.push({ x: cx, y: cy - cw * 0.6 - 4, w: cw, c: o.c, lead: o.i === 0, f: o.c === focus });
      }
    }
  }

  // ── Kabut tipis di cakrawala, garis kecepatan, vinyet ──
  const hzg = ctx.createLinearGradient(0, hz - H * 0.04, 0, hz + H * 0.2); hzg.addColorStop(0, th.haze); hzg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.5; ctx.fillStyle = hzg; ctx.fillRect(0, hz - H * 0.04, W, H * 0.24); ctx.globalAlpha = 1;
  const kmh = focus ? Math.round(focus.vel * SKALA) : 0; peakKmh = Math.max(peakKmh, kmh);
  if (!REDUCE && focus && E.state === 'running' && (fNitro || kmh > 150)) {
    ctx.strokeStyle = fNitro ? 'rgba(160,225,255,.35)' : 'rgba(255,255,255,.14)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 6.283 + 0.2, ph = fr_(tSec * 2.4 + k * 0.37), r0 = H * (0.25 + ph * 0.5), r1 = r0 + H * 0.08 * (0.4 + ph);
      ctx.moveTo(W / 2 + Math.cos(a) * r0 * 1.5, hz + Math.sin(a) * r0 * 0.9); ctx.lineTo(W / 2 + Math.cos(a) * r1 * 1.5, hz + Math.sin(a) * r1 * 0.9);
    }
    ctx.stroke();
  }
  const vg = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.45, W / 2, H * 0.55, H * 1.0); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(4,2,20,.45)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // ── Label nama di atas mobil terdekat ──
  tags.sort(function (a, b) { return b.w - a.w; });
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let k = 0; k < Math.min(tags.length, 10); k++) {
    const g = tags[k], fs = clamp(g.w * 0.12, 9, 15), nm = '@' + g.c.v.u, txt = nm.length > 13 ? nm.slice(0, 12) + '…' : nm;
    ctx.font = '700 ' + fs + 'px "Space Grotesk",Inter,sans-serif';
    const tw = ctx.measureText(txt).width + fs * 1.1, th2 = fs * 1.55;
    ctx.fillStyle = g.f ? '#2D7DFF' : g.lead ? '#ffb800' : 'rgba(8,6,32,.72)'; rrect(ctx, g.x - tw / 2, g.y - th2, tw, th2, th2 / 2); ctx.fill();
    ctx.fillStyle = g.lead && !g.f ? '#241a00' : '#fff'; ctx.fillText((g.lead ? '♛ ' : '') + txt, g.x, g.y - th2 / 2 + 0.5);
  }
  drawHud(ctx, E, cfg, rank, focus, kmh, W, H, tSec);
}

function drawHud(ctx, E, cfg, rank, focus, kmh, W, H, tSec) {
  const u = clamp(H / 450, 0.7, 1.7), pad = 12 * u, F = function (px, wt) { return (wt || 700) + ' ' + Math.round(px * u) + 'px "Space Grotesk",Inter,sans-serif'; };
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  // Pewaktu + jarak (kiri atas)
  const bw = 168 * u, bh = 52 * u, lead = rank[0], prog = clamp((lead ? lead.d : 0) / cfg.L, 0, 1);
  ctx.fillStyle = 'rgba(8,6,32,.66)'; rrect(ctx, pad, pad, bw, bh, 10 * u); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = F(22, 800); ctx.fillText(fmtTime(E.t), pad + 10 * u, pad + 25 * u);
  ctx.fillStyle = '#9fb4ff'; ctx.font = F(10, 700); ctx.fillText('JARAK ' + Math.round(lead ? lead.d : 0) + ' / ' + nf(cfg.L) + ' M', pad + 10 * u, pad + 39 * u);
  ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(pad + 10 * u, pad + 44 * u, bw - 20 * u, 3 * u);
  ctx.fillStyle = '#ffd23f'; ctx.fillRect(pad + 10 * u, pad + 44 * u, (bw - 20 * u) * prog, 3 * u);
  // Papan peringkat (kiri)
  const rows = Math.min(rank.length, W < 520 ? 5 : 10), rh = 19 * u, lw = Math.min(W * 0.34, 176 * u), ly = pad + bh + 8 * u;
  if (rows) {
    ctx.fillStyle = 'rgba(8,6,32,.6)'; rrect(ctx, pad, ly, lw, rows * rh + 8 * u, 10 * u); ctx.fill();
    for (let k = 0; k < rows; k++) {
      const c = rank[k], ry = ly + 4 * u + k * rh, isF = c === focus;
      if (isF) { ctx.fillStyle = 'rgba(45,125,255,.55)'; rrect(ctx, pad + 3 * u, ry, lw - 6 * u, rh - 1, 6 * u); ctx.fill(); }
      ctx.fillStyle = k === 0 ? '#ffd23f' : '#c9d3ff'; ctx.font = F(10, 800); ctx.textAlign = 'right'; ctx.fillText(String(k + 1), pad + 19 * u, ry + rh * 0.68);
      ctx.fillStyle = WARNA[c.v.color]; ctx.fillRect(pad + 24 * u, ry + 4 * u, 8 * u, rh - 9 * u);
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = F(10, 600);
      let nm = '@' + c.v.u; const mx = lw - 78 * u; while (nm.length > 3 && ctx.measureText(nm).width > mx) nm = nm.slice(0, -2) + '…';
      ctx.fillText(nm, pad + 37 * u, ry + rh * 0.68);
      ctx.textAlign = 'right'; ctx.fillStyle = c.done ? '#2EE59D' : c.nitros.length ? '#4dc3ff' : '#9fb4ff'; ctx.font = F(9, 700);
      ctx.fillText(c.done ? 'FINISH' : k === 0 ? 'LEAD' : '-' + Math.round(lead.d - c.d) + 'm', pad + lw - 7 * u, ry + rh * 0.68);
    }
    ctx.textAlign = 'left';
  }
  // Peta lintasan mini (kanan atas)
  const ms = clamp(H * 0.3, 80, 160) * (u > 1.2 ? 1.1 : 1), mx0 = W - ms - pad, my0 = pad;
  ctx.fillStyle = 'rgba(8,6,32,.6)'; rrect(ctx, mx0, my0, ms, ms, 12 * u); ctx.fill();
  const inner = ms - 22 * u; ctx.save(); ctx.translate(mx0 + 11 * u, my0 + 11 * u); ctx.scale(inner, inner);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 9 / inner * u; ctx.stroke(course.path);
  ctx.strokeStyle = '#7f8cc0'; ctx.lineWidth = 4.5 / inner * u; ctx.stroke(course.path); ctx.restore();
  const dot = function (z, col, r) { const p = miniAt(z); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(mx0 + 11 * u + p[0] * inner, my0 + 11 * u + p[1] * inner, r * u, 0, 6.3); ctx.fill(); };
  dot(cfg.L, '#f4f4ff', 4); dot(0, '#2EE59D', 3.5);
  for (let k = Math.min(rank.length, 40) - 1; k >= 0; k--) { const c = rank[k]; if (c !== focus) dot(c.d, WARNA[c.v.color], k === 0 ? 3.6 : 2.4); }
  if (focus) dot(focus.d, '#ffffff', 4.6);
  // Speedometer + posisi (kanan bawah)
  const R = clamp(H * 0.14, 44, 82), gx = W - R - pad - 6 * u, gy = H - R - pad - 4 * u, gmax = Math.max(160, Math.ceil(Math.max(cfg.capNatKmh * 1.4, peakKmh * 1.1) / 20) * 20);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, fr = clamp(kmh / gmax, 0, 1);
  ctx.fillStyle = 'rgba(8,6,32,.66)'; ctx.beginPath(); ctx.arc(gx, gy, R + 6 * u, 0, 6.3); ctx.fill();
  ctx.lineCap = 'round'; ctx.lineWidth = 7 * u; ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.beginPath(); ctx.arc(gx, gy, R - 4 * u, a0, a1); ctx.stroke();
  const gg = ctx.createLinearGradient(gx - R, gy, gx + R, gy); gg.addColorStop(0, '#2D7DFF'); gg.addColorStop(0.6, '#ffd23f'); gg.addColorStop(1, '#ff4d2e');
  ctx.strokeStyle = gg; ctx.beginPath(); ctx.arc(gx, gy, R - 4 * u, a0, a0 + (a1 - a0) * fr + 0.001); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = F(R * 0.5 / u, 800); ctx.fillText(String(kmh), gx, gy + R * 0.14);
  ctx.fillStyle = '#9fb4ff'; ctx.font = F(9, 700); ctx.fillText('KM/H', gx, gy + R * 0.42);
  const pos = focus ? rank.indexOf(focus) + 1 : 0;
  if (pos) {
    ctx.fillStyle = pos === 1 ? '#ffd23f' : '#fff'; ctx.font = F(34, 800); ctx.textAlign = 'right';
    const pt = String(pos); ctx.fillText(pt, gx - R - 22 * u, gy + R * 0.3);
    ctx.font = F(12, 800); ctx.textAlign = 'left'; ctx.fillText(ordinal(pos), gx - R - 20 * u, gy + R * 0.3 - 14 * u);
    ctx.fillStyle = '#9fb4ff'; ctx.font = F(9, 700); ctx.textAlign = 'right'; ctx.fillText('/ ' + rank.length, gx - R - 22 * u, gy + R * 0.3 + 13 * u);
  }
  // Label sorotan manual
  if (focusNo && focus) {
    ctx.textAlign = 'left'; ctx.font = F(10, 700); const t = 'SOROTAN: @' + focus.v.u + ' · klik lagi di papan untuk kembali ke juara 1', tw = ctx.measureText(t).width + 18 * u;
    ctx.fillStyle = 'rgba(45,125,255,.85)'; rrect(ctx, pad, H - pad - 22 * u, Math.min(tw, W * 0.6), 22 * u, 11 * u); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(t.length > 60 && W < 700 ? 'SOROTAN: @' + focus.v.u : t, pad + 9 * u, H - pad - 7 * u);
  }
  ctx.textAlign = 'left';
}

let lastSlow = 0;
function renderSlow() {
  const E = eng.E, cfg = eng.cfg, rank = eng.ranking(), st = eng.stats();
  // HUD
  const stTxt = { idle: rank.length ? 'Siap start' : 'Menunggu pemain', countdown: 'Bersiap…', running: 'Balapan berlangsung', paused: 'Dijeda', finishing: 'Finis!', finished: 'Selesai' }[E.state];
  setText($('hud-status-txt'), stTxt);
  const hs = $('hud-status'); hs.className = 'hud-status ' + (E.state === 'running' || E.state === 'finishing' ? 'run' : E.state === 'countdown' || E.state === 'paused' ? 'cd' : 'wait');
  $('hud-led').className = 'led pulse ' + (E.state === 'running' ? 'ok' : 'warn');
  setText($('hud-timer'), fmtTime(E.t)); setText($('hud-sesi'), 'ARENA #' + pad2(E.sesiNo));
  setText($('hud-grid'), st.cars); setText($('hud-pace'), nf(eng.pace())); setText($('hud-gift'), nf(st.giftCount));
  // overlay
  const ov = $('stage-overlay'), oc = $('overlay-content');
  if (E.state === 'countdown') { const n = Math.ceil(E.cdLeft); ov.classList.add('show'); const k = n > 0 ? String(n) : 'GO!'; if (oc.dataset.k !== k) { oc.dataset.k = k; oc.innerHTML = '<div class="big-count' + (n > 0 ? '' : ' go') + '">' + esc(k) + '</div>'; } }
  else if (E.state === 'paused') { ov.classList.add('show'); if (oc.dataset.k !== 'p') { oc.dataset.k = 'p'; oc.innerHTML = '<div class="wait-msg t-secondary">Balapan dijeda</div>'; } }
  else if (E.state === 'idle' && !rank.length) { ov.classList.add('show'); if (oc.dataset.k !== 'w') { oc.dataset.k = 'w'; oc.innerHTML = '<div class="wait-msg">Menunggu pemain</div><div class="muted" style="margin-top:6px">Tap layar ' + cfg.tiket + 'x untuk dapat mobil</div>'; } }
  else { ov.classList.remove('show'); oc.dataset.k = ''; }
  // papan peringkat + minimap
  const top = rank.slice(0, 5), sig = top.map(function (c) { return c.v.u + Math.round(c.d) + (c.nitros.length ? 'n' : ''); }).join('|') + E.state;
  if (renderSlow.sig !== sig) {
    renderSlow.sig = sig;
    $('board-list').innerHTML = top.length ? top.map(function (c, i) {
      const gap = i === 0 ? 'JARAK' : '-' + Math.round(top[0].d - c.d) + 'm';
      return '<div class="rk p' + (i + 1) + (c.no === focusNo ? ' focus' : '') + '" data-no="' + c.no + '" role="button" tabindex="0" title="Klik untuk menyorot pembalap ini"><div class="row gap8" style="min-width:0"><span class="rk-pos">' + (i < 3 ? 'P' : '') + (i + 1) + '</span><div class="col" style="min-width:0"><span class="rk-name truncate">@' + esc(c.v.u) + '</span><span class="caps-xs ' + (c.nitros.length ? 't-tertiary' : 'faint') + '">' +
        (c.done ? 'FINISH' : c.nitros.length ? 'NITRO AKTIF' : Math.round(c.vel * SKALA) + ' KM/H') + '</span></div></div><div class="col" style="align-items:flex-end"><span class="rk-dist">' + Math.round(c.d) + 'm</span><span class="caps-xs faint">' + gap + '</span></div></div>';
    }).join('') : '<div class="empty">Belum ada pembalap</div>';
  }
  setText($('tk-state'), E.frenzyUntil > E.t && E.state === 'running' ? 'x2 FRENZY AKTIF' : 'x1');
  setText($('ticker'), S.tick || 'Belum ada gift.');
  // ETA
  const lead = rank[0]; let eta = '—';
  if (lead && E.state === 'running' && lead.vel > 0.5) eta = fmtTime((cfg.L - lead.d) / lead.vel);
  setText($('foot-eta'), eta);
  setText($('foot-msg'), 'Penonton: tap ' + cfg.tiket + 'x untuk dapat mobil · antrean ' + st.waiting);
  // CTA
  setText($('cta-title'), 'Tap layar ' + cfg.tiket + 'x untuk dapat mobil!');
  const lj = E.lastJoin;
  setText($('cta-join-name'), lj ? '@' + lj.u + ' dapat Mobil' + (lj.car ? ' #' + pad2(lj.car.no) : ' (antre)') : 'Belum ada yang bergabung');
  setText($('cta-join-cnt'), st.cars + ' di grid');
  let best = 0; E.viewers.forEach(function (v) { if (!v.booked && v.ticket > best) best = v.ticket; });
  $('cta-join-bar').style.width = Math.min(100, best / cfg.tiket * 100) + '%';
}
function showNitroToast(info) {
  if (!info.car || !roadWrap) return;
  const t = document.createElement('div'); t.className = 'road-toast';
  t.textContent = (info.rep > 1 ? info.rep + '× ' : '') + info.rule.jenis_gift.split('|')[0].toUpperCase() + ' BOOST! (@' + info.v.u + ')';
  roadWrap.appendChild(t); setTimeout(function () { t.remove(); }, 2500);
}

// ── Podium ──
function carSvg(color, w) { return '<div class="podium-car" style="--car:' + color + (w ? ';width:' + w : '') + '"><svg viewBox="0 0 120 50"><use href="#svg-car"/></svg></div>'; }
function renderPodium(d) {
  const r = d.results, h = d.highlights, st = d.stats;
  setText($('pd-sesi'), 'RACE #' + pad2(eng.E.sesiNo)); setText($('pd-time'), '· WAKTU ' + fmtTime(st.time));
  setText($('pd-taps'), nf(st.taps)); setText($('pd-gifts'), nf(st.gifts));
  const cols = [[r[1], 's2', 2], [r[0], 's1', 1], [r[2], 's3', 3]];
  $('pd-steps').innerHTML = cols.map(function (c) {
    const x = c[0];
    if (!x) return '<div class="step-col"><div class="step ' + c[1] + '"><span class="rank-n">' + c[2] + '</span></div></div>';
    return '<div class="step-col c' + c[2] + '">' + carSvg(WARNA[x.color], c[2] === 1 ? '150px' : '') +
      '<div class="step-tag"><div class="h-sm truncate">@' + esc(x.u) + '</div><div class="caps-xs ' + (c[2] === 1 ? 't-secondary' : 'faint') + '">' + (c[2] === 1 ? 'Juara 1' : 'Juara ' + c[2]) + ' · ' + Math.round(x.j) + 'm</div></div>' +
      '<div class="step ' + c[1] + '"><span class="rank-n">' + c[2] + '</span><div class="num"><b>' + nf(x.tp) + '</b> <span class="caps-xs">tap</span><br><span class="caps-xs">' + x.nt + '× nitro</span></div></div></div>';
  }).join('');
  $('pd-runners').innerHTML = r.slice(3, 8).map(function (x) {
    return '<div class="rk"><div class="row gap8" style="min-width:0"><b class="num faint">#' + x.r + '</b><span class="rk-name truncate">@' + esc(x.u) + '</span></div><div class="col" style="align-items:flex-end"><b class="num t-primary">' + Math.round(x.j) + 'm</b><span class="caps-xs faint">-' + Math.round(r[0].j - x.j) + 'm</span></div></div>';
  }).join('') || '<div class="help">Tidak ada pembalap lain.</div>';
  $('pd-left').innerHTML =
    '<div class="mini-card"><div class="caps t-tertiary" style="margin-bottom:6px">VIP sponsor utama</div>' + (h.vip ? '<div class="h-sm truncate">@' + esc(h.vip.u) + '</div><div class="caps-xs t-secondary">' + nf(h.vip.gift) + ' koin · ' + h.vip.nitro + '× nitro</div>' : '<div class="help">Belum ada gift.</div>') + '</div>' +
    '<div class="mini-card"><div class="caps t-primary" style="margin-bottom:6px">Penonton ter-tap</div>' + (h.tapper ? '<div class="h-sm truncate">@' + esc(h.tapper.u) + '</div><div class="caps-xs faint">' + nf(h.tapper.taps) + ' tap saat balapan</div>' : '<div class="help">Belum ada tap.</div>') + '</div>';
  setText($('pd-cta'), 'Tap layar ' + eng.cfg.tiket + 'x untuk booking mobil di race #' + pad2(eng.E.sesiNo + 1) + '!');
}
let confettiOn = false, confettiRaf = 0, parts = [];
function startConfetti() {
  const cv = $('confetti'); if (!cv) return;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  const box = cv.parentElement; cv.width = box.clientWidth; cv.height = box.clientHeight;
  const ctx = cv.getContext('2d'); parts = [];
  const add = function (n) { for (let i = 0; i < n; i++) parts.push({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * .6, s: 5 + Math.random() * 7, c: WARNA[i % WARNA.length], vx: Math.random() * 3 - 1.5, vy: 2 + Math.random() * 3, r: Math.random() * 360, vr: Math.random() * 10 - 5 }); };
  add(90); confettiOn = true; startConfetti.add = add;
  cancelAnimationFrame(confettiRaf);
  (function loop() {
    if (!confettiOn) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y > cv.height + 20) { if (parts.length > 90) { parts.splice(i, 1); continue; } p.y = -20; p.x = Math.random() * cv.width; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r * Math.PI / 180); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.5); ctx.restore();
    }
    confettiRaf = requestAnimationFrame(loop);
  })();
}
function stopConfetti() { confettiOn = false; cancelAnimationFrame(confettiRaf); }

// ════════════════════════════════════════════════════════
// BAGIAN 6: SIDEBAR, KONTROL BALAPAN, FEED
// ════════════════════════════════════════════════════════
function logEvent(icon, title, desc, cls) {
  S.feed.unshift({ icon: icon, title: title, desc: desc, cls: cls || '', t: Date.now() });
  if (S.feed.length > 40) S.feed.length = 40;
  S.feedDirty = true;
}
function renderSideSession() {
  const E = eng.E;
  const map = { idle: ['Menunggu', 'y'], countdown: ['Hitung mundur', 'y'], running: ['Berjalan', 'g'], paused: ['Dijeda', 'y'], finishing: ['Finis', 'g'], finished: ['Selesai', 'b'] }[E.state];
  const p = $('side-sesi-pill'); p.className = 'pill ' + map[1]; p.textContent = map[0];
  setText($('side-sesi-info'), 'Sesi #' + pad2(E.sesiNo) + (S.demo ? ' · DEMO' : ''));
}
function syncButtons() {
  const s = eng.state, run = s === 'running' || s === 'finishing', act = run || s === 'paused' || s === 'countdown';
  $('btn-start').disabled = !(s === 'idle' || s === 'paused'); $('btn-start').lastChild.textContent = s === 'paused' ? 'Lanjut' : 'Mulai';
  $('btn-pause').disabled = !(s === 'running'); $('btn-stop').disabled = !(run || s === 'paused');
  $('btn-reset').disabled = false; $('btn-clear').disabled = false;
  ['qb-all', 'qb-pack', 'qb-frenzy'].forEach(function (id) { $(id).disabled = !(s === 'running'); });
  void act;
}
function connUI() {
  const map = { off: ['warn', 'Belum tersambung'], ws: ['ok', 'Tersambung'], demo: ['ok', 'Mode demo'], lost: ['bad', 'Terputus'] }[S.conn];
  $('side-led').className = 'led pulse ' + map[0]; setText($('side-live'), map[1]); setText($('side-src'), S.connSrc);
  $('rc-led').className = 'led ' + map[0]; setText($('rc-conn'), map[1] + (S.conn === 'ws' || S.conn === 'demo' ? ' (' + S.connSrc + ')' : ''));
  $('rc-warn').hidden = S.conn !== 'lost';
  const h = S.config.username_host; setText($('side-host'), h ? '@' + h : '@—');
}

function renderRace() {
  const E = eng.E, st = eng.stats(), rank = eng.ranking(), cfg = eng.cfg;
  setText($('rc-sesi'), ''); $('rc-sesi').innerHTML = 'Sesi #' + pad2(E.sesiNo) + ': <b>' + esc({ idle: 'Menunggu', countdown: 'Hitung mundur', running: 'Berjalan', paused: 'Dijeda', finishing: 'Finis', finished: 'Selesai' }[E.state]) + '</b>' + (S.demo ? ' · <span class="t-secondary">DEMO</span>' : '');
  setText($('rc-elapsed'), fmtTime(E.t) + '.' + Math.floor((E.t % 1) * 10));
  $('st-cars').innerHTML = nf(st.cars) + ' <small>mobil</small>'; setText($('st-cars-sub'), 'antrean ' + st.waiting);
  const pace = eng.pace(); $('st-pace').innerHTML = nf(pace) + ' <small>tap/mnt</small>'; setText($('st-pace-sub'), 'puncak ' + nf(E.peak));
  $('st-gift').innerHTML = nf(st.giftCount) + ' <small>kali</small>'; setText($('st-gift-sub'), S.boostFeed[0] ? 'terakhir: ' + S.boostFeed[0].nama : 'belum ada gift');
  $('st-viewers').innerHTML = nf(st.active) + ' <small>orang</small>'; setText($('st-viewers-sub'), 'tiket terpenuhi ' + (st.active ? Math.round(st.booked / st.active * 100) : 0) + '%');
  const top = rank.slice(0, 6);
  $('rc-lanes').innerHTML = top.length ? top.map(function (c, i) {
    const p = Math.min(100, c.d / cfg.L * 100);
    return '<div class="lane-bar"><span style="width:26px" class="' + (i === 0 ? 't-secondary' : 'faint') + '">P' + (i + 1) + '</span><div class="bar"><i style="width:' + p.toFixed(1) + '%"></i></div><span class="truncate" style="width:110px;text-align:right">@' + esc(c.v.u) + '</span><span class="t-success" style="width:42px;text-align:right">' + Math.round(p) + '%</span></div>';
  }).join('') : '<div class="empty">Belum ada pembalap di lintasan.</div>';
  if (rank[0]) { setText($('rc-leader'), Math.round(rank[0].vel * SKALA) + ' KM/H'); setText($('rc-leader-txt'), 'Pemimpin: @' + rank[0].v.u + ' (' + Math.round(rank[0].d / cfg.L * 100) + '% lintasan)'); setText($('rc-gap'), rank[1] ? 'Selisih ' + Math.round(rank[0].d - rank[1].d) + ' m dari P2' : ''); }
  else { setText($('rc-leader'), '—'); setText($('rc-leader-txt'), 'Belum ada pembalap'); setText($('rc-gap'), ''); }
  if (S.feedDirty) {
    S.feedDirty = false;
    $('feed').innerHTML = S.feed.length ? S.feed.map(function (f) {
      return '<div class="feed-item ' + f.cls + '"><span class="feed-ico"><span class="ms" style="font-size:18px">' + esc(f.icon) + '</span></span><div class="grow"><div class="row between gap8"><b class="truncate" style="font-size:13px">' + esc(f.title) + '</b><span class="caps-xs faint">' + new Date(f.t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</span></div><div class="help">' + esc(f.desc) + '</div></div></div>';
    }).join('') : '<div class="empty">Menunggu event…</div>';
  }
  setText($('mon-queue'), Outbox.q.length + (Outbox.q.length ? ' menunggu' : ' (kosong)'));
  setText($('mon-sync'), S.lastSync ? Math.round((Date.now() - S.lastSync) / 1000) + ' dtk lalu' : (HAS_API ? 'belum ada' : 'offline'));
  setText($('mon-latency'), S.latency == null ? '—' : S.latency + ' ms');
  const sehat = Outbox.q.length < 10 && S.conn !== 'lost'; const mh = $('mon-health'); mh.className = 'pill ' + (sehat ? 'g' : 'r'); mh.textContent = sehat ? 'Sehat' : 'Perlu perhatian';
  if (S.serverInfo) setText($('mon-log'), nf(S.serverInfo.logEvent) + ' baris');
  setText($('gs-cars'), st.cars);
}
function refreshServerInfo() {
  if (!S.token) return;
  api('getStatusSistem', S.token).then(function (r) { if (r.success) S.serverInfo = r.data; });
}

async function cmdStart() {
  if (!(await ensureAdmin())) return;
  const s = eng.state;
  if (s === 'paused') { eng.resume(); return; }
  if (s === 'finished') { toast('Tunggu podium selesai atau tekan Reset sesi.', 'warning'); return; }
  if (s !== 'idle') return;
  if (S.sim.on) { S.demo = true; eng.markDemo(); }
  const r = eng.startCountdown(S.demo);
  if (!r.ok) { toast(r.why === 'nocars' ? 'Belum ada mobil di grid. Tunggu penonton mencapai ' + eng.cfg.tiket + ' tap, atau aktifkan Simulator.' : 'Tidak bisa memulai sekarang.', 'warning'); return; }
  go('arena');
}
async function cmdStop() { if (!(await ensureAdmin())) return; if (await confirmBox('Hentikan balapan?', 'Hasil dihitung dari jarak saat ini dan tidak ada pemenang resmi.', 'Hentikan')) eng.stop(); }
async function cmdReset() { if (!(await ensureAdmin())) return; if (await confirmBox('Reset sesi?', 'Balapan yang berjalan dibatalkan. Tiket penonton tetap tersimpan.', 'Reset')) { eng.reset(false); S.demo = S.sim.on; } }
async function cmdClear() { if (!(await ensureAdmin())) return; if (await confirmBox('Kosongkan lintasan?', 'Semua mobil dihapus dan tiket penonton direset.', 'Kosongkan')) { eng.clearTrack(); } }

// ════════════════════════════════════════════════════════
// BAGIAN 7: PENGATURAN BOOST (optimistic UI + simpan terdebounce)
// ════════════════════════════════════════════════════════
const FX = { spark: ['Spark Merah', '#FF4D2E'], flame: ['Flame Trail', '#FFD23F'], plasma: ['Blue Plasma', '#2D7DFF'], rainbow: ['Rainbow Lightning', '#B57CFF'], vortex: ['Golden Vortex', '#2EE59D'], solar: ['Solar Flare', '#FF9F43'] };
function eqDist(b) { return b.tambahan_kecepatan / SKALA * b.durasi_detik; }
function tier(k) { return k <= 10 ? 'Tier micro' : k < 1000 ? 'Tier menengah' : 'Tier sultan'; }
function boostSaved(state) { const el = $('boost-save-state'); el.className = 'caps-xs ' + (state === 'err' ? 't-tertiary' : state === 'save' ? 't-secondary' : 't-primary'); el.innerHTML = '<span class="ms" style="font-size:14px">' + (state === 'err' ? 'error' : 'sync') + '</span> ' + (state === 'err' ? 'Belum tersinkron' : state === 'save' ? 'Menyimpan…' : 'Tersimpan'); }
const saveBoostsNow = debounce(async function () {
  boostSaved('save');
  const r = await api('simpanDaftarBoost', S.token, S.boosts);
  if (r.success) { S.boosts = r.data; ls.set('tt_boost', S.boosts); boostSaved('ok'); }
  else { boostSaved('err'); if (r.code !== 'AUTH') toast('Boost belum tersimpan di server: ' + r.message, 'danger'); }
}, 900);
function commitBoosts() {
  ls.set('tt_boost', S.boosts);
  eng.setBoosts(S.boosts, S.config.terapkan_langsung === 'ya');
  renderBoostAll(); saveBoostsNow();
}
function filteredBoosts() {
  const q = S.boostQ.trim().toLowerCase();
  return S.boosts.filter(function (b) {
    if (q && b.jenis_gift.toLowerCase().indexOf(q) === -1) return false;
    const k = b.nilai_koin;
    return S.boostFilter === 'all' || (S.boostFilter === 'murah' && k <= 10) || (S.boostFilter === 'menengah' && k > 10 && k < 1000) || (S.boostFilter === 'sultan' && k >= 1000);
  });
}
function renderBoostAll() { renderBoostTable(); renderBalance(); renderEditor(); renderBoostFeed(); }
function renderBoostTable() {
  const rows = filteredBoosts(), m = eng.cfg.m;
  $('boost-tbody').innerHTML = rows.length ? rows.map(function (b) {
    const fx = FX[b.efek] || FX.spark, taps = Math.round(eqDist(b) / m);
    return '<tr class="clickable ' + (S.beSel === b.id ? 'sel' : '') + '" data-id="' + esc(b.id) + '"><td><div class="row gap12"><span class="gift-ico"><span class="ms">redeem</span></span><div style="min-width:0"><div class="h-sm truncate">' + esc(b.jenis_gift.split('|')[0]) + '</div><div class="caps-xs faint">' + tier(b.nilai_koin) + (b.jenis_gift.indexOf('|') > -1 ? ' · alias ' + esc(b.jenis_gift.split('|').slice(1).join(', ')) : '') + '</div></div></div></td>' +
      '<td class="num t-secondary"><b>' + nf(b.nilai_koin) + '</b></td><td class="num t-primary"><b>+' + b.tambahan_kecepatan + '</b> km/h</td><td class="num">' + b.durasi_detik + ' dtk</td><td class="num muted">' + nf(taps) + ' tap</td>' +
      '<td><span class="fx"><i style="background:' + fx[1] + '"></i>' + fx[0] + '</span></td>' +
      '<td><button class="switch" role="switch" data-act="toggle" aria-checked="' + (b.aktif === 'ya') + '" aria-label="Aktifkan ' + esc(b.jenis_gift.split('|')[0]) + '"></button></td>' +
      '<td class="r"><button class="btn btn-icon btn-ghost" data-act="edit" aria-label="Edit"><span class="ms">edit</span></button> <button class="btn btn-icon btn-ghost" data-act="del" aria-label="Hapus"><span class="ms">delete</span></button></td></tr>';
  }).join('') : '<tr><td colspan="8" class="empty">Tidak ada gift yang cocok.</td></tr>';
  setText($('boost-count'), S.boosts.length + ' gift'); setText($('boost-foot'), 'Menampilkan ' + rows.length + ' dari ' + S.boosts.length + ' gift');
}
function renderBalance() {
  const aktif = S.boosts.filter(function (b) { return b.aktif === 'ya'; }), cfg = eng.cfg;
  if (!aktif.length) { setText($('bal-score'), 'Tidak ada gift aktif'); return; }
  const top = aktif.reduce(function (a, b) { return eqDist(b) > eqDist(a) ? b : a; });
  const dist = eqDist(top), pct = dist / cfg.L * 100, taps = dist / cfg.m;
  const tot = top.tambahan_kecepatan + cfg.capNatKmh, capk = +S.config.batas_kecepatan_maks;
  const lab = pct < 25 ? ['Aman', 'g'] : pct < 50 ? ['Seimbang', 'y'] : pct < 80 ? ['Dominan', 'r'] : ['Pay-to-win', 'r'];
  const sc = $('bal-score'); sc.className = 'pill num ' + lab[1]; sc.textContent = lab[0] + ' · ' + Math.round(pct) + '% lintasan';
  setText($('bal-1'), Math.round(dist) + ' m'); $('bal-1b').style.width = Math.min(100, pct) + '%'; setText($('bal-1t'), '“' + top.jenis_gift.split('|')[0] + '” membawa mobil ' + Math.round(pct) + '% panjang lintasan');
  setText($('bal-2'), nf(taps) + ' tap'); $('bal-2b').style.width = Math.min(100, taps / (cfg.tiket * 10) * 100) + '%'; setText($('bal-2t'), 'setara tap yang harus dilakukan pemain gratis');
  setText($('bal-3'), capk + ' km/h'); $('bal-3b').style.width = Math.min(100, tot / capk * 100) + '%'; setText($('bal-3t'), 'tap penuh + nitro terkuat = ' + tot + ' km/h' + (tot > capk ? ' (dipotong batas)' : ''));
}
function renderBoostFeed() {
  const f = S.boostFeed;
  $('boost-feed').innerHTML = f.length ? f.slice(0, 3).map(function (x) {
    return '<div class="panel-inset row between gap12"><div class="row gap12" style="min-width:0"><span class="gift-ico"><span class="ms">redeem</span></span><div style="min-width:0"><b class="truncate" style="display:block">@' + esc(x.u) + '</b><span class="help">' + esc(x.nama) + ' (' + nf(x.koin) + ')</span></div></div><div class="col" style="align-items:flex-end"><b class="num t-secondary">+' + x.kmh + ' km/h</b><span class="caps-xs faint">' + x.dur + ' dtk' + (x.no ? ' · #' + pad2(x.no) : '') + '</span></div></div>';
  }).join('') : '<div class="empty" style="grid-column:1/-1">Belum ada gift pada sesi ini.</div>';
}
function renderEditor() {
  const d = S.beDraft, form = $('be-form');
  if (!d) { setText($('be-title'), 'Pilih atau tambah gift'); form.style.opacity = .45; form.style.pointerEvents = 'none'; return; }
  form.style.opacity = 1; form.style.pointerEvents = '';
  setText($('be-title'), (S.beNew ? 'Gift baru' : 'Edit: ' + d.jenis_gift.split('|')[0]));
  if (document.activeElement !== $('be-nama')) $('be-nama').value = d.jenis_gift;
  if (document.activeElement !== $('be-koin')) $('be-koin').value = d.nilai_koin;
  $('be-speed').value = d.tambahan_kecepatan; $('be-dur').value = d.durasi_detik;
  setText($('be-speed-v'), '+' + d.tambahan_kecepatan + ' km/h'); setText($('be-dur-v'), d.durasi_detik + ' dtk');
  $('be-fx').innerHTML = Object.keys(FX).map(function (k) { return '<button class="radio-card" data-fx="' + k + '" aria-pressed="' + (d.efek === k) + '" style="padding:8px 10px"><span class="dot"></span><span style="font-size:13px">' + FX[k][0] + '</span></button>'; }).join('');
  const dist = eqDist(d);
  $('be-preview').innerHTML = 'Mobil melaju <b class="t-secondary">+' + d.tambahan_kecepatan + ' km/h</b> selama ' + d.durasi_detik + ' detik, tambahan ±' + Math.round(dist) + ' m (setara ' + nf(Math.round(dist / eng.cfg.m)) + ' tap).';
  $('be-delete').style.visibility = S.beNew ? 'hidden' : 'visible';
}
function selectBoost(id) {
  const b = S.boosts.find(function (x) { return x.id === id; });
  S.beSel = id; S.beNew = false; S.beDraft = b ? Object.assign({}, b) : null; renderBoostTable(); renderEditor();
}
function applyPreset(f, label) {
  confirmBox('Terapkan preset “' + label + '”?', 'Kecepatan boost semua gift diskalakan (' + f + '×) dari nilai bawaan.', 'Terapkan').then(function (ok) {
    if (!ok) return;
    S.boosts = S.boosts.map(function (b) {
      const base = DEFAULT_BOOSTS.find(function (x) { return x.jenis_gift.toLowerCase() === b.jenis_gift.toLowerCase(); }) || b;
      return Object.assign({}, b, { tambahan_kecepatan: clamp(Math.round(base.tambahan_kecepatan * f / 5) * 5, 5, 250), durasi_detik: clamp(Math.round(base.durasi_detik * (f > 1 ? 1.2 : f < 1 ? 0.8 : 1)), 1, 60) });
    });
    commitBoosts(); toast('Preset “' + label + '” diterapkan.', 'success');
  });
}

// ════════════════════════════════════════════════════════
// BAGIAN 8: PENGATURAN GAME (kontrol generik via data-cfg)
// ════════════════════════════════════════════════════════
const RULES = {
  tap_tiket_masuk: { t: 'int', min: 1, max: 5000 }, panjang_lintasan: { t: 'int', min: 200, max: 10000 }, kecepatan_per_tap: { t: 'num', min: 0.1, max: 5 },
  maks_kecepatan_alami: { t: 'int', min: 30, max: 400 }, batas_kecepatan_maks: { t: 'int', min: 60, max: 1000 }, hitung_mundur_detik: { t: 'int', min: 3, max: 30 },
  durasi_podium_detik: { t: 'int', min: 5, max: 120 }, interval_sync_detik: { t: 'int', min: 2, max: 30 }, maks_peserta_arena: { t: 'int', min: 10, max: 1000 }
};
function dirtyKeys() { return Object.keys(S.draft).filter(function (k) { return String(S.draft[k]) !== String(S.config[k]); }); }
function syncControls() {
  const src = Object.assign({}, S.config, S.draft);
  $$('[data-cfg]').forEach(function (el) {
    const k = el.dataset.cfg, v = src[k];
    if (el.classList.contains('switch')) el.setAttribute('aria-checked', String(v === 'ya'));
    else if (el.dataset.type === 'seg' || el.dataset.type === 'radio') $$('[data-v]', el).forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); });
    else if (document.activeElement !== el) el.value = v;
  });
  $$('[data-out]').forEach(function (el) { el.textContent = src[el.dataset.out]; });
  const L = +src.panjang_lintasan, m = +src.kecepatan_per_tap;
  if (L && m) setText($('est-dur'), 'Estimasi ±' + fmtTime(L / (8 * m)) + ' menit bila pemain rata-rata 8 tap/detik (tanpa nitro).');
  const dk = dirtyKeys(), d = dk.length > 0;
  $('dirty-led').hidden = !d; setText($('dirty-t'), d ? 'Perubahan belum disimpan' : 'Semua tersimpan');
  setText($('dirty-s'), d ? dk.length + ' pengaturan diubah. Berlaku ' + (src.terapkan_langsung === 'ya' ? 'langsung di sesi aktif.' : 'di sesi berikutnya.') : 'Belum ada perubahan.');
  $('btn-cfg-save').disabled = !d;
}
function validateKey(k, v) {
  const r = RULES[k]; if (!r) return '';
  const n = Number(v);
  if (!isFinite(n) || v === '' || n < r.min || n > r.max) return 'Harus angka ' + r.min + '–' + r.max;
  return '';
}
function setDraft(k, v) {
  const e = validateKey(k, v);
  $$('[data-err="' + k + '"]').forEach(function (el) { el.textContent = e; });
  $$('[data-cfg="' + k + '"]').forEach(function (el) { if (el.tagName === 'INPUT') el.setAttribute('aria-invalid', e ? 'true' : 'false'); });
  if (e) return false;
  S.draft[k] = RULES[k] ? Number(v) : v;
  if (String(S.draft[k]) === String(S.config[k])) delete S.draft[k];
  syncControls();
  return true;
}
async function saveConfig(partial) {
  if (!(await ensureAdmin())) return;
  const payload = Object.assign({}, S.config, S.draft, partial || {});
  for (const k in RULES) { const e = validateKey(k, payload[k]); if (e) { toast('Pengaturan tidak valid: ' + k + ' — ' + e, 'danger'); return; } }
  const prev = S.config;
  S.config = Object.assign({}, payload); S.draft = {};                              // optimistic
  eng.setConfig(S.config, S.config.terapkan_langsung === 'ya'); ls.set('tt_cfg', S.config); armSync(); connUI(); syncControls();
  const r = await api('simpanKonfigurasi', S.token, payload);
  if (r.success) { S.config = Object.assign({}, S.config, r.data); ls.set('tt_cfg', S.config); toast('Pengaturan disimpan' + (S.config.terapkan_langsung === 'ya' ? ' dan berlaku langsung.' : ' (berlaku di sesi berikutnya).'), 'success'); }
  else { S.draft = {}; Object.keys(payload).forEach(function (k) { if (String(payload[k]) !== String(prev[k])) S.draft[k] = payload[k]; }); S.config = prev; syncControls(); if (r.code !== 'AUTH') toast('Gagal menyimpan: ' + r.message, 'danger'); }
  syncControls();
}

// ════════════════════════════════════════════════════════
// BAGIAN 9: RIWAYAT & LAPORAN (data di-cache, Chart.js lazy)
// ════════════════════════════════════════════════════════
function loadScript(url) {
  if (S.libs[url]) return S.libs[url];
  S.libs[url] = new Promise(function (res, rej) { const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = function () { delete S.libs[url]; rej(new Error('Gagal memuat ' + url)); }; document.head.appendChild(s); });
  return S.libs[url];
}
function loadRiwayat(force) {
  if (S.rw && !force) renderRiwayat();
  else $('tb-peringkat').innerHTML = '<tr><td colspan="5"><div class="skeleton" style="height:90px"></div></td></tr>';
  api('getRiwayatBundle').then(function (r) {
    if (r.success) { S.rw = r.data; ls.set('tt_rw', S.rw); renderRiwayat(); }
    else if (!S.rw) { renderRiwayat(); if (r.code !== 'OFFLINE') toast('Riwayat belum bisa dimuat: ' + r.message, 'warning'); }
  });
}
function rwFilters() { return { user: $('f-user').value.trim().toLowerCase().replace(/^@/, ''), dari: $('f-dari').value, sampai: $('f-sampai').value, sesi: $('f-sesi').value }; }
function inRange(iso, f) { const t = new Date(iso).getTime(); if (f.dari && t < new Date(f.dari + 'T00:00:00').getTime()) return false; if (f.sampai && t > new Date(f.sampai + 'T23:59:59').getTime()) return false; return true; }
function renderRiwayat() {
  const rw = S.rw || { sesi: [], pemain: [] }, f = rwFilters();
  $$('#rw-tabs [data-tab]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tab === S.rwTab)); });
  ['peringkat', 'sesi', 'hasil', 'grafik'].forEach(function (t) { $('rw-' + t).hidden = t !== S.rwTab; });
  $('f-sort-wrap').hidden = S.rwTab !== 'peringkat'; $('f-sesi-wrap').hidden = !(S.rwTab === 'hasil');
  $$('#rw-filter .field')[1].hidden = $$('#rw-filter .field')[2].hidden = S.rwTab === 'peringkat';
  const sel = $('f-sesi'), cur = sel.value;
  sel.innerHTML = '<option value="">Semua sesi</option>' + rw.sesi.map(function (s) { return '<option value="' + esc(s.id_sesi) + '">' + esc(fmtDate(s.waktu_mulai)) + ' — @' + esc(s.pemenang || '—') + '</option>'; }).join('');
  sel.value = cur;
  const pl = rw.pemain.filter(function (p) { return !f.user || p.username.indexOf(f.user) > -1; }).sort(function (a, b) { return S.rwSort === 'like' ? b.like - a.like : S.rwSort === 'gift' ? b.gift - a.gift : (b.menang - a.menang) || (b.like - a.like); });
  $('tb-peringkat').innerHTML = pl.length ? pl.slice(0, 200).map(function (p, i) { return '<tr><td class="num">' + (i + 1) + '</td><td><b>@' + esc(p.username) + '</b></td><td class="r num t-secondary">' + nf(p.menang) + '</td><td class="r num">' + nf(p.like) + '</td><td class="r num">' + nf(p.gift) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">Belum ada data peringkat.</td></tr>';
  const sl = rw.sesi.filter(function (s) { return inRange(s.waktu_mulai, f) && (!f.user || String(s.pemenang).indexOf(f.user) > -1); });
  $('tb-sesi').innerHTML = sl.length ? sl.map(function (s) {
    const dur = (new Date(s.waktu_selesai) - new Date(s.waktu_mulai)) / 1000;
    return '<tr class="clickable" data-sesi="' + esc(s.id_sesi) + '"><td>' + esc(fmtDate(s.waktu_mulai)) + '</td><td class="muted">' + esc(String(s.id_sesi).slice(0, 8)) + '</td><td><b>@' + esc(s.pemenang || '—') + '</b></td><td class="r num">' + nf(s.jumlah_peserta) + '</td><td class="r num">' + nf(s.total_like) + '</td><td class="r num">' + nf(s.total_gift) + '</td><td class="r num">' + (dur > 0 ? fmtTime(dur) : '—') + '</td></tr>';
  }).join('') : '<tr><td colspan="7" class="empty">Belum ada sesi selesai.</td></tr>';
  if (S.rwTab === 'hasil') fetchHasil();
  if (S.rwTab === 'grafik') renderCharts();
}
async function loadHasil() {
  const f = rwFilters(), tb = $('tb-hasil');
  tb.innerHTML = '<tr><td colspan="8"><div class="skeleton" style="height:70px"></div></td></tr>';
  const r = await api('getHasilTersaring', { username: f.user, dari: f.dari, sampai: f.sampai, idSesi: f.sesi, limit: 500 });
  if (!r.success) { tb.innerHTML = '<tr><td colspan="8" class="empty">' + esc(r.code === 'OFFLINE' ? 'Server tidak tersedia (mode offline).' : r.message) + '</td></tr>'; return; }
  S.hasilRows = r.data.baris;
  tb.innerHTML = S.hasilRows.length ? S.hasilRows.map(function (h) { return '<tr><td>' + esc(fmtDate(h.waktu)) + '</td><td class="muted">' + esc(h.id_sesi.slice(0, 8)) + '</td><td class="r num">' + h.peringkat + '</td><td><b>@' + esc(h.username) + '</b></td><td class="r num">' + nf(h.jarak) + ' m</td><td class="r num">' + h.nitro + '</td><td class="r num">' + nf(h.tap) + '</td><td class="r num">' + nf(h.gift) + '</td></tr>'; }).join('') : '<tr><td colspan="8" class="empty">Tidak ada hasil yang cocok.</td></tr>';
  setText($('hasil-info'), 'Menampilkan ' + Math.min(500, r.data.total) + ' dari ' + r.data.total + ' baris.');
}
const fetchHasil = debounce(loadHasil, 250);
async function renderCharts() {
  const rw = S.rw || { sesi: [] };
  try { await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'); } catch (e) { toast('Grafik tidak dapat dimuat (CDN diblokir).', 'warning'); return; }
  const css = getComputedStyle(document.documentElement), txt = css.getPropertyValue('--muted').trim() || '#B8B0E0', grid = 'rgba(140,132,184,.25)';
  const cs = $('ch-sesi'), curr = cs.value;
  cs.innerHTML = rw.sesi.map(function (s) { return '<option value="' + esc(s.id_sesi) + '">' + esc(fmtDate(s.waktu_mulai)) + '</option>'; }).join('');
  if (curr) cs.value = curr;
  const s = rw.sesi.find(function (x) { return x.id_sesi === cs.value; }) || rw.sesi[0];
  const mk = function (id, cfg) { if (S.charts[id]) S.charts[id].destroy(); S.charts[id] = new Chart($(id), cfg); };
  const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: txt } } }, scales: { x: { ticks: { color: txt }, grid: { color: grid } }, y: { ticks: { color: txt }, grid: { color: grid }, beginAtZero: true } } };
  let menit = []; try { menit = s ? JSON.parse(s.like_per_menit || '[]') : []; } catch (e) { menit = []; }
  mk('ch-like', { type: 'line', data: { labels: menit.map(function (_, i) { return 'Menit ' + (i + 1); }), datasets: [{ label: 'Like', data: menit, borderColor: '#2D7DFF', backgroundColor: 'rgba(45,125,255,.2)', fill: true, tension: .3 }] }, options: base });
  const gs = rw.sesi.slice(0, 20).reverse();
  mk('ch-gsesi', { type: 'bar', data: { labels: gs.map(function (x) { return fmtDate(x.waktu_mulai).slice(0, 6); }), datasets: [{ label: 'Total gift (koin)', data: gs.map(function (x) { return +x.total_gift; }), backgroundColor: '#FFD23F' }] }, options: base });
  if (s) {
    const r = await api('getHasilTersaring', { idSesi: s.id_sesi, limit: 100 });
    const rows = (r.success ? r.data.baris : []).filter(function (x) { return x.gift > 0; }).sort(function (a, b) { return b.gift - a.gift; }).slice(0, 10);
    mk('ch-gift', { type: 'bar', data: { labels: rows.map(function (x) { return '@' + x.username; }), datasets: [{ label: 'Gift (koin)', data: rows.map(function (x) { return x.gift; }), backgroundColor: '#FF4D2E' }] }, options: Object.assign({}, base, { indexAxis: 'y' }) });
  }
}
function exportData() {
  const rw = S.rw || { sesi: [], pemain: [] }, f = rwFilters();
  if (S.rwTab === 'hasil') return { name: 'hasil-balapan', head: ['Tanggal', 'Sesi', 'Peringkat', 'Username', 'Jarak (m)', 'Nitro', 'Tap', 'Gift'], rows: S.hasilRows.map(function (h) { return [fmtDate(h.waktu), h.id_sesi, h.peringkat, h.username, h.jarak, h.nitro, h.tap, h.gift]; }) };
  if (S.rwTab === 'sesi' || S.rwTab === 'grafik') return { name: 'rekap-sesi', head: ['Tanggal', 'Sesi', 'Pemenang', 'Peserta', 'Like', 'Gift'], rows: rw.sesi.filter(function (s) { return inRange(s.waktu_mulai, f); }).map(function (s) { return [fmtDate(s.waktu_mulai), s.id_sesi, s.pemenang, s.jumlah_peserta, s.total_like, s.total_gift]; }) };
  const pl = rw.pemain.filter(function (p) { return !f.user || p.username.indexOf(f.user) > -1; }).sort(function (a, b) { return S.rwSort === 'like' ? b.like - a.like : S.rwSort === 'gift' ? b.gift - a.gift : (b.menang - a.menang) || (b.like - a.like); });
  return { name: 'papan-peringkat', head: ['#', 'Username', 'Menang', 'Total like', 'Total gift'], rows: pl.map(function (p, i) { return [i + 1, p.username, p.menang, p.like, p.gift]; }) };
}
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }
function csvFallback(d) { const q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }; downloadBlob(new Blob(['\ufeff' + [d.head].concat(d.rows).map(function (r) { return r.map(q).join(','); }).join('\r\n')], { type: 'text/csv;charset=utf-8' }), d.name + '.csv'); toast('Library ekspor tidak tersedia — diunduh sebagai CSV (bisa dibuka di Excel).', 'warning'); }
async function doExport(kind) {
  if (!(await ensureAdmin())) return;
  if (S.rwTab === 'hasil' && !S.hasilRows.length) await loadHasil();
  const d = exportData(); if (!d.rows.length) { toast('Tidak ada data untuk diunduh.', 'warning'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    if (kind === 'xlsx') {
      await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([d.head].concat(d.rows)), 'Data');
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'turbotap-' + d.name + '-' + stamp + '.xlsx');
    } else {
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
      const doc = new window.jspdf.jsPDF({ orientation: d.head.length > 6 ? 'landscape' : 'portrait' });
      doc.setFontSize(14); doc.text('TurboTap Live — ' + d.name.replace(/-/g, ' '), 14, 14); doc.setFontSize(9); doc.text(new Date().toLocaleString('id-ID'), 14, 20);
      doc.autoTable({ head: [d.head], body: d.rows, startY: 25, styles: { fontSize: 8 }, headStyles: { fillColor: [45, 125, 255] } });
      downloadBlob(doc.output('blob'), 'turbotap-' + d.name + '-' + stamp + '.pdf');
    }
    toast('Berkas diunduh.', 'success');
  } catch (e) { csvFallback(d); }
}

// ════════════════════════════════════════════════════════
// BAGIAN 10: KONEKTOR TIKTOK LIVE (WebSocket lokal) & SIMULATOR
// ════════════════════════════════════════════════════════
const Konektor = {
  ws: null, want: false, timer: 0, pernahBuka: false, peringatan: false,
  connect: function (url) {
    this.want = true; clearTimeout(this.timer); ls.set('tt_ws', { on: true, url: url });
    try { if (this.ws) this.ws.close(); } catch (e) { /* abaikan */ }
    let ws; try { ws = new WebSocket(url); } catch (e) { toast('Alamat konektor tidak valid.', 'danger'); return; }
    this.ws = ws; S.connSrc = 'TikTok'; $('btn-ws').lastChild.textContent = 'Menyambung…';
    ws.onopen = function () { Konektor.pernahBuka = true; Konektor.peringatan = false; S.conn = 'ws'; connUI(); $('btn-ws').lastChild.textContent = 'Putuskan'; logEvent('hub', 'Konektor tersambung', url, 'ok'); toast('Konektor TikTok Live tersambung.', 'success'); };
    ws.onmessage = function (ev) {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'like') eng.like(m.u, m.n, m.c);
      else if (m.t === 'gift') eng.gift(m.u, m.n, m.g, m.coins, m.rep);
      else if (m.t === 'status' && m.host && !S.config.username_host) { S.config.username_host = String(m.host); connUI(); }
    };
    const lost = function () {
      if (Konektor.ws !== ws) return;
      if (!Konektor.pernahBuka && Konektor.want && !Konektor.peringatan) {
        Konektor.peringatan = true;
        toast('Belum bisa menyambung ke ' + url + '. Pastikan konektor (node konektor.js) berjalan di PC INI. Jika browser menanyakan izin "akses jaringan lokal / local network", pilih Izinkan (ikon gembok di address bar → Setelan situs).', 'warning', 12000);
        logEvent('wifi_off', 'Konektor belum terjangkau', url, 'warn');
      }
      if (S.conn === 'ws') { S.conn = 'lost'; connUI(); logEvent('wifi_off', 'Konektor terputus', 'Arena tetap berjalan. Mencoba menyambung ulang…', 'warn'); toast('Koneksi TikTok Live terputus — arena tetap berjalan.', 'warning'); }
      $('btn-ws').lastChild.textContent = Konektor.want ? 'Menyambung…' : 'Sambung';
      if (Konektor.want) Konektor.timer = setTimeout(function () { Konektor.connect(url); }, 3000);
    };
    ws.onclose = lost; ws.onerror = function () { try { ws.close(); } catch (e) { /* abaikan */ } };
  },
  disconnect: function () { this.want = false; this.pernahBuka = false; this.peringatan = false; ls.set('tt_ws', { on: false, url: ($('ws-url') && $('ws-url').value) || 'ws://localhost:8765' }); clearTimeout(this.timer); try { if (this.ws) this.ws.close(); } catch (e) { /* abaikan */ } this.ws = null; S.conn = S.sim.on ? 'demo' : 'off'; S.connSrc = S.sim.on ? 'Simulator' : '—'; connUI(); $('btn-ws').lastChild.textContent = 'Sambung'; }
};
const NAMA = ['budi_gaming', 'siti_speed', 'andi_tap', 'clara_queen', 'rizky_tap', 'wahyu_99', 'doni_racing', 'speedy_boy', 'nina.drift', 'joko_turbo', 'lestari88', 'fajar_x', 'ayu_cantik', 'bima_s', 'dewi_nitro', 'eko_gas', 'farah_live', 'gilang_pro', 'hana_tap', 'indra_k', 'jasmine_r', 'kevin_gt', 'lia_moto', 'maman_slow', 'nanda_rev', 'oki_boost', 'putri_zoom', 'qori_fast', 'reza_king', 'sari_tap'];
S.sim = { on: false, bots: [], timer: 0, giftFreq: 4, n: 30 };
function simStart() {
  S.sim.on = true; S.demo = true; eng.markDemo();
  S.sim.bots = [];
  for (let i = 0; i < S.sim.n; i++) { const base = NAMA[i % NAMA.length]; S.sim.bots.push({ u: 'sim_' + (i < NAMA.length ? base : base + i), n: base, rate: 1.5 + Math.random() * 8, burst: Math.random() < 0.25, ph: Math.random() * 6 }); }
  S.conn = Konektor.ws && S.conn === 'ws' ? 'ws' : 'demo'; if (S.conn === 'demo') S.connSrc = 'Simulator';
  clearInterval(S.sim.timer);
  let tk = 0;
  S.sim.timer = setInterval(function () {
    tk++;
    const t = tk * 0.25;
    S.sim.bots.forEach(function (b) {
      let r = b.rate; if (b.burst) r *= 0.4 + 1.2 * Math.abs(Math.sin(t / 3 + b.ph));
      const c = Math.floor(r * 0.25 + Math.random());
      if (c > 0) eng.like(b.u, b.n, c);
    });
    if (S.sim.giftFreq > 0 && Math.random() < S.sim.giftFreq * 0.03) {
      const b = S.sim.bots[Math.floor(Math.random() * S.sim.bots.length)], pool = S.boosts.filter(function (x) { return x.aktif === 'ya'; });
      if (pool.length) { const w = pool.filter(function () { return Math.random() < 0.6; }), r = (w.length ? w : pool)[Math.floor(Math.random() * (w.length || pool.length))]; eng.gift(b.u, b.n, r.jenis_gift.split('|')[0], r.nilai_koin, Math.random() < .2 ? 1 + Math.floor(Math.random() * 5) : 1); }
    }
  }, 250);
  connUI(); renderSideSession();
}
function simStop() {
  S.sim.on = false; clearInterval(S.sim.timer);
  if (eng.state === 'idle') S.demo = false;
  if (S.conn === 'demo') { S.conn = 'off'; S.connSrc = '—'; }
  connUI(); renderSideSession();
}

// ════════════════════════════════════════════════════════
// BAGIAN 11: LOOP UTAMA (rAF + cadangan saat tab tersembunyi)
// ════════════════════════════════════════════════════════
let lastT = performance.now(), frames = 0, fpsT = performance.now();
function advance(ms) {
  let dt = (ms - lastT) / 1000; lastT = ms;
  if (dt > 5) dt = 5;
  while (dt > 1e-4) { const s = Math.min(dt, 0.05); eng.tick(s); dt -= s; }
}
function frame(ms) {
  advance(ms); frames++;
  if (ms - fpsT >= 1000) { S.fps = Math.round(frames * 1000 / (ms - fpsT)); frames = 0; fpsT = ms; setText($('chip-fps'), 'Engine: ' + S.fps + ' FPS'); }
  if (S.view === 'arena' && !$('arena-race').hidden) renderFrame(ms);
  if (ms - lastSlow > 220) {
    lastSlow = ms;
    if (S.view === 'arena' && !$('arena-race').hidden) renderSlow();
    else if (S.view === 'race') renderRace();
    syncDock();                                  // dock Mode Siaran tetap akurat saat layar podium tampil
  }
  requestAnimationFrame(frame);
}
setInterval(function () { if (document.hidden) advance(performance.now()); }, 250);

// 1 Hz: podium, mulai otomatis, indikator sinkron
setInterval(function () {
  if (eng.state === 'finished') {
    S.podiumLeft = Math.max(0, S.podiumLeft - 1); setText($('pd-count'), fmtTime(S.podiumLeft));
    if (S.podiumLeft <= 0) { eng.reset(false); S.demo = S.sim.on; }
  } else if (eng.state === 'idle' && S.auto && S.token && eng.stats().cars >= 2 && Date.now() - (S.idleSince || 0) > 6000) {
    const r = eng.startCountdown(S.demo); if (r.ok) toast('Sesi berikutnya dimulai otomatis.', 'info');
  }
  if (eng.state !== 'idle') S.idleSince = Date.now(); else if (!S.idleSince) S.idleSince = Date.now();
  setText($('chip-sync'), 'Sync: ' + (Outbox.q.length ? Outbox.q.length + ' antre' : (S.lastSync ? 'OK' : (HAS_API ? 'siap' : 'offline'))) + (S.latency != null ? ' · ' + S.latency + 'ms' : ''));
  setText($('gs-server'), 'Server: ' + (HAS_API ? (S.latency != null ? 'terhubung (' + S.latency + ' ms)' : 'siap') : 'offline'));
  $('gs-led').className = 'led ' + (HAS_API ? 'ok' : 'bad');
  if (eng.state === 'idle') { if (S.view === 'arena') $('arena-podium').hidden = true; }
}, 1000);
document.addEventListener('visibilitychange', function () { lastT = performance.now(); });

// ════════════════════════════════════════════════════════
// BAGIAN 12: PENGIKATAN EVENT (delegasi — tanpa handler inline)
// ════════════════════════════════════════════════════════
function bind() {
  // navigasi
  $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.view); }); });
  $('btn-theme').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });
  initDock();
  $('btn-obs').addEventListener('click', function () { setObs(true); }); $('btn-obs2').addEventListener('click', function () { setObs(true); });
  $('obs-exit').addEventListener('click', function () { setObs(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if ($('m-login').classList.contains('show')) finishLogin(false); else if (document.body.classList.contains('obs')) setObs(false); else closeModal('m-confirm'); }
  });
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && document.body.classList.contains('obs')) { document.body.classList.remove('obs'); } measureTrack(); });
  // auth
  $('btn-auth').addEventListener('click', function () { if (S.token) { api('logoutAdmin', S.token); setToken(null); toast('Keluar dari mode admin.', 'info'); if (LOCKED[S.view]) go('arena'); } else ensureAdmin(); });
  $('btn-login-cancel').addEventListener('click', function () { finishLogin(false); });
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const pin = $('login-pin').value.trim(); if (!pin) { $('login-err').textContent = 'Masukkan PIN.'; return; }
    const btn = $('btn-login'); btn.disabled = true; $('login-err').textContent = '';
    const r = await api('loginAdmin', pin); btn.disabled = false;
    if (r.success) { setToken(r.data.token); finishLogin(true); toast('Masuk sebagai admin.', 'success'); outKick(); }
    else { $('login-err').textContent = r.code === 'OFFLINE' ? 'Server tidak tersedia (mode offline).' : r.message; $('login-pin').select(); }
  });
  // kontrol balapan
  $('btn-start').addEventListener('click', cmdStart); $('btn-pause').addEventListener('click', function () { eng.pause(); });
  $('btn-stop').addEventListener('click', cmdStop); $('btn-reset').addEventListener('click', cmdReset); $('btn-clear').addEventListener('click', cmdClear);
  $('btn-emergency').addEventListener('click', cmdClear);
  $('qb-all').addEventListener('click', function () { const k = eng.boostAll(20, 6); logEvent('bolt', 'Host Overboost +20%', 'Semua mobil +' + k + ' km/h selama 6 dtk', 'gift'); });
  $('qb-pack').addEventListener('click', function () { const n = eng.packTighten(); logEvent('compress', 'Rapatkan barisan', n + ' pembalap belakang dapat dorongan', 'gift'); });
  $('qb-frenzy').addEventListener('click', function () { eng.frenzy(15); logEvent('whatshot', 'Nitro Frenzy 15 detik', 'Boost gift berlipat 2×', 'gift'); });
  $('btn-ping').addEventListener('click', pingServer); $('btn-ping2').addEventListener('click', pingServer);
  $('btn-flush').addEventListener('click', function () { collectBatch(); outKick(); toast('Mengirim antrean sinkron…', 'info'); });
  $('btn-pd-now').addEventListener('click', async function () { if (!(await ensureAdmin())) return; eng.reset(false); S.demo = S.sim.on; cmdStart(); });
  $('btn-pd-confetti').addEventListener('click', function () { if (startConfetti.add) startConfetti.add(80); });
  const at = $('auto-toggle'); if (at) { at.setAttribute('aria-checked', String(S.auto)); at.addEventListener('click', function () { S.auto = !S.auto; ls.set('tt_auto', S.auto); at.setAttribute('aria-checked', String(S.auto)); }); }
  // simulator & konektor
  $('sim-toggle').addEventListener('click', function () { const on = $('sim-toggle').getAttribute('aria-checked') !== 'true'; $('sim-toggle').setAttribute('aria-checked', String(on)); on ? simStart() : simStop(); });
  $('sim-count').addEventListener('input', function () { S.sim.n = +this.value; setText($('sim-count-v'), this.value); });
  $('sim-count').addEventListener('change', function () { if (S.sim.on) { simStop(); simStart(); $('sim-toggle').setAttribute('aria-checked', 'true'); } });
  $('sim-gift').addEventListener('input', function () { S.sim.giftFreq = +this.value; setText($('sim-gift-v'), this.value == 0 ? 'mati' : this.value < 4 ? 'jarang' : this.value < 8 ? 'sedang' : 'sering'); });
  const pilihFokus = function (e) {
    const r = e.target.closest && e.target.closest('.rk[data-no]'); if (!r) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); const no = +r.dataset.no; focusNo = focusNo === no ? 0 : no; renderSlow.sig = '';
  };
  $('board-list').addEventListener('click', pilihFokus); $('board-list').addEventListener('keydown', pilihFokus);
  $('btn-ws').addEventListener('click', function () { if (Konektor.want) Konektor.disconnect(); else Konektor.connect($('ws-url').value.trim()); });
  // boost
  $('btn-add-boost').addEventListener('click', function () { S.beNew = true; S.beSel = null; S.beDraft = { id: uid(), jenis_gift: '', nilai_koin: 1, tambahan_kecepatan: 30, durasi_detik: 5, efek: 'spark', aktif: 'ya' }; renderBoostTable(); renderEditor(); $('be-nama').focus(); });
  $('boost-q').addEventListener('input', function () { S.boostQ = this.value; renderBoostTable(); });
  $('boost-filter').addEventListener('click', function (e) { const b = e.target.closest('button'); if (!b) return; S.boostFilter = b.dataset.f; $$('#boost-filter button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); renderBoostTable(); });
  $('preset-santai').addEventListener('click', function () { applyPreset(0.6, 'Santai'); });
  $('preset-kompetitif').addEventListener('click', function () { applyPreset(1, 'Kompetitif'); });
  $('preset-hype').addEventListener('click', function () { applyPreset(1.6, 'Hype bar-bar'); });
  $('boost-tbody').addEventListener('click', function (e) {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = tr.dataset.id, act = (e.target.closest('[data-act]') || {}).dataset;
    if (act && act.act === 'toggle') { const b = S.boosts.find(function (x) { return x.id === id; }); b.aktif = b.aktif === 'ya' ? 'tidak' : 'ya'; commitBoosts(); return; }
    if (act && act.act === 'del') { confirmBox('Hapus gift?', 'Pengaturan boost ini akan dihapus.', 'Hapus').then(function (ok) { if (ok) { S.boosts = S.boosts.filter(function (x) { return x.id !== id; }); if (S.beSel === id) { S.beSel = null; S.beDraft = null; } commitBoosts(); } }); return; }
    selectBoost(id);
  });
  const bd = function (k, conv) { return function () { if (!S.beDraft) return; S.beDraft[k] = conv(this.value); renderEditor(); }; };
  $('be-nama').addEventListener('input', function () { if (S.beDraft) { S.beDraft.jenis_gift = this.value; $('be-nama-e').textContent = ''; } });
  $('be-koin').addEventListener('input', function () { if (S.beDraft) S.beDraft.nilai_koin = Math.max(0, Math.round(+this.value || 0)); });
  $('be-speed').addEventListener('input', bd('tambahan_kecepatan', Number)); $('be-dur').addEventListener('input', bd('durasi_detik', Number));
  $('be-fx').addEventListener('click', function (e) { const b = e.target.closest('[data-fx]'); if (b && S.beDraft) { S.beDraft.efek = b.dataset.fx; renderEditor(); } });
  $('be-close').addEventListener('click', function () { S.beDraft = null; S.beSel = null; S.beNew = false; renderBoostTable(); renderEditor(); });
  $('be-save').addEventListener('click', function () {
    const d = S.beDraft; if (!d) return;
    if (!d.jenis_gift.trim()) { $('be-nama-e').textContent = 'Nama gift wajib diisi.'; $('be-nama').focus(); return; }
    d.jenis_gift = d.jenis_gift.trim();
    if (S.beNew) S.boosts.push(Object.assign({}, d)); else S.boosts = S.boosts.map(function (x) { return x.id === d.id ? Object.assign({}, d) : x; });
    S.beSel = d.id; S.beNew = false; commitBoosts(); toast('Boost diterapkan.', 'success');
  });
  $('be-delete').addEventListener('click', function () { const id = S.beSel; if (!id) return; confirmBox('Hapus gift?', 'Pengaturan boost ini akan dihapus.', 'Hapus').then(function (ok) { if (ok) { S.boosts = S.boosts.filter(function (x) { return x.id !== id; }); S.beSel = null; S.beDraft = null; commitBoosts(); } }); });
  // pengaturan game (generik)
  $$('[data-cfg]').forEach(function (el) {
    const k = el.dataset.cfg, immediate = !!el.closest('#v-boost');
    if (el.classList.contains('switch')) el.addEventListener('click', function () { const v = el.getAttribute('aria-checked') === 'true' ? 'tidak' : 'ya'; if (immediate) saveConfig({ [k]: v }); else setDraft(k, v); });
    else if (el.dataset.type === 'seg' || el.dataset.type === 'radio') el.addEventListener('click', function (e) { const b = e.target.closest('[data-v]'); if (!b) return; setDraft(k, el.dataset.num ? Number(b.dataset.v) : b.dataset.v); });
    else { const h = function () { setDraft(k, el.value); }; el.addEventListener('input', h); el.addEventListener('change', h); }
  });
  $('btn-cfg-save').addEventListener('click', function () { saveConfig(); });
  $('btn-cfg-reset').addEventListener('click', async function () { if (await confirmBox('Reset ke bawaan?', 'Semua pengaturan game dikembalikan ke nilai bawaan pabrik.', 'Reset')) saveConfig(Object.assign({}, DEFAULT_CONFIG, { username_host: S.config.username_host, logo_url: S.config.logo_url })); });
  $('btn-pin').addEventListener('click', async function () {
    const r = await api('ubahPinAdmin', S.token, $('pin-lama').value, $('pin-baru').value);
    if (r.success) { if (r.data && r.data.token) setToken(r.data.token); $('pin-lama').value = $('pin-baru').value = ''; $('pin-err').textContent = ''; toast('PIN admin diperbarui.', 'success'); }
    else $('pin-err').textContent = r.message;
  });
  const mig = async function (dry) {
    const id = $('mig-id').value.trim(); if (!id) { toast('Masukkan ID spreadsheet lama.', 'warning'); return; }
    if (!dry && !(await confirmBox('Impor data?', 'Data dari spreadsheet lama digabung ke database baru (aman diulang).', 'Impor'))) return;
    const out = $('mig-out'); out.hidden = false; out.textContent = dry ? 'Memindai…' : 'Mengimpor…';
    const r = await api(dry ? 'pindaiMigrasi' : 'imporMigrasi', S.token, id, null);
    if (!r.success) { out.textContent = '✖ ' + r.message; return; }
    out.textContent = (dry ? 'PINDAI (tidak menulis data)\n' : 'IMPOR SELESAI\n') + Object.keys(r.data.laporan).map(function (n) { const x = r.data.laporan[n]; return x.tidakAda ? n + ': sheet tidak ada di sumber' : n + ': sumber ' + x.sumber + ' → tambah ' + x.inserted + ', perbarui ' + x.updated + ', lewati ' + x.skipped; }).join('\n');
  };
  $('btn-mig-scan').addEventListener('click', function () { mig(true); }); $('btn-mig-run').addEventListener('click', function () { mig(false); });
  // riwayat
  $('rw-tabs').addEventListener('click', function (e) { const b = e.target.closest('[data-tab]'); if (!b) return; S.rwTab = b.dataset.tab; renderRiwayat(); });
  $('rw-sort').addEventListener('click', function (e) { const b = e.target.closest('[data-s]'); if (!b) return; S.rwSort = b.dataset.s; $$('#rw-sort button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); renderRiwayat(); });
  ['f-user', 'f-dari', 'f-sampai', 'f-sesi'].forEach(function (id) { $(id).addEventListener('input', debounce(renderRiwayat, 250)); });
  $('btn-f-reset').addEventListener('click', function () { ['f-user', 'f-dari', 'f-sampai', 'f-sesi'].forEach(function (id) { $(id).value = ''; }); renderRiwayat(); });
  $('btn-rw-refresh').addEventListener('click', function () { loadRiwayat(true); });
  $('ch-sesi').addEventListener('change', renderCharts);
  $('tb-sesi').addEventListener('click', function (e) { const tr = e.target.closest('tr[data-sesi]'); if (!tr) return; S.rwTab = 'hasil'; $('f-sesi').value = tr.dataset.sesi; renderRiwayat(); });
  $('btn-xlsx').addEventListener('click', function () { doExport('xlsx'); }); $('btn-pdf').addEventListener('click', function () { doExport('pdf'); });
  window.addEventListener('beforeunload', function () { collectBatch(); outPersist(); });
}
async function pingServer() {
  const r = await api('ping');
  if (r.success) toast('Server merespons dalam ' + S.latency + ' ms.', 'success'); else toast('Ping gagal: ' + r.message, 'danger');
}

// ════════════════════════════════════════════════════════
// BAGIAN 13: INISIALISASI (render dari cache lokal → sinkron server)
// ════════════════════════════════════════════════════════
function applyBootstrap(d) {
  if (d.config) { S.config = Object.assign({}, DEFAULT_CONFIG, d.config); ls.set('tt_cfg', S.config); eng.setConfig(S.config, false); }
  if (d.boosts && d.boosts.length) { S.boosts = d.boosts; ls.set('tt_boost', S.boosts); eng.setBoosts(S.boosts, false); }
  if (d.nomorSesi && eng.state === 'idle' && d.nomorSesi > eng.E.sesiNo) eng.E.sesiNo = d.nomorSesi;
  armSync(); connUI(); syncControls(); renderSideSession();
  if (S.view === 'boost') renderBoostAll();
}
function init() {
  setTheme(ls.get('tt_theme', 'dark'));
  S.config = Object.assign({}, DEFAULT_CONFIG, ls.get('tt_cfg', {}));
  const b = ls.get('tt_boost', null); if (b && b.length) S.boosts = b;
  eng.setConfig(S.config, true); eng.setBoosts(S.boosts, true);
  const bs = ls.get('tt_boot', null); if (bs && bs.nomorSesi) eng.E.sesiNo = bs.nomorSesi;
  buildLanes(); bind(); updateAuthUI(); connUI(); syncControls(); renderSideSession(); syncButtons(); armSync();
  $('boot').style.opacity = '0'; setTimeout(function () { $('boot').style.display = 'none'; }, 260);
  requestAnimationFrame(function (t) { lastT = t; frame(t); });
  apiBatch([{ action: 'getBootstrap' }, { action: 'getRiwayatBundle' }]).then(function (rs) {
    const r = rs[0], w = rs[1];
    if (r.success) { ls.set('tt_boot', r.data); applyBootstrap(r.data); }
    else if (r.code !== 'OFFLINE') toast('Server belum terjangkau — memakai pengaturan tersimpan di perangkat. ' + r.message, 'warning', 6000);
    else logEvent('cloud_off', 'Mode offline', 'Isi GAS_URL di js/config.js. Sementara: pengaturan bawaan dipakai, data tidak disimpan.', 'warn');
    if (w && w.success) { S.rw = w.data; ls.set('tt_rw', S.rw); }
  });
  if (S.token) outKick();
  const w = ls.get('tt_ws', null);                       // sambung otomatis jika terakhir dipakai
  if (w && w.url) $('ws-url').value = w.url;
  const lokal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);   // dibuka lewat konektor → langsung sambung
  if ((w && w.on && w.url) || (lokal && !(w && w.on === false))) setTimeout(function () { Konektor.connect((w && w.url) || ('ws://' + location.host)); }, 600);
}
init();
})();