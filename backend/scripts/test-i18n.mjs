// AI'A NOT: i18n SÖZLEŞME TESTİ — "sunucu metni çevrilmeden ekrana düşmesin" sınıfını kapatır.
// NEDEN VAR (gerçek olay): sunucu `_sys(p, 'refuel_none', 'Doldurulacak DOTERYUM yok...')` diye
// TÜRKÇE düz metin yolluyordu. İstemci kodu sözlükte bulamayınca HAM metni basıyor → İngilizce
// oynayan kullanıcı ekranda Türkçe "DOTERYUM" satırı gördü ("ingilizceye çevrilmemiş").
// Kural: sunucudan gelen HER `sys.code` istemci sözlüğünde EN ve TR olarak BULUNMALI.
// İkinci kural: EN ve TR sözlükleri AYNI anahtar kümesine sahip olmalı (bir dilde eksik anahtar
// sessizce diğer dile düşer → "Türkçe oynarken İngilizce satır" hatası).
import { readFileSync } from 'node:fs';

const rooms = readFileSync(new URL('../src/rooms.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../game-client/index.html', import.meta.url), 'utf8');

const results = [];
const ok = (name, cond, extra = '') => results.push([name, !!cond, extra]);

// --- 1) Sunucudaki metin kodları -------------------------------------------------
// (a) `_sys(player, 'kod', ...)`
const codes = new Set([...rooms.matchAll(/_sys\(\s*[a-zA-Z]+,\s*'([a-z_]+)'/g)].map((m) => m[1]));
// (b) `sysAll(metin, 'kod', ...)` — kod 2. argüman; metin template/çok parçalı olabilir, bu yüzden
// basit regex YETMEZ (ilk argümandaki `,` argüman sınırı sanılır). Küçük bir tarayıcı ile çağrının
// argümanlarını üst-seviye virgüllerden bölüyoruz.
// NEDEN EKLENDİ: bu tarama yoktu ve `anom_solved_all` (Anomali çözüldü anonsu) iki sözlükte de
// EKSİK kaldı → İngilizce oynayan oyuncu ham Türkçe satır gördü. Testin kör noktası kapandı.
function sysAllCodes(src) {
  const out = new Set();
  const re = /sysAll\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, cur = '', i = m.index + m[0].length;
    const args = [];
    let inS = false, inT = false, inB = false;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i], prev = src[i - 1];
      if (inB) { if (c === '`' && prev !== '\\') inB = false; cur += c; continue; }
      if (inS) { if (c === "'" && prev !== '\\') inS = false; cur += c; continue; }
      if (inT) { if (c === '"' && prev !== '\\') inT = false; cur += c; continue; }
      if (c === "'") { inS = true; cur += c; continue; }
      if (c === '`') { inB = true; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) break; }
      if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
      cur += c;
    }
    args.push(cur);
    if (/kind\s*=/.test(args.join(','))) continue;   // fonksiyon TANIMI (`sysAll(text, kind='info'`), çağrı değil
    const code = (args[1] || '').match(/'([a-z_]+)'/);
    if (code) out.add(code[1]);
  }
  return out;
}
const allCodes = sysAllCodes(rooms);
for (const c of allCodes) codes.add(c);
ok('sunucu metin kodu bulundu (sys + sysAll)', codes.size >= 25, `${codes.size} kod (sysAll: ${allCodes.size})`);
ok('sysAll taraması çalışıyor (regex kör kalmadı)', allCodes.size >= 5, [...allCodes].sort().join(' '));

// --- 2) İstemci sözlükleri (üst seviye anahtarlar) ------------------------------
function dictKeys(lang) {
  const i = html.indexOf(`\n  ${lang}: {`);
  if (i < 0) throw new Error('sözlük bulunamadı: ' + lang);
  const s = html.indexOf('{', i);
  let d = 0, j = s;
  for (; j < html.length; j++) {
    if (html[j] === '{') d++;
    else if (html[j] === '}') { d--; if (d === 0) break; }
  }
  const body = html.slice(s + 1, j);
  // Yalnız ÜST SEVİYE (4 boşluklu) anahtarlar: iç içe nesnelerin anahtarları sayılmaz.
  return new Set([...body.matchAll(/^\s{4}([a-z0-9_]+):/gm)].map((m) => m[1]));
}
const EN = dictKeys('en'), TR = dictKeys('tr');
ok('iki dil sözlüğü okundu', EN.size > 100 && TR.size > 100, `en=${EN.size} tr=${TR.size}`);

// --- 3) Sunucu kodları iki dilde de olmalı --------------------------------------
// `chat_*` kodları sunucudan gelir ama istemci sözlüğünde `chat_need_target` gibi FARKLI adlarla
// karşılanır; eşleme listesi burada açıkça tutulur (sessiz istisna yok, belge var).
const ALIAS = { chat_notarget: 'chat_need_target' };
const missingEn = [], missingTr = [];
for (const c of codes) {
  const key = ALIAS[c] || c;
  if (!EN.has(key)) missingEn.push(c);
  if (!TR.has(key)) missingTr.push(c);
}
ok('her sunucu sys kodu EN sözlüğünde var', missingEn.length === 0,
  missingEn.length ? `EKSİK: ${missingEn.join(', ')} (ham Türkçe metin ekrana düşer!)` : `${codes.size} kod`);
ok('her sunucu sys kodu TR sözlüğünde var', missingTr.length === 0,
  missingTr.length ? `EKSİK: ${missingTr.join(', ')}` : `${codes.size} kod`);

// --- 4) EN/TR anahtar PARİTESİ --------------------------------------------------
const onlyEn = [...EN].filter((k) => !TR.has(k));
const onlyTr = [...TR].filter((k) => !EN.has(k));
ok('TR\'de olup EN\'de olmayan anahtar yok (ters fallback)', onlyEn.length === 0,
  onlyEn.length ? `EKSİK EN: ${onlyEn.join(', ')}` : '');
ok('EN\'de olup TR\'de olmayan anahtar yok (TR oynarken İngilizce satır)', onlyTr.length === 0,
  onlyTr.length ? `EKSİK TR: ${onlyTr.join(', ')}` : '');

// --- 5) Kaldırılan mekaniğin sözlük kalıntısı geri gelmesin ---------------------
ok('kaldırılan `refuel_none` (DOTERYUM dönüşümü) sözlükte YOK',
  !EN.has('refuel_none') && !TR.has('refuel_none'));
const staleInServer = /refuel_none/.test(rooms);
ok('sunucu `refuel_none` göndermiyor (M3c: dolum malzeme harcamaz)', !staleInServer);

// ---------------------------------------------------------------------------
const failed = results.filter(([, c]) => !c);
for (const [n, c, e] of results) console.log(`${c ? 'GECTI  ' : 'BASARISIZ'} ${n}${e ? '  — ' + e : ''}`);
console.log(`\nSONUC: ${results.length - failed.length}/${results.length} kontrol gecti`);
process.exit(failed.length ? 1 : 0);
