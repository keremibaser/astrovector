// AI'A NOT: server.js — TEK GİRİŞ NOKTASI. İki ayrı WebSocket sunucusu var:
//   1) PUBLIC_GAME_WS  (port 8081): oyuncular buraya bağlanır. Sadece oyun mesajları.
//   2) ADMIN_WS        (port 8090): SADECE admin-client (localhost) buraya bağlanır.
//      ADMIN_SECRET_KEY handshake'i zorunlu; yanlış key => socket DERHAL kapanır + IP blacklist 60sn.
//      ADMIN_SECRET_KEY tanimli DEGILSE bu yuva HIC ACILMAZ (bkz. M5b notu: sunucu olmez, uyarir).
// Performans gerekçesi (bkz. MIMARI_VE_GOREVLER.md):
//   - 'ws' kütüphanesi (saf WebSocket) seçildi, Socket.io DEĞİL. Socket.io'nun polling
//     fallback katmanı + event-name overhead'i gereksiz CPU/RAM ve ~100-300ms handshake gecikmesi demek.
//   - Admin inspect PUSH-BASED DEĞİL TAP-BASED: room loop'unun zaten ürettiği eventler
//     eventbus'a (ring buffer) düşer; admin istediğinde buffer filtrelenip akıtılır.
//     => Admin veri çektiğinde OYUNCU LOOP'U HİÇ EKSTRA İŞ YAPMAZ, BLOCKLANMAZ.
//
// ÇALIŞTIRMA: cd backend && npm i && node server.js
// Ayarlar .env'den gelir (bkz. .env.example).

import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomManager } from './src/rooms.js';
import { Telemetry } from './src/telemetry.js';
import { EventBus } from './src/eventbus.js';
import { MSG, ADMIN_MSG } from './src/protocol.js';
import { galaxy, GALAXY_SEED } from './src/galaxy.js';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PORT_GAME = Number(process.env.PORT_GAME || process.env.PORT || 8081);
// AI'A NOT (M5 — PaaS uyumu): Render/Fly/Railway/Heroku tek portu `PORT` ile verir; PORT_GAME
// verilmemişse onu kullanırız. Yerelde .env'de PORT_GAME=8081 olduğu için davranış değişmez.
// AI'A NOT: SUNUCU SÜRÜM DAMGASI. "Sunucu gerçekten yeni kodla mı çalışıyor" sorusu tek bakışta
// cevaplanmalı — eski süreç portu tutarken yeni süreç düşerse (EADDRINUSE) yeni kod HİÇ devreye
// girmez ve bu kullanıcı için görünmez olur (yaşandı). Konsolda bu damga + istemcideki SURUM
// eşleşmiyorsa iki taraf farklı sürümdedir.
const SURUM = '2026-10-18k-M5b';
const PORT_ADMIN = Number(process.env.PORT_ADMIN || 8090);
// AI'A NOT (M5b — PaaS/ücretsiz barındırma): ADMIN_SECRET_KEY .env'de olur ve ASLA repoya girmez.
// Bulut platformlarında (Back4App/Render/Cloud Run) `.env` YOKTUR. Eskiden burada `throw` vardı:
// konteyner açılışta çöküp yeniden başlatma döngüsüne giriyordu (ölçüldü — server.js:41).
// Artık anahtar yoksa süreç ÖLMEZ: **admin yuvası hiç açılmaz** ve yüksek sesle uyarılır.
// Bu, güvenlik açısından DAHA SIKIdır (yuvayı hiç açmamak, zayıf/boş bir anahtarla açmaktan iyidir)
// ve oyunu etkilemez. Yerelde admin gerekiyorsa .env'e ADMIN_SECRET_KEY ekle (.env.example).
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;
const ADMIN_ENABLED = !!ADMIN_SECRET;
if (!ADMIN_ENABLED) {
  console.warn('');
  console.warn('[UYARI] ADMIN_SECRET_KEY tanimli degil -> ADMIN PANELI DEVRE DISI.');
  console.warn(`        Oyun normal calisir; admin yuvasi (port ${PORT_ADMIN}) HIC ACILMAZ.`);
  console.warn('        Yerelde admin icin .env dosyasina ADMIN_SECRET_KEY ekle (.env.example).');
  console.warn('');
}

