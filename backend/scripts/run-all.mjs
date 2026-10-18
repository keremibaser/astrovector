// AI'A NOT: run-all.mjs — TEST PAKETİ KOŞUCUSU (kendi kendine yeter).
// =============================================================================
// NEDEN VAR (yaşanan arıza — gizli bağımlılık): `test-all` altı ayrı npm script'ini `&&` ile
// zincirliyordu ve bu suite'lerin bir kısmı (test-combat, test-fuel, test-craft-boost,
// test-pirates, test-chat) DIŞARIDAN ÇALIŞAN bir sunucuya (localhost:8081) bağlanıyordu. Yani
// "tüm testler geçti" sonucu yalnızca geliştiricinin dev sunucusu ayaktayken doğruydu; sunucu
// kapatılınca paket `ECONNREFUSED ::1:8081` ile yarıda koptu (yaşandı, 2026-10-18).
//
// YENİ SÖZLEŞME: koşucu, sunucuya ihtiyaç duyan suite'ler için PAYLAŞILAN bir örnek kaldırır
// (ayrı portlar 8099/8100 + rastgele test anahtarı), adresi `WS_URL` ile verir, suite'leri SERİ
// koşar, sonunda sunucuyu kapatır ve sonuç tablosunu basar. Dev sunucusuna (8081) hiç dokunmaz.
//
// KURAL: suite listesi seri koşar (paralel DEĞİL) — sabit portlar ve deterministik galaksi
// paylaşıldığı için paralel koşum birbirini bozar (bkz. SSOT "tek seferde tek test-all" notu).

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const S = 'C:/Users/PC/AppData/Local/hermes/cache/scratch';   // (yalnız olası teşhis dosyaları için)
void S;

const PORT_GAME = 8099;
const PORT_ADMIN = 8100;
const SERVER_URL = `ws://127.0.0.1:${PORT_GAME}`;

// Sunucuya bağlanan suite'ler (WS_URL'i okurlar) — bunlar için paylaşılan örnek şart.
const NEEDS_SERVER = new Set(['test-combat', 'test-fuel', 'test-craft-boost', 'test-pirates', 'test-chat']);
// Sıra korunur: hızlı/tarayıcısız kontroller önce, ağ testleri sonra.
const SUITES = [
  'test-bat', 'test-i18n', 'test-store', 'test-admin', 'test-m4',
  'test-anomaly', 'test-warp', 'test-combat', 'test-fuel', 'test-craft-boost',
  'test-pirates', 'test-chat',
];

const probe = (port) => new Promise((ok) => {
  const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false));
  s.setTimeout(700, () => { s.destroy(); ok(false); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (await probe(PORT_GAME)) {
  console.error(`\n[HATA] ${PORT_GAME} portu DOLU — paylasilan test sunucusu kaldirilamaz.`);
  console.error('       Bu portu tutan sureci kapat, sonra tekrar kos.');
  process.exit(2);
}

console.log(`[RUN-ALL] paylasilan test sunucusu kaldiriliyor: ${SERVER_URL} (admin 127.0.0.1:${PORT_ADMIN})`);
const srv = spawn(process.execPath, [resolve(root, 'backend/server.js')], {
  env: {
    ...process.env,
    PORT_GAME: String(PORT_GAME),
    PORT_ADMIN: String(PORT_ADMIN),
    ADMIN_SECRET_KEY: 'runall_' + Math.random().toString(36).slice(2, 10),
  },
  stdio: 'ignore',
});
process.on('exit', () => { try { srv.kill(); } catch { /* zaten ölmüş */ } });

const t0 = Date.now();
while (Date.now() - t0 < 20000 && !(await probe(PORT_GAME))) await sleep(200);
if (!(await probe(PORT_GAME))) {
  console.error('[HATA] paylasilan test sunucusu ACILAMADI — suite\'ler kosulmadi.');
  srv.kill();
  process.exit(3);
}
console.log(`[RUN-ALL] sunucu hazir (${Date.now() - t0} ms). ${SUITES.length} suite seri kosulacak.\n`);

const results = [];
for (const suite of SUITES) {
  const t = Date.now();
  console.log(`\n${'='.repeat(72)}\n[RUN-ALL] ${suite}${NEEDS_SERVER.has(suite) ? `  (WS_URL=${SERVER_URL})` : ''}\n${'='.repeat(72)}`);
  const r = spawnSync('npm', ['run', suite], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: NEEDS_SERVER.has(suite) ? { ...process.env, WS_URL: SERVER_URL } : process.env,
  });
  const code = r.status === null ? 99 : r.status;
  results.push({ suite, code, ms: Date.now() - t });
  // Sunucu testler sırasında ölürse (crash) kalan ağ testleri anlamsız olur: yüksek sesle söyle.
  if (code !== 0 && NEEDS_SERVER.has(suite) && !(await probe(PORT_GAME))) {
    console.log(`\n[RUN-ALL] !! paylasilan sunucu artik DINLEMIYOR — kalan ag testleri anlamsiz.`);
  }
}

srv.kill();

console.log(`\n${'='.repeat(72)}\n[RUN-ALL] SONUC TABLOSU\n${'='.repeat(72)}`);
for (const { suite, code, ms } of results) {
  console.log(`  ${code === 0 ? 'GECTI  ' : 'KIRIK  '} ${suite.padEnd(18)} ${String(code).padStart(2)}  ${(ms / 1000).toFixed(1)} sn`);
}
const broken = results.filter((r) => r.code !== 0);
console.log(`\n[RUN-ALL] ${results.length - broken.length}/${results.length} suite gecti`
  + (broken.length ? ` — KIRIK: ${broken.map((b) => b.suite).join(', ')}` : ''));
process.exit(broken.length ? 1 : 0);
