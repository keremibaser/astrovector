// AI'A NOT: test-milestone4.mjs — Milestone 4 (Admin Tanrı Modu) uçtan uca doğrulama testi.
// Test ettikleri:
// 1. Admin auth handshake
// 2. Galaxy overview (16384 yıldız, canlı odalar, oyuncu koordinatları)
// 3. Canlı stream & snapshot (inspect)
// 4. God mode: spawn_asteroid (rocknew yayını + admin command_res)
// 5. God mode: trigger_star_kill (supernova yayını + acil durum bildirimi)
// 6. God mode: kill_player

import WebSocket from 'ws';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_KEY = 'test_key_m4_' + Math.random().toString(36).slice(2, 8);
const P_ADMIN = 8093, P_GAME = 8094;

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
  // 1) Oyuncu Bağlantısı
  const playerWs = new WebSocket(`ws://localhost:${P_GAME}`);
  const playerMsgs = [];
  playerWs.on('message', raw => {
    try { playerMsgs.push(JSON.parse(raw)); } catch {}
  });
  await new Promise(r => playerWs.on('open', r));
  await sleep(400);

  const initSnap = playerMsgs.find(m => m.t === 'sn');
  check('Oyuncu bağlandı ve snapshot aldı', !!initSnap, `Room: ${initSnap?.roomId}, Star: ${initSnap?.star?.n}`);
  const currentRoomId = initSnap.roomId;
  const currentStarId = initSnap.star.i;

  // 2) Admin Bağlantısı ve Auth
  const adminWs = new WebSocket(`ws://localhost:${P_ADMIN}`);
  const adminMsgs = [];
  adminWs.on('message', raw => {
    try { adminMsgs.push(JSON.parse(raw)); } catch {}
  });
  await new Promise(r => adminWs.on('open', r));
  adminWs.send(JSON.stringify({ t: 'adm:auth', key: TEST_KEY }));
  await sleep(400);

  const authOk = adminMsgs.find(m => m.t === 'adm:auth_ok');
  check('Admin auth başarılı (adm:auth_ok)', !!authOk, `Stars: ${authOk?.stats?.stars}`);

  // 3) Galaxy Overview Komutu
  adminWs.send(JSON.stringify({ t: 'adm:command', op: 'galaxy_overview', args: {} }));
  await sleep(400);
  const galMsg = adminMsgs.find(m => m.t === 'adm:galaxy');
  check('Galaxy overview verisi alındı (adm:galaxy)', !!galMsg?.overview, `Total stars: ${galMsg?.overview?.totalStars}`);
  check('Galaxy overview aktif oda içeriyor', (galMsg?.overview?.activeRooms?.length || 0) >= 1, `Aktif odalar: ${galMsg?.overview?.activeRooms?.length}`);
  check('Galaxy overview oyuncu konumu içeriyor', (galMsg?.overview?.players?.length || 0) >= 1, `Oyuncular: ${galMsg?.overview?.players?.length}`);

  // 4) Inspection Stream & Snapshot
  adminWs.send(JSON.stringify({ t: 'adm:inspect', kind: 'player', id: initSnap.you }));
  await sleep(400);
  const snapMsg = adminMsgs.find(m => m.t === 'adm:snap');
  check('Player inspect snapshot alındı (adm:snap)', snapMsg?.snapshot?.id === initSnap.you, `Callsign: ${snapMsg?.snapshot?.callsign}`);

  // 5) God Mode: Spawn Asteroid
  const prevRockCount = initSnap.rocks.length;
  adminWs.send(JSON.stringify({
    t: 'adm:command',
    op: 'spawn_asteroid',
    args: { roomId: currentRoomId, ore: 'TITAN', size: 30, x: 150, y: 150 }
  }));
  await sleep(400);

  const spawnRes = adminMsgs.find(m => m.t === 'adm:command_res' && m.op === 'spawn_asteroid');
  check('spawn_asteroid komut cevabı başarılı', spawnRes?.ok === true, `Room: ${spawnRes?.roomId}`);
  const rockNewPacket = playerMsgs.find(m => m.t === 'rocknew');
  check('Oyuncuya rocknew paketi yayınlandı (canlı spawn)', rockNewPacket?.ore === 'TITAN', `Kaya ID: ${rockNewPacket?.id}, ore=${rockNewPacket?.ore}`);

  // 6) God Mode: Trigger Star Kill (Supernova)
  adminWs.send(JSON.stringify({
    t: 'adm:command',
    op: 'trigger_star_kill',
    args: { starId: currentStarId }
  }));
  await sleep(500);

  const starKillRes = adminMsgs.find(m => m.t === 'adm:command_res' && m.op === 'trigger_star_kill');
  check('trigger_star_kill komut cevabı başarılı', starKillRes?.ok === true, `StarId: ${starKillRes?.starId}`);
  const starKillSys = playerMsgs.find(m => m.t === 'sys' && m.code === 'star_kill');
  check('Oyuncuya supernova sistem uyarısı ulaştı', !!starKillSys, `Mesaj: ${starKillSys?.msg}`);

  // 7) God Mode: Kill Player
  adminWs.send(JSON.stringify({
    t: 'adm:command',
    op: 'kill_player',
    args: { id: initSnap.you }
  }));
  await sleep(400);

  const killRes = adminMsgs.find(m => m.t === 'adm:command_res' && m.op === 'kill_player');
  check('kill_player komut cevabı başarılı', killRes?.ok === true, `PlayerId: ${killRes?.id}`);

  console.log(`\nSONUÇ: ${passed}/${total} Milestone 4 kontrolleri geçti`);

  playerWs.close();
  adminWs.close();
} finally {
  srv.kill();
}

if (passed === total) {
  process.exit(0);
} else {
  process.exit(1);
}
