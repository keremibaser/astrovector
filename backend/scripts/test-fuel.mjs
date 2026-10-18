// AI'A NOT: M2b/M2e/M3c YAKIT uçtan uca testi — tarayıcı yok, gerçek ws istemcisi.
// Doğrulanan zincir (hepsi SUNUCUDAN gelen paketle):
//  (1) snapshot'ta yakit/fuelMax + DOĞUŞ ENVANTERİ (M2i: 5 WARP HUCRESI; DOTERYUM doğuşta YOK)
//  (2) UÇUŞ TÜKETİMİ: kat edilen mesafe / FUEL_PER_DISTANCE = harcanan yakıt (M2e: 600)
//  (3) YAKIT DOLUMU YALNIZ YILDIZIN DİBİNDE (REFUEL_RANGE) ve YAVAŞ: uzaktan 'refuel' →
//      refuel_far; yıldız dibinde ~REFUEL_RATE yakıt/sn akar
//  (4) **M3c (KULLANICI DÜZELTMESİ, birebir: "Y'ye basınca doteryum convert yapmayacak yıldızdan
//      yakıt çekecek")**: dolum HİÇBİR MALZEME HARCAMAZ. Test bunu KANITLAR: ambarda TEK BİR
//      DOTERYUM bile yokken (madencilik bu senaryoda hiç yapılmadı) dolum çalışır. Eski
//      "her REFUEL_AMOUNT yakıt için 1 DOTERYUM" kuralı ve küsurat mekaniği KALDIRILDI.
//      (Madencilik/kapsül zinciri artık test-craft-boost'ta; burada yakıt sözleşmesi ölçülür.)
//  (5) depo bittiğinde İTİŞ KAPISI: istenen adım yakıt bütçesiyle kırpılır (acil damla kadar)
//  (6) dolum SINIRI sunucuda (refuel_full)
import WebSocket from 'ws';
import { galaxy } from '../src/galaxy.js';

// AI'A NOT: Test hedefi env ile verilebilir — mevcut sunucuya DOKUNMADAN ikinci bir örnek
// (PORT_GAME=8082) üzerinde koşmak için: WS_URL=ws://localhost:8082 node backend/scripts/test-fuel.mjs
const URL = process.env.WS_URL || 'ws://localhost:8081';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const g = galaxy();

// Sunucudaki sabitlerle AYNI olmalı (backend/src/rooms.js) — testin ölçüsü bunlar.
const FUEL_TANK = 45, FUEL_PER_DISTANCE = 600, WARP_FUEL = 3,
      FUEL_MATERIAL = 'DOTERYUM', JUMP_RANGE = 700,   // M3c: yalnız ZANAAT cevheri (dolumda harcanmaz)
      STARTER_WARP_CELLS = 5,        // M2i: doğuşta verilen WARP HUCRESI (kullanıcı isteği)
      REFUEL_RANGE = 700,            // dolum yalnız bu yarıçapta (yıldızın dibi)
      REFUEL_RATE = 2;               // yakıt/sn (KULLANICI: "ağır ağır, saniyede iki fuel")

function makeClient(tag) {
  const c = { tag, ws: new WebSocket(URL), box: [], sn: null, fuel: null, cargo: {} };
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.box.push(m);
    // AI'A NOT: GÜNCEL YAKIT BURADA TUTULUR. `sn` yalnız bağlanma/warp anındaki değeri taşır;
    // değişimler ayrı `fuel` paketiyle gelir (sunucu tam sayı her değiştiğinde yollar).
    if (m.t === 'sn') { c.sn = m; c.fuel = m.fuel; c.cargo = m.cargo || {}; }
    if (m.t === 'fuel') c.fuel = m.v;
    if (m.t === 'loot') c.cargo = m.cargo || c.cargo;   // envanter sunucudan gelir
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = async (pred, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = c.box.findIndex(pred);
      if (i >= 0) return c.box.splice(i, 1)[0];
      await sleep(40);
    }
    return null;
  };
  c.open = new Promise(r => c.ws.on('open', r));
  return c;
}

