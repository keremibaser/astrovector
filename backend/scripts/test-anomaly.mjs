// AI'A NOT: M4a ANOMALİ uçtan uca testi — tarayıcı yok, gerçek ws istemcisi, KENDİ sunucusunu açar.
//
// NEDEN VAR: Bu özellik "yazılmış ama çalışmayan" koddan ibaretti (handler'lar vardı, `room.anomaly`
// hiç oluşturulmuyordu, mesajlar dispatcher'a bağlı değildi). Test, o boşluğun GERİ GELMEMESİNİN
// bekçisidir: eksik katmanların her birini tek tek ölçer.
//
// Ölçülen zincir:
//  (1) SNAPSHOT: anomali nesnesi geliyor mu (kind/signal/konum) + KOD İSTEMCİYE GİTMİYOR mu
//      (sunucu otoriterliği: kod yalnız ipucu olarak, yalnız menzilde açılır)
//  (2) MENZİL KAPISI: uzaktan E taraması ve R çözme reddediliyor (anom_far)
//  (3) SİNYAL: E → frekans İPUCU (3 hane + '?'); ateşle yıkılmıyor (anom_signal)
//  (4) ÇÖZME MİNİ-OYUNU: yanlış hane → anom_wrong (kaç hane doğru bilgisi), ipucundan türetilen
//      kodla çözülüyor → anom_solved + ödül kapsülleri + odaya anons
//  (5) TEKRAR ÇÖZÜM reddi (anom_already)
//  (6) KALINTI: ateşle hp düşer (anomhp) → yıkılır (anomgone) + ganimet kapsülleri
//
// Koşum: node backend/scripts/test-anomaly.mjs
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { galaxy } from '../src/galaxy.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = galaxy();

const SIGNAL_KINDS = ['SILENT_BEACON', 'OBSCURED_SIGNAL'];
const LOOT_KINDS = ['RUIN', 'GRAVEYARD', 'DERELICT'];
const signalStar = g.stars.find((s) => SIGNAL_KINDS.includes(s.a));
const lootStar = g.stars.find((s) => LOOT_KINDS.includes(s.a));

let passed = 0, total = 0;
function check(desc, cond, extra = '') {
  total++;
  if (cond) { passed++; console.log(`GECTI   ${desc}${extra ? ' — ' + extra : ''}`); }
  else console.error(`HATA    ${desc}${extra ? ' — ' + extra : ''}`);
}

function makeClient(port) {
  const c = { ws: new WebSocket(`ws://localhost:${port}`), box: [], sn: null };
  c.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    c.box.push(m);
    if (m.t === 'sn') c.sn = m;
    // Konum SUNUCU ONAYLI diff'ten güncellenir (kırpılan adım gerçekten ne kadar gitti?).
    if (m.t === 'du' && c.sn) {
      const me = m.d.find((x) => x[0] === c.sn.you);
      if (me) { c.sn.x = me[1]; c.sn.y = me[2]; }
    }
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.take = (pred) => { const i = c.box.findIndex(pred); return i >= 0 ? c.box.splice(i, 1)[0] : null; };
  c.wait = async (pred, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = c.take(pred);
      if (hit) return hit;
      await sleep(40);
    }
    return null;
  };
  c.open = new Promise((r) => c.ws.on('open', r));
  return c;
}

// Anomaliye doğru uç (adım adım, sunucu hız kırpmasını bekleyerek).
async function flyTo(c, tx, ty, stopAt = 0) {
  for (let i = 0; i < 14; i++) {
    const dx = tx - c.sn.x, dy = ty - c.sn.y;
    const d = Math.hypot(dx, dy);
    if (d <= stopAt + 5) return d;
    const want = Math.min(d - stopAt, 250);
    c.send({ t: 'mv', x: Math.round(c.sn.x + (dx / d) * want), y: Math.round(c.sn.y + (dy / d) * want), r: 0 });
    await sleep(750);
  }
  return Math.hypot(tx - c.sn.x, ty - c.sn.y);
}

async function withServer(starId, portGame, portAdmin, fn) {
  const srv = spawn(process.execPath, [resolve(root, 'backend/server.js')], {
    env: {
      ...process.env, ADMIN_SECRET_KEY: 'test_anom_key',
      PORT_GAME: String(portGame), PORT_ADMIN: String(portAdmin),
      TEST_HOME_STAR: String(starId),
    },
    stdio: 'ignore',
  });
  await sleep(1600);
  try { await fn(); } finally { srv.kill(); await sleep(500); }
}

