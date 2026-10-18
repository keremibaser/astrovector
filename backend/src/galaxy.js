// AI'A NOT: galaxy.js — DETERMINISTIK YILDIZ HARITASI ÜRETİCİ (server + client aynı sonucu alır).
//
// NEDEN DETERMINISTIK: 4096 yıldızın statik verisi CDN'den JSON olarak gelir (starmap.json).
// Ama server bir yıldızın var olup olmadığını DOĞRULAMAK zorunda (warp isteği spoof edilebilir).
// Aynı seed + aynı algoritma => server ve client aynı haritayı üretir; JSON yalnız hız için.
// (bkz. MIMARI_VE_GOREVLER.md §Room Yönetimi, §Telemetry)
//
// SPIRAL GALAKSI: yıldızlar 2 kollu sarmalda dağıtılır — gerçek bir galaksi gibi ve
// "gizemli derin uzay" hissi için merkeze yakın yoğunluk, dışarıda seyrek yıldızlar.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GALAXY_SEED = Number(process.env.GALAXY_SEED || 20261017);
const STAR_COUNT = 16384;      // kullanıcı isteği: daha fazla yıldız (performans sorunu değil:
                                // harita istemcide YALNIZ pencere içindekini çizer/sorgular).
const GALAXY_RADIUS = 13000;   // 4 kat yıldız AMA çok daha geniş alan → yıldızların arası
                                // belirgin şekilde açılır (yoğunluk: 4x yıldız / 10.6x alan).
const ARMS = 2;
const SPIRAL_TIGHTNESS = 2000; // r/2000 → 13000 birimde ~1 tam tur (kol başına yıldız seyrek)

const DATA_DIR = join(process.cwd(), 'backend', 'data');
const DESTROYED_FILE = join(DATA_DIR, 'destroyed_stars.json');

export function loadDestroyedStars() {
  try {
    if (existsSync(DESTROYED_FILE)) {
      const raw = readFileSync(DESTROYED_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return new Set(list.map(Number));
    }
  } catch (err) {
    console.warn('[GALAXY] destroyed_stars.json okunamadi:', err.message);
  }
  return new Set();
}

export function saveDestroyedStar(starId) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const current = loadDestroyedStars();
    current.add(Number(starId));
    writeFileSync(DESTROYED_FILE, JSON.stringify([...current]), 'utf8');
  } catch (err) {
    console.error('[GALAXY] destroyed_stars.json yazilamadi:', err.message);
  }
}

// mulberry32 — küçük, hızlı, deterministik PRNG. Math.random() KULLANILMAZ (o seed'lenemez).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// AI'A NOT: Yıldız isimleri hece tablosundan üretilir — "Veyra-IX", "Kaldros", "Umbriel".
// Gizemli ton için kasvetli/sert heceler seçildi; bazı yıldızlar "anomali" işaretlidir.
const SYL_A = ['Vey', 'Kar', 'Tho', 'Zar', 'Nyx', 'Oro', 'Umb', 'Cyg', 'Vy', 'Dra', 'Mor', 'Hel', 'Ser', 'Ith', 'Qar', 'Bel'];
const SYL_B = ['ra', 'dos', 'nis', 'thak', 'dis', 'ka', 'riel', 'ton', 'mir', 'vex', 'shar', 'dun', 'lith', 'ara', 'um', 'or'];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

// Yıldız sınıfları — gizemli palet: çoğunluk kırmızı/cüce (K/M), az sayıda parlak mavi (O/B).
// c = renk indeksi (client palette'ine karşılık gelir).
const CLASSES = [
  { k: 'O', w: 1, c: 0 },  // soluk mavi
  { k: 'B', w: 3, c: 1 },  // mavi-beyaz
  { k: 'A', w: 6, c: 2 },  // beyaz
  { k: 'F', w: 10, c: 3 }, // sarımsı
  { k: 'G', w: 14, c: 4 }, // sarı
  { k: 'K', w: 26, c: 5 }, // turuncu
  { k: 'M', w: 40, c: 6 }, // kızıl cüce (en yaygın)
];
const TOTAL_W = CLASSES.reduce((s, c) => s + c.w, 0);

