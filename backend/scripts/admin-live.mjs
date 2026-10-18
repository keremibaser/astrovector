// =============================================================================
// admin-live.mjs — YALNIZCA yerel/ops doğrulama. HIÇBIR ZAMAN imjaya girmez
// (.dockerignore: backend/scripts/ dışarıda). Canlı Render ws'ne .env'den
// ADMIN_SECRET_KEY okuyarak bağlanır; anahtar asla loglanmaz / stdout'a çıkmaz.
//
//   set ADMIN_SECRET_KEY=***yapıştır*** && node backend/scripts/admin-live.mjs [op]
//   WS_URL=wss://<canlı> node backend/scripts/admin-live.mjs galaxy_overview
//
// Tekrar vurgulama: sır bu dosyada DEGILDIR — sadece env var'da. Komut yalnizca
// okur (`galaxy_overview` gibi) ama sunucu tarafinda `telemetry.critical(...)`
// tetikler => `INSERT INTO events` (ON CONFLICT yok, yeni satir, PG'ye commit).
// Ardindan GET /healthz -> store.written.telemetry 0 => 1 olur.
// -----------------------------------------------------------------------------
import WebSocket from 'ws';

const key = process.env.ADMIN_SECRET_KEY;
if (!key) { console.error('ADMIN_SECRET_KEY env eksik'); process.exit(64); }

const op = process.argv[2] || 'galaxy_overview';
const url = (process.env.WS_URL || 'https://astrovector.onrender.com').replace(/^http/, 'ws');
const ws = new WebSocket(url);
let settled = false;
const done = (c) => { if (settled) return; settled = true; try { ws.close(); } catch {} process.exit(c); };

ws.on('open', () => ws.send(JSON.stringify({ t: 'adm:auth', key })));
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  console.log('  <-', m.t || '?', JSON.stringify(m).slice(0, 140));
  if (m.t === 'adm:auth_ok' && !sentCmd) {
    sentCmd = true;
    ws.send(JSON.stringify({ t: 'adm:command', op, args: {} }));
    console.log('  op gönderildi:', op);
  }
  // sunucunun döndürdüğü başarı/canlı-yanıt türünü bekle; herhangi bir
  // adm:galaxy / adm:ok / adm:result gelince bitir. (Zaman aşımı
  // yedek çıkış, ama INSERT sunucuda hâlâ atılmıştır.)
  if (m.t && /^(adm:galaxy|adm:ok|adm:result|adm:command_ok|adm:destroyed_star)$/.test(m.t)) {
    setTimeout(() => done(0), 300);
  }
});
ws.on('error', (e) => { console.error('bağlantı hata:', e.message); done(1); });
setTimeout(() => { console.error('zaman aşımı (sunucu yanıt vermedi / protokol uyuştu) — ama INSERT hâlâ atılmıştır'); done(2); }, 12000);

var sentCmd = false; // eslint-disable-line
