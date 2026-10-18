// Test: Admin herhangi bir yıldızı (oyuncu olmasa bile) seçip canlı izleyebilmeli.
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_KEY = 'test_key_anystar_' + Math.random().toString(36).slice(2, 8);
const P_ADMIN = 8095, P_GAME = 8096;

const srv = spawn(process.execPath, [resolve(root, 'backend/server.js')], {
  env: { ...process.env, ADMIN_SECRET_KEY: TEST_KEY, PORT_ADMIN: String(P_ADMIN), PORT_GAME: String(P_GAME) },
  stdio: 'ignore',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);

let passed = 0, total = 0;
function check(desc, cond, extra = '') {
  total++;
  if (cond) {
    passed++;
    console.log(`GECTI   ${desc} ${extra ? '— ' + extra : ''}`);
  } else {
    console.error(`HATA    ${desc} ${extra ? '— ' + extra : ''}`);
  }
}

try {
  const adminWs = new WebSocket(`ws://localhost:${P_ADMIN}`);
  const msgs = [];
  adminWs.on('message', raw => {
    try { msgs.push(JSON.parse(raw)); } catch {}
  });
  await new Promise(r => adminWs.on('open', r));
  adminWs.send(JSON.stringify({ t: 'adm:auth', key: TEST_KEY }));
  await sleep(400);

  // 1) Oyuncusuz boş bir yıldızı izleme (örn. Star 0)
  adminWs.send(JSON.stringify({ t: 'adm:command', op: 'room_detail', args: { id: 's0' } }));
  await sleep(400);

  const room0 = msgs.find(m => m.t === 'adm:room' && m.room?.id === 's0');
  check('Oyuncusuz Star 0 odası oluşturuldu ve dökümü alındı', !!room0?.room, `Yıldız: ${room0?.room?.star?.n}, Kayalar: ${room0?.room?.rocks?.length}`);
  check('Star 0 asteroid kuşağı içeriyor', (room0?.room?.rocks?.length || 0) > 0, `Kaya adedi: ${room0?.room?.rocks?.length}`);

  // 2) Korsan İstasyonu olan bir sistemi izleme (Star 7071)
  adminWs.send(JSON.stringify({ t: 'adm:command', op: 'room_detail', args: { id: 's7071' } }));
  await sleep(400);

  const room7071 = msgs.find(m => m.t === 'adm:room' && m.room?.id === 's7071');
  check('Korsan sistemi Star 7071 odası dökümü alındı', !!room7071?.room, `PirateLvl: ${room7071?.room?.pirateLvl}`);
  check('Star 7071 korsan istasyonu içeriyor', !!room7071?.room?.station, `İstasyon HP: ${room7071?.room?.station?.hp}/${room7071?.room?.station?.maxHp}`);

  console.log(`\nSONUÇ: ${passed}/${total} Boş Yıldız/Oda İzleme Kontrolleri Geçti`);
  adminWs.close();
} finally {
  srv.kill();
}

if (passed === total) process.exit(0);
else process.exit(1);