// Anomali tipleri — oyunun "gizem" katmanı (statik flavor, Milestone 5'te içerik kazanacak).
export const ANOMALIES = ['DERELICT', 'SILENT_BEACON', 'RUIN', 'GRAVEYARD', 'OBSCURED_SIGNAL'];

export function generateGalaxy(seed = GALAXY_SEED, count = STAR_COUNT) {
  const rnd = mulberry32(seed);
  const stars = [];

  for (let i = 0; i < count; i++) {
    // --- Sarmal kol konumu -------------------------------------------------
    // r: merkezden uzaklık (kare kök dağılımı => alanı eşit doldurur, merkez yoğun)
    const r = Math.sqrt(rnd()) * GALAXY_RADIUS;
    const arm = Math.floor(rnd() * ARMS);
    // Sarmal açısı: yarıçapla artar (logaritmik sarmal) + kol içi dağılım (spread)
    const spiralAngle = r / SPIRAL_TIGHTNESS + arm * (Math.PI * 2 / ARMS);
    const spread = (rnd() - 0.5) * (0.85 - r / GALAXY_RADIUS * 0.35); // dışarıda kol daha ince
    const angle = spiralAngle + spread;

    const x = Math.round(Math.cos(angle) * r);
    const y = Math.round(Math.sin(angle) * r);

    // --- Sınıf seçimi ------------------------------------------------------
    let pick = rnd() * TOTAL_W, cls = CLASSES[0];
    for (const c of CLASSES) { if (pick < c.w) { cls = c; break; } pick -= c.w; }

    // --- İsim --------------------------------------------------------------
    const name = SYL_A[Math.floor(rnd() * SYL_A.length)] + SYL_B[Math.floor(rnd() * SYL_B.length)]
      + (rnd() < 0.45 ? '-' + ROMAN[1 + Math.floor(rnd() * (ROMAN.length - 1))] : '');

    // --- Gizem katmanı: ~%4 anomali ---------------------------------------
    const anomaly = rnd() < 0.04 ? ANOMALIES[Math.floor(rnd() * ANOMALIES.length)] : null;

    // --- Kısa anahtarlar (JSON boyutu: 4096 yıldız ~150KB, CDN'den cache'lenir) ---
    stars.push({
      i, n: name, x, y, c: cls.c, k: cls.k,
      p: Math.floor(rnd() * 9),                      // gezegen sayısı
      a: anomaly,                                     // anomali tipi veya null
      b: rnd() < 0.55 ? 1 + Math.floor(rnd() * 2) : 0, // asteroid kuşağı sayısı (0-2)
    });
  }
  return { seed, radius: GALAXY_RADIUS, count, stars };
}

// AI'A NOT: Server warp doğrulaması için haritayı bellekte bir kez üretir ve O(1) index tutar.
let _cache = null;
export function galaxy() {
  if (!_cache) {
    _cache = generateGalaxy();
    _cache.byId = new Map(_cache.stars.map(s => [s.i, s]));
    const destroyed = loadDestroyedStars();
    for (const id of destroyed) {
      const star = _cache.byId.get(id);
      if (star) star.a = 'SUPERNOVA';
    }
  }
  return _cache;
}
export function resetGalaxyCache() { _cache = null; }
export function starById(id) { return galaxy().byId.get(Number(id)) || null; }

// Bir yıldız sistemi için room kimliği: "s<starId>". Belt ayırt edilecekse "s<id>-b<n>".
export function roomIdForStar(starId) { return `s${starId}`; }
export function starIdFromRoom(roomId) { return Number(String(roomId).replace(/^s/, '').split('-')[0]); }
