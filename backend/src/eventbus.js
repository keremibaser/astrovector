// AI'A NOT: eventbus.js — Admin "Tanrı Modu" Inspection'ın veri kaynağı.
//
// MİMARİ (bkz. MIMARI_VE_GOREVLER.md §Admin Inspection):
//   Room tick'i zaten ürettiği eventleri buraya push eder (push maliyeti: bir array push).
//   Admin inspect istediğinde BUFFER'DAN filtreleyip okuruz — ekstra hesap YOK.
//   Bu "tap-based" desen sayesinde admin veri çekerken oyuncu loop'u SIFIR ekstra iş yapar.
//
// Ring buffer: sabit kapasite (500), dolunca en eskisi üzerine yazılır → memory sabit.
// Her event bir artan `seq` alır → admin stream'i "son okuduğu yerden devam" edebilir.

export class EventBus {
  constructor(capacity = 500) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;      // bir sonraki yazım index'i
    this.seq = 0;       // toplam üretilen event sayısı (monotonik artar)
  }

  // AI'A NOT: push — OYUN LOOP'UNDAN çağrılır, MUTLAKA sync ve O(1) olmalı.
  push(ev) {
    ev.seq = this.seq++;
    this.buffer[this.head] = ev;
    this.head = (this.head + 1) % this.capacity;
  }

  // Admin inspect başlarken: hedefin son N eventini (seq'e göre eski→yeni sıralı) döndür.
  query({ kind, id, last = 20, since = null }) {
    const out = [];
    // AI'A NOT: Buffer'ı baştan sona değil, head'den geriye doğru gez — en yeniler önce.
    // since verilmişse sadece seq > since olanlar (stream devamı); yoksa son `last` adet.
    const scanLimit = since != null ? this.capacity : last;
    for (let i = 0, scanned = 0; i < this.capacity && scanned < scanLimit; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const ev = this.buffer[idx];
      if (!ev) break;
      scanned++;
      if (ev.seq <= (since ?? -1)) continue;
      if (kind && ev.kind !== kind) continue;
      if (id && ev.targetId !== id && ev.actorId !== id) continue;
      out.push(ev);
      if (out.length >= last) break;
    }
    return out.reverse(); // eski→yeni akış sırası
  }

  // Admin stream'in kaldığı yeri işaretlemek için güncel seq.
  cursor() { return this.seq; }

  // Admin dashboard için özet.
  stats() { return { capacity: this.capacity, totalEvents: this.seq }; }
}