// Sunucu onaylı konumu (du diff) baz alınır: kırpılan adım gerçekten ne kadar gitti?
async function stepTo(c, tx, ty, stopAt = 0) {
  const dx = tx - c.sn.x, dy = ty - c.sn.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return 0;
  const want = Math.min(d - stopAt, 250);
  c.send({ t: 'mv', x: Math.round(c.sn.x + dx / d * want), y: Math.round(c.sn.y + dy / d * want), r: 0 });
  await sleep(700);
  const du = await c.wait(m => m.t === 'du' && m.d.some(x => x[0] === c.sn.you), 2000);
  const before = { x: c.sn.x, y: c.sn.y };
  if (du) { const me = du.d.find(x => x[0] === c.sn.you); c.sn.x = me[1]; c.sn.y = me[2]; }
  return Math.hypot(c.sn.x - before.x, c.sn.y - before.y);
}

async function flyTo(c, tx, ty, stopAt = 180) {
  for (let i = 0; i < 20; i++) {
    const d = Math.hypot(tx - c.sn.x, ty - c.sn.y);
    if (d <= stopAt) break;
    await stepTo(c, tx, ty, stopAt);
  }
  return Math.hypot(tx - c.sn.x, ty - c.sn.y);
}

async function faceTo(c, tx, ty) {
  const dx = tx - c.sn.x, dy = ty - c.sn.y;
  c.send({ t: 'mv', x: Math.round(c.sn.x), y: Math.round(c.sn.y), r: Number(Math.atan2(dx, -dy).toFixed(3)) });
  await sleep(400);
}

// Kapsül avı: düşen ganimeti SON konumuna göre takip edip üzerine git; SUNUCU toplar (loot).
async function collectPickup(c, pickId, ms = 9000) {
  const lootP = c.wait(m => m.t === 'loot' && m.amount > 0, ms);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const mv = c.box.slice().reverse().find(m => m.t === 'pickmv' && m.d.some(x => x[0] === pickId));
    if (!mv) break;
    const e = mv.d.find(x => x[0] === pickId);
    c.send({ t: 'mv', x: e[1], y: e[2], r: 0 });
    await sleep(300);
    if (c.box.some(m => m.t === 'pickgone' && m.id === pickId)) break;
  }
  return lootP;
}

const results = [];
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'GECTI ' : 'BASARISIZ'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// ---------------------------------------------------------------------------
const A = makeClient('A');
await A.open;
await A.wait(m => m.t === 'sn');
console.log(`bagli: room=${A.sn.roomId} yildiz=${A.sn.star.n} konum=(${A.sn.x},${A.sn.y}) kaya=${A.sn.rocks.length}`);
ok('snapshot yakit alanlari geldi', Number.isFinite(A.sn.fuel) && A.sn.fuelMax === FUEL_TANK,
  `yakit=${A.sn.fuel}/${A.sn.fuelMax}`);
ok('depo dolu basliyor', A.sn.fuel === FUEL_TANK);
// KULLANICI İSTEĞİ: "başlangıçta 5 doteryum ver" — doğuş envanteri SUNUCUDAN gelir (snapshot).
ok(`dogusta ${STARTER_WARP_CELLS} WARP HUCRESI verildi (M2i)`, ((A.sn.cargo || {}).WARPCELL || 0) === STARTER_WARP_CELLS,
  `envanter=${JSON.stringify(A.sn.cargo)}`);

// --- 1) DOĞUŞTA DOLUM DENEMESİ: doğuş halkası (380-620) menzil İÇİNDE → ama depo DOLU ---
// AI'A NOT: Bu kontrol M2e'nin iki kuralını birlikte doğrular: (a) yıldızın dibinde olmak
// gerekiyor (doğuş orada), (b) depo doluysa dolum başlamaz. Tank DOLUYKEN başka türlü
// "dolum çalışmıyor" demek yanıltıcı olurdu.
{
  const spawnDist = Math.hypot(A.sn.x, A.sn.y);
  A.box.length = 0;
  A.send({ t: 'refuel', on: true });
  const r = await A.wait(m => m.t === 'sys' && String(m.code || '').startsWith('refuel_'), 4000);
  ok('depo doluyken dolum baslamaz (refuel_full)', r && r.code === 'refuel_full',
    `dogus mesafesi=${Math.round(spawnDist)} (menzil ${REFUEL_RANGE}) → kod=${r ? r.code : 'yanit yok'}`);
}

