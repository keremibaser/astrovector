// AI'A NOT: gen-map.mjs — yıldız haritasını JSON olarak diske yazar.
// Çalıştırma: npm run genmap   (veya: node backend/scripts/gen-map.mjs)
//
// Çıktı: game-client/starmap.json — statik dosya, GitHub Pages/Cloudflare Pages'e
// index.html ile birlikte gider ve CDN tarafından cache'lenir (sıfır server maliyeti).
// Server ise gömülü deterministik üreticiyi (galaxy.js) kullanır — JSON'a bağımlı DEĞİL,
// böylece dosya silinse bile warp doğrulaması çalışır.

import { writeFileSync, mkdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateGalaxy, GALAXY_SEED } from '../src/galaxy.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dir, '../../game-client/starmap.json');

const g = generateGalaxy();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(g));

const kb = (statSync(outPath).size / 1024).toFixed(1);
const anomalies = g.stars.filter(s => s.a).length;
const withBelts = g.stars.filter(s => s.b > 0).length;
console.log(`starmap.json yazildi: ${outPath}`);
console.log(`  seed=${GALAXY_SEED}  yildiz=${g.count}  boyut=${kb} KB`);
console.log(`  anomali=${anomalies}  asteroid kusagi olan sistem=${withBelts}`);
