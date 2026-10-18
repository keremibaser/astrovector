// ===========================================================================
// M3 — SOHBET testi: 4 kanal (g/s/l/p) + rate limit + metin temizliği.
//   A ve B ana sistemde (aynı oda) | C iki atlama uzağa gider (ne yerel ne sektör)
// Çalıştırma: node backend/scripts/test-chat.mjs      (sunucu 8081'de ayakta olmalı)
// ===========================================================================
import WebSocket from 'ws';
import { galaxy } from '../src/galaxy.js';

const URL = process.env.WS_URL || 'ws://localhost:8081';   // WS_URL ile başka bir örneğe yönlendirilebilir
const CHAT_BURST_MAX = 4, CHAT_BURST_MS = 6000, CHAT_MAX_LEN = 120;
const CD = 850;                        // iki mesaj arası test beklemesi (sunucu CD'si 700ms)
const QUIET = CHAT_BURST_MS + 1000;    // kota penceresini tamamen boşaltan bekleme

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[OK]   ${name}${extra ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? '  → ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- istemci: sohbet + sys + sn mesajlarını toplar ---------------------------------
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = {
      ws, chats: [], sys: [], sn: null, id: null, callsign: null, star: null,
      chat(ch) { return ch ? this.chats.filter((m) => m.ch === ch) : this.chats; },
      lastChat(ch) { const a = this.chat(ch); return a[a.length - 1] || null; },
      lastSys(code) { const a = this.sys.filter((m) => m.code === code); return a[a.length - 1] || null; },
      send(o) { ws.send(JSON.stringify(o)); },
      close() { try { ws.close(); } catch { /* yoksay */ } },
    };
    ws.on('open', () => { c.send({ t: 'hb', c: Date.now() }); setTimeout(() => resolve(c), 900); });
    ws.on('error', reject);
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'sn') {
        c.sn = m;
        c.id = m.you;
        c.callsign = m.cs || c.callsign;      // M3: sunucu artık kendi çağrı işaretini de yollar
        if (m.star) c.star = m.star.i;
      } else if (m.t === 'chat') c.chats.push(m);
      else if (m.t === 'sys') c.sys.push(m);
    });
  });
}

// --- galaksi yardımcıları: sektör testi için komşu ve İKİ ATLAMA uzak yıldız -------------
// AI'A NOT: Tek adımda "komşunun komşusu ama evden uzak" bir yıldız bulmak kırılgan (yıldız
// yoğunluğu merkeze doğru çok artıyor). Bunun yerine EV'DEN UZAKLAŞAN BİR YOL yürünür:
// her adım menzil içinde ve evden daha uzak olan yıldıza gider — 3 adım sonra kesin uzaktayız.
const JUMP = 700;
const g = galaxy();
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function walkAway(homeId, hops = 3) {
  const home = g.stars[homeId];
  const path = [];
  let cur = home;
  for (let k = 0; k < hops; k++) {
    const d0 = dist(cur, home);
    let best = null, bestD = d0;
    for (const s of g.stars) {
      if (s.i === cur.i || path.some((p) => p.i === s.i)) continue;
      if (dist(s, cur) > JUMP * 0.8) continue;          // menzil içinde olmalı
      const d = dist(s, home);
      if (d > bestD) { bestD = d; best = s; }
    }
    if (!best) break;
    path.push(best);
    cur = best;
  }
  return path;
}

