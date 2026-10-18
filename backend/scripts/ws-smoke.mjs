// =============================================================================
// ws-smoke — CANLI/HEDEF sunucuya gerçek WebSocket bağlantısı kurup `sn` paketini doğrular.
// =============================================================================
// AI'A NOT: Neden ayrı bir sınama? `curl` yalnız HTTP katmanını görür; oyunun taşındığı katman
// WebSocket'tir. Bulut platformları (Back4App/Render/Cloud Run) `$PORT` verir ve trafiği oraya
// yönlendirir — "imaj derlendi" demek "oyun oynanabilir" demek DEĞİLDİR. Bu betik bağlanır,
// ilk `sn` (snapshot) paketini bekler ve sunucu-otoriter alanların GERÇEKTEN geldiğini kanıtlar
// (boş paket yeterli değil: jumpRange sayı, recipes/items dizi olmalı).
//
// KULLANIM:
//   node backend/scripts/ws-smoke.mjs                                  # ws://127.0.0.1:8081
//   WS_URL=ws://127.0.0.1:18080 node backend/scripts/ws-smoke.mjs      # ikinci örnek / $PORT taklidi
//   WS_URL=wss://astrovector-xxx.code.run node backend/scripts/ws-smoke.mjs   # CANLI hedef
//
// Çıkış kodu 0 = akış çalışıyor, 1 = başarısız (sebebi yazdırır).
import WebSocket from 'ws';

const url = process.env.WS_URL || 'ws://127.0.0.1:8081';
const t0 = Date.now();
let done = false;

const ws = new WebSocket(url);
const fail = (why) => {
  if (done) return; done = true;
  console.log(`SONUC: BASARISIZ — ${why}`);
  try { ws.terminate(); } catch {}
  process.exit(1);
};
const timer = setTimeout(() => fail(`${Date.now() - t0}ms içinde 'sn' paketi gelmedi`), 12000);

ws.on('open', () => console.log(`baglanti kuruldu: ${url}  (${Date.now() - t0}ms)`));
ws.on('error', (e) => fail(`soket hatasi: ${e.message}`));
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.t !== 'sn' || done) return;
  done = true; clearTimeout(timer);
  console.log(`sn alindi  (${Date.now() - t0}ms)`);
  console.log(`  anahtarlar : ${Object.keys(m).sort().join(',').slice(0, 160)}`);
  console.log(`  jumpRange  : ${m.jumpRange}`);
  console.log(`  fuel/tank  : ${m.fuel}/${m.fuelMax}`);
  console.log(`  recipes    : ${Array.isArray(m.recipes) ? m.recipes.length : 'YOK'}`);
  const itemsOk = !!m.items && typeof m.items === 'object' && Object.keys(m.items).length > 0;
  console.log(`  items      : ${itemsOk ? `${Object.keys(m.items).length} kalem` : 'YOK'}`);
  const ok = typeof m.jumpRange === 'number' && Array.isArray(m.recipes) && itemsOk;
  console.log(ok
    ? 'SONUC: BASARILI — WebSocket akisi ve sunucu-otoriter alanlar saglam'
    : 'SONUC: BASARISIZ — sn eksik alanlarla geldi');
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
});
