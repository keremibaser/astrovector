// AI'A NOT: teşhis aracı — belirli bir oyuncunun TAM durumunu (son kabul edilen mv zamanı dahil)
// admin inspect ile çeker. mv paketleri geliyor mu, yoksa client hiç göndermiyor mu ayırt eder.
// Kullanım: node backend/scripts/admin-inspect.mjs [playerId]
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const key = readFileSync(resolve(root, '.env'), 'utf8').match(/ADMIN_SECRET_KEY=(\S+)/)[1].trim();
const wanted = process.argv[2];

const a = new WebSocket('ws://localhost:8090');
a.on('open', () => a.send(JSON.stringify({ t: 'adm:auth', key })));
a.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'adm:auth_ok') a.send(JSON.stringify({ t: 'adm:command', op: 'list_players', args: {} }));
  if (m.t === 'adm:players') {
    const p = wanted ? m.players.find(p => p.id === wanted) : m.players[0];
    if (!p) { console.log('oyuncu yok'); process.exit(0); }
    a.send(JSON.stringify({ t: 'adm:inspect', kind: 'player', id: p.id }));
  }
  if (m.t === 'adm:snap') {
    const s = m.snapshot;
    if (!s) { console.log('snapshot yok'); process.exit(0); }
    const age = Date.now() - s.lastAcceptedAt;
    console.log(`id=${s.id} callsign=${s.callsign} room=${s.roomId} x=${s.x.toFixed(1)} y=${s.y.toFixed(1)}`);
    console.log(`son mv paketi ${age} ms once kabul edildi  (taze = client gonderiyor)`);
    console.log(`hiz uyarisi=${s.speedWarnings}  shield=${Math.round(s.shield)} hull=${s.hull}`);
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 6000);