// Geliştirme statik servisi için istemci klasörü + MIME tablosu (bkz. gameHttp).
const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'game-client');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};
// Admin stream throttle: admin insana 4Hz yeter; daha sık event paketlemek sadece CPU israfı.
const ADMIN_STREAM_THROTTLE_MS = 250;
// Eşzamanlı admin inspection stream limiti — sunucuyu yormamak için sert üst sınır.
const MAX_ADMIN_STREAMS = 3;

const rooms = new RoomManager();
const telemetry = new Telemetry();
const eventBus = new EventBus(500); // son 500 event tutulur (ring buffer)

// Basit IP blacklist — üretimde LRU map'e çevrilir.
const blacklist = new Map(); // ip -> unbanTimestamp
// Periyodik temizlik: süresi dolan IP'leri sil (uzun uptimede bellek sızıntısını önler).
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of blacklist) if (ts <= now) blacklist.delete(ip);
}, 60_000);

// ---------------------------------------------------------------------------
// TICK LOOP (10 Hz) — OYUNUN KALBİ
// ---------------------------------------------------------------------------
// AI'A NOT: Bu loop ASLA await'li I/O içERMEZ (DB çağrısı vb). Saf CPU hesabı senkron.
// Herhangi bir async işlem gerekiyorsa telemetry/eventbus KUYRUĞUNA bırakılır.
// Bu kural bozulursa tüm oyuncuların tick'i gecikir — en kritik performans sözleşmesi.
const TICK_MS = 100;
// AI'A NOT (M3f — "saniyede iki fuel" sözleşmesi): tick'e SABİT dt (=TICK_MS/1000) veriliyordu.
// setInterval(100) Windows'ta ortalama ~107-108 ms'de tetiklenir; yani oyun saati duvar saatinden
// ~%7 YAVAŞ akıyordu: dolum nominal 2/sn ölçüldü 1,86/sn (kanıt: ardışık +1 yakıt paketleri
// 539 ms arayla). Kalkan regen (6/sn) dahil TÜM "…/sn" sabitleri aynı oranda sapıyordu.
// Artık GERÇEK geçen süre verilir; 0,25 sn tavanı, tek seferlik uzun bir gecikme (GC, disk, uyku)
// sonrasında oyuncuların ışınlanmasını önler. Sözleşme: "…/sn" değerleri DUVAR SAATİNE göredir.
let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const realDt = Math.min((now - lastTickAt) / 1000, 0.25);
  lastTickAt = now;
  const t0 = Date.now();
  for (const room of rooms.activeRooms()) {
    room.tick(realDt);
    // AI'A NOT: YAKIT DOLUMU (M2e) — Y basılı olan her oyuncu için SÜREKLİ dolum. Kararı sunucu
    // verir (_refuelTick): mesafe/malzeme/depo kapıları orada. tick'in içinde I/O yok kuralı
    // bozulmaz: yalnız durum güncellenir, paketler mevcut tick döngüsünde gönderilir.
    for (const p of room.players.values()) if (p.refuelOn) rooms._refuelTick(p, realDt);
    // Room'un ürettiği eventleri eventbus'a yaz (admin inspection bunları okur).
    for (const ev of room.drainEvents()) eventBus.push(ev);
  }
  const elapsed = Date.now() - t0;
  // AI'A NOT: tick süresi TICK_MS'i geçiyorsa ölçek problemi var demektir → admin'e raporlanır.
  if (elapsed > TICK_MS) console.warn(`[TICK OVERRUN] ${elapsed}ms > ${TICK_MS}ms`);
}, TICK_MS);

