// AI'A NOT: test-store.mjs — M3a KALICI DEPO SÖZLEŞMESİ (veritabanı GEREKTİRMEZ).
//
// NEDEN SAHTE POOL: 'pg' modunu doğrulamak için gerçek Postgres gerekmez; `pg` sürücüsünün
// arayüzünü taklit eden bir sınıf enjekte ediyoruz (Store zaten `poolFactory` kabul ediyor).
// Böylece SORGU METNİ ve PARAMETRELERİ denetleyebiliyoruz — asıl sözleşme bunlar:
//   · yıldız yazımı TEK sorgu + ON CONFLICT (yinelenen yıldız patlatmasın)
//   · telemetry TEK multi-INSERT (batch mimarisi — DB nefes alsın)
//   · yazma hatasında batch GERİ KUYRUĞA KONMAZ (sonsuz döngü > veri kaybı)
//   · DB'ye bağlanamazsa süreç ölmez, DOSYA moduna düşer (M5b felsefesi)
//   · kuyruğa eklemek I/O YAPMAZ (tick güvenliği: aksi hâlde oyun loop'u bloklanırdı)
//
// Koşum: node backend/scripts/test-store.mjs   (ya da npm run test-store)

import { Store } from '../src/store.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const section = (t) => console.log(`\n[${t}]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sahte pg sürücüsü — gerçek bağlantı YOK, yalnız sorgu kaydı + istenen hata enjeksiyonu.
// ---------------------------------------------------------------------------
class FakePool {
  constructor(cfg) { this.cfg = cfg; this.calls = []; this.ended = false; FakePool.last = this; }
  async query(sql, params) {
    this.calls.push({ sql, params });
    if (this.failRegex && this.failRegex.test(sql)) throw new Error('sahte DB hatasi');
    if (/^\s*SELECT star_id/i.test(sql)) return { rows: this.rows || [] };
    return { rows: [] };
  }
  async end() { this.ended = true; }
}
FakePool.last = null;
// DİKKAT: `Store.init()` kendi havuzunu ÜRETİR (`new poolFactory(...)`) — testin tuttuğu nesne ile
// Store'un kullandığı nesne AYNI olmalı. Bu yüzden test "en son üretilen havuz"a proxy ile bakar;
// tohum ayarları prototype'a yazılır (tüm örnekler görsün).
const newFake = (opts = {}) => {
  FakePool.prototype.rows = opts.rows || [];
  FakePool.prototype.failRegex = opts.failRegex || null;
  FakePool.last = null;
  return new Proxy({}, { get: (_t, k) => FakePool.last[k] });
};
const quiet = { log() {}, warn() {}, error() {} };

const tempDir = () => mkdtempSync(join(tmpdir(), 'astro-store-'));

// ===========================================================================
// 1) DOSYA MODU — bugünkü yerel davranış korunuyor mu?
// ===========================================================================
section('dosya modu (DATABASE_URL yok)');
{
  const dir = tempDir();
  const store = new Store({ url: '', dataDir: dir, logger: quiet });
  const mode = await store.init();
  ok('mod file', mode === 'file', `-> ${mode}`);

  store.queueDestroyedStar(42);
  store.queueDestroyedStar(42);   // aynı yıldız iki kez: tek kayıt olmalı
  store.queueDestroyedStar(7);
  ok('kuyruk bekliyor (henüz yazılmadı = tick güvenli)', store.pending.destroyed === 2, JSON.stringify(store.pending));
  ok('kuyrukta I/O yok (dosya henüz yok)', !existsSync(join(dir, 'destroyed_stars.json')));

  store.queueTelemetry([{ kind: 'test', playerId: 'p1', data: { a: 1 }, ts: Date.now() }]);
  await store.flushOnce();

  const set = store.readDestroyedFileSet();
  ok('yıldızlar dosyaya yazıldı', set.has(42) && set.has(7) && set.size === 2, `size=${set.size}`);
  ok('telemetry NDJSON yazıldı', readFileSync(join(dir, 'telemetry.ndjson'), 'utf8').includes('"kind":"test"'));
  ok('kuyruklar boşaldı', store.pending.destroyed === 0 && store.pending.telemetry === 0);
  ok('sayaçlar', store.written.destroyed === 2 && store.written.telemetry === 1, JSON.stringify(store.written));

  const again = await store.loadDestroyedStars();
  ok('geri okuma', again.has(42) && again.has(7));
  await store.close();
}