async function main() {
  console.log('== M3 SOHBET: 4 kanal + rate limit + temizlik ==\n');
  const A = await connect();
  const B = await connect();
  const C = await connect();
  await sleep(850);

  ok('üç istemci de snapshot aldı', !!(A.sn && B.sn && C.sn));
  ok('her istemci kendi çağrı işaretini aldı', !!(A.callsign && B.callsign && C.callsign),
    `${A.callsign} / ${B.callsign} / ${C.callsign}`);
  const home = A.star;
  ok('doğuş yıldızı okundu', Number.isFinite(home), `star=${home}`);
  ok('A ve B aynı sistemde (YEREL kanal hedefi)', A.star === home && B.star === home);

  // --- C'yi evden UZAKLAŞTIR (yerel ve sektör dışına) ---------------------------------
  const path = walkAway(home, 3);
  ok('uzaklaşma yolu bulundu (3 atlama)', path.length === 3, path.map((s) => s.i).join(' → '));
  for (const hop of path) { C.send({ t: 'warp', starId: hop.i }); await sleep(1150); }
  await sleep(500);
  const farStar = path.length ? path[path.length - 1].i : null;
  ok('C uzak sisteme gitti', C.star === farStar, `C.star=${C.star} hedef=${farStar}`);
  ok('C artık A ile aynı odada DEĞİL', C.star !== home, `home=${home} C=${C.star}`);
  const dHome = farStar ? dist(g.stars[farStar], g.stars[home]) : 0;
  ok('C sektör menzilinin DIŞINDA', dHome > JUMP, `uzaklik=${Math.round(dHome)} > ${JUMP}`);

  // --- 1) YEREL ----------------------------------------------------------------------
  A.chats.length = B.chats.length = C.chats.length = 0;
  A.send({ t: 'chat', ch: 'l', m: 'yerel-merhaba' });
  await sleep(850);
  ok('YEREL: aynı odadaki B aldı', !!B.lastChat('l'), JSON.stringify(B.lastChat('l')));
  ok('YEREL: uzaktaki C ALMADI', C.chat('l').length === 0, `C yerel=${C.chat('l').length}`);
  ok('YEREL: gönderen kendi mesajının kopyasını gördü', !!A.lastChat('l'));
  ok('YEREL: gönderen adı paket içinde', (B.lastChat('l') || {}).from === A.callsign,
    `from=${(B.lastChat('l') || {}).from} beklenen=${A.callsign}`);

  // --- 2) SEKTÖR ---------------------------------------------------------------------
  A.chats.length = B.chats.length = C.chats.length = 0;
  A.send({ t: 'chat', ch: 's', m: 'sektor-merhaba' });
  await sleep(850);
  ok('SEKTÖR: aynı sektördeki B aldı', !!B.lastChat('s'), JSON.stringify(B.lastChat('s')));
  ok('SEKTÖR: iki atlama uzaktaki C ALMADI', C.chat('s').length === 0, `C sektör=${C.chat('s').length}`);

  // --- 3) GLOBAL ---------------------------------------------------------------------
  A.chats.length = B.chats.length = C.chats.length = 0;
  A.send({ t: 'chat', ch: 'g', m: 'global-merhaba' });
  await sleep(850);
  ok('GLOBAL: B aldı', !!B.lastChat('g'));
  ok('GLOBAL: uzaktaki C de aldı (tüm galaksi)', !!C.lastChat('g'), JSON.stringify(C.lastChat('g')));

  // --- 4) ÖZEL (DM) ------------------------------------------------------------------
  // AI'A NOT: Kanallar sunucuda TEK rate limit sayacını paylaşır. Yukarıdaki 3 mesaj kotayı
  // doldurduğu için özel mesaj testinden ÖNCE pencere boşaltılır (yoksa DM yerine chat_flood gelir
  // ve test "chat_noone yok" diye yanlış kırmızı verir).
  await sleep(QUIET);
  A.chats.length = B.chats.length = C.chats.length = 0;
  A.sys.length = 0;
  A.send({ t: 'chat', ch: 'p', to: B.callsign, m: 'gizli-mesaj' });
  await sleep(850);
  const dmB = B.lastChat('p');
  ok('ÖZEL: hedef B aldı', !!dmB && dmB.m === 'gizli-mesaj', JSON.stringify(dmB));
  ok('ÖZEL: paket dm bayraklı', !!dmB && dmB.dm === 1);
  ok('ÖZEL: gönderen A kopyayı gördü (echo)', !!A.lastChat('p') && A.lastChat('p').echo === 1);
  ok('ÖZEL: üçüncü kişi C ALMADI', C.chat('p').length === 0, `C özel=${C.chat('p').length}`);

  A.chats.length = 0; A.sys.length = 0;
  A.send({ t: 'chat', ch: 'p', to: 'YOKBOYLEBIRI', m: 'kimse' });
  await sleep(850);
  ok('ÖZEL: olmayan çağrı işareti → chat_noone', !!A.lastSys('chat_noone'),
    (A.lastSys('chat_noone') || {}).msg || 'yanıt yok');
  ok('ÖZEL: olmayan hedefe mesaj GİTMEDİ', A.chat('p').length === 0, `A özel=${A.chat('p').length}`);

  // --- 5) RATE LIMIT -----------------------------------------------------------------
  // AI'A NOT: A yukarıda zaten mesaj yolladı → sunucu sayacı DOLU olabilir. Test pencereyi
  // boşaltmayı BEKLER, yoksa "spam" mesajlarının hangisi geçeceği önceki testlere bağlı olur
  // (ilk koşuda tam bu oldu: spam1-4 bloke, spam5-6 geçti).
  await sleep(QUIET);
  A.chats.length = B.chats.length = 0; A.sys.length = 0;
  // CD 700ms → 850ms aralıkla 6 mesaj: ilk 4'ü gider, 5. ve 6. pencere kotasına takılır.
  for (let i = 1; i <= 6; i++) {
    A.send({ t: 'chat', ch: 'l', m: 'spam' + i });
    await sleep(800);
  }
  await sleep(400);
  ok('RATE LIMIT: fazla mesaj reddedildi (chat_flood)', !!A.lastSys('chat_flood'),
    (A.lastSys('chat_flood') || {}).msg || 'yanıt yok');
  const delivered = B.chat('l').map((m) => m.m);
  ok(`RATE LIMIT: pencerede tam ${CHAT_BURST_MAX} mesaj iletildi`,
    delivered.length === CHAT_BURST_MAX, `B yerel=[${delivered.join(',')}]`);
  ok('RATE LIMIT: sınırı aşan mesajlar GİTMEDİ',
    !delivered.includes('spam5') && !delivered.includes('spam6'), `B=[${delivered.join(',')}]`);

  // --- 6) TEMİZLİK -------------------------------------------------------------------
  A.chats.length = B.chats.length = 0;
  await sleep(QUIET);
  const dirty = 'kontrol\u0000\u001b[31m \u0007 ' + 'X'.repeat(300) + ' <b>etiket</b>';
  A.send({ t: 'chat', ch: 'l', m: dirty });
  await sleep(800);
  const got = B.lastChat('l');
  ok('TEMİZLİK: mesaj iletildi', !!got);
  if (got) {
    ok('TEMİZLİK: uzunluk kırpıldı', got.m.length <= CHAT_MAX_LEN, `len=${got.m.length}`);
    ok('TEMİZLİK: kontrol karakteri yok', !/[\u0000-\u001f\u007f]/.test(got.m));
    ok('TEMİZLİK: açı parantezleri atıldı', !/[<>]/.test(got.m), JSON.stringify(got.m.slice(-24)));
  }

  // --- 7) BOŞ/GEÇERSİZ KANAL ---------------------------------------------------------
  A.chats.length = B.chats.length = 0; A.sys.length = 0;
  await sleep(QUIET);
  A.send({ t: 'chat', ch: 'zzz', m: 'bilinmeyen kanal' });   // bilinmeyen kanal → yerel sayılır
  await sleep(850);
  ok('BİLİNMEYEN kanal yerel sayılır', !!B.lastChat('l'), JSON.stringify(B.lastChat('l')));
  A.chats.length = B.chats.length = 0; A.sys.length = 0;
  A.send({ t: 'chat', ch: 'l', m: '   ' });                  // boş metin → sessizce yok sayılır
  await sleep(850);
  ok('BOŞ mesaj yayınlanmadı', B.chat('l').length === 0, `B=${B.chat('l').length}`);
  ok('BOŞ mesaj hata da üretmedi', A.sys.length === 0, JSON.stringify(A.sys.map((s) => s.code)));

  A.close(); B.close(); C.close();
  console.log(`\nSONUC: ${pass}/${pass + fail} gecti` + (fail ? ` — ${fail} HATA` : ''));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST COKTU:', e); process.exit(1); });