// ---------------------------------------------------------------------------
// TELEMETRY FLUSH TIMER — DB'yi yormayan yazım (bkz. MIMARI_VE_GOREVLER.md §Telemetry)
// ---------------------------------------------------------------------------
setInterval(() => telemetry.flush(), 5000);
// Kritik eventler (yıldız yok etme) queue'ya değil direkt DB'ye gider: telemetry.critical(...)
// Bu, game loop'u blocklamaz — flush'u kısa süreli ayrı bir microtask yapar.

// ---------------------------------------------------------------------------
// PUBLIC GAME WEBSOCKET (Oyuncular)
// ---------------------------------------------------------------------------
// AI'A NOT: /starmap.json — client'a yıldız haritası. Deterministik üretilir, İLK istekte
// bellekte cache'lenir. CORS açık: client file:// veya Pages'ten çekebilsin.
// SÜRÜM KURALI (CAN YAKAN HATA): bu yanıt `public, max-age=86400` ile gönderiliyordu. Galaksi
// 4096 → 16384 yıldıza çıkarılınca tarayıcı 24 saat boyunca ESKİ haritayı kullanmaya devam etti:
// istemci kendi yıldızının indeksini eski dizide bulamadı → harita oyuncunun yıldızına
// merkezlenmedi, "SEN" işareti çizilmedi ve warp hedefleri sunucudaki konumlarla uyuşmadı
// ("atlayamıyorum"). Artık sürüm damgası var: `no-cache` + `ETag: "<seed>-<count>"` → tarayıcı
// her açılışta ucuz bir 304 alır, ASLA bayat harita kullanmaz. İstemci ayrıca snapshot'taki
// `map:{seed,count}` ile karşılaştırıp uyuşmazsa sürüm sorgusuyla yeniden çeker.
let starmapCache = null;
let starmapVersion = null;
const gameHttp = createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/starmap.json')) {
    if (!starmapCache) {
      // byId Map'i JSON'a girmesin diye replacer: Map'ler zaten {} olur, açıkça düşürüyoruz.
      const g = galaxy();
      starmapCache = JSON.stringify(g, (k, v) => (k === 'byId' ? undefined : v));
      starmapVersion = `"${g.seed}-${g.count}"`;
    }
    if (req.headers['if-none-match'] === starmapVersion) {
      res.writeHead(304, {
        'ETag': starmapVersion,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'ETag': starmapVersion,
    });
    return res.end(starmapCache);
  }
  // AI'A NOT: GELİŞTİRME STATİK SERVİSİ. Neden: istemciyi file:// yerine AYNI ORIGIN'den
  // (http://localhost:8081/) servis etmek test kancalarının (?probe=1/?map=1) ve
  // starmap.json'un tek adresten çalışmasını sağlar; preview paneli de dosya yoluna
  // ?query eklenince sayfayı bulamıyordu. Yayında istemci statik host'tan (Pages) gider,
  // bu dal sadece geliştirmede devreye girer.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const full = join(CLIENT_DIR, rel);
  // AI'A NOT: path traversal koruması — çözümlenmiş yol CLIENT_DIR dışına çıkmamalı.
  if (full.startsWith(CLIENT_DIR)) {
    try {
      const buf = await readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(rel).toLowerCase()] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        // AI'A NOT (M3e — CAN YAKAN HATA): burada `no-cache` vardı. `no-cache` "önbelleğe alma"
        // demek DEĞİL, "kullanmadan önce doğrula" demektir; sunucu ETag/Last-Modified
        // göndermediği için bazı tarayıcılar sekmeyi yeniden kullanınca (bfcache) ESKİ sayfayı
        // göstermeye devam etti → kullanıcı yeni sunucu + ESKİ istemci kombinasyonuyla oynadı
        // ("Y çalışmıyor, ekranda çevrilmemiş DOTERYUM yazıyor"). Geliştirme istemcisi her
        // yüklemede DİSKTEN okunmalı: `no-store` bunu garanti eder.
        'Cache-Control': 'no-store, must-revalidate',
      });
      return res.end(buf);
    } catch { /* dosya yok → aşağıdaki sağlık yanıtına düşer */ }
  }
  // Sağlık kontrolü; yayında oyun HTML'i statik host'tan (Pages) servis edilir.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`AstroVector game ws ok (seed ${GALAXY_SEED})`);
});
const gameWss = new WebSocketServer({ server: gameHttp, perMessageDeflate: false });
// AI'A NOT: perMessageDeflate: false — deflate her pakette CPU harcar; oyun paketleri zaten
// küçük (diff'ler <100 byte). Sadece snapshot paketleri büyük; onlar tek seferde gider, sıkıştırmaya değer değil.

