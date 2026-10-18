// AI'A NOT: store.js — M3a KALICI DEPO KATMANI (kalıcılığın TEK kapısı).
// =============================================================================
// NEDEN VAR: Oyunun bugüne kadar "kalıcı" sandığı tek şey `backend/data/destroyed_stars.json`
// dosyasıydı ve telemetry kuyruğu yalnız console'a yazıyordu (`telemetry.js` TODO'ları). Buluta
// çıkınca iki gerçek ortaya çıktı:
//   1) Render/Back4App gibi platformlarda **dosya sistemi GEÇİCİDİR** ("any changes to your
//      filesystem … are lost every time the service redeploys, restarts, or spins down").
//      Yani dosyaya yazan bir "kalıcılık" bulutta SESSİZCE veri kaybeder — testte çalışır,
//      yayında kaybolur. Kalıcı veri için DIŞ servis şart.
//   2) Oyun loop'u I/O YAPAMAZ (performans sözleşmesi). Eski `saveDestroyedStar()` tam da
//      tick içinden `writeFileSync` çağırıyordu → sözleşme ihlali (bkz. Tuzak 65).
//
// TASARIM — İKİ MOD, TEK ARAYÜZ:
//   · 'pg'   : DATABASE_URL tanımlıysa Postgres (Render Postgres / Supabase — ikisi de Postgres
//              olduğu için sağlayıcı değişse bile KOD DEĞİŞMEZ, yalnız bağlantı dizesi değişir).
//   · 'file' : DATABASE_URL yoksa bugünkü davranış (yerel geliştirme). Aynı arayüz, aynı semantik.
//
// SÖZLEŞMELER:
//   · Oyun loop'undan çağrılan her şey SENKRON ve I/O'suzdur: `queueDestroyedStar`, `queueTelemetry`.
//     Gerçek yazım `flushOnce()` içinde, kendi zamanlayıcısında olur.
//   · DB yoksa/ölürse OYUN ÖLMEZ: `init()` hata verirse dosya moduna DÜŞER ve yüksek sesle uyarır
//     (M5b'deki ADMIN_SECRET_KEY kararının aynı felsefesi: bozuk konfigürasyon oyunu düşürmez).
//   · Yazma hatası olursa batch GERİ KUYRUĞA KONMAZ (sonsuz döngü riski); kayıp kabul edilir,
//     `failed` sayacı artar — teşhis `stats()` / `/healthz` üzerinden GÖRÜNÜR olur.
//
// NEDEN supabase-js DEĞİL: Supabase de Postgres'tir; `DATABASE_URL` ile aynı `pg` sürücüsüyle
// konuşulur. Böylece (a) sağlayıcı seçimi ertelenebilir/kod maliyetsiz değiştirilebilir,
// (b) buluta Supabase anahtarı gömme zorunluluğu kalkar.

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Ardışık yazma başarısızlığında bir kaydın EN FAZLA kaç kez yeniden deneneceği (sonsuz döngü yok).
const MAX_WRITE_ATTEMPTS = 2;

