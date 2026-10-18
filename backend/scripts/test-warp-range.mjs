// AI'A NOT: WARP MENZİLİ testi — sunucunun menzil dışı isteği REDDETTİĞİNİ ve menzil içi
// isteği kabul ettiğini bağımsız bir ws istemcisiyle kanıtlar. Tarayıcıya gerek yok.
// Ayrıca sn paketindeki jumpRange alanının geldiğini doğrular (client menzili oradan alır).
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { galaxy } from '../src/galaxy.js';

// AI'A NOT (PAKET BAĞIMSIZLIĞI — düzeltilen gizli bağımlılık): Bu test ÖNCEDEN dışarıdan çalışan bir
// sunucuya (`ws://localhost:8081`) bağlanıyordu. Yani `npm run test-all` yalnızca geliştiricinin dev
// sunucusu AYAKTAYKEN geçiyordu; sunucu kapatılınca `ECONNREFUSED ::1:8081` ile kırıldı (yaşandı).
// Yeni davranış: 8081 dinliyorsa onu kullanır (dev akışı bozulmaz), dinlemiyorsa KENDİ sunucusunu
// ayrı portlarda (8097/8098) kaldırır ve test bitince kapatır → paket kendi kendine yeter.
const SELF_PORT = 8097;
const base = 'ws://127.0.0.1:';
const probe = (port) => new Promise((ok) => {
  const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false));
  s.setTimeout(700, () => { s.destroy(); ok(false); });
});

let srv = null;
const url = (await probe(8081)) ? base + 8081 : base + SELF_PORT;
if (!url.endsWith('8081')) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  // PORT_GAME env'i .env'deki değeri EZER (dotenv var olanı üzerine yazmaz — bkz. Tuzak 62b).
  srv = spawn(process.execPath, [resolve(root, 'backend/server.js')], {
    env: {
      ...process.env,
      PORT_GAME: String(SELF_PORT),
      PORT_ADMIN: '8098',
      ADMIN_SECRET_KEY: 'warp_test_' + Math.random().toString(36).slice(2, 8),
    },
    stdio: 'ignore',
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(await probe(SELF_PORT))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(await probe(SELF_PORT))) { console.log('KENDI SUNUCUSU ACILAMADI'); srv.kill(); process.exit(3); }
  console.log(`kendi sunucusu kaldirildi: ${url}`);
}
process.on('exit', () => { if (srv) { try { srv.kill(); } catch { /* zaten ölmüş */ } } });

const g = galaxy();
const ws = new WebSocket(url);
const got = [];
let roomId = null, homeId = null, jumpRange = null, phase = 0;

const home = () => g.stars.find(s => s.i === homeId);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  got.push(m);

  if (m.t === 'sn' && phase === 0) {
    // İlk snapshot: başlangıç sistemi + menzil
    roomId = m.roomId; homeId = m.star.i; jumpRange = m.jumpRange;
    console.log(`baslangic: room=${roomId} yildiz=${m.star.n} (id ${homeId})  sunucudan menzil=${jumpRange}`);
    if (jumpRange !== 700) { console.log('BEKLENMEYEN MENZIL'); process.exit(1); }

    const h = home();
    // Menzil İÇİ ve menzil DIŞI adaylar (yıldız-yıldız mesafesi)
    const near = g.stars.filter(s => s.i !== homeId && dist(s, h) < 650).sort((a, b) => dist(b, h) - dist(a, h))[0];
    const far = g.stars.filter(s => s.i !== homeId && dist(s, h) > 900).sort((a, b) => dist(a, h) - dist(b, h))[0];
    console.log(`adaylar: yakin=${near.n ?? near.i} (${Math.round(dist(near, h))} birim) | uzak=${far.n ?? far.i} (${Math.round(dist(far, h))} birim)`);
    globalThis.near = near; globalThis.far = far;
    phase = 1;
    console.log('>> menzil DISI warp denemesi gonderiliyor...');
    ws.send(JSON.stringify({ t: 'warp', starId: far.i }));
    return;
  }

  if (m.t === 'sys' && m.code === 'warp_range' && phase === 1) {
    console.log(`menzil disi REDDEDILDI: "${m.msg}"`);
    phase = 2;
    console.log('>> menzil ICINDEKI yildiza warp deneniyor...');
    ws.send(JSON.stringify({ t: 'warp', starId: globalThis.near.i }));
    return;
  }

  if (m.t === 'sys' && m.code === 'warp_nocell' && phase === 2) {
    // M2h: warp artık 1 WARP HUCRESI ister (3 DOTERYUM → 1 hücre). Test önce üretir, sonra dener.
    console.log('hücre yok → WARPCELL üretiliyor (3 DOTERYUM)...');
    ws.send(JSON.stringify({ t: 'craft', id: 'WARPCELL' }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'warp', starId: globalThis.near.i })), 450);
    return;
  }

  if (phase === 2 && m.t === 'sn') {
    const ok = m.roomId !== roomId && m.star.i === globalThis.near.i;
    console.log(`menzil ici warp ${ok ? 'BASARILI' : 'BASARISIZ'}: yeni room=${m.roomId} yildiz=${m.star.n}`);
    console.log(ok ? '\nSONUC: MENZIL DOGRULAMASI CALISIYOR' : '\nSONUC: BASARISIZ');
    ws.close();
    process.exit(ok ? 0 : 1);
  }
});

ws.on('open', () => console.log('bagli'));
setTimeout(() => { console.log('ZAMAN ASIMI — beklenen mesaj gelmedi. Gelenler:', got.map(m => m.t + (m.code ? ':' + m.code : '')).join(',')); process.exit(2); }, 16000);