// ===========================================================================
// 2) PG MODU (sahte sürücü) — sorgu metni + parametreler
// ===========================================================================
section('pg modu (sahte sürücü)');
{
  const pool = newFake({ rows: [{ star_id: 5 }, { star_id: 900 }] });
  const store = new Store({ url: 'postgres://sahte/db', poolFactory: FakePool, dataDir: tempDir(), logger: quiet });
  const mode = await store.init();
  ok('mod pg', mode === 'pg', `-> ${mode}`);
  ok('şema kuruldu (2 tablo IF NOT EXISTS)',
    pool.calls.filter((c) => /CREATE TABLE IF NOT EXISTS/.test(c.sql)).length === 2,
    JSON.stringify(pool.calls.map((c) => c.sql.slice(0, 30))));
  ok('tablolar: destroyed_stars + telemetry_events',
    /destroyed_stars/.test(pool.calls[0].sql) && /telemetry_events/.test(pool.calls[1].sql));

  const seeded = await store.loadDestroyedStars();
  ok('DB tohumu okundu', seeded.has(5) && seeded.has(900) && seeded.size === 2);
  ok('load sorgusu SELECT star_id ...', /SELECT star_id FROM destroyed_stars/.test(pool.calls.find((c) => /SELECT star_id/.test(c.sql)).sql));

  const before = pool.calls.length;
  store.queueDestroyedStar(11);
  store.queueDestroyedStar(12);
  store.queueDestroyedStar(11);   // yineleme
  ok('kuyrukta I/O yok (sorgu sayısı artmadı)', pool.calls.length === before);
  await store.flushOnce();
  const ins = pool.calls.slice(before).find((c) => /INSERT INTO destroyed_stars/.test(c.sql));
  ok('yıldız TEK sorgu + unnest', !!ins && /unnest\(\$1::int\[\]\)/.test(ins.sql));
  ok('yıldız ON CONFLICT (yineleme patlamasın)', !!ins && /ON CONFLICT \(star_id\) DO NOTHING/.test(ins.sql));
  ok('yıldız parametreleri benzersiz [11,12]',
    !!ins && ins.params[0].length === 2 && ins.params[0].includes(11) && ins.params[0].includes(12),
    JSON.stringify(ins && ins.params));

  const b2 = pool.calls.length;
  store.queueTelemetry([
    { kind: 'mine', playerId: 'p9', data: { rock: 3 }, ts: 1700000000000 },
    { kind: 'admin_command', playerId: 'admin', data: { op: 'kill_player' }, ts: 1700000001000, critical: true },
  ]);
  await store.flushOnce();
  const tins = pool.calls.slice(b2).find((c) => /INSERT INTO telemetry_events/.test(c.sql));
  ok('telemetry TEK multi-INSERT', !!tins && /VALUES \(\$1, \$2, \$3, \$4, \$5::jsonb\),\(\$6/.test(tins.sql), tins && tins.sql);
  ok('telemetry parametreleri (10 = 2 kayıt x 5)', !!tins && tins.params.length === 10, `len=${tins && tins.params.length}`);
  ok('critical bayrağı taşındı', !!tins && tins.params[8] === true && tins.params[3] === false);
  ok('JSONB veri metinleştirildi', !!tins && typeof tins.params[4] === 'string' && tins.params[4].includes('rock'));

  const st = store.stats();
  ok('stats: mod + yazılan sayılar', st.mode === 'pg' && st.written.destroyed === 2 && st.written.telemetry === 2, JSON.stringify(st));
  ok('stats sır sızdırmaz (yalnız mod/sayaç)', !JSON.stringify(st).includes('postgres://'));
  await store.close();
  ok('close() havuzu kapattı', pool.ended === true);
}

// ===========================================================================
// 3) DAYANIKLILIK — DB yok/bozuk olsa bile OYUN ÖLMEZ
// ===========================================================================
section('dayaniklilik');
{
  const dir = tempDir();
  // Şema sorgusu patlasın (DB erişilemez / ömrü dolmuş Render Postgres senaryosu).
  FakePool.prototype.failRegex = /CREATE TABLE/;
  const S = new Store({ url: 'postgres://sahte/db', poolFactory: FakePool, dataDir: dir, logger: quiet });
  const mode = await S.init();
  FakePool.prototype.failRegex = null;
  ok('şema hatasında mod file\'a düştü', mode === 'file', `-> ${mode}`);
  ok('düşüş kaydedildi (failed++ + lastError)', S.failed === 1 && /pg init/.test(S.lastError || ''), `${S.failed} / ${S.lastError}`);
  ok('mod isteği kayıtlı (teşhis: pg istendi)', S.requestedMode === 'pg' && S.stats().requested === 'pg');

  // Dosya modunda da çalışmaya devam etmeli (oyun oynanabilir kalır).
  S.queueDestroyedStar(3);
  await S.flushOnce();
  ok('düşüş sonrası yazım çalışıyor', S.readDestroyedFileSet().has(3));
  await S.close();
}

// ===========================================================================
// 4) YAZMA HATASI — batch geri kuyruğa KONMAZ (sonsuz döngü yok), görünür kalır
// ===========================================================================
section('yazma hatası politikası');
{
  const store = new Store({ url: 'postgres://sahte/db', poolFactory: FakePool, dataDir: tempDir(), logger: quiet });
  FakePool.prototype.failRegex = null;
  await store.init();
  FakePool.prototype.failRegex = /INSERT INTO/;
  store.queueTelemetry([{ kind: 'x', playerId: 'p', data: {}, ts: Date.now() }]);
  store.queueDestroyedStar(77);
  await store.flushOnce();   // 1. deneme: başarısız
  ok('hata sayıldı (failed=2)', store.failed === 2, `failed=${store.failed}`);
  ok('son hata görünür', /destroyed|telemetry/.test(store.lastError || ''), `${store.lastError}`);
  ok('telemetry hemen düşülür (kuyrukta beklemez)', store.pending.telemetry === 0, JSON.stringify(store.pending));
  ok('yıldız BİR KEZ daha denenir (geçici kesintiyi kurtarır)', store.pending.destroyed === 1, JSON.stringify(store.pending));
  await store.flushOnce();   // 2. ardışık başarısızlık → düşülür
  FakePool.prototype.failRegex = null;
  ok('ikinci başarısızlıkta kayıt düşülür (sonsuz döngü YOK)', store.pending.destroyed === 0, JSON.stringify(store.pending));
  ok('hata sonrası yazım toparlanır (bir sonraki flush başarılı)',
    await (async () => { store.queueDestroyedStar(78); await store.flushOnce(); return store.pending.destroyed === 0; })());
  await store.close();
}

// ===========================================================================
// 5) OTOMATİK FLUSH — startAutoFlush kuyruğu kendiliğinden boşaltır
// ===========================================================================
section('otomatik flush');
{
  const dir = tempDir();
  const store = new Store({ url: '', dataDir: dir, logger: quiet });
  await store.init();
  store.startAutoFlush(60);   // testte hızlı
  store.queueDestroyedStar(1234);
  await sleep(180);
  store.stopAutoFlush();
  ok('zamanlayıcı kuyruğu boşalttı', store.readDestroyedFileSet().has(1234), JSON.stringify(store.pending));
  await store.close();
}

console.log(`\nTEST-STORE ${pass}/${pass + fail}${fail ? ' — BASARISIZ' : ' — BASARILI'}`);
process.exit(fail ? 1 : 0);
