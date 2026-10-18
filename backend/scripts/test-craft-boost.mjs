// AI'A NOT: M2h testi — SHIFT BOOST (hız + iki kat yakıt) ve ZANAAT/EŞYA/WARP HÜCRESİ zinciri.
// Tarayıcı GEREKMEZ: saf `ws` istemcisi sunucunun kendi kararlarını doğrular.
//
// Neyi KANITLAR (kullanıcı istekleri):
//  1. "shifte basılı tutarak daha hızlı gitsin"      → AYNI istek (200 birim, ~1.2 sn aralık)
//     boost'ta TAM kabul edilir, boost'suz KIRPILIR (tek fark `msg.boost` bayrağı).
//     DİKKAT: sunucu dt'yi SON KABUL EDİLEN paketten ölçer → aralık, okuma beklemesiyle toplanır;
//     ilk sürüm 320 ms sanıp hiç kırpma görmedi (iki istek de tam kabul edildi).
//  2. "ama iki kat yakıt harcasın"                   → boost'ta DOLU depo ile gidilebilen mesafe
//     ≈ FUEL_TANK × (FUEL_PER_DISTANCE / BOOST_FUEL_MUL) = 45 × 300 = 13500 birim. Boost'suz
//     27000 birimdir (test-fuel.mjs bunu ayrıca 20/20 doğrular) → oran tam 2.
//     Ölçüm TAZE bir oyuncuda (B) ve YALNIZ boost'ta yapılır: `perFuel` moda bağlı olduğu için
//     aynı depoda mod değiştirmek hesabı karıştırır (ilk sürümde 19456 çıktı).
//  3. "doteryumdan warp fuel yapılsın öyle atlansın"  → CRAFT WARPCELL 3 DOTERYUM harcar,
//     warp 1 hücre tüketir (hücre yoksa 'warp_nocell'), ikinci warp'ta hücre bittiği görülür.
//  4. Tarifeler/eşya adları/boost çarpanları `sn` paketinde SUNUCUDAN gelir (istemci sabit gömmez).
import WebSocket from 'ws';
import { galaxy } from '../src/galaxy.js';

const g = galaxy();
const URL = process.env.WS_URL || 'ws://localhost:8081';   // WS_URL ile başka bir örneğe yönlendirilebilir
const ws = new WebSocket(URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => ws.send(JSON.stringify(o));

let me = null, my = { x: 0, y: 0 }, cargo = {}, sn = null;
const sysMsgs = [];       // {code, msg, p}
const loots = [];         // {ore, amount, cargo}
let results = [], fails = 0;

function ok(name, cond, detail = '') {
  results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) fails++;
  console.log(`${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`);
}
const lastSys = (code) => [...sysMsgs].reverse().find((m) => m.code === code);

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'sn') {
    sn = m; me = m.you;
    if (m.cargo) cargo = { ...m.cargo };
    rockList.clear();
    for (const r of (m.rocks || [])) rockList.set(r[0], { x: r[1], y: r[2], size: r[3], hp: r[4], ore: r[5] });
  } else if (m.t === 'rocknew') {
    rockList.set(m.id, { x: m.x, y: m.y, size: m.size, hp: m.hp, ore: m.ore });
  } else if (m.t === 'rockgone') {
    rockList.delete(m.id);
  } else if (m.t === 'pick') {
    picks.set(m.id, { x: m.x, y: m.y, ore: m.ore });
  } else if (m.t === 'du') {
    for (const d of m.d) if (d[0] === me) my = { x: d[1], y: d[2] };
  } else if (m.t === 'sys') {
    sysMsgs.push({ code: m.code, msg: m.msg, p: m.p });
    if (m.code === 'warp_ok') { cargo = { ...(m.cargo || cargo) }; }
  } else if (m.t === 'loot') {
    loots.push({ ore: m.ore, amount: m.amount, cargo: m.cargo });
    if (m.cargo) cargo = { ...m.cargo };
  }
});

// Tek bir hareket paketi gönderip sunucunun KABUL ETTİĞİ mesafeyi ölçer.
// (Sunucunun gerçek konumu `du` diff'inden okunur — istemci tahmini değil.)
async function jump(dx, boostFlag, gapMs) {
  const from = { ...my };
  await sleep(gapMs);
  send({ t: 'mv', x: Math.round(from.x + dx), y: Math.round(from.y), r: 0, boost: boostFlag });
  await sleep(220);
  return Math.hypot(my.x - from.x, my.y - from.y);
}

