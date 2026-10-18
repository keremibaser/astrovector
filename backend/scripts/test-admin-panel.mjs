// AI'A NOT: admin-client/index.html'in KENDİ JS'ini, gerçek bir WebSocket'e karşı Node'da
// çalıştıran izole test harness'i. Neden: admin paneli gerçek anahtarı ister ve gerçek
// anahtar okunamaz (maskeleme) — bu yüzden AYRI bir test sunucusu (kendi bildiğim anahtarla,
// 8091/8092 portlarında) ayağa kaldırılıp panel kodu o sunucuya yönlendirilir.
// Panel kodu DEĞİŞTİRİLMEZ; yalnız document/localStorage/WebSocket global'leri taklit edilir.
// Doğrulanan: auth handshake → list_players isteği → oyuncu satırlarının DOM'a render edilmesi.

import { readFileSync } from 'fs';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_KEY = 'testkey_' + Math.random().toString(36).slice(2, 10);
const P_ADMIN = 8091, P_GAME = 8092;

// --- 1) Test sunucusu: kendi anahtarı ve portları ile ayrı instance ---
const srv = spawn(process.execPath, [resolve(root, 'backend/server.js')], {
  env: { ...process.env, ADMIN_SECRET_KEY: TEST_KEY, PORT_ADMIN: String(P_ADMIN), PORT_GAME: String(P_GAME) },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(1200);

// --- 2) Test sunucusuna bir oyuncu bağla ki liste boş olmasın ---
const g = new WebSocket(`ws://localhost:${P_GAME}`);
await new Promise(r => g.on('open', r));
await sleep(300);

// --- 3) Panel kodunu çıkar ---
const html = readFileSync(resolve(root, 'admin-client/index.html'), 'utf8');
const i = html.lastIndexOf('<script>');
const body = html.slice(i + 8, html.indexOf('</script>', i));

// --- 4) Minimal DOM + localStorage taklidi ---
// AI'A NOT: CANLI ODA RENDER'I (kullanıcı isteği: "admin ekranında oyunun direkt görünmesi
// lazım, sadece tablo değil, direkt odayı renderlamalı canlı"). Panel artık 'adm:room' paketinde
// canvas'a çiziyor; bu yüzden getContext('2d') DÖNDÜREN bir taklit ŞART — yoksa işleyici
// TypeError ile patlar ve tablolar/legend hiç çizilmez (test yalancı negatif verir). Çizim
// çağrıları no-op'a bağlanır: burada amaçlanan DOM/VERİ akışını doğrulamak.
function makeCtx() {
  return new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (t[k] = () => {})),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', className: '',
    style: {}, disabled: false, children: [],
    width: 880, height: 470,          // canvas boyutları (drawRoom okur)
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); this.innerHTML += c.innerHTML; },
    querySelectorAll: () => [],
    addEventListener() {}, focus() {},
    getContext: () => (el._ctx ??= makeCtx()),
  };
  return el;
}
const els = {};
const document = {
  getElementById: (id) => (els[id] ??= makeEl(id)),
  createElement: (t) => makeEl('<' + t + '>'),
  querySelectorAll: () => [],
};
const store = { astrovector: undefined };
const localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
};
// Anahtarı önceden koy → panel açılışta otomatik bağlanır (gerçek akışın aynısı).
store['astrovector.adminKey'] = TEST_KEY;

// WebSocket'i 8090 → 8091 yönlendir (panel kodu URL'yi sabit tutar).
const RealWS = WebSocket;
const WS = function (url) { return new RealWS(url.replace(`:8090`, `:${P_ADMIN}`)); };

// --- 5) Panel kodunu çalıştır ---
new Function('document', 'localStorage', 'WebSocket', 'alert', 'confirm', body)(
  document, localStorage, WS, () => {}, () => true,
);

await sleep(1500);

// --- 6) Sonuçları kontrol et ---
const stats = els['stats']?.textContent ?? '';
const players = els['players']?.innerHTML ?? '';
const rooms = els['rooms']?.innerHTML ?? '';
const keyboxHidden = els['keybox']?.style.display === 'none';
console.log('auth sonrasi stats alani dolu mu :', stats.includes('seed') ? 'EVET' : 'HAYIR', `(${stats.replace(/\s+/g, ' ').slice(0, 80)})`);
console.log('anahtar kutusu gizlendi mi       :', keyboxHidden ? 'EVET' : 'HAYIR');
console.log('oyuncu satiri render edildi mi   :', players.includes('callsign') || /[A-Z]+-[A-Z0-9]{4}/.test(players) ? 'EVET' : 'HAYIR');
console.log('render edilen liste              :', players.replace(/<br>/g, ' | ').replace(/<[^>]+>/g, '').trim());
console.log('localStorage anahtari saklandi mi:', store['astrovector.adminKey'] === TEST_KEY ? 'EVET' : 'HAYIR');

// --- 7) ODA LİSTESİ + ODA SEÇİMİ (yeni: "oda seçme olsun, her şey görünsün") ---
const roomsOk = /oyuncu \d+/.test(rooms) && /kaya \d+/.test(rooms);
console.log('oda listesi render edildi mi     :', roomsOk ? 'EVET' : 'HAYIR');
console.log('render edilen odalar             :', rooms.replace(/<br>/g, ' | ').replace(/<[^>]+>/g, '').trim().slice(0, 160));

// Satıra tıkla → panel 'room_detail' ister (gerçek kullanıcı akışının aynısı).
const row0 = (els['rooms']?.children ?? [])[0];
if (row0 && typeof row0.onclick === 'function') row0.onclick();
await sleep(800);
const rv = els['roomView']?.innerHTML ?? '';
const detailOk = /Oyuncular/.test(rv) && /Kayalar/.test(rv);
console.log('oda dokumu (room_detail) geldi mi:', detailOk ? 'EVET' : 'HAYIR');
console.log('oda dokumu basligi               :', (rv.match(/<h3>[^<]*<\/h3>/g) || []).join(' ').replace(/<[^>]+>/g, ' '));
console.log('oda dokumunde yakit kolonu var mi:', /yakit/.test(rv) ? 'EVET' : 'HAYIR');
// M2e: panel artık CANLI RENDER ediyor → legend satırı + düşen kapsül tablosu da gelmeli.
const legend = els['roomLegend']?.innerHTML ?? '';
const liveOk = /CANLI/.test(legend) && (els['roomLive']?.style?.display === 'block');
console.log('canli render legend/panel acildi mi:', liveOk ? 'EVET' : 'HAYIR',
  `(legend="${legend.replace(/<[^>]+>/g, '').trim()}")`);
const picksOk = /Dusen kapsuller/.test(rv);
console.log('kapsul bolumu dokumde var mi   :', picksOk ? 'EVET' : 'HAYIR');
const detailOk2 = detailOk && liveOk && picksOk;
const ok = stats.includes('seed') && keyboxHidden && /[A-Z]+-[A-Z0-9]{4}/.test(players) && roomsOk && detailOk2;
console.log(ok ? '\nSONUC: ADMIN PANELI UCTAN UCA CALISIYOR' : '\nSONUC: BASARISIZ');

g.close();
srv.kill();
process.exit(ok ? 0 : 1);
