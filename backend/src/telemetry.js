// AI'A NOT: telemetry.js — DB'yi YORMAYAN ANALYTICS YAZIMI.
//
// MANTIK (bkz. MIMARI_VE_GOREVLER.md §Telemetry):
//   Oyuncu eylemi ──▶ in-memory queue (max 1000) ──▶ 5 sn'de bir VEYA 200 item dolunca
//                     tek multi-INSERT / tek transaction ile Supabase'e yazılır.
//   Kritik eventler (yıldız yok etme) queue'yı BYPASS eder → anında DB.
//
// NEDEN ÖNEMLİ: 1000 oyuncu * 10 eylem/sn = 10K insert/sn → Postgres ölür.
// Batch'lenince: 10K insert/sn, 5 sn'de bir 1000'lik 20 sorguya iner → DB nefes alır.
//
// NOT (M3a GÜNCEL): flush artık GERÇEK kalıcı depoya yazıyor. Kuyruk mimarisi aynı kaldı:
//       record() hâlâ tick'ten çağrılabilen tek metod ve saf senkron push; gerçek yazım
//       store.flushOnce() içinde (kendi 5 sn'lik zamanlayıcısı) olur.
//       Depo yoksa (bağlanmadıysa) eski davranış: console'a loglanır.

const MAX_QUEUE = 1000;
const FLUSH_THRESHOLD = 200;

export class Telemetry {
  constructor() {
    this.queue = [];
    this.dropped = 0; // kuyruk taşınca atılan event sayısı (admin dashboard'a raporlanır)
    this.store = null; // M3a: kalıcı depo (server.js bağlar)
  }

  // Kalıcı depoyu bağla. Bağlanmazsa telemetry console'a yazar (yerel hızlı koşumlar).
  useStore(store) { this.store = store; }

  // AI'A NOT: record — OYUN LOOP'UNDAN ÇAĞRILABİLECEK TEK METOD ve saf sync push (<1µs).
  // Asla await/IO içermez; gerçek DB yazımı yalnız flush'ta, timer'ın kendi çağrısında olur.
  record(kind, playerId, data = {}) {
    if (this.queue.length >= MAX_QUEUE) {
      // Kuyruk taşarsa en eski %10 atılır: telemetry veri kaybı kabul edilebilir,
      // oyun state kaybı asla kabul edilmez. Memory şişmesindense eski veriyi feda et.
      this.queue.splice(0, Math.floor(MAX_QUEUE / 10));
      this.dropped++;
    }
    this.queue.push({ kind, playerId, data, ts: Date.now() });
    if (this.queue.length >= FLUSH_THRESHOLD) this.flush(); // fire-and-forget (aşağıda async)
  }

  // Kritik eventler: yıldız yok etme, admin komutları, ödemeler.
  // AI'A NOT: Bunlar kuyruğa girmez — DB'ye ANINDA yazılır ama game loop'u blocklamaz:
  //   flush hemen başlar ama fire-and-forget; hata sadece loglanır, oyun devam eder.
  critical(kind, playerId, data = {}) {
    const item = { kind, playerId, data, ts: Date.now(), critical: true };
    // Yerelde görünürlük şart: kritik event her modda console'a da düşer.
    console.log(`[TELEMETRY-CRITICAL]`, item);
    if (this.store) this.store.queueTelemetry([item]); // `critical:true` DB'de ayrı sorgulanır
  }

  // AI'A NOT: flush — snapshot al, kuyruğu temizle, sonra yaz. Yazma sırasında yeni
  // record'lar temiz kuyruğa düşebilir (race yok: sync snapshot, async write).
  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    this._write(batch);
  }

  // AI'A NOT: _write — Milestone 3'te: supabase.from('telemetry').insert(batch) tek sorguda.
  // Şu an mock: sadece sayar. YAZMA HATASI OLURSA batch kuyruğa GERİ konmaz (sonsuz loop riski);
  // kayıp kabul edilir + dropped sayacı artar — admin dashboard'da görülür.
  _write(batch) {
    // M3a: kalıcı depo bağlıysa ona devret — bu metodun kendisi I/O YAPMAZ (tick içinden
    // çağrılan flush() tick'i bloklamamalı). Gerçek yazım store.flushOnce() içinde olur.
    if (this.store) {
      this.store.queueTelemetry(batch);
      console.log(`[TELEMETRY] ${batch.length} events -> store (mod ${this.store.mode}; dropped ${this.dropped})`);
      return;
    }
    console.log(`[TELEMETRY] flushing ${batch.length} events (dropped total: ${this.dropped})`);
  }

  // Graceful shutdown için senkron boşaltım. Kuyruk depoya devredilir; gerçek yazımı
  // server.js'teki `await store.close()` yapar (SIGTERM handler'ı senkron kalmak zorunda).
  flushSync() {
    const batch = this.queue.splice(0, this.queue.length);
    if (this.store) {
      this.store.queueTelemetry(batch);
      console.log(`[TELEMETRY-SHUTDOWN] ${batch.length} events -> store (kapanista yazilacak)`);
      return;
    }
    console.log(`[TELEMETRY-SHUTDOWN] ${batch.length} events discarded to log`);
  }
}