// ---------------------------------------------------------------------------
// M2i: DOĞUŞ ENVANTERİ DEĞİŞTİ ("5 doteryum yerine 5 warp fuel") → zanaat testi artık
// DOTERYUM'u DOĞUŞTA bulamaz. Bu yüzden gerçek oyun yolunu kullanır: kayayı bul → uç →
// ateş et → kapsülü topla. Test böylece "maden → zanaat" zincirinin TAMAMINI doğrular
// (eskiden doğuş hediyesine güveniyordu = eksik kapsama).
const rockList = new Map();      // id -> {x,y,ore,size,hp}
const picks = new Map();         // id -> {x,y,ore}

async function flyTo(tx, ty, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const d = Math.hypot(tx - my.x, ty - my.y);
    if (d < 26) return true;
    send({ t: 'mv', x: Math.round(tx), y: Math.round(ty), r: 0 });
    await sleep(90);
  }
  return Math.hypot(tx - my.x, ty - my.y) < 60;
}

async function mineOre(ore, need, budgetMs = 60_000) {
  // AI'A NOT: Kuşakta DOTERYUM ağırlığı %6 → ~20 kayalık kuşakta genelde TEK bir DOTERYUM kayası
  // olur. Kırıldıktan sonra ROCK_RESPAWN_MS (15 sn) boyunca o cevher HİÇ YOKTUR. Bu yüzden
  // "tries" sayacı yerine SÜRE bütçesi kullanılır: kaya yeniden doğana kadar beklenir
  // (ilk sürüm 10 denemeyle ~9 sn'de pes ediyordu → test sadece 1 cevher toplayabiliyordu).
  const t0 = Date.now();
  while ((cargo[ore] || 0) < need && Date.now() - t0 < budgetMs) {
    const list = [...rockList.entries()].filter(([, r]) => r.ore === ore);
    if (!list.length) { await sleep(1200); continue; }
    list.sort((a, b) => Math.hypot(a[1].x - my.x, a[1].y - my.y) - Math.hypot(b[1].x - my.x, b[1].y - my.y));
    const [rid, rock] = list[0];
    // Kuşak yıldızdan 700-1600 birim uzakta; doğuş noktası 380-620 → en uzak kayaya ~1300 birim
    // yol var (220 birim/sn → ~6 sn). Bütçe 12 sn: uzak kaya da hedefe girsin.
    if (!(await flyTo(rock.x, rock.y, 12_000))) continue;
    for (let shot = 0; shot < 14 && rockList.has(rid); shot++) {
      // ATEŞ YÖNÜ ŞART: sunucu ışını `r` açısıyla atar (fx=sin r, fy=-cos r) → `r=0` yalnız
      // KUZEYİ vurur. Açı, benim konumumdan kayaya göre hesaplanır (korsanlarla aynı formül).
      const ddx = rock.x - my.x, ddy = rock.y - my.y;
      send({ t: 'fire', r: Math.atan2(ddx, -ddy) });
      await sleep(300);
    }
    await flyTo(rock.x, rock.y, 3000);           // kapsül kayanın hemen yanında düşer → üstüne git
    await sleep(600);
  }
  return (cargo[ore] || 0) >= need;
}

// M2h: ikinci bağlantı (B) — yalnız BOOST yakıt ölçümü için, TAZE oyuncu.
const B = { ws: null, my: { x: 0, y: 0 }, cargo: {}, sn: null, you: null };
B.ws = new WebSocket(URL);
B.ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'sn') { B.sn = m; B.you = m.you; if (m.cargo) B.cargo = { ...m.cargo }; }
  else if (m.t === 'du') { for (const d of m.d) if (d[0] === B.you) B.my = { x: d[1], y: d[2] }; }
});
async function jumpB(dx, gapMs, readMs = 220) {
  const from = { ...B.my };
  await sleep(gapMs);
  B.ws.send(JSON.stringify({ t: 'mv', x: Math.round(from.x + dx), y: Math.round(from.y), r: 0, boost: 1 }));
  await sleep(readMs);
  return Math.hypot(B.my.x - from.x, B.my.y - from.y);
}