gameWss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  if ((blacklist.get(ip) || 0) > Date.now()) return ws.close(4003, 'banned');

  // AI'A NOT: Player nesnesi RoomManager'da üretilecek; socket sadece I/O kabuğu.
  const player = rooms.connect(ws, ip);
  if (!player) return ws.close(4001, 'room full'); // tüm belt mirror'ları doluysa

  ws.on('message', (raw) => {
    // AI'A NOT: JSON.parse hatalı pakette throw eder → try/catch ŞART (crash loop'u önler).
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleGameMessage(player, msg);
  });
  ws.on('close', () => rooms.disconnect(player));
  ws.on('error', () => {}); // error sonrası close tetiklenir; yakalanmazsa process çöker

  // Client-authoritative önizleme: client kendi pozisyonunu tahmin eder, server doğrular.
  // Bu yüzden mv mesajına 20/snz rate-limit uygulanır (daha fazlası spam/bot'tur).
  player.lastMsgAt = Date.now();
});

function handleGameMessage(player, msg) {
  // AI'A NOT: Burada tek switch — tüm oyun mesaj tipleri protocol.js'den gelir.
  // Milestone 1'de doldurulacak: mv, fire, tb, warp, chat...
  switch (msg.t) {
    case MSG.MV: rooms.handleMove(player, msg); break;
    case MSG.CHAT: rooms.handleChat(player, msg); break;
    case MSG.FIRE: rooms.handleFire(player, msg); break;
    case MSG.TB: rooms.handleTractorBeam(player, msg); break;
    case MSG.WARP: rooms.handleWarp(player, msg); break;
    case MSG.REFUEL: rooms.handleRefuel(player, msg); break;
    case MSG.CRAFT: rooms.handleCraft(player, msg); break;   // M2h: zanaat
    case MSG.USE: rooms.handleUse(player, msg); break;       // M2h: üretilen eşyayı kullan
    // M4a: ANOMALİ — bu iki satır EKSİKTİ ve tüm anomali özelliği bu yüzden ÖLÜ koddu
    // (protokolde sabit vardı, handler yazılmıştı, ama mesaj hiç yönlendirilmiyordu).
    case MSG.SCAN_ANOM: rooms.handleScanAnomaly(player, msg); break;   // E: frekans ipucu
    case MSG.SOLVE_ANOM: rooms.handleSolveAnomaly(player, msg); break; // R: kodu gir
    // AI'A NOT: HEARTBEAT YANITI ŞART. Client 'hb' gönderip cevap bekliyor. Sunucu sessiz
    // kalırsa client "baglanti oldu" sanıp yeniden bağlanır — ve oyuncu, sabit duran ya da
    // sekmesi arka planda olan (dolayısıyla hiç diff üretmeyen) her oyuncu için sonsuz
    // RECONNECT DÖNGÜSÜ oluşur. Ayrıca gerçek RTT ölçümü de bu yanıta bağlı.
    case MSG.HB: if (player.ws.readyState === 1) player.ws.send(JSON.stringify({ t: 'hb', c: msg.c })); break;
    default: break; // bilinmeyen tip sessizce düşürülür (log spam yok)
  }
}