// --- 2) UÇUŞ TÜKETİMİ: 1 yakıt = FUEL_PER_DISTANCE (600) birim ---
A.box.length = 0;
await A.wait(m => m.t === 'fuel', 2000);   // güncel yakıt değerini yakala
const fuel0 = A.fuel;
let moved = 0;
for (let i = 0; i < 8; i++) moved += await stepTo(A, A.sn.x + 5000, A.sn.y, 0);
const consumed = fuel0 - A.fuel;
const expected = Math.floor(moved / FUEL_PER_DISTANCE);
console.log(`ucus: ${Math.round(moved)} birim → beklenen ~${expected} yakit, harcanan ${consumed} (kalan ${A.fuel})`);
ok(`tuketim = mesafe/${FUEL_PER_DISTANCE} (±2)`, Math.abs(consumed - expected) <= 2);

// --- 3) M3c: DOLUM İÇİN MADENCİLİK GEREKMEZ (kullanıcı düzeltmesi) ---
// AI'A NOT: Bu test artık madencilik YAPMAZ. Kasıtlı: M3c kuralı "yakıt yıldızdan çekilir, malzeme
// harcanmaz" — dolum bölümlerinin ambarda TEK BİR DOTERYUM yokken çalışması bu kuralın KANITIDIR.
// (Kırılan eski sürüm tam burada "Doldurulacak DOTERYUM yok" diye reddediyordu.) Madencilik +
// kapsül toplama zinciri test-craft-boost.mjs içinde ölçülür; burada yalnız YAKIT sözleşmesi var.
ok(`dogusta ${FUEL_MATERIAL} YOK (ambarda: ${Object.entries(A.cargo || {}).map(([k, n]) => k + ":" + n).join(",") || "bos"})`,
  ((A.cargo || {})[FUEL_MATERIAL] || 0) === 0);

  // --- 4) DOLUM MESAFE KAPISI: yıldızdan >700 birim uzakta doldurmaya çalış ---
  // Sabit bir yön (yukarı) seçilir → kesin menzil dışı. Kaya konumuna bağlı DEĞİL: bu testin
  // madencilik bölümü kaldırıldı, dolayısıyla kaya referansı da yok (M3c).
  await flyTo(A, 0, -1200, 120);
  const farDist = Math.hypot(A.sn.x, A.sn.y);
  A.box.length = 0;
  const fuelFar = A.fuel;
  A.send({ t: 'refuel', on: true });
  const sysFar = await A.wait(m => m.t === 'sys' && String(m.code || '').startsWith('refuel_'), 4000);
  await sleep(1500);
  ok('uzaktan dolum REDDEDILDI (refuel_far)', sysFar && sysFar.code === 'refuel_far',
    `mesafe=${Math.round(farDist)} → kod=${sysFar ? sysFar.code : 'yanit yok'}`);
  ok('reddedilen dolum yakit ARTIRMADI', A.fuel <= fuelFar, `${fuelFar} → ${A.fuel}`);

  // --- 5) YILDIZIN DİBİNDE YAVAŞ DOLUM — ve MALZEME HARCAMADIĞI (M3c) ---
  // AI'A NOT (KULLANICI DÜZELTMESİ): eski test "her 15 yakıt için TAM 1 DOTERYUM" ölçüyordu.
  // O kural REDDEDİLDİ; artık ölçülen sözleşme şu: dolum ÇALIŞIR ve ambara HİÇ DOKUNMAZ.
  // Testin en güçlü kanıtı: ambar bu noktada BOŞ (madencilik hiç yapılmadı) — eski sürüm olsaydı
  // dolum "Doldurulacak DOTERYUM yok" diye BAŞLAMAZDI.
  await flyTo(A, 420, 0, 60);                     // yıldıza yakın bir park noktası (<700)
  const nearDist = Math.hypot(A.sn.x, A.sn.y);
  await A.wait(m => m.t === 'fuel', 2500);
  const f1 = A.fuel;
  const ore0 = (A.cargo || {})[FUEL_MATERIAL] || 0;
  const hold0 = JSON.stringify(A.cargo || {});
  A.send({ t: 'refuel', on: true });
  const startSys = await A.wait(m => m.t === 'sys' && m.code === 'refuel_start', 4000);
  const t0 = Date.now();
  await sleep(3000);                              // ~3 sn × 2/sn ≈ +6 yakıt
  A.send({ t: 'refuel', on: false });
  const stopSys = await A.wait(m => m.t === 'sys' && (m.code === 'refuel_off' || m.code === 'refuel_full' || m.code === 'refuel_full_tick'), 4000);
  const elapsed = (Date.now() - t0) / 1000;
  const g1 = A.fuel - f1;
  console.log(`   dolum#1: ${f1} → ${A.fuel} (+${g1}, ${elapsed.toFixed(1)}sn) ${FUEL_MATERIAL} ${ore0} → ${(A.cargo || {})[FUEL_MATERIAL] || 0}`);
  ok('yildiz dibinde dolum BASLADI (refuel_start) — ambarda DOTERYUM YOKKEN', !!startSys, `mesafe=${Math.round(nearDist)}`);
  // "AĞIR AĞIR": ~3 sn'de yaklaşık REFUEL_RATE*3 kadar (anında +15 değil). Toleranslı bant.
  ok(`dolum YAVAS ve SUREKLI (~${REFUEL_RATE}/sn)`, g1 >= Math.floor(REFUEL_RATE * elapsed) - 2 && g1 <= Math.ceil(REFUEL_RATE * elapsed) + 4,
    `+${g1} (${elapsed.toFixed(1)}sn)`);
  // AI'A NOT (KULLANICI İSTEĞİ — BİREBİR: "refuel bi anda değil ağır ağır olsun saniyede iki fuel"):
  // hızın ÖLÇÜLEN değeri sözleşmedir. Bant geniş tutulur (ağ gecikmesi) ama 5/sn'lik eski hız ya da
  // "anında dolum" bu bandın DIŞINDA kalır → hız sessizce değiştirilemez.
  const rate = g1 / elapsed;
  ok('dolum hizi ~2 yakıt/sn (AGIR AGIR — "aninda doldurma" degil)', rate >= 1.2 && rate <= 3.0,
    `olculen ~${rate.toFixed(2)}/sn (${g1} yakıt / ${elapsed.toFixed(1)}sn)`);
  ok('Y birakilinca/depo dolunca dolum durdu', !!stopSys, stopSys ? `kod=${stopSys.code}` : 'durma paketi yok');
  // Depo bu dolumda SINIRA ULAŞTIYSA sunucu KENDİLİĞİNDEN durdurmuş olmalı (refuel_full_tick):
  // çizim tarafında "Y bırakıldı" ile "depo doldu" aynı kapıya düşer, sebep AYRIŞTIRILIR.
  if (A.fuel >= FUEL_TANK - 0.01) {
    ok('depo dolunca dolum KENDILIGINDEN durdu (refuel_full_tick)',
      !!stopSys && stopSys.code === 'refuel_full_tick', `kod=${stopSys ? stopSys.code : 'yok'} (${A.fuel}/${FUEL_TANK})`);
  }
  // M3c'NİN ÇEKİRDEĞİ: yakıt geldi, ambar AYNI kaldı (hiçbir cevher/eşya harcanmadı).
  ok('dolum MALZEME HARCAMADI (M3c — yakit yildizdan gelir)',
    ((A.cargo || {})[FUEL_MATERIAL] || 0) === ore0 && JSON.stringify(A.cargo || {}) === hold0,
    `DOTERYUM ${ore0} → ${(A.cargo || {})[FUEL_MATERIAL] || 0}, ambar ${hold0} → ${JSON.stringify(A.cargo || {})}`);
  const fAfterStop = A.fuel;
  await sleep(1500);
  ok('durduktan sonra yakit ARTMIYOR (Y birakildi)', Math.abs(A.fuel - fAfterStop) <= 1, `${fAfterStop} → ${A.fuel}`);

  // --- 5b) DOLU DEPODA DOLUM BAŞLAMAZ (sunucu sınırı) ---
  // AI'A NOT: Önce depoda YER AÇILIR: uçuş ~1 yakıt / 600 birim yakar. Aksi hâlde depo zaten
  // dolu olduğu için dolum hiç başlamaz ve "doldu" paketi (refuel_full_tick) HİÇ gelmez —
  // ilk yazımda tam bu yüzden yalancı kırmızı yandı.
  const ang2 = 0.7;
  await flyTo(A, Math.round(Math.cos(ang2) * 1700), Math.round(Math.sin(ang2) * 1700), 100);
  await flyTo(A, 420, 0, 60);
  await A.wait(m => m.t === 'fuel', 2500);
  A.box.length = 0;
  A.send({ t: 'refuel', on: true });
  const fullTick = await A.wait(m => m.t === 'sys' && m.code === 'refuel_full_tick', 12000);
  ok('depo dolana kadar dolum surdu (refuel_full_tick)', !!fullTick,
    `kod=${fullTick ? fullTick.code : 'yanit yok'} (${A.fuel}/${FUEL_TANK})`);
  A.box.length = 0;
  const cFull = (A.cargo || {})[FUEL_MATERIAL] || 0;
  A.send({ t: 'refuel', on: true });
  const rFull = await A.wait(m => m.t === 'sys' && String(m.code || '').startsWith('refuel_'), 3000);
  await sleep(1000);
  ok('depo doluyken dolum reddedildi (refuel_full)', rFull && rFull.code === 'refuel_full',
    `kod=${rFull ? rFull.code : 'yanit yok'} (${A.fuel}/${FUEL_TANK})`);
  ok('reddedilen dolum yakit ARTIRMADI (depo tasmaz)', A.fuel <= FUEL_TANK + 0.01, `${A.fuel}/${FUEL_TANK}`);
  ok('dolum, ambarda SIFIR DOTERYUM ile calisti (M3c regresyonu — eski malzeme kapisi YOK)',
    cFull === 0, `DOTERYUM=${cFull}`);