export const SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS destroyed_stars (
     star_id INTEGER PRIMARY KEY,
     destroyed_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS telemetry_events (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     kind TEXT NOT NULL,
     player_id TEXT,
     critical BOOLEAN NOT NULL DEFAULT false,
     data JSONB
   )`,
]);

// `pg` OPSİYONEL bağımlılıktır: dosya modunda hiç yüklenmez (kurulum/derleme yükü yok).
async function loadPgPool() {
  const mod = await import('pg');
  return mod.default ? mod.default.Pool : mod.Pool;
}

export class Store {
  constructor({ url = process.env.DATABASE_URL, poolFactory = null, dataDir = null, logger = console } = {}) {
    this.dataDir = dataDir || join(process.cwd(), 'backend', 'data');
    this.destroyedFile = join(this.dataDir, 'destroyed_stars.json');
    this.telemetryFile = join(this.dataDir, 'telemetry.ndjson');

    this.url = url || null;
    this.mode = this.url ? 'pg' : 'file';   // istenen mod; init() başarısız olursa 'file'a düşer
    this.requestedMode = this.mode;
    this.poolFactory = poolFactory;
    this.pool = null;
    this.log = logger;

    this.destroyedQueue = new Map();  // id -> true (aynı yıldız iki kez yazılmaz)
    this.destroyedAttempts = new Map(); // id -> ardışık başarısız deneme sayısı (retry sınırı için)
    this.telemetryQueue = [];
    this.written = { destroyed: 0, telemetry: 0 };
    this.failed = 0;
    this.lastError = null;

    this._timer = null;
    this._flushing = false;
  }

  // ---------------------------------------------------------------------------
  // KURULUM
  // ---------------------------------------------------------------------------
  async init() {
    if (this.mode === 'file') {
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      return this.mode;
    }
    try {
      const Pool = this.poolFactory || await loadPgPool();
      // Render'ın iç Postgres'i TLS istemez; Supabase ve dış bağlantılar ister → dizeye bakarak karar.
      const ssl = /sslmode=require|supabase\.(co|com)/i.test(this.url) ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({ connectionString: this.url, max: 3, ssl });
      for (const sql of SCHEMA_SQL) await this.pool.query(sql);
      this.log.log(`[STORE] Postgres bagli — tablolar hazir (destroyed_stars, telemetry_events)`);
      return this.mode;
    } catch (err) {
      // BOZUK/SÜRESİ DOLMUŞ DB OYUNU DÜŞÜRMEZ: dosya moduna düş, yüksek sesle uyar.
      this.mode = 'file';
      this.failed++;
      this.lastError = `pg init: ${err.message}`;
      this.log.warn('');
      this.log.warn(`[UYARI] Postgres'e baglanilamadi -> KALICILIK DOSYA MODUNA DUSTU (gecici!).`);
      this.log.warn(`        sebep: ${err.message}`);
      this.log.warn('        Oyun normal calisir; kalici veri bu surecte kaybolabilir.');
      this.log.warn('');
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      return this.mode;
    }
  }

  // ---------------------------------------------------------------------------
  // OYUN LOOP'UNDAN ÇAĞRILANLAR — SENKRON, I/O YOK (<1µs)
  // ---------------------------------------------------------------------------
  queueDestroyedStar(starId) {
    const id = Number(starId);
    if (Number.isFinite(id)) this.destroyedQueue.set(id, true);
  }

  queueTelemetry(items) {
    for (const it of items) this.telemetryQueue.push(it);
  }

  get pending() {
    return { destroyed: this.destroyedQueue.size, telemetry: this.telemetryQueue.length };
  }

  // ---------------------------------------------------------------------------
  // YAZIM (yalnız zamanlayıcıdan / kapanıştan çağrılır)
  // ---------------------------------------------------------------------------
  async flushOnce() {
    if (this._flushing) return false;   // üst üste binmesin
    this._flushing = true;
    try {
      await this._flushDestroyed();
      await this._flushTelemetry();
      return true;
    } finally {
      this._flushing = false;
    }
  }

  async _flushDestroyed() {
    const ids = [...this.destroyedQueue.keys()];
    if (!ids.length) return;
    try {
      if (this.mode === 'pg') {
        // Tek sorgu, dizi parametresi: INSERT ... SELECT unnest(...) ON CONFLICT DO NOTHING
        await this.pool.query(
          'INSERT INTO destroyed_stars (star_id) SELECT * FROM unnest($1::int[]) ON CONFLICT (star_id) DO NOTHING',
          [ids],
        );
      } else {
        const cur = this.readDestroyedFileSet();
        for (const id of ids) cur.add(id);
        writeFileSync(this.destroyedFile, JSON.stringify([...cur]), 'utf8');
      }
      for (const id of ids) this.destroyedQueue.delete(id);
      for (const id of ids) this.destroyedAttempts.delete(id);   // başarılı yazım deneme sayacını sıfırlar
      this.written.destroyed += ids.length;
    } catch (err) {
      // POLİTİKA (testle sabitlendi): sonsuz yeniden deneme YOK — ama yıldız kaydı telemetriden
      // değerlidir, o yüzden BİR KEZ daha denenir (geçici ağ/DB kesintisi kurtulur); ikinci ardışık
      // başarısızlıkta kayıt düşülür ve `failed`/`lastError` ile GÖRÜNÜR kalır.
      this._fail('destroyed', err, ids.length);
      for (const id of ids) {
        const n = (this.destroyedAttempts.get(id) || 0) + 1;
        if (n >= MAX_WRITE_ATTEMPTS) {
          this.destroyedQueue.delete(id);
          this.destroyedAttempts.delete(id);
        } else {
          this.destroyedAttempts.set(id, n);
        }
      }
    }
  }

  async _flushTelemetry() {
    if (!this.telemetryQueue.length) return;
    const batch = this.telemetryQueue.splice(0, this.telemetryQueue.length);
    try {
      if (this.mode === 'pg') {
        const params = [];
        const rows = batch.map((it, i) => {
          const b = i * 5;
          params.push(
            new Date(it.ts || Date.now()).toISOString(),
            String(it.kind),
            it.playerId == null ? null : String(it.playerId),
            !!it.critical,
            JSON.stringify(it.data ?? {}),
          );
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`;
        });
        // TEK multi-INSERT (batch mimarisi): 1000 event = 1 sorgu, DB nefes alır.
        await this.pool.query(
          `INSERT INTO telemetry_events (at, kind, player_id, critical, data) VALUES ${rows.join(',')}`,
          params,
        );
      } else {
        appendFileSync(this.telemetryFile, batch.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8');
      }
      this.written.telemetry += batch.length;
    } catch (err) {
      this._fail('telemetry', err, batch.length);
    }
  }

  _fail(kind, err, count) {
    this.failed++;
    this.lastError = `${kind}: ${err.message}`;
    // Kayıp kabul edilir (kuyruğa geri KOYULMAZ: sonsuz döngü > veri kaybı). Görünür kalır: stats().
    this.log.warn(`[STORE] ${kind} yazilamadi (${count} kayit atildi): ${err.message}`);
  }

  startAutoFlush(ms = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.flushOnce().catch(() => {}); }, ms);
    if (this._timer.unref) this._timer.unref();
  }

  stopAutoFlush() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---------------------------------------------------------------------------
  // OKUMA (yalnız AÇILIŞTA — boot I/O'su serbesttir; tick'te değil)
  // ---------------------------------------------------------------------------
  readDestroyedFileSet() {
    try {
      if (existsSync(this.destroyedFile)) {
        const list = JSON.parse(readFileSync(this.destroyedFile, 'utf8'));
        if (Array.isArray(list)) return new Set(list.map(Number));
      }
    } catch (err) {
      this.log.warn(`[STORE] destroyed_stars okunamadi: ${err.message}`);
    }
    return new Set();
  }

  async loadDestroyedStars() {
    if (this.mode !== 'pg') return this.readDestroyedFileSet();
    try {
      const r = await this.pool.query('SELECT star_id FROM destroyed_stars');
      return new Set(r.rows.map((row) => Number(row.star_id)));
    } catch (err) {
      this._fail('load-destroyed', err, 0);
      return this.readDestroyedFileSet();
    }
  }

  // Teşhis: /healthz bu sayıları yayınlar → "DB gerçekten kullanılıyor mu" sorusu
  // uzaktan, sır paylaşmadan cevaplanabilir.
  stats() {
    return {
      mode: this.mode,
      requested: this.requestedMode,
      pending: this.pending,
      written: { ...this.written },
      failed: this.failed,
      lastError: this.lastError,
    };
  }

  async close() {
    this.stopAutoFlush();
    await this.flushOnce();
    if (this.pool) {
      try { await this.pool.end(); } catch { /* kapanışta hata önemsiz */ }
    }
  }
}