// ---------------------------------------------------------------------------
// ADMIN WEBSOCKET — TANRI MODU (LOCALHOST ONLY)
// ---------------------------------------------------------------------------
const adminHttp = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AstroVector admin ws ok');
});
const adminWss = new WebSocketServer({ server: adminHttp, perMessageDeflate: false });

let activeAdminStreams = 0;

adminWss.on('connection', (ws, req) => {
  // M5 — DERİNLİK SAVUNMASI. Port zaten 127.0.0.1'e bağlı (ADMIN_BIND), yani uzaktan bağlantı
  // gelmez; ama `ADMIN_BIND`/`ADMIN_ALLOW_REMOTE` ile bir gün açılırsa bu kapı yine kapanır.
  // Neden iki katman: kullanıcı sözleşmesi "admin-client ASLA bir web servisine deploy edilmez,
  // sadece bu makinede açılır" — tek bayrağa güvenmek yayında pahalıya patlar (yanlış env = açık kapı).
  const remote = (req.socket && req.socket.remoteAddress) || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal && !ADMIN_ALLOW_REMOTE) {
    console.warn(`[admin] Yerel olmayan baglanti REDDEDILDI: ${remote}`);
    ws.close(4003, 'admin is local-only');
    return;
  }
  let authenticated = false;
  let inspecting = null; // { kind, id } — aktif inceleme hedefi
  let streamTimer = null;

  // AI'A NOT: AUTH HANDSHAKE. İlk mesaj mutlaka adm:auth + key olmalı.
  // 5 sn içinde auth olmayan socket öldürülür (brute-force penceresini daraltır).
  const authTimeout = setTimeout(() => !authenticated && ws.close(4004, 'auth timeout'), 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!authenticated) {
      if (msg.t === ADMIN_MSG.AUTH && msg.key === ADMIN_SECRET) {
        authenticated = true;
        clearTimeout(authTimeout);
        ws.send(JSON.stringify({ t: ADMIN_MSG.AUTH_OK, stats: rooms.globalStats() }));
      } else {
        // Yanlış key: kapat + blacklist. Log'a tam IP yazılır.
        const ip = req.socket.remoteAddress;
        blacklist.set(ip, Date.now() + 60_000);
        ws.close(4004, 'bad key');
      }
      return;
    }

    switch (msg.t) {
      case ADMIN_MSG.INSPECT: startInspection(ws, msg); break;
      case ADMIN_MSG.UNINSPECT: stopInspection(ws); break;
      case ADMIN_MSG.COMMAND: handleAdminCommand(ws, msg); break;
    }
  });

  // -------------------------------------------------------------------
  // ON-DEMAND INSPECTION — MİMARİNİN KRİTİK PARÇASI
  // -------------------------------------------------------------------
  // AI'A NOT: startInspection ASLA yeni hesap yapmaz. Yapılan tek şey:
  //   eventbus'taki ring buffer'ı filtrelip ilgili eventleri akıtmak.
  //   Bu sayede admin veri çekerken oyuncu tick loop'una sıfır ekstra maliyet.
  //   Kısıtlar: max 3 eşzamanlı stream, 250ms throttle.
  function startInspection(adminWs, msg) {
    if (activeAdminStreams >= MAX_ADMIN_STREAMS) {
      return adminWs.send(JSON.stringify({ t: ADMIN_MSG.ERROR, code: 'RATE_LIMITED' }));
    }
    if (inspecting) activeAdminStreams--; // eski stream'i bırakıp yenisine geçiyor
    inspecting = { kind: msg.kind, id: msg.id };
    activeAdminStreams++;
    // İlk paket: hedefin anlık durum özeti (pozisyon, hp, shield, room, son 20 event).
    const snapshot = rooms.describeTarget(msg.kind, msg.id);
    const recent = eventBus.query({ kind: msg.kind, id: msg.id, last: 20 });
    adminWs.send(JSON.stringify({ t: ADMIN_MSG.SNAPSHOT, snapshot, recent }));

    // Throttle'lı canlı stream: her 250ms'de bir, o hedefe ait yeni eventleri çek-gönder.
    let cursor = eventBus.cursor();
    streamTimer = setInterval(() => {
      const events = eventBus.query({ kind: msg.kind, id: msg.id, since: cursor });
      if (!events.length) return;
      cursor = events[events.length - 1].seq;
      adminWs.send(JSON.stringify({ t: ADMIN_MSG.STREAM, events }));
    }, ADMIN_STREAM_THROTTLE_MS);
  }

  function stopInspection(adminWs) {
    if (streamTimer) clearInterval(streamTimer);
    if (inspecting) { activeAdminStreams--; inspecting = null; }
    if (adminWs.readyState === 1) adminWs.send(JSON.stringify({ t: ADMIN_MSG.UNINSPECTED }));
  }

  ws.on('close', () => { clearTimeout(authTimeout); if (streamTimer) clearInterval(streamTimer); if (inspecting) activeAdminStreams--; });
});

