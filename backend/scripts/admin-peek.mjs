// AI'A NOT: test aracı — admin ws'ten oyuncu listesini çeker (uçtan uca doğrulama için).
// Kullanım: node backend/scripts/admin-peek.mjs
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const key = readFileSync(resolve(root, '.env'), 'utf8').match(/ADMIN_SECRET_KEY=(\S+)/)[1].trim();
const a = new WebSocket('ws://localhost:8090');
a.on('open', () => a.send(JSON.stringify({ t: 'adm:auth', key })));
a.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'adm:auth_ok') a.send(JSON.stringify({ t: 'adm:command', op: 'list_players', args: {} }));
  if (m.t === 'adm:players') {
    for (const p of m.players) console.log(`${p.callsign}  ${p.room}  x=${p.x} y=${p.y}  hull=${p.hull} shield=${p.shield} warnings=${p.warnings}`);
    if (!m.players.length) console.log('(oyuncu yok)');
    process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT (server kapali olabilir)'); process.exit(1); }, 5000);
