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
// NOT: Şu an flush console.log yapar. Milestone 3'te Supabase client bağlanınca
//       gerçek INSERT'e dönüşecek — flush() içi tek değişecek, kuyruk mimarisi aynı kalır.

const MAX_QUEUE = 1000;
const FLUSH_THRESHOLD = 200;

export class Telemetry {
  constructor() {
    this.queue = [];
    this.dropped = 0; // kuyruk taşınca atılan event sayısı (admin dashboard'a raporlanır)
  }

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
    // Milestone 3: Supabase'e direkt insert (async, catch'li). Şimdilik console.
    console.log(`[TELEMETRY-CRITICAL]`, item);
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
    // TODO Milestone 3: gerçek Supabase INSERT buraya.
    console.log(`[TELEMETRY] flushing ${batch.length} events (dropped total: ${this.dropped})`);
  }

  // Graceful shutdown için senkron boşaltım (async DB'ye yazılamıyorsa log'a düşer).
  flushSync() {
    const batch = this.queue.splice(0, this.queue.length);
    console.log(`[TELEMETRY-SHUTDOWN] ${batch.length} events discarded to log`);
    // TODO Milestone 3: burada await supabase insert (shutdown handler await'lenebilir yapılacak).
  }
}