// ---------------------------------------------------------------------------
// A) SİNYAL ANOMALİSİ — keşif + ipucu + çözme mini-oyunu
// ---------------------------------------------------------------------------
if (!signalStar) {
  console.error('HATA: galakside sinyal anomalisi olan yıldız bulunamadı (galaxy.js değişti mi?)');
  process.exit(1);
}
console.log(`\n=== A) SINYAL: yildiz ${signalStar.i} (${signalStar.n}) anomali=${signalStar.a} ===`);

await withServer(signalStar.i, 8095, 8096, async () => {
  const A = makeClient(8095);
  await A.open;
  await sleep(400);
  // İKİNCİ OYUNCU: çözüm anonsu (anom_solved_all) ÇÖZENİ hariç tutar (sysAll excludeId) — anonsun
  // gerçekten odadaki DİĞER oyuncuya gittiğini ölçmek için ikinci bir istemci şart.
  const B2 = makeClient(8095);
  await B2.open;
  await sleep(300);

  const anom = A.sn && A.sn.anom;
  check('snapshot anomali nesnesi içeriyor', !!anom, anom ? `${anom.kind} @ (${anom.x},${anom.y})` : 'anom=null');
  check('anomali türü yıldızın `a` alanıyla aynı', anom && anom.kind === signalStar.a, anom && anom.kind);
  check('sinyal türü doğru işaretlenmiş (signal=true, hp=0)', anom && anom.signal === true && anom.hp === 0);
  check('KOD İSTEMCİYE GİTMİYOR (snapshot\'ta code/hint yok — sunucu otoriterliği)',
    anom && anom.code === undefined && anom.hint === undefined,
    anom ? Object.keys(anom).join(',') : '');
  check('anomali başlangıçta çözülmemiş', anom && anom.solved === false);

  // (2) MENZİL: spawn (380-620) ile anomali (900-1420) arası çoğu durumda menzil dışı.
  //     Uzaktan E → ipucu VERİLMEZ; uzaktan R → anom_far.
  const dist0 = Math.hypot(anom.x - A.sn.x, anom.y - A.sn.y);
  A.send({ t: 'scan_anom' });
  const near0 = dist0 <= 1200;
  const scanFar = await A.wait((m) => m.t === 'sys' && (m.code === 'anom_far' || m.code === 'anom_hint'), 2500);
  check(near0 ? 'doğuş konumu ipucu menzilinde → anom_hint alındı'
    : 'menzil dışında tarama reddedildi (anom_far)',
    near0 ? (scanFar && scanFar.code === 'anom_hint') : (scanFar && scanFar.code === 'anom_far'),
    `mesafe=${Math.round(dist0)} kod=${scanFar && scanFar.code}`);

  // (3) ANOMALİYE UÇ (400 birim içine)
  const distN = await flyTo(A, anom.x, anom.y, 400);
  check('anomaliye yaklaşıldı (solve menzili 450 içinde)', distN <= 460, `mesafe=${Math.round(distN)}`);

  // Yakında E → ipucu paketi (maskeli kod)
  A.send({ t: 'scan_anom' });
  const hintPkt = await A.wait((m) => m.t === 'anom_hint', 3000);
  check('yakında E taraması ipucu paketi döndürdü (anom_hint)', !!hintPkt,
    hintPkt ? `ipucu="${hintPkt.hint}"` : 'paket gelmedi');
  const hint = hintPkt && hintPkt.hint;
  check('ipucu MASKELİ (son hane gizli, 3 hane açık)', !!hint && hint.includes('?') && hint.split(' ').length === 4,
    hint || '');

  // (4) SİNYAL ATEŞLE YIKILMAZ — doğru yol söylenir (FIRE_RANGE=380, bu yüzden 250'ye kadar yaklaş)
  await flyTo(A, anom.x, anom.y, 250);
  const aim = Math.atan2(anom.x - A.sn.x, -(anom.y - A.sn.y));
  A.send({ t: 'fire', r: Number(aim.toFixed(3)) });
  const shot = await A.wait((m) => m.t === 'shot', 2500);
  const sigMsg = await A.wait((m) => m.t === 'sys' && m.code === 'anom_signal', 2500);
  check('sinyal anomali ateşle yıkılmıyor (anom_signal + hedef duruyor)',
    !!shot && shot.hk === 'anomaly' && !!sigMsg && A.sn.anom && A.sn.anom.solved === false,
    shot ? `hk=${shot.hk}` : 'atış paketi yok');

  // (5) ÇÖZME MİNİ-OYUNU: ipucundan türet, yanlış hanede "kaç hane doğru" bilgisi gelmeli
  const digits = hint.split(' ').slice(0, 3);
  const wrongLast = '0123456789'.split('').find((d) => `${digits.join('')}${d}` !== hint) || '0';
  A.send({ t: 'solve_anom', id: anom.id, code: `${digits.join('')}${wrongLast}` });
  const wrong = await A.wait((m) => m.t === 'sys' && m.code === 'anom_wrong', 3000);
  check('yanlış frekans reddedildi (anom_wrong)', !!wrong, wrong ? `p=${JSON.stringify(wrong.p)}` : '');
  check('yanlış denemede KAÇ HANE doğru bilgisi geldi (3 hane ipuçtan doğru)',
    wrong && wrong.p && wrong.p.ok === 3, wrong && wrong.p ? `ok=${wrong.p.ok}/4` : '');

  // İpucundaki 3 hane + 4. haneyi deneyerek çöz (testin tek başına çözebilmesi = ipucu YETERLİ)
  let solvedPkt = null, tries = 0;
  for (let d = 0; d <= 9 && !solvedPkt; d++) {
    tries++;
    A.send({ t: 'solve_anom', id: anom.id, code: `${digits.join('')}${d}` });
    solvedPkt = await A.wait((m) => m.t === 'anom_solved', 1200);
    if (!solvedPkt) await A.wait((m) => m.t === 'sys' && m.code === 'anom_wrong', 600);
  }
  check('ipucundan türetilen kodla sinyal ÇÖZÜLDÜ (anom_solved)', !!solvedPkt, `${tries} denemede`);
  const picks = A.box.filter((m) => m.t === 'pick');
  check('çözüm ödülü kapsülleri doğdu (>=3 pick paketi)', picks.length >= 3,
    picks.map((p) => p.ore).join(','));
  const allMsg = await B2.wait((m) => m.t === 'sys' && m.code === 'anom_solved_all', 4000);
  check('odaya çözüm anonsu gitti (anom_solved_all → DİĞER oyuncuya)',
    !!allMsg, allMsg ? `p=${JSON.stringify(allMsg.p)}` : 'anons gelmedi');
  const solvedBcast = !!(await B2.wait((m) => m.t === 'anom_solved', 1500));
  check('çözüm olayı odadaki diğer istemciye yayınlandı (anom_solved)', solvedBcast);

  // (6) TEKRAR ÇÖZÜM
  A.send({ t: 'solve_anom', id: anom.id, code: 1111 });
  const again = await A.wait((m) => m.t === 'sys' && m.code === 'anom_already', 2500);
  check('çözülmüş sinyal tekrar çözülemiyor (anom_already)', !!again);
  A.ws.close();
  B2.ws.close();
});

