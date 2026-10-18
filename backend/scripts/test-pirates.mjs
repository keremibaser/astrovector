// ===========================================================================
// test-pirates.mjs — M2i KORSANLAR + KORSAN İSTASYONU
// ===========================================================================
// Kullanıcı isteği (birebir): "korsanlar olsun, bazı yıldızlarda da korsan istasyonları.
// Ama öyle her yıldızda korsan olmasın yani."
//
// Test İKİ katmandan oluşur:
//  1) SAF (ağ yok): pirates.js dağılımı + determinizm + Room içinde gemi üretimi/ateş/ganimet.
//     Neden saf: korsan davranışı ZAMAN ve RASTGELELİK içerir; canlı sunucuda "korsan bana
//     ateş etti mi" beklemek testi kırılgan yapar (Tuzak 39 dersinin devamı).
//  2) CANLI: gerçek sunucudan snapshot → ana sistem GÜVENLİ olmalı (pirateLvl=0, korsan yok).
import { Room } from '../src/rooms.js';
import { RoomManager } from '../src/rooms.js';
import { pirateLevel, pirateHash, PIRATE_HULL, PIRATE_DMG } from '../src/pirates.js';
import { galaxy } from '../src/galaxy.js';
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://localhost:8081';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
};

// ---------------------------------------------------------------------------
console.log('\n== 1) DAGILIM: "her yildizda korsan olmasin" ==');
const g = galaxy();
const mgr = new RoomManager();
const home = mgr.homeStarId;
const lv = { 0: 0, 1: 0, 2: 0 };
for (const s of g.stars) lv[pirateLevel(s.i, home)]++;
const tot = g.stars.length;
const pct = (n) => (100 * n / tot).toFixed(1);
console.log(`  yildiz=${tot}  sakin=${lv[0]} (%${pct(lv[0])})  korsan=${lv[1]} (%${pct(lv[1])})  istasyon=${lv[2]} (%${pct(lv[2])})`);
ok('cogu yildiz SAKIN (>%50)', lv[0] > tot * 0.5, pct(lv[0]) + '%');
ok('korsanli yildiz var', lv[1] + lv[2] > 0, (lv[1] + lv[2]) + ' yildiz');
ok('istasyon LUks (yildizlarin <%15i)', lv[2] < tot * 0.15, pct(lv[2]) + '%');
ok('ana sistem GUVENLI', pirateLevel(home, home) === 0, 'star=' + home);
ok('deterministik (iki cagri ayni)', pirateLevel(123, home) === pirateLevel(123, home)
  && pirateHash(123) === pirateHash(123));

// ---------------------------------------------------------------------------
console.log('\n== 2) KORSANLI SISTEM: uretim + yaklasma + ATES + ganimet ==');
const pirateStars = g.stars.filter(s => pirateLevel(s.i, home) === 1);
const stStars = g.stars.filter(s => pirateLevel(s.i, home) === 2);
ok('korsan sistemi bulundu', pirateStars.length > 0, pirateStars.length + ' adet');

// Sahte RoomManager: hasar/olay kaydını taklit eder (Room.mgr bekler).
const fakeMgr = {
  damage: [],
  _damagePlayer(room, target, dmg) { target.shield = Math.max(0, target.shield - dmg); fakeMgr.damage.push([target.id, dmg]); },
  _sys() {},
};
const mkPlayer = (id) => ({
  id, callsign: 'TEST-' + id, x: 0, y: 0, r: 0, shield: 100, hull: 100, cargo: {},
  ws: { readyState: 3, send() {} }, kills: 0, deaths: 0, roomId: null, lastFireAt: 0,
});

const room = new Room('s' + pirateStars[0].i, home, fakeMgr);
ok('korsanli odada seviye 1', room.pirateLvl === 1, 'star=' + pirateStars[0].i);
ok('korsansiz yildizda seviye 0', new Room('s' + home, home, fakeMgr).pirateLvl === 0);

const pl = mkPlayer('p1');
room.addPlayer(pl);
const t0 = Date.now();
room._pirateTick(1 / 20, t0);                 // ilk tick: sayaç kurulur, üretim yok (ani saldırı olmaz)
ok('ilk tickte HEMEN korsan dogmuyor', room.npcs.size === 0);
room._pirateTick(1 / 20, t0 + 13_000);        // 13 sn sonra üretim zamanı gelir
ok('takviye dogdu', room.npcs.size === 1, [...room.npcs.keys()].join(','));

const npc = [...room.npcs.values()][0];
const d0 = Math.hypot(npc.x - pl.x, npc.y - pl.y);
// Yeterince uzun simülasyon: korsan 132 birim/sn ile yaklaşır; ~1000 birim mesafeyi kapatıp
// ateş menziline (340) girmesi ~6 sn sürer → 200 tick (10 sn) koşulur.
for (let i = 0; i < 200; i++) room._pirateTick(1 / 20, t0 + 13_000 + i * 50);
const d1 = Math.hypot(npc.x - pl.x, npc.y - pl.y);
ok('korsan OYUNCUYA yaklasti', d1 < d0, `${Math.round(d0)} -> ${Math.round(d1)}`);
ok('korsan menzile girince ATES etti', fakeMgr.damage.length > 0, fakeMgr.damage.length + ' vurus');
ok('ates hasari beklenen deger', fakeMgr.damage.every(d => d[1] === PIRATE_DMG), 'dmg=' + PIRATE_DMG);

