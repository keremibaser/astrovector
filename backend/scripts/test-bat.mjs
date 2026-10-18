// AI'A NOT: BAT DOSYASI SÖZLEŞME TESTİ — "start.bat hemen kapanıyor" sınıfını kapatır.
// NEDEN VAR (gerçek olay): start.bat'ın REM satırlarına UTF-8 karakter yazıldı (`—`, `→`).
// cmd bu baytları OEM kod sayfasıyla bozuk okudu, bloğu bozdu ve script PARSE aşamasında öldü:
//     kapatildi was unexpected at this time.
// Kullanıcı çift tıklıyor, pencere ANINDA kapanıyor, hiçbir şey çalışmıyor — ve cmd HİÇBİR YERE
// log bırakmadığı için teşhis zor. Bu test üç kuralı zorlar:
//   (1) SAF ASCII: her bayt 0x20-0x7E ya da \t / \r / \n olmalı. Türkçe harf/ok işareti YASAK.
//   (2) CRLF: parantezli bloklarda LF-only satır sonu cmd'yi şaşırtır; .bat CRLF ister.
//   (3) Parantez dengesi: her satırda `(` ve `)` sayısı eşit olmalı (kaçışlı `^(` sayılmaz).
// Ayrıca `timeout` YERİNE `ping -n 2 127.0.0.1` kuralı: MSYS PATH'i öne geçerse coreutils
// `timeout` bulunur ve "/t invalid time interval" hatası verir.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const files = readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.bat'));
const results = [];
const ok = (name, cond, extra = '') => results.push([name, !!cond, extra]);

ok('projede .bat dosyası var', files.length > 0, files.join(', '));

for (const f of files) {
  const raw = readFileSync(join(ROOT, f), 'latin1');
  // (1) ASCII
  const badChars = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 9 && c !== 10 && c !== 13 && (c < 32 || c > 126)) {
      const line = raw.slice(0, i).split('\n').length;
      // eslint-disable-next-line no-control-regex
      badChars.push(`satir ${line} bayt 0x${c.toString(16)}`);
    }
  }
  ok(`${f}: saf ASCII (Türkçe/UTF-8 karakter YOK — cmd bunu bozar)`, badChars.length === 0,
    badChars.length ? badChars.slice(0, 3).join(' | ') + ' → pencere anında kapanır' : '');

  // (2) CRLF
  const lf = (raw.match(/\n/g) || []).length;
  const crlf = (raw.match(/\r\n/g) || []).length;
  ok(`${f}: CRLF satır sonu`, lf > 0 && lf === crlf, `LF=${lf} CRLF=${crlf}`);

  // (3) Parantez DENGESİ — satır satır değil, BLOK bazında: cmd'de bloklar satırlar arasında
  // açılıp kapanır (`for ... do (` / `if ... (` / kapanış `)`). Gerçek kural:
  //   a) derinlik HİÇ NEGATİFE DÜŞMEMELİ (kapatma, açılıştan önce gelmez),
  //   b) dosya sonunda derinlik 0 olmalı (kapanmamış blok = "was unexpected at this time").
  let depth = 0, minDepth = 0, depthErr = '';
  raw.split('\n').forEach((line, i) => {
    if (/^\s*REM\b/i.test(line)) return;
    const opens = (line.replace(/\^\(/g, '').match(/\(/g) || []).length;
    const closes = (line.replace(/\^\)/g, '').match(/\)/g) || []).length;
    depth += opens - closes;
    if (depth < minDepth) { minDepth = depth; if (!depthErr) depthErr = `satir ${i + 1}'de fazladan ) var`; }
  });
  ok(`${f}: parantez/blok dengesi (kapanmamış blok yok)`,
    minDepth === 0 && depth === 0,
    minDepth !== 0 ? depthErr : (depth !== 0 ? `${depth} kapanmamış ( açık kaldı` : ''));

  // (4) `timeout /t` yasak (MSYS coreutils çakışması)
  ok(`${f}: \`timeout /t\` yerine \`ping -n 2\` kullanılmış`,
    !/timeout\s+\/t/i.test(raw));
}

const failed = results.filter(([, c]) => !c);
for (const [n, c, e] of results) console.log(`${c ? 'GECTI  ' : 'BASARISIZ'} ${n}${e ? '  — ' + e : ''}`);
console.log(`\nSONUC: ${results.length - failed.length}/${results.length} kontrol gecti`);
process.exit(failed.length ? 1 : 0);