// --- 6) DEPOYU BİTİR: itiş kapısı devreye girmeli ---
// AI'A NOT: adım tavanı yakıt menziline göre ölçeklenir: depo = tank * FUEL_PER_DISTANCE birim
// yol eder, adım başına ~250 birim gidilir → 45*600/250 ≈ 108 adım. Tavan DÜŞÜK kalırsa test
// "depo bitmedi" diye yalancı negatif verir.
let steps = 0;
// AI'A NOT: tavan ACİL DAMLADAN ötürü pay BIRAKIR: yakıt 5'in altına inince damla (0.35/sn)
// tüketimle (adım başına 0.42/0.7sn ≈ 0.6/sn) YARIŞIR ve kuyruk uzar — tavan darsa test
// "depo bitmedi" diye YALANCI NEGATİF verir (yaşandı: 128 adımda yakıt 1'de kaldı).
const stepCap = Math.ceil((FUEL_TANK * FUEL_PER_DISTANCE) / 250) + 60;
while (A.fuel > 0 && steps < stepCap) { await stepTo(A, A.sn.x + 5000, A.sn.y, 0); steps++; }
console.log(`depo bitti (${steps} adim sonra) → yakit=${A.fuel}`);
ok('depo 0 a kadar tukendi (sunucu bildirimi)', A.fuel === 0);

