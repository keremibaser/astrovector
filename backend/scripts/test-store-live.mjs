// =============================================================================
// AI'A NOT: test-store-live.mjs — GERÇEK Postgres round-trip + cross-restart test.
//
// `test-store.mjs` SAHTE havuzla SQL metnini kanıtlar; BU script GERÇEK `pg`
// sürücüsüyle aynı prod bağlantı dizesine yazar, iki ayrı Store örneği arasında
// (soğuk yeniden başlangıç taklidi) satırın kalıcı kaldığını doğrular.
//
// CI-EMİN: DATABASE_URL yoksa SKIP (process.exit 0). Yalnizca geliştirici env'inde
// veya `DATABASE_URL=...` ile manuel koşturulduğunda çalışır. Docker imjasından
// dışarıda (backend/scripts/ .dockerignore'da).
//
//    set DATABASE_URL=<Render DB "Connection Details" sayfasındaki URL>
//    node backend/scripts/test-store-live.mjs
//
// Güvenlik: sır ASLA loglanmaz; eklenen 'live_probe' satırı test sonunda
// DELETE ile temizlenir → prod veriye etki yoktur.
// -----------------------------------------------------------------------------
import { Store } from '../src/store.js';
import { readFileSync } from 'fs';

const KIND = 'live_probe';

// env var, yoksa yerel .env (gitlenmez). Sıraya göre oku — değeri asla basilmaz.
let url = process.env.DATABASE_URL || process.env.DATABASE_URL_RENDER;
if (!url) {
  for (const p of ['.env', 'backend/.env']) {
    try {
      for (const ln of readFileSync(p, 'utf8').split('\n')) {
        if (ln.startsWith('DATABASE_URL=')) url = ln.slice('DATABASE_URL='.length).trim();
        if (ln.startsWith('DATABASE_URL_RENDER=')) url = ln.slice('DATABASE_URL_RENDER='.length).trim();
      }
    } catch {}
  }
}
if (!url) {
  console.log("[test-store-live] SKIP: DATABASE_URL yok → yerel file modundasın. Gerçek pg testi için Render Postgres Connection Details URL'ini env ya da .env dosyanla birlikte koy, yeniden dene.");
  process.exit(0);
}

const log = {
  log: (...a) => console.log('[store]', ...a),
  warn: (...a) => console.warn('[store]', ...a),
};

(async () => {
  // --- 1. Instance: init + gerçek INSERT ---
  const s = new Store({ url, logger: log });
  await s.init();
  if (s.mode !== 'pg') {
    console.error('[FAIL] Store pg moda düştü →', s.lastError || 'bilinmedi');
    console.error('       (Render Postgres IP-izin listesinde olabilirsin; erişim engelli ise bu normaldir.)');
    process.exit(1);
  }
  console.log('[1] Store pg modda (mode=' + s.mode + ', requested=' + s.requestedMode + ') — bağlantı kuruldu, şema hazır.');

  s.queueTelemetry([{ kind: KIND, playerId: 'p', data: { op: 'galaxy_overview', verified: true }, critical: true, ts: Date.now() }]);
  await s.flushOnce();          // tek multi-INSERT
  const a = s.stats();
  console.log('[2] yazım sonrası stats:', JSON.stringify(a));
  if (a.written.telemetry !== 1) { console.error('[FAIL] written.telemetry != 1 ->', a.written.telemetry); process.exit(1); }
  if (a.failed !== 0 || a.pending.telemetry !== 0) { console.error('[FAIL] pending/failed != 0'); process.exit(1); }

  await s.close();              // pool.end → process sonlanır (soğuk yeniden başlangıç simülasyonu)

  // --- 2. Instance: YENİ process — INSERT yok mu, yoksa onunla mı geçen? ---
  const s2 = new Store({ url, logger: log });
  await s2.init();
  const r = await s2.pool.query('SELECT count(*) AS n FROM telemetry_events WHERE kind=$1', [KIND]);
  const count = Number(r.rows[0].n);
  console.log('[3] yeni bağlantıda events satırı sayısı:', count);
  if (count !== 1) { console.error('[FAIL] satır yok/gardoldu → kalıcı yazım başarısız:', count); process.exit(1); }

  // --- cleanup: prod tablosunu asanizmayalım ---
  await s2.pool.query('DELETE FROM telemetry_events WHERE kind=$1', [KIND]);
  console.log('[4] canlı probe satırı silindi — prod temiz.');
  await s2.close();

  console.log('[OK] test-store-live: gerçek pg INSERT → soğuk-restart simülasyonu → SELECT round-trip BAŞARILI.');
  console.log('    → Render Postgres kalıcı yazımı, M3a sözleşmesi canlı onaylandı.');
  process.exit(0);
})().catch((e) => { console.error('[ERR]', e && e.stack ? e.stack : e); process.exit(1); });