// ---------------------------------------------------------------------------
// B) KALINTI ANOMALİSİ — ateşle yağma
// ---------------------------------------------------------------------------
if (!lootStar) {
  console.error('HATA: galakside kalıntı anomalisi olan yıldız bulunamadı');
  process.exit(1);
}
console.log(`\n=== B) KALINTI: yildiz ${lootStar.i} (${lootStar.n}) anomali=${lootStar.a} ===`);

await withServer(lootStar.i, 8097, 8098, async () => {
  const B = makeClient(8097);
  await B.open;
  await sleep(400);
  const anom = B.sn && B.sn.anom;
  check('kalıntı anomali snapshot\'ta (signal=false, hp>0)',
    !!anom && anom.signal === false && anom.hp > 0, anom ? `${anom.kind} hp=${anom.hp}/${anom.max}` : 'yok');
  if (!anom) return;

  const dist = await flyTo(B, anom.x, anom.y, 220);
  check('kalıntıya yaklaşıldı', dist <= 260, `mesafe=${Math.round(dist)}`);

  const aim = Math.atan2(anom.x - B.sn.x, -(anom.y - B.sn.y));
  let gone = null;
  for (let i = 0; i < 4 && !gone; i++) {
    B.send({ t: 'fire', r: Number(aim.toFixed(3)) });
    await sleep(700);
    gone = B.take((m) => m.t === 'anomgone');
  }
  const hpPkt = B.box.find((m) => m.t === 'anomhp');
  check('ateş kalıntıya hasar verdi (anomhp paketi)', !!hpPkt, hpPkt ? `${hpPkt.hp}/${hpPkt.max}` : 'paket yok');
  check('kalıntı yıkıldı (anomgone)', !!gone, gone ? `why=${gone.why}` : 'yıkılmadı');
  const orePicks = B.box.filter((m) => m.t === 'pick');
  check('yıkılan kalıntıdan ganimet düştü (>=4 kapsül)', orePicks.length >= 4,
    orePicks.map((p) => p.ore).join(','));
  const lootMsg = await B.wait((m) => m.t === 'sys' && m.code === 'anom_looted', 2500);
  check('yağma bildirimi geldi (anom_looted)', !!lootMsg);
  B.ws.close();
});

console.log(`\nSONUC: ${passed}/${total} anomali kontrolu gecti`);
process.exit(passed === total ? 0 : 1);
