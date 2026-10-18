// AI'A NOT: M2 UÇTAN UCA TESTİ — tarayıcı yok, iki gerçek ws istemcisi (A ve B).
// Doğrulanan zincir: (1) kaya madenciliği → rockhp → rockgone → LOOT (2) PvP → dmg → boom →
// ölüm + ana sisteme KURTARMA (yeni snapshot, tamir) (3) atış cooldown'ı (spam tek isabet eder)
// (3b) M3d KALKAN REGEN: saldırıdan sonra GECİKME boyunca kalkan dolmaz, sonra kendiliğinden dolar
// (gövde dolmaz) (4) tractor beam → kaya oyuncuya doğru çekilir (rockmv).
// Bu test "gördüm sanırım" demez: her adımda SUNUCUDAN gelen paketi bekler ve doğrular.
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://localhost:8081';   // WS_URL ile başka bir örneğe yönlendirilebilir
// Sunucudaki sabitlerle AYNI olmalı (backend/src/rooms.js) — testin ölçüsü bunlar.
const SHIELD_REGEN_DELAY_MS = 5000, SHIELD_REGEN_RATE = 6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient(tag) {
  const c = { tag, ws: new WebSocket(URL), box: [], sn: null, shield: 100, hull: 100, shPackets: 0 };
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.box.push(m);
    if (m.t === 'sn') c.sn = m;
    // M3d: kalkan/gövde durumu istemcide TAKİP edilir — regen testi bu değerleri ölçer.
    // (Hasar `dmg`, kendiliğinden dolum `sh` paketiyle gelir.)
    if (m.t === 'dmg' && c.sn && m.id === c.sn.you) { c.shield = m.shield; c.hull = m.hull; }
    if (m.t === 'sh') { c.shield = m.v; c.shPackets++; }
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

// Sunucu hız doğrulaması yapar (MAX_SPEED*dt): hedefe VARANA dek kırpılmış adımlarla uç.
// AI'A NOT: Hedefe TAM ÜSTÜNE varmayız — durma mesafesi `stopAt` kadar boşluk bırakır.
// (Tam üst üste binmek ateş geometrisini bozar; sunucu tarafında da point-blank koruması var.)
async function flyTo(c, tx, ty, stopAt = 150) {
  for (let i = 0; i < 16; i++) {
    const dx = tx - c.sn.x, dy = ty - c.sn.y;
    const d = Math.hypot(dx, dy);
    if (d <= stopAt) break;
    const step = Math.max(20, Math.min(d - stopAt, 250));
    c.send({ t: 'mv', x: Math.round(c.sn.x + dx / d * step), y: Math.round(c.sn.y + dy / d * step), r: 0 });
    await sleep(700);
    // AI'A NOT: Her adımda SUNUCUNUN onayladığı konumu (diff) baz al. Kırpılma/zamanlama
    // farkı birikirse "vardım sanırım" yanılgısı oluşur ve atış menzil dışına düşer.
    const du = await c.wait(m => m.t === 'du' && m.d.some(x => x[0] === c.sn.you), 2000);
    if (du) { const me = du.d.find(x => x[0] === c.sn.you); c.sn.x = me[1]; c.sn.y = me[2]; }
  }
  return Math.hypot(tx - c.sn.x, ty - c.sn.y) <= stopAt + 40;
}

// Gemiyi hedefe ÇEVİR: ileri vektör = (sin r, -cos r) → r = atan2(dx, -dy)
async function faceTo(c, tx, ty) {
  const dx = tx - c.sn.x, dy = ty - c.sn.y;
  c.send({ t: 'mv', x: Math.round(c.sn.x), y: Math.round(c.sn.y), r: Number(Math.atan2(dx, -dy).toFixed(3)) });
  await sleep(400);
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
const homeRoom = A.sn.roomId;
console.log(`A bagli: room=${homeRoom} konum=(${A.sn.x},${A.sn.y}) kaya=${A.sn.rocks.length} envanter=${JSON.stringify(A.sn.cargo)}`);
ok('snapshot geldi + cargo alani var', A.sn.cargo !== undefined);
ok('jumpRange sunucudan geldi', A.sn.jumpRange === 700);

// --- 1) MADENCİLİK: en yakın kayaya git, ateş et, kır, ganimet al ---
let rock = null, bestD = Infinity;
for (const r of A.sn.rocks) {
  const d = Math.hypot(r[1] - A.sn.x, r[2] - A.sn.y);
  if (d < bestD) { bestD = d; rock = r; }
}
console.log(`hedef kaya: id=${rock[0]} boyut=${rock[3]} hp=${rock[4]} ore=${rock[5]} mesafe=${Math.round(bestD)}`);
await flyTo(A, rock[1], rock[2], 200);
console.log(`   A kayaya ulasti: (${A.sn.x},${A.sn.y}) mesafe=${Math.round(Math.hypot(rock[1] - A.sn.x, rock[2] - A.sn.y))}`);
await faceTo(A, rock[1], rock[2]);

// AI'A NOT: M2e — KAYA KIRILINCA GANİMET ANINDA ENVANTERE GİRMEZ. Uzaya bir KAPSÜL düşer
// ('pick' paketi); oyuncunun ÜZERİNE GİTMESİ ya da tractor ile çekmesi gerekir (kullanıcı
// isteği: "düşen item önce uzaya düşecek biz gidip gemiyle toplayacaz"). Test bunu uçtan uca
// doğrular: kır → kapsül düştü → kapsüle uç → TEMAS ile envantere girdi.
const pickP = A.wait(m => m.t === 'pick', 8000);
let shots = 0, gone = false;
// AI'A NOT: paketler ODAYA yayınlanır — başka bir istemci (ör. açık tarayıcı sekmesi) aynı
// odada ateş edip kaya kırarsa, id FİLTRESİ olmadan döngü yanlış kayayı "kırıldı" sayar.
const rId = rock[0];
for (let i = 0; i < 6 && !gone; i++) {
  A.send({ t: 'fire' });
  shots++;
  const hp = await A.wait(m => (m.t === 'rockhp' && m.id === rId) || (m.t === 'rockgone' && m.id === rId), 1500);
  if (hp && hp.t === 'rockgone') gone = true;
  await sleep(300);   // cooldown
}
const pick = await pickP;
ok('kaya kirildi (rockgone)', gone, `${shots} atis`);
ok('ganimet UZAYA DUSTU (pick paketi)', !!pick,
  pick ? `${pick.id} ${pick.ore} x${pick.amount} @ (${pick.x},${pick.y})` : 'kapsul paketi gelmedi');

// Kapsül süzülür (drift) → hedefin SON konumunu paketlerden takip et ve üzerine git.
let loot = null;
if (pick) {
  const lootP = A.wait(m => m.t === 'loot' && m.ore === pick.ore, 8000);
  await flyTo(A, pick.x, pick.y, 90);
  let px = pick.x, py = pick.y;
  for (let i = 0; i < 8; i++) {
    const mv = A.box.slice().reverse().find(m => m.t === 'pickmv' && m.d.some(x => x[0] === pick.id));
    if (mv) { const e = mv.d.find(x => x[0] === pick.id); px = e[1]; py = e[2]; }
    A.send({ t: 'mv', x: px, y: py, r: 0 });
    await sleep(320);
    if (A.box.some(m => m.t === 'pickgone' && m.id === pick.id)) break;
  }
  loot = await lootP;
}
ok('kapsül TEMASLA toplandi (loot)', !!(loot && loot.amount > 0),
  loot ? `+${loot.amount} ${loot.ore} → ${JSON.stringify(loot.cargo)}` : 'envantere girmedi');

// --- 2) COOLDOWN: art arda 3 atış → yalnız 1 'shot' paketi ---
A.box.length = 0;
A.send({ t: 'fire' }); A.send({ t: 'fire' }); A.send({ t: 'fire' });
await sleep(700);
const shotCount = A.box.filter(m => m.t === 'shot' && m.id === A.sn.you).length;
ok('atis cooldown calisiyor (3 spam → 1 isabet)', shotCount === 1, `${shotCount} paket`);

// --- 3) PvP: B baglan, A ona ates etsin -> dmg ... boom -> B ana sisteme doner ---
const B = makeClient('B');
await B.open;
await B.wait(m => m.t === 'sn');
console.log(`B bagli: room=${B.sn.roomId} konum=(${B.sn.x},${B.sn.y})`);
ok('B ayni ana sistemde dogdu', B.sn.roomId === homeRoom);

// A, B'nin yanina uçup ona doner
B.send({ t: 'mv', x: B.sn.x, y: B.sn.y, r: 0 });
await sleep(200);
await flyTo(A, B.sn.x, B.sn.y, 140);
console.log(`   A B ye yaklasti: (${A.sn.x},${A.sn.y}) mesafe=${Math.round(Math.hypot(B.sn.x - A.sn.x, B.sn.y - A.sn.y))}`);
await faceTo(A, B.sn.x, B.sn.y);
A.box.length = 0; B.box.length = 0;

let firstDmg = null, boom = null, deathSnap = null, hks = [];
// AI'A NOT: 100 kalkan + 100 gövde = 200 hp; vuruş 14 → ~15 isabet gerekir. M3d'DEN SONRA bu
// hesap SADELEŞTİ: kalkan artık savaş sırasında DOLMUYOR (her hasar 5 sn'lik regen sayacını
// sıfırlar) → turlar arası "kalkan geri geldi" yarışı yok, hasar gerçekten BİRİKİR.
// (Öncesinde kalkan 6/sn dolarak hasarın yarısını siliyordu ve ölüm ~29 tur sürüyordu; testin
// tavanı bu yüzden 50'ye çıkarılmıştı. Tavan, savaşın uzamasına karşı koruma olarak duruyor.)
// AYRICA: `boom` ve `dmg` ODAYA yayınlanır — başka bir istemci aynı odada ölürse yanlış
// patlama döngüyü erken bitirir ve test yalancı negatif verir. Bu yüzden hedef ID'ye göre
// filtreliyoruz (B.sn.you = B'nin kendi id'si).
const bId = B.sn.you;
for (let i = 0; i < 50 && !boom; i++) {
  A.send({ t: 'fire' });
  const s = await A.wait(m => m.t === 'shot', 1200);
  if (s) hks.push(s.hk);
  const d = await B.wait(m => m.t === 'dmg' && m.id === bId, 1200);
  if (d && !firstDmg) firstDmg = d;
  // AI'A NOT: TEŞHİS SATIRI — hasar birikimi ve kalkan yenilenmesi yarışını GÖRÜNÜR yapar.
  // (Kalkan 6/sn yenilenir; atış başına 14 vurur. Tempo yavaşsa hasar birikir ama asla bitmez.)
  console.log(`   atis ${String(i + 1).padStart(2)}: hk=${s ? s.hk : 'yok'}  dmg=${d ? `${d.dmg} → ${d.shield}/${d.hull}` : 'paket yok'}`);
  boom = await B.wait(m => m.t === 'boom' && m.id === bId, 900);
  await sleep(180);
}
console.log(`   isabet sonuclari: ${hks.join(',') || '(atis yok)'}`);
ok('PvP hasar paketi geldi (dmg)', !!firstDmg,
  firstDmg ? `-${firstDmg.dmg} → kalkan ${firstDmg.shield} govde ${firstDmg.hull} (konum alani var: ${firstDmg.x !== undefined})` : '');
ok('hedef yok edildi (boom)', !!boom);
// Ölüm sonrası: B yeni snapshot almalı (kurtarma → ana sistem, tamir)
deathSnap = await B.wait(m => m.t === 'sn', 5000);
ok('olum sonrasi yeni snapshot (kurtarma)', !!deathSnap,
  deathSnap ? `room=${deathSnap.roomId} konum=(${deathSnap.x},${deathSnap.y}) kalkan=${deathSnap.shield} govde=${deathSnap.hull}` : 'snapshot yok');
if (deathSnap) {
  console.log(`   kurtarma: room=${deathSnap.roomId}`);
  ok('kurtarma ana sisteme yapti', deathSnap.roomId === homeRoom);
  ok('kurtarma sonrasi tamir (kalkan+govde 100)', deathSnap.shield === 100 && deathSnap.hull === 100);
}
ok('olduren kill bildirimi aldi', !!(await A.wait(m => m.t === 'sys' && m.code === 'kill', 1500)));

// --- 3b) M3d: KALKAN (GEMI ENERJISI) SALDIRIDAN SONRA KENDILIGINDEN DOLAR ---
// Kullanıcı isteği (birebir): "geminin enerjisi kendi kendine dolsun saldırıya uğradıktan bir süre
// sonra". Sözleşme: son hasardan sonra SHIELD_REGEN_DELAY_MS boyunca kalkan DOLMAZ; süre geçince
// dolmaya başlar. Gövde (hull) ASLA kendiliğinden dolmaz — onun yolu TAMIR SETI (H).
// Hedef B'dir: ölümden yeni döndü (kalkan/gövde 100, ana sistem) ve A yanındadır.
await flyTo(A, B.sn.x, B.sn.y, 140);
await faceTo(A, B.sn.x, B.sn.y);
B.box.length = 0;
let shieldBroke = false;
for (let i = 0; i < 20 && !shieldBroke; i++) {           // kalkanı gövdeye TAŞANA kadar vur
  A.send({ t: 'fire' });
  await A.wait(m => m.t === 'shot', 1200);
  await B.wait(m => m.t === 'dmg' && m.id === B.sn.you, 1200);
  shieldBroke = B.hull < 100;
  await sleep(180);
}
const sHit = B.shield, hHit = B.hull;
console.log(`   kalkan kirildi: kalkan=${sHit} govde=${hHit} (${B.shPackets} sh paketi)`);
ok('kalkan govdeye tasacak kadar hasar aldi (test kurulumu)', hHit < 100, `govde=${hHit}`);
await sleep(3600);                                       // gecikme penceresi (5 sn'den kısa)
const sDelay = B.shield;
ok('saldiri sonrasi GECIKME boyunca kalkan DOLMADI', sDelay <= sHit + 0.01,
  `kirilma ${sHit} → 3.6 sn sonra ${sDelay} (gecikme ${SHIELD_REGEN_DELAY_MS} ms)`);
const shBefore = B.shPackets;
await sleep(3000);                                       // gecikme bitti → regen penceresi
const sAfter = B.shield;
ok('gecikme sonrasi kalkan KENDILIGINDEN doldu', sAfter > sDelay + 1,
  `${sDelay} → ${sAfter} (~${SHIELD_REGEN_RATE}/sn)`);
ok('dolum SUNUCUDAN `sh` paketiyle bildirildi', B.shPackets > shBefore, `sh paketi ${shBefore} → ${B.shPackets}`);
ok('govde (hull) KENDILIGINDEN DOLMADI (yalniz TAMIR SETI ile)', B.hull === hHit, `govde ${hHit} → ${B.hull}`);

// --- 4) TRACTOR BEAM: B en yakin kayayi ceksin, kaya hareket etmeli ---
const rockB = B.sn.rocks[0];
B.send({ t: 'mv', x: rockB[1] - 200, y: rockB[2], r: 0 });
await sleep(900);
B.box.length = 0;
B.send({ t: 'tb', on: true, tid: rockB[0] });
const mv = await B.wait(m => m.t === 'rockmv', 3000);
ok('tractor beam kayayi cekiyor (rockmv)', !!mv, mv ? `${rockB[0]} → (${mv.d[0][1]},${mv.d[0][2]})` : 'hareket paketi yok');

// ---------------------------------------------------------------------------
const failed = results.filter(([, c]) => !c);
console.log(`\nSONUC: ${results.length - failed.length}/${results.length} kontrol gecti`);
if (failed.length) console.log('BASARISIZ: ' + failed.map(([n]) => n).join(' | '));
A.ws.close(); B.ws.close();
process.exit(failed.length ? 1 : 0);
