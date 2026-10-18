// AI'A NOT: PvP ışınının NEYE çarptığını görmek için teşhis betiği.
// 'shot' paketindeki hk alanı ('rock' | 'player' | null) ışının sonucunu söyler.
import WebSocket from 'ws';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mk() {
  const c = { box: [], sn: null };
  c.ws = new WebSocket('ws://localhost:8081');
  c.ws.on('message', (raw) => { const m = JSON.parse(raw); c.box.push(m); if (m.t === 'sn') c.sn = m; });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = async (p, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = c.box.findIndex(p); if (i >= 0) return c.box.splice(i, 1)[0]; await sleep(40); } return null; };
  c.pos = () => ({ x: c.sn.x, y: c.sn.y });
  return c;
}

const A = mk(), B = mk();
await new Promise(r => A.ws.on('open', r));
await new Promise(r => B.ws.on('open', r));
await A.wait(m => m.t === 'sn'); await B.wait(m => m.t === 'sn');
console.log(`A spawn (${A.sn.x},${A.sn.y})  B spawn (${B.sn.x},${B.sn.y})  mesafe=${Math.round(Math.hypot(A.sn.x - B.sn.x, A.sn.y - B.sn.y))}`);

// A'yı B'ye uçur: her adımda SUNUCUNUN bildirdiği konumu (diff) baz al
async function step() {
  const d = await A.wait(m => m.t === 'du' && m.d.some(x => x[0] === A.sn.you), 2500);
  if (d) { const me = d.d.find(x => x[0] === A.sn.you); A.sn.x = me[1]; A.sn.y = me[2]; }
}
for (let i = 0; i < 10; i++) {
  const dx = B.sn.x - A.sn.x, dy = B.sn.y - A.sn.y, dist = Math.hypot(dx, dy);
  console.log(`  adim ${i}: A=(${A.sn.x},${A.sn.y}) -> B mesafe=${Math.round(dist)}`);
  if (dist < 150) break;
  const s = Math.min(dist - 140, 250);
  if (s <= 0) break;
  A.send({ t: 'mv', x: Math.round(A.sn.x + dx / dist * s), y: Math.round(A.sn.y + dy / dist * s), r: 0 });
  await sleep(950);
  await step();          // sunucunun onayladığı konuma geç
}

// B'yi tam konumundan bir kez daha bildir (hareketsiz ama emin olalım)
B.send({ t: 'mv', x: B.sn.x, y: B.sn.y, r: 0 });
await sleep(400);
await step();
const dx = B.sn.x - A.sn.x, dy = B.sn.y - A.sn.y, dist = Math.hypot(dx, dy);
const r = Math.atan2(dx, -dy);
console.log(`son: A=(${A.sn.x},${A.sn.y}) B=(${B.sn.x},${B.sn.y}) mesafe=${Math.round(dist)}  r=${r.toFixed(3)}`);
console.log(`beklenen ileri vektor=(${(dx / dist).toFixed(2)},${(dy / dist).toFixed(2)})`);
A.send({ t: 'mv', x: Math.round(A.sn.x), y: Math.round(A.sn.y), r: Number(r.toFixed(3)) });
await sleep(300);
await step();

A.box.length = 0; B.box.length = 0;
A.send({ t: 'fire' });
await sleep(900);
const aShot = A.box.filter(m => m.t === 'shot');
const bDmg = B.box.filter(m => m.t === 'dmg');
console.log('A ya gelen paketler:', A.box.map(m => m.t + (m.hk !== undefined ? ':' + m.hk : '')).join(',') || '(yok)');
console.log('B ye gelen paketler:', B.box.map(m => m.t).join(',') || '(yok)');
if (aShot.length) console.log('  -> shot hk =', JSON.stringify(aShot[0].hk), 'hedef nokta =', aShot[0].hx, aShot[0].hy);
console.log(bDmg.length ? `PVP ISABET: -${bDmg[0].dmg}` : 'PVP ISABET YOK');
A.ws.close(); B.ws.close(); process.exit(0);