// ---------------------------------------------------------------------------
// GOD MODE KOMUTLARI
// ---------------------------------------------------------------------------
// AI'A NOT: Her komut telemetry.critical(...) ile DB'ye kalıcı loglanır — denetim izi şart.
function handleAdminCommand(ws, msg) {
  telemetry.critical('admin_command', 'admin', { op: msg.op, args: msg.args });
  switch (msg.op) {
    case 'kill_player': {
      const ok = rooms.killPlayer(msg.args.id);
      ws.send(JSON.stringify({ t: ADMIN_MSG.COMMAND_RES, op: 'kill_player', ok, id: msg.args.id }));
      break;
    }
    case 'spawn_asteroid': {
      const roomId = msg.args.roomId || msg.args.beltId;
      const ok = rooms.spawnAsteroid(roomId, msg.args);
      ws.send(JSON.stringify({ t: ADMIN_MSG.COMMAND_RES, op: 'spawn_asteroid', ok, roomId }));
      break;
    }
    case 'list_players': // AI'A NOT: admin panelin oyuncu listesi — on-demand, push DEĞİL.
      ws.send(JSON.stringify({ t: ADMIN_MSG.PLAYERS, players: rooms.listPlayers() }));
      break;
    case 'list_rooms':   // "her şey görünsün": tüm CANLI odalar (hibernasyondakiler yok).
      ws.send(JSON.stringify({ t: ADMIN_MSG.ROOMS, rooms: rooms.listRooms(), stats: rooms.globalStats() }));
      break;
    case 'room_detail':  // tek odanın tam dökümü: oyuncular + kayalar + bekleyen eventler
      ws.send(JSON.stringify({ t: ADMIN_MSG.ROOM, room: rooms.roomDetail(msg.args.id) }));
      break;
    case 'trigger_star_kill': {
      const ok = rooms.beginStarKill(msg.args.starId);
      ws.send(JSON.stringify({ t: ADMIN_MSG.COMMAND_RES, op: 'trigger_star_kill', ok, starId: msg.args.starId }));
      break;
    }
    case 'galaxy_overview': {
      ws.send(JSON.stringify({ t: ADMIN_MSG.GALAXY, overview: rooms.galaxyOverview() }));
      break;
    }
    default: ws.send(JSON.stringify({ t: ADMIN_MSG.ERROR, code: 'UNKNOWN_OP' }));
  }
}

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN — telemetry kuyruğunu DB'ye boşaltmadan ölme
// ---------------------------------------------------------------------------
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown); // Docker/systemd SIGTERM gönderir, SIGINT değil
function gracefulShutdown() {
  console.log('Shutting down; flushing telemetry...');
  telemetry.flushSync();
  process.exit(0);
}

