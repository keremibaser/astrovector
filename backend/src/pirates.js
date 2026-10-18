// ===========================================================================
// KORSAN SİSTEMLERİ (M2i)
// ===========================================================================
// AI'A NOT — KULLANICI İSTEĞİ (birebir): "korsanlar olsun, bazı yıldızlarda da korsan
// istasyonları. Ama öyle her yıldızda korsan olmasın yani."
//
// Tasarım kararları:
//  * Hangi yıldızda korsan olduğu DETERMINISTIK (seed + yıldız id) → hibernate/warp sonrası
//    dünya değişmez ve sunucu yeniden başlasa da aynı kalır (M1 galaksi sözleşmesi).
//  * Çoğu yıldız SAKİN. Ana sistem (oyuncunun doğduğu yer) HER ZAMAN güvenli: yeni oyuncu
//    doğar doğmaz korsan ateşi yemez (spawn kampı yok).
//  * İstasyon, korsan gemilerinin ÜREME MERKEZİDİR: yok edilirse korsan takviyesi durur.
//    Böylece "bölgeyi temizleme" oyunun içinde gerçek bir ilerleme olur.
import { GALAXY_SEED } from './galaxy.js';

const SALT = (GALAXY_SEED ^ 0x9e3779b9) >>> 0;
export const PIRATE_CHANCE = 34;    // yüzde: yıldızların ~%34'ünde korsan var (HER yıldızda DEĞİL)
export const STATION_CHANCE = 12;   // yüzde: korsan olan yıldızların bir kısmında İSTASYON

// Deterministik karma (Murmur3 finalizer): aynı yıldız → aynı değer, [0,1) aralığında DÜZGÜN dağılım.
// AI'A NOT (TUZAK — bu satırda bir kez yanıldık): xorshift sonunda `>>> 0` UNUTULURSA sonuç
// İŞARETLİ olur (-0.5..+0.5) ve `v*100 >= CHANCE` kapısı tersine döner: testin bulduğu gibi
// "yıldızların %52'sinde istasyon" gibi saçma bir dağılım çıkar. Hash fonksiyonları her zaman
// `>>> 0` ile kapatılır; dağılım TESTLE doğrulanır (bkz. test-pirates bölüm 1).
export function pirateHash(starId) {
  let h = (starId + 0x9e3779b9 + SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

// 0 = sakin sistem · 1 = korsan gemileri var · 2 = korsan İSTASYONU (gemi üretir)
export function pirateLevel(starId, safeStarId = -1) {
  if (starId === safeStarId) return 0;
  const a = pirateHash(starId);
  if (a * 100 >= PIRATE_CHANCE) return 0;
  return pirateHash(starId ^ 0x5bf03635) * 100 < STATION_CHANCE ? 2 : 1;
}

export const PIRATE_HULL = 70;          // korsan gövdesi (oyuncu 100)
export const PIRATE_SPEED = 132;        // yaklaşma hızı (oyuncu 220 — korsan daha yavaş)
export const PIRATE_RANGE = 340;        // ateş menzili (oyuncu 380: oyuncu daha avantajlı)
export const PIRATE_DMG = 9;            // vuruş hasarı (oyuncu 14)
export const PIRATE_COOLDOWN_MS = 1500; // ateş aralığı
export const PIRATE_STANDOFF = 200;     // bu mesafeden yakınsa geri durur (kucaklaşmaz)
export const PIRATE_ACTIVE = 2600;      // bu mesafeye kadar kovalar (sistem ölçeği), ötesinde devriye
export const NPC_CAP = 4;               // odada aynı anda en fazla korsan
export const STATION_HULL = 320;        // istasyon birkaç atışta yıkılmaz (sabır işi)
export const STATION_RADIUS = 44;       // istasyon gövde yarıçapı (isabet testi + çizim)
export const STATION_SPAWN_MS = 7000;   // istasyon varken takviye aralığı
export const NPC_SPAWN_MS = 12000;      // istasyonsuz korsan bölgesinde takviye aralığı