const before = room.pickups.size;
room._damageNpc(npc, PIRATE_HULL, pl);        // tek vuruşta yok et (hasar testi ayrı: rayPick)
ok('korsan yok edildi (odadan dustu)', !room.npcs.has(npc.id));
ok('GANIMET dustu', room.pickups.size > before, (room.pickups.size - before) + ' kapsul');
ok('kill sayaci arttı', pl.kills === 1, 'kills=' + pl.kills);

// rayPick: korsan hedef seçilebiliyor mu (yoksa oyuncu vuramaz)
const room2 = new Room('s' + pirateStars[0].i, home, fakeMgr);
room2.addPlayer(pl);
room2._spawnNpc(Date.now());
const n2 = [...room2.npcs.values()][0];
n2.x = 100; n2.y = 0;
const hit = room2.rayPick({ id: 'p1', x: 0, y: 0 }, 1, 0, 380);
ok('rayPick korsani secer', !!hit && hit.kind === 'npc', hit ? hit.kind : 'yok');

// ---------------------------------------------------------------------------
console.log('\n== 3) KORSAN ISTASYONU: yikilinca takviye DURUR ==');
ok('istasyonlu yildiz var', stStars.length > 0, stStars.length + ' adet');
const sr = new Room('s' + stStars[0].i, home, fakeMgr);
ok('istasyon yildizda ISTASYON var', !!sr.station, sr.station ? `(${sr.station.x},${sr.station.y}) hp=${sr.station.hp}` : '');
ok('istasyon yildizda seviye 2', sr.pirateLvl === 2);
const sp = mkPlayer('p2');
sr.addPlayer(sp);
sr._pirateTick(1 / 20, t0);
ok('istasyon varsa ilk korsan da hemen gelmez', sr.npcs.size === 0);
sr._pirateTick(1 / 20, t0 + 8000);
ok('istasyondan korsan uretildi', sr.npcs.size === 1);
const sHit = sr.rayPick({ id: 'p2', x: 0, y: 0 }, 1, 0, 4000);
sr._damageStation(50, sp);
ok('istasyon hasar aldi', sr.station && sr.station.hp === sr.station.maxHp - 50, 'hp=' + sr.station.hp);
const pk = sr.pickups.size;
sr._damageStation(9999, sp);
ok('istasyon YIKILDI', sr.station === null);
ok('istasyon ganimeti dustu', sr.pickups.size > pk + 2, (sr.pickups.size - pk) + ' kapsul');
const npcCount = sr.npcs.size;
sr._pirateTick(1 / 20, t0 + 60_000);
ok('istasyon yikildiktan sonra yeni korsan GELMEZ', sr.npcs.size <= npcCount, 'npc=' + sr.npcs.size);

// ---------------------------------------------------------------------------
console.log('\n== 4) CANLI SUNUCU: ana sistem guvenli ==');
const res = await new Promise((resolve) => {
  const ws = new WebSocket(WS_URL);
  const out = { sn: null, err: null };
  const to = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 8000);
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.t === 'sn') { out.sn = m; }
    if (m.t === 'npc') out.npcPacket = m;
  });
  ws.on('error', (e) => { out.err = String(e.message); clearTimeout(to); resolve(out); });
});
if (res.err) { ok('sunucuya baglanildi', false, res.err); }
else {
  const sn = res.sn || {};
  ok('dogusta 5 WARP HUCRESI', ((sn.cargo || {}) || {})['WARPCELL'] === 5 || (sn.cargo && sn.cargo.WARPCELL === 5),
    JSON.stringify(sn.cargo));
  ok('ana sistemde korsan seviyesi 0', sn.pirateLvl === 0, 'pirateLvl=' + sn.pirateLvl);
  ok('ana sistemde korsan gemisi yok', Array.isArray(sn.npcs) && sn.npcs.length === 0);
  ok('ana sistemde istasyon yok', sn.station === null);
}

// ---------------------------------------------------------------------------
console.log('\n== 5) REGRESYON: NPC "by" olarak mesaj yoluna girdiğinde sunucu COKMEMELI ==');
// Canlıda yaşandı: korsan bir oyuncuyu yok edince `_destroyPlayer` → `_sys(by=npc)` çağırdı;
// NPC'nin `ws` alanı olmadığı için `player.ws.readyState` TypeError attı ve TÜM SUNUCU düştü.
{
  const m2 = new RoomManager();
  let threw = null;
  try { m2._sys({ id: 'x1', callsign: 'KORSAN-01' }, 'kill', 'test', { name: 'A' }); } catch (e) { threw = String(e.message); }
  ok('NPC hedefe _sys cokmuyor', !threw, threw || 'temiz');
  let threw2 = null;
  try { m2._sys(undefined, 'kill', 'test'); } catch (e) { threw2 = String(e.message); }
  ok('undefined hedefe _sys cokmuyor', !threw2, threw2 || 'temiz');
}

console.log(`\nSONUC: ${pass}/${pass + fail} gecti` + (fail ? ` — ${fail} HATA` : ''));
process.exit(fail ? 1 : 0);