// ===========================================================================
// M5 — DİNLEME ADRESLERİ (DEPLOY GÜVENLİĞİ)
// ===========================================================================
// AI'A NOT: Önceden İKİSİ DE `listen(port)` çağırıyordu = **0.0.0.0** = bulutta admin portu
// (8090) İNTERNETE AÇIK olurdu. Kullanıcı sözleşmesi: "admin-client ASLA bir web servisine deploy
// edilmez, sadece bu makinede açılır." Artık bu kural KODLA zorlanıyor:
//   - game  → GAME_BIND   (varsayılan 0.0.0.0; yayında Caddy/nginx arkasında çalışır)
//   - admin → ADMIN_BIND  (varsayılan **127.0.0.1**; dışarıdan ERİŞİLEMEZ, SSH tüneliyle açılır:
//             `ssh -L 8090:127.0.0.1:8090 kullanici@sunucu` → tarayıcıda http://localhost:8090)
// `ADMIN_ALLOW_REMOTE=1` bilinçli bir kaçış kapısıdır (ör. tümüyle kapalı bir VPC içinde).
const GAME_BIND = process.env.GAME_BIND || '0.0.0.0';
const ADMIN_BIND = process.env.ADMIN_BIND || '127.0.0.1';
const ADMIN_ALLOW_REMOTE = process.env.ADMIN_ALLOW_REMOTE === '1';

gameHttp.listen(PORT_GAME, GAME_BIND, () =>
  console.log(`Game ws   : ws://${GAME_BIND}:${PORT_GAME}   (SURUM ${SURUM})  [oyuncu trafigi]`));
if (ADMIN_ENABLED) {
  adminHttp.listen(PORT_ADMIN, ADMIN_BIND, () => console.log(`Admin ws  : ws://${ADMIN_BIND}:${PORT_ADMIN} (SADECE YEREL${ADMIN_ALLOW_REMOTE ? ' — uzak erisim ACIK!' : ', uzaktan erisilemez'})`));
} else {
  // Anahtar yoksa HİÇBİR port dinlenmez: dışarıya açık bir admin yuvası bulunmaz.
  console.log('Admin ws  : KAPALI (ADMIN_SECRET_KEY yok) — hicbir port dinlenmiyor');
}

// AI'A NOT (M3f — İKİNCİ TUR, gerçek hata buydu): ilk denemede `error` dinleyicisini yalnız
// `gameHttp`/`adminHttp` üzerine koydum ve İŞE YARAMADI: `ws` paketi bir `WebSocketServer`
// oluştururken http sunucusuna bindiği için yükseltme hatasını KENDİ üzerinden yayar →
// "Emitted 'error' event on WebSocketServer instance at:" ile ham yığın izi ekrana düşüyordu.
// Dinleyici DÖRT nesneye de takılmalı: iki http sunucusu + iki WebSocketServer.
// Ayrıca uncaughtException yedeği: beklenmedik bir hata ham stack yerine eylem mesajı versin.
const fatal = (err, port) => {
  const inUse = err && err.code === 'EADDRINUSE';
  console.error(inUse
    ? `\n[HATA] Port ${port} DOLU — eski sunucu sureci hala calisiyor olabilir.\n`
      + '       Yeni kod DEVREYE GIRMEZ. Yapilacak: bu pencerede Ctrl+C, sonra start.bat\n'
      + `       (start.bat once 8081/8090'i tutan PID'i kapatir) ya da:\n`
      + `       netstat -ano | findstr ":${port} "   ->  taskkill /PID <pid> /F\n`
    : `\n[HATA] Sunucu baslatilamadi (port ${port}): ${err && err.message}\n`
      + '       Bu pencereyi KAPATMA, yukaridaki mesaji bana gonder.\n');
  process.exit(1);
};
for (const [srv, port] of [[gameHttp, PORT_GAME], [adminHttp, PORT_ADMIN],
  [gameWss, PORT_GAME], [adminWss, PORT_ADMIN]]) {
  srv.on('error', (err) => fatal(err, port));
}