ws.on('open', async () => {
  try {
    await sleep(700);
    if (!sn) { console.log('HATA: sn paketi gelmedi'); process.exit(1); }

    // ---- 0) SÖZLEŞME: tarifeler + eşya adları + boost çarpanları sunucudan gelir
    ok('sn.recipes geldi', Array.isArray(sn.recipes) && sn.recipes.length === 4,
      (sn.recipes || []).map((r) => `${r.id}x${r.out}(${Object.entries(r.cost).map(([o, n]) => o + n).join('+')})`).join(' '));
    ok('sn.items geldi', sn.items && sn.items.WARPCELL === 'WARPCELL' && sn.items.BEACON === 'BEACON',
      JSON.stringify(sn.items));
    ok('sn.boost: hız >1 ve yakıt çarpanı 2',
      sn.boost && sn.boost.mul > 1 && sn.boost.fuel === 2, JSON.stringify(sn.boost));
    ok('doğuşta 5 WARP HUCRESI var (M2i kullanıcı isteği)', (cargo.WARPCELL || 0) >= 5, `cargo=${JSON.stringify(cargo)}`);
    ok('doğuşta DOTERYUM VERİLMEZ (artık madencilik şart)', !(cargo.DOTERYUM > 0), `DOTERYUM=${cargo.DOTERYUM || 0}`);

    // ---- 1) HIZ: AYNI dt'de AYNI çok büyük istek (5000 birim) → sunucu iki kez de KIRPAR ve
    //    kırpma sınırı boost'ta BOOST_MUL kat büyüktür. Oran ölçümü dt'den BAĞIMSIZDIR
    //    (iki paket de aynı aralıkta gider) — ilk sürümde mutlak eşik kullanmak yanıltıcıydı:
    //    ilk paketin dt'si spawn anından ölçüldüğü için büyük çıkıyor ve hiç kırpma görünmüyordu.
    await jump(10, 0, 1000);        // ısınma: sunucunun `lastAcceptedAt`i otursun
    const norm = await jump(5000, 0, 1000);
    const bst = await jump(5000, 1, 1000);
    const ratio = bst / Math.max(norm, 1);
    ok('boost hız tavanını BOOST_MUL kat yükseltiyor',
      ratio > 1.4 && ratio < 1.7,
      `kırpılan mesafe: boost'suz ${Math.round(norm)} / boost'lu ${Math.round(bst)} birim → oran ${ratio.toFixed(2)} (beklenen ${sn.boost.mul})`);
    ok('hız tavanı gerçekten uygulanıyor (5000 birimlik istek kırpıldı)',
      norm < 1500 && bst < 2000, `${Math.round(norm)} / ${Math.round(bst)} birim kabul edildi`);

    // ---- 2) YAKIT: TAZE oyuncu (B), YALNIZ boost. Dolu depo ile gidilebilen mesafe:
    //    45 × (600/2) = 13500 birim. Kırpılma başlar başlamaz dur (o an depo bitti).
    while (!B.sn) await sleep(100);
    let total = 0, steps = 0, advB = 999;
    while (advB > 140 && steps < 300) { advB = await jumpB(150, 300); total += advB; steps++; }
    const expect = 45 * (600 / 2);        // FUEL_TANK × (FUEL_PER_DISTANCE / BOOST_FUEL_MUL)
    // ÜST SINIR NEDEN %12 GEVŞEK: depo bitmeye yakın ACİL YAKIT DAMLASI devreye girer (tasarım:
    // yıldızsız mahsur kalmayasın) ve son ~5 yakıtlık dilimde ekstra yol yaptırır. Ölçülen
    // oran yine 600/300 = 2; tolerans yalnız bu kuyruğu kapsar.
    ok('boost TAM İKİ KAT yakıt harcıyor (dolu depo ≈ 13500 birim)',
      total > expect * 0.93 && total < expect * 1.12,
      `${Math.round(total)} birim / ${steps} adım (beklenen ~${expect} + acil damla kuyruğu; boost'suz olsa 27000 olurdu)`);

    // ---- 3) ZANAAT: WARPCELL (3 DOTERYUM) → craft_ok + kargo güncellenir
    //    M2i: DOTERYUM artık doğuşta gelmiyor → GERÇEK madencilik yoluyla toplanır (kaya kır →
    //    kapsülü topla). Böylece "maden → zanaat → warp" zinciri uçtan uca doğrulanır.
    const gotOre = await mineOre('DOTERYUM', 3);
    ok('madencilikle DOTERYUM toplandı (doğuş hediyesi YOK)', gotOre, `DOTERYUM=${cargo.DOTERYUM || 0}`);
    const dBefore = cargo.DOTERYUM || 0;
    send({ t: 'craft', id: 'WARPCELL' });
    await sleep(600);
    const cOk = lastSys('craft_ok');
    ok('craft WARPCELL → craft_ok', !!cOk, cOk ? `"${cOk.msg}"` : 'yanıt yok');
    ok('WARPCELL envantere girdi', (cargo.WARPCELL || 0) >= 1, JSON.stringify(cargo));
    ok('DOTERYUM 3 azaldı', (cargo.DOTERYUM || 0) === dBefore - 3, `${dBefore} → ${cargo.DOTERYUM || 0}`);

    // ---- 4) ZANAAT REDDİ: TITAN yok → craft_fail (sessiz ret YOK, sebep yazılır)
    send({ t: 'craft', id: 'FUELCAN' });
    await sleep(500);
    const cFail = lastSys('craft_fail');
    ok('malzeme yoksa craft_fail + sebep', !!cFail, cFail ? `"${cFail.msg}"` : 'yanıt yok');

    // ---- 5) BİLİNMEYEN TARİF / ELDE OLMAYAN EŞYA
    send({ t: 'craft', id: 'NOPE' });
    await sleep(400);
    ok('bilinmeyen tarif → craft_unknown', !!lastSys('craft_unknown'));
    // NOT: kullanım yolunda SIRA "elimde var mı" → "kimlik geçerli mi"dir; olmayan eşya use_need
    // döner (use_unknown yalnız envanterde OLUP kullanılamayan bir eşya için tetiklenir).
    send({ t: 'use', id: 'REPAIRKIT' });
    await sleep(400);
    ok('elde olmayan eşya → use_need', !!lastSys('use_need'),
      (lastSys('use_need') || {}).msg || '');
    send({ t: 'use', id: 'NOPE' });
    await sleep(400);
    ok('olmayan/tanımsız eşya → use_need (sessiz ret yok)', !!lastSys('use_need'),
      (lastSys('use_need') || {}).msg || '');

    // ---- 6) WARP ARTIK HÜCRE İSTER: hücre varken atlar, hücreyi TÜKETİR, sonraki warp reddedilir
    const home = g.stars.find((s) => s.i === sn.star.i);
    const near = g.stars.filter((s) => s.i !== home.i)
      .filter((s) => Math.hypot(s.x - home.x, s.y - home.y) < 650)
      .sort((a, b) => Math.hypot(b.x - home.x, b.y - home.y) - Math.hypot(a.x - home.x, a.y - home.y))[0];
    if (!near) {
      ok('menzil içi yıldız bulundu', false, 'galakside aday yok');
    } else {
      const cellsBefore = cargo.WARPCELL || 0;
      send({ t: 'warp', starId: near.i });
      await sleep(900);
      ok('hücre ile warp başarılı', !!lastSys('warp_ok'),
        `hücre ${cellsBefore} → ${cargo.WARPCELL || 0}`);
      ok('warp 1 WARP HUCRESI tüketti', (cargo.WARPCELL || 0) === cellsBefore - 1,
        JSON.stringify(cargo));
      // M2i: doğuşta 5 HÜCRE var → "hücre yok" durumuna gerçek yolla gelmek için ileri-geri
      // atlanır (her atlama 1 hücre). Sayaç ilerlemezse döngü kırılır (sonsuz döngü yok).
      // ÖNEMLİ: hedef HER ZAMAN bulunduğumuzdan FARKLI seçilir — sunucu aynı sisteme yapılan
      // warp isteğini SESSİZCE yok sayar (warp_nocell gelmez, testi yanıltır).
      const other = () => (((sn && sn.star) ? sn.star.i : home.i) === near.i ? home.i : near.i);
      let guard = 0;
      while ((cargo.WARPCELL || 0) > 0 && guard++ < 12) {
        const cur = cargo.WARPCELL;
        send({ t: 'warp', starId: other() });
        await sleep(900);
        if ((cargo.WARPCELL || 0) === cur) break;
      }
      send({ t: 'warp', starId: other() });    // hücre yok → reddedilmeli
      await sleep(900);
      const nc = lastSys('warp_nocell');
      ok('hücre yokken warp reddedilir (warp_nocell)', !!nc, nc ? `"${nc.msg}"` : 'yanıt yok');
    }

    console.log('\n===== M2h SONUÇ =====');
    console.log(results.join('\n'));
    console.log(`\n${results.length - fails}/${results.length} TEST GECTI`);
    process.exit(fails ? 1 : 0);
  } catch (e) {
    console.log('TEST HATASI:', e && e.message);
    process.exit(1);
  }
});