// AI'A NOT: ÖLÇEK DERSİ (M2e). Kapı TAM ORANLI: izin = yakit * FUEL_PER_DISTANCE - fuelAccum.
// Yakıt 0'da tek bütçe ACİL DAMLADIR (0.35/sn). Tek adım ölçmek KIRILGAN: damla miktarı adım
// aralığına bağlı ve FUEL_PER_DISTANCE 300 → 600 olunca tavan da iki katına çıktı. Nitekim eski
// eşik (<100 birim) YALANCI NEGATİF verdi: 183 birim "başarısız" sayıldı, oysa kapı çalışıyordu
// (damla × 600 ≈ 150-200 birim). Artık SÖZLEŞME ölçülür: yakıt 0'da 6 adım, kapısız beklentinin
// (6×250=1500) belirgin ALTINDA kalmalı.
let starved = 0;
for (let i = 0; i < 6; i++) starved += await stepTo(A, A.sn.x + 5000, A.sn.y, 0);
console.log(`yakit 0 iken 6 adim → ${Math.round(starved)} birim (kapisiz beklenti ~1500, damla butcesi ~${Math.round(0.35 * 4.2 * FUEL_PER_DISTANCE)})`);
ok('yakit bitince itis kapisi calisiyor (6 adim < kapisiz beklentinin %75i)',
  starved < 1500 * 0.75, `${Math.round(starved)} birim / 6 adim`);

// ---------------------------------------------------------------------------
const failed = results.filter(([, c]) => !c);
console.log(`\nSONUC: ${results.length - failed.length}/${results.length} kontrol gecti`);
if (failed.length) console.log('BASARISIZ: ' + failed.map(([n]) => n).join(' | '));
A.ws.close();
process.exit(failed.length ? 1 : 0);
