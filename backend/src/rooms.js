// AI'A NOT: rooms.js — Room/Channel Yönetimi (Interest Management'ın kalbi).
//
// MİMARİ KARARLAR (detay: MIMARI_VE_GOREVLER.md §Room Yönetimi):
//  - Her YILDIZ SİSTEMİ = 1 Room. Room id = "s<starId>". Sistem dolarsa mirror room: "s<id>-b2".
//  - Sadece AKTİF (içinde oyuncu olan) room'lar tick edilir; boş room 30sn sonra hibernate.
//  - BROADCAST STRATEJİSİ: tüm diff'ler TEK string'e birleşir → socket başına tek ws.send.
//  - SNAPSHOT vs DIFF AYRIMI: asteroidler STATİKTİR → yalnız snapshot'ta gider (tek seferlik,
//    ~30 entity). Oyuncular diff'e girer (10Hz). Bu ayrım bandwidth'i ~%90 düşürür.
//
// KRİTİK PERFORMANS SÖZLEŞMESİ: tick() içinde ASLA I/O veya await YOK.
// DB/telemetry her zaman kuyruğa gider (telemetry.js), game loop hiç blocklanmaz.

import { starById, roomIdForStar, galaxy, GALAXY_SEED, saveDestroyedStar } from './galaxy.js';
// M2i — KORSANLAR: hangi sistemde korsan/istasyon olduğu bu modülde DETERMINISTIK hesaplanır.
import {
  pirateLevel, pirateHash, PIRATE_HULL, PIRATE_SPEED, PIRATE_RANGE, PIRATE_DMG,
  PIRATE_COOLDOWN_MS, PIRATE_STANDOFF, PIRATE_ACTIVE, NPC_CAP,
  STATION_HULL, STATION_RADIUS, STATION_SPAWN_MS, NPC_SPAWN_MS,
} from './pirates.js';

const ROOM_CAPACITY = 50;
const HIBERNATE_DELAY_MS = 30_000;
const ANOMALY_RADIUS = 28;
// AI'A NOT: Sunucu-tarafı hız sınırı. Client kendi pozisyonunu "tahmin eder"
// (client-authoritative önizleme) ama sunucu DOĞRULAR. 220 birim/sn client hızıyla eşleşir;
// 1.5 çarpanı ağ jitter'ı toleransıdır (paket gecikmesi meşru mesafeyi büyütür).
const MAX_SPEED = 220 * 1.5;

// AI'A NOT: WARP MENZİLİ (galaksi birimi). Bir warp isteği yalnız bu mesafeyi kapsayabilir;
// daha uzak bir yıldız reddedilir. Client haritada menzil halkasını gösterir ama kararı
// SUNUCU verir — client spoof edilse bile menzil dışına atlanamaz.
// Süpürme testi: 1200 birim ötedeki yıldıza warp denemesi → warp_range hatası dönmeli.
const JUMP_RANGE = 700;

// ---------------------------------------------------------------------------
// M2 SABİTLERİ — ÇATIŞMA + MADENCİLİK
// ---------------------------------------------------------------------------
// AI'A NOT: Ateş HITSCAN'dir (uçan mermi simülasyonu YOK). Neden: mermi nesnesi tick içinde
// konum güncellemesi + çarpışma testi + dif yayını gerektirir; hitscan'de tek ışın taraması
// yeter. Sunucu her zaman TEK GERÇEK KAYNAK: istemci sadece görsel çizer.
const FIRE_COOLDOWN_MS = 260;   // atış aralığı — istemcideki cooldown ile AYNI olmalı
const FIRE_RANGE = 380;         // isabet menzili (birim)
const FIRE_DMG = 14;            // oyuncuya vuruş (önce kalkan, taşan gövdeye)
const MINE_DMG = 34;            // kayaya vuruş (kaya hp'si boyut*3 → 2-3 vuruşta kırılır)
const TRACTOR_RANGE = 320;      // tractor beam menzili
// ---------------------------------------------------------------------------
// M4a — ANOMALİ SABİTLERİ (bkz. SSOT §M4a)
// AI'A NOT: Bu özellik sunucuda YAZILMIŞTI ama hiç ÇALIŞMIYORDU: `room.anomaly` hiçbir yerde
// oluşturulmuyordu, `_damageAnomaly` tanımsızdı, `rayPick` anomaliyi hiç görmüyordu ve
// `solve_anom` mesajı dispatcher'a bağlı değildi. Yani 4 katmanın 3'ü yoktu ve handler'lar
// ölü koddu (bkz. analiz raporu). Aşağıdaki sabitler o boşluğu kapatır.
const ANOM_HULL = 60;            // KALINTI türleri (RUIN/GRAVEYARD/DERELICT): MINE_DMG ile 2 vuruş
const ANOM_RADIUS = 26;          // ışın/tractor isabet yarıçapı (görsel sprite ~26 px)
const ANOM_SIGNAL_KINDS = ['SILENT_BEACON', 'OBSCURED_SIGNAL'];  // frekans çözme (R)
const ANOM_LOOT_KINDS = ['RUIN', 'GRAVEYARD', 'DERELICT'];       // yağma (ateş / tractor)
const ANOM_SOLVE_RANGE = 450;    // kodu girebilmek için en fazla mesafe (mevcut sözleşme)
const ANOM_HINT_RANGE = 1200;    // E taramasıyla frekans ipucu alınabilen mesafe
const ANOM_LOOT_STEP_MS = 1800;  // tractor ile yağmada parçalar arası süre
const ANOM_LOOT_PIECES = 6;      // bir kalıntıdan kaç parça çıkar (sonra tükenir)
const TRACTOR_SPEED = 140;      // çekme hızı (birim/sn)
const ROCK_RESPAWN_MS = 15_000; // kırılan kaya bu süre sonra aynı yerde yeniden doğar
// Gemiler iki kat büyütüldü (kullanıcı isteği) → isabet yarıçapı da ölçeklenir.
// HUD/istemci ile AYNI değer: yoksa "vurdum ama saymadı" hissi oluşur.
const PLAYER_RADIUS = 16;
// ---------------------------------------------------------------------------
// M2b — YAKIT (kullanıcı isteği)
// ---------------------------------------------------------------------------
// AI'A NOT: Yakıt BİR MADDEDEN yapılır: asteroidlerden çıkan DOTERYUM. Depo 45 birim;
// her 300 birim yol 1 yakıt, her warp 3 yakıt. Depo bittiğinde itiş KAPANIR (konum
// güncellenmez) ama oyuncu kalıcı mahsur kalmasın diye çok yavaş bir ACİL DAMLASI vardır
// (güneş yelkeni). Bu, "yakıtsız kaldım, hesap sildim" durumunu engeller.
// KULLANICI GERİ BİLDİRİMİ: 1 yakıt = 100 birim ÇOK ÇABUK bitiyordu (depo 4500 birimlik yol
// demekti, sarmal kolda iki yıldız arası bile yetmiyordu) → 300'e çıkarıldı: depo artık
// 13.500 birim yol eder, tek yakıtla yıldızlar arası rahat gidilir.
const FUEL_TANK = 45;             // depo hacmi
// AI'A NOT: KULLANICI GERİ BİLDİRİMİ #2: "yakıt yine 2 kat daha yavaş azalsın" → 300 → 600.
// Depo artık 27.000 birim yol eder (sarmal kolda yıldızlar arası mesafeye göre rahat).
const FUEL_PER_DISTANCE = 600;    // kaç birim yol = 1 yakıt
// M2i (KULLANICI İSTEĞİ, birebir): "oyunun başında 5 doteryum yerine 5 warp fuel versin".
// Doğuş envanteri artık WARP HUCRESI: oyuncu ilk saniyeden atlayabilir.
// M3c: DOTERYUM doğuşta verilmez AMA artık yakıt için de gerekmez — yakıt yıldızdan çekilir.
// DOTERYUM yalnız zanaat cevheridir (WARPCELL 3, YAKIT KUTUSU 2+TITAN 1); madencilikle toplanır.
const STARTER_WARP_CELLS = 5;
const WARP_FUEL = 3;              // warp başına yakıt
// M3c (KULLANICI DÜZELTMESİ): Y = "DOTERYUM çevirme" DEĞİL, **YILDIZDAN YAKIT ÇEKME**.
// DOTERYUM artık yalnız zanaat cevheri (WARPCELL 3, YAKIT KUTUSU 2+TITAN 1). Dolumda MALZEME
// HARCANMAZ (REFUEL_AMOUNT kaldırıldı) — yakıtın bedeli ZAMAN + KONUM.
const FUEL_MATERIAL = 'DOTERYUM'; // zanaat cevheri: WARPCELL + YAKIT KUTUSU tariflerinde
const FUEL_EMERGENCY_CAP = 5;     // acil damlası bu değerin üstüne çıkmaz
const FUEL_EMERGENCY_RATE = 0.35; // birim/sn
// ---------------------------------------------------------------------------
// M2e — YAKIT DOLUMU ARTIK YILDIZA BAĞLI VE SÜREKLİ (kullanıcı isteği) / M3c düzeltmesi
// ---------------------------------------------------------------------------
// AI'A NOT: KULLANICI İSTEĞİ (birebir): "sadece yıldızın dibindeyken Y'ye basınca yavaş yavaş
// doldurulabilsin". Yeni model:
//   * Y BASILI tutulur → istemci {t:'refuel', on:true/false} yollar (tek basış = başlat/durdur).
//   * Dolum yalnız sistem yıldızının (0,0) REFUEL_RANGE yakınında çalışır.
//   * Hız REFUEL_RATE yakıt/sn → 45'lik depo ~22,5 saniyede dolar (KULLANICI: "ağır ağır").
//   * **M3c:** yakıt DOĞRUDAN yıldızdan çekilir; hiçbir malzeme harcanmaz. (Önceki "15 yakıt =
//     1 DOTERYUM" dönüşümü kullanıcı tarafından REDDEDİLDİ — birebir: "Y'ye basınca doteryum
//     convert yapmayacak yıldızdan yakıt çekecek". Küsurat/geri-alma mekaniği bu yüzden TAMAMEN
//     kaldırıldı: harcanacak malzeme yoksa devredecek küsurat da yok.)
// AI'A NOT: REFUEL_RANGE = 700 seçildi çünkü: (a) doğuş halkası 380-620 → oyuncu doğduğu anda
// menzil İÇİNDEDİR (mekaniği hemen keşfeder), (b) kuşak 700'den başlar → maden için yıldızdan
// uzaklaşmak, yakıt için geri dönmek gerekir (istasyon turu doğar), (c) yıldızın görsel halesi
// ~96 birim olduğundan 700 "dibinde" hissini verir. İstemci aynı halkayı çizer (aynı sabit).
const REFUEL_RANGE = 700;   // yıldızın "dibi" (birim) — bu yarıçapın dışında dolum yok
const REFUEL_RATE = 2;      // yakıt/sn (KULLANICI İSTEĞİ: "ağır ağır, saniyede iki fuel") → 45'lik depo ~22,5 sn
// ---------------------------------------------------------------------------
// M2e — UZAYA DÜŞEN KAPSÜLLER (kullanıcı isteği)
// ---------------------------------------------------------------------------
// AI'A NOT: KULLANICI İSTEĞİ: "asteroidlerden veya oyundaki herhangi bir şeyden düşen item ÖNCE
// UZAYA DÜŞECEK, biz gidip gemiyle toplayacağız; tractor beam de çekebilecek pickupları".
// Eskiden kaya kırılınca ganimet ANINDA envantere giriyordu (madencilik = tek tuş). Artık:
// kaya kırılır → düştüğü yerde bir KAPSÜL belirir, hafifçe süzülür (uzaya düşme hissi); oyuncu
// üzerine giderse (~PICKUP_PICK_RADIUS) ya da tractor beam ile çekerse envanterine girer.
// Kapsül sonsuza kadar kalmaz (PICKUP_LIFE_MS) — alan temizlenir, sunucu şişmez.
const PICKUP_PICK_RADIUS = 30;   // temas/toplama yarıçapı (gemi merkezine göre)
const PICKUP_LIFE_MS = 90_000;   // kapsülün uzayda kalma süresi
const PICKUP_DRIFT = 26;         // düşüş süzülme hızı (birim/sn) — yavaşça sürüklenir

// AI'A NOT: Cevher tablosu AĞIRLIKLI — DOTERYUM (yakıt) nadirdir, bu yüzden değerlidir.
// Eskiden cevher tipi index'e göre dağıtılıyordu (her 5 kayada bir tekrar) → yakıt maddesi
// her yerde bulunurdu ve yakıt anlamsızlaşırdı.
const ORE_TABLE = [
  ['DEMIR', 30], ['BAKIR', 24], ['TITAN', 18], ['SILICON', 14], ['REZONANS', 8], [FUEL_MATERIAL, 6],
];
// ---------------------------------------------------------------------------
// M2h — ZANAAT (CRAFTING) + SHIFT BOOST
// ---------------------------------------------------------------------------
// AI'A NOT (KULLANICI İSTEĞİ): "kripto ney? bana bütün materyalleri söyle, oyunda crafting olacak
// bi işe yaramaları lazım. mesela doteryumdan warp fuel yapılsın öyle atlansın."
// Bu yüzden 6 cevherin TAMAMI bir tarife bağlandı; hiçbir cevher "sadece sayı" değil:
//   DEMIR + BAKIR      → TAMIR SETI  (H)  : gövde + kalkan onarır
//   DOTERYUM x3        → WARP HUCRESI     : warp artık YAKIT DEĞİL HÜCRE ister (1 hücre = 1 atlama)
//   DOTERYUM x2 + TITAN→ YAKIT KUTUSU (G) : depoyu yıldızdan uzakta doldurur
//   SILICON + REZONANS  → ISARET FISEGI (J): 30 sn boyunca TÜM odayı sınırsız menzilde gösterir
// Üretilen eşyalar CARGO'ya girer (ayrı envanter YOK): böylece mevcut senkron/HUD/kapsül kodu
// değişmeden çalışır, eşyalar da HUD'un kargo satırında görünür.
const ITEMS = { WARPCELL: 'WARPCELL', REPAIRKIT: 'REPAIRKIT', FUELCAN: 'FUELCAN', BEACON: 'BEACON' };
// AI'A NOT: Tarife listesi TEK YERDE ve sıralı — istemci aynı listeyi kendi panelinde gösterir
// (sayı tuşları 1..4 bu sıraya bağlıdır). Maliyetler {cevher: adet}.
const RECIPES = [
  { id: ITEMS.WARPCELL,  out: 1, cost: { DOTERYUM: 3 } },
  { id: ITEMS.REPAIRKIT, out: 1, cost: { DEMIR: 4, BAKIR: 2 } },
  { id: ITEMS.FUELCAN,   out: 1, cost: { DOTERYUM: 2, TITAN: 1 } },
  { id: ITEMS.BEACON,    out: 1, cost: { SILICON: 2, REZONANS: 1 } },
];
const WARP_CELL_ITEM = ITEMS.WARPCELL;
const REPAIR_HULL = 40, REPAIR_SHIELD = 40;   // TAMIR SETI etkisi
// M3d (KULLANICI İSTEĞİ, birebir): "geminin enerjisi kendi kendine dolsun saldırıya uğradıktan
// bir süre sonra". Kalkan = gemi enerjisi. Saldırıdan sonra bir GECİKME boyunca dolmaz, sonra
// kendiliğinden dolar. Gövde kendiliğinden DOLMAZ (TAMIR SETI/H işidir).
const SHIELD_REGEN_DELAY_MS = 5000;  // son hasardan sonra bekleme ("bir süre sonra")
const SHIELD_REGEN_RATE = 6;         // kalkan/sn — tam dolum ~17 sn
const FUELCAN_FUEL = 15;                      // YAKIT KUTUSU etkisi (yıldıza gitmeden)
const BEACON_SEC = 30;                        // ISARET FISEGI süresi
// AI'A NOT: SHIFT BOOST — "shifte basılı tutarak daha hızlı gitsin gemi ama iki kat yakıt harcasın".
// Hız çarpanı ve yakıt çarpanı İSTEMCİYLE AYNI olmalı (bkz. Tuzak 5: farklı olursa sunucu kırpar
// ve oyuncu sürekli geri çekilme yaşar). Yakıt çarpanı = kaç kat tüketim: mesafe başına eşik
// FUEL_PER_DISTANCE / BOOST_FUEL_MUL olur.
const BOOST_MUL = 1.55;
const BOOST_FUEL_MUL = 2;

const ORE_TOTAL_W = ORE_TABLE.reduce((s, [, w]) => s + w, 0);
function pickOre(rnd = Math.random) {
  let r = rnd() * ORE_TOTAL_W;
  for (const [o, w] of ORE_TABLE) { if (r < w) return o; r -= w; }
  return 'DEMIR';
}

// Oyuncu çağrı işaretleri — gizemli ton.
const CALLSIGNS = ['PILOT', 'DRIFTER', 'PROSPECTOR', 'SCAVENGER', 'OUTRIDER', 'STARLING', 'VAGRANT', 'HALO'];

// ===========================================================================
// M3 — SOHBET: 4 KANAL (g/s/l/p) + SUNUCU TARAFI RATE LIMIT
// AI'A NOT: Sohbetin LİDERLİĞİ sunucuda. İstemci yalnız "hangi kanal + ne yazdım" der; kim kime
// ulaşır, kaç mesaj hakkı var, metin ne kadar — hepsi burada karara bağlanır (istemci sayacı
// yok sayılır; aksi hâlde rate limit bir DOM konsol komutuyla aşılır).
//   g = GLOBAL  → tüm galaksi
//   s = SEKTÖR  → JUMP_RANGE içindeki komşu sistemler (kuşak = oyuncunun çevresi)
//   l = YEREL   → aynı sistem (oda)
//   p = ÖZEL    → çağrı işaretine DM (gönderene de kopya döner)
// ===========================================================================
const CHAT_MAX_LEN = 120;
const CHAT_CD_MS = 700;            // iki mesaj arası en az bu süre (makro/tuş spam'i)
const CHAT_BURST_MAX = 4;          // pencere başına en fazla mesaj
const CHAT_BURST_MS = 6000;        // pencere süresi
const CHAT_CH = new Set(['g', 's', 'l', 'p']);

// Metin temizliği: kontrol karakterleri (satır sonu/ESC dahil), açı parantezleri ve fazla boşluk
// atılır, uzunluk kırpılır. İstemci bitmap fonta basar (5x7 ASCII) — yine de sunucu KENDİ
// doğrulamasını yapar, istemciye güvenilmez.
function cleanChat(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

// Sektör komşuları: yıldız id → yakın yıldız id kümesi. TEMBEL hesaplanır ve önbelleğe alınır
// (16384 yıldızı her mesajda taramak gereksiz; bir yıldızın çevresi asla değişmez).
const _sectorCache = new Map();
function sectorStars(starId) {
  let set = _sectorCache.get(starId);
  if (set) return set;
  const self = starById(starId);
  set = new Set([starId]);
  if (self) {
    for (const s of galaxy().stars) {
      if (Math.hypot(s.x - self.x, s.y - self.y) <= JUMP_RANGE) set.add(s.i);
    }
  }
  if (_sectorCache.size > 2048) _sectorCache.clear();   // bellek emniyeti (uzun oturumlar)
  _sectorCache.set(starId, set);
  return set;
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();   // roomId -> Room
    this.players = new Map(); // playerId -> player
    this.homeStarId = this._pickHomeStar();
  }

  // AI'A NOT: Başlangıç sistemi — galaksinin merkezinden uzakta, sakin bir kol yıldızı.
  // KUŞAKLI OLMAK ZORUNDA: oyuncu ilk madenciliğini ve yakıt hammaddesini (DOTERYUM) burada
  // yapar; kuşaksız bir yıldızda doğarsa etrafında hiç kaya olmaz (oyun "boş" başlar).
  // Deterministik: galaksinin %37'sinden başlayıp ilk KUŞAKLI yıldızı seçeriz (seed sabit).
  _pickHomeStar() {
    // AI'A NOT (TEST KANCASI): `TEST_HOME_STAR=<id>` başlangıç sistemini sabitler. Anomali testi
    // deterministik bir anomali sistemi gerektiriyor; ana sistem (seed'e göre seçilen) anomalisiz
    // olabilir ve testin "oraya yürümesi" mümkün değil (warp menzil ister). ÜRETİMDE ETKİSİZ:
    // ortam değişkeni verilmezse davranış aynen eskisi (kuşaklı ilk yıldız).
    const forced = Number(process.env.TEST_HOME_STAR);
    if (Number.isFinite(forced) && forced > 0) return forced;
    const g = galaxy();
    const n = g.stars.length;
    const start = Math.floor(n * 0.37);
    for (let k = 0; k < n; k++) {
      const s = g.stars[(start + k) % n];
      if (s.b > 0) return s.i;
    }
    return g.stars[start].i;
  }

  // -------------------------------------------------------------------------
  // BAĞLANTI / AYRILMA
  // -------------------------------------------------------------------------
  connect(ws, ip) {
    const player = {
      id: 'p' + Math.random().toString(36).slice(2, 8),
      callsign: CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)] + '-' +
        Math.random().toString(36).slice(2, 6).toUpperCase(),
      ws, ip,
      x: 0, y: 0, r: 0,
      shield: 100, hull: 100,
      lastHitAt: 0,             // M3d: son hasar anı (kalkan regen GECİKMESİ buradan sayılır)
      shieldSent: 100,          // M3d: HUD'a gönderilen son TAM kalkan değeri (paket israfını önler)
      roomId: null,
      lastAcceptedAt: Date.now(), // hız doğrulaması zaman referansı
      speedWarnings: 0,           // hız ihlali sayacı (admin + telemetry)
      cargo: { [WARP_CELL_ITEM]: STARTER_WARP_CELLS }, // M2i: doğuşta 5 WARP HUCRESI (warp için)
      lastFireAt: 0,              // M2: atış cooldown zamanı
      tractor: null,              // M2: { rockId } — aktifse tick'te kaya çekilir
      kills: 0, deaths: 0,        // M2: telemetri/istatistik
      fuel: FUEL_TANK,            // M2b: yakıt (dolu başlar)
      fuelAccum: 0,               // M2b: 1 yakıt için biriken mesafe
      fuelSent: FUEL_TANK,        // M2b: HUD'a gönderilen son tam sayı (paket israfını önler)
      refuelOn: false,            // M2e/M3c: yıldızdan yakıt çekme açık mı (küsurat YOK: harcanan malzeme yok)
    };
    this.players.set(player.id, player);
    // AI'A NOT: Doğuş noktası RASTGELE — herkes aynı koordinatta doğarsa gemiler tam üst üste
    // biner ve ekranda yalnızca en üstteki görünür ("gemim pembe çıkıyor" belirtisinin sebebi).
    // Yıldızın etrafında halka: yarıçap 380-620 birim, rastgele açı → yıldızın içine spawn olunmaz
    // ama oyuncular birbirinden ayrı başlar. Deterministik olması gerekmez (sunucu tek gerçek kaynak).
    const a = Math.random() * Math.PI * 2;
    const rr = 380 + Math.random() * 240;
    player.x = Math.round(Math.cos(a) * rr);
    player.y = Math.round(Math.sin(a) * rr);
    player.r = Math.atan2(-player.y, -player.x) + Math.PI / 2;  // yıldıza bakar şekilde doğ
    this.assignRoom(player, roomIdForStar(this.homeStarId));
    // AI'A NOT (TEST KANCASI): `TEST_ANOM_NEAR=1` doğuş noktasını anomalinin 260 birim yanına
    // taşır. Neden gerekli: anomali normalde yıldızdan 900-1420 birim uzakta doğar, spawn ise
    // 380-620'de → oyuncu anomalinin GÖRSELİNİ göremez ve önizleme paneli canvas'a tuş
    // gönderemediği için "ekranda nasıl duruyor" hiç doğrulanamıyordu. ÜRETİMDE ETKİSİZ: env
    // yoksa bu blok çalışmaz; hiçbir mekanik/kural değişmez, yalnız başlangıç konumu.
    if (process.env.TEST_ANOM_NEAR === '1') {
      const room = this.rooms.get(player.roomId);
      const an = room && room.anomaly;
      if (an) {
        const ang = Math.atan2(an.y, an.x) + 0.35;
        player.x = Math.round(an.x + Math.cos(ang) * 260);
        player.y = Math.round(an.y + Math.sin(ang) * 260);
      }
    }
    return player;
  }

  disconnect(player) {
    const room = this.rooms.get(player.roomId);
    if (room) room.removePlayer(player);
    this.players.delete(player.id);
  }

  // AI'A NOT: assignRoom — kapasite kontrolü + mirror room fallback. Dolu sistemde
  // "s12" drama "s12-b2"ye düşer; 50+ oyuncu aynı sistemde oynayabilir.
  assignRoom(player, baseRoomId) {
    const oldRoom = this.rooms.get(player.roomId);
    if (oldRoom) oldRoom.removePlayer(player); // eski room'dakiler 'X' flag'i görür

    let roomId = baseRoomId;
    for (let i = 2; i <= 4; i++) {
      const room = this.rooms.get(roomId);
      if (!room || room.players.size < ROOM_CAPACITY) break;
      roomId = `${baseRoomId}-b${i}`;
    }
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Room(roomId, this.homeStarId, this));
    const room = this.rooms.get(roomId);
    player.roomId = roomId;
    room.addPlayer(player);
    return room;
  }

  // -------------------------------------------------------------------------
  // WARP — Milestone 1'in ana yeniliği
  // -------------------------------------------------------------------------
  // AI'A NOT: Warp GÜVENLİ olmalı. Client "olmayan bir yıldıza" veya harita dışına warp
  // isteyebilir (spoof). Bu yüzden starId deterministik galaxy üzerinden doğrulanır —
  // client'ın gönderdiği isme/koordinata asla güvenilmez.
  handleWarp(player, msg) {
    const starId = Number(msg.starId ?? msg.sysId);
    if (!Number.isInteger(starId)) return this._sys(player, 'warp_invalid', 'Warp koordinati gecersiz.');
    const star = starById(starId);
    if (!star) return this._sys(player, 'warp_invalid', 'Boyle bir yildiz yok. Sinyal sahte.');

    if (this._starOf(player.roomId) === starId) return; // aynı sisteme warp: yok say

    // AI'A NOT: YAKIT — warp da yakıt yakar (3 birim). Böylece "sonsuz zıplama" yok; oyuncu
    // DOTERYUM bulup dönüştürmek zorunda. Depo yetersizse warp REDDEDİLİR (istemci de
    // göndermez, ama karar burada).
    // AI'A NOT (M2h — KULLANICI İSTEĞİ): "doteryumdan warp fuel yapılsın ÖYLE ATLANSIN". Warp
    // artık depo yakıtıyla DEĞİL, üretilen WARP HUCRESIYLE yapılır: 3 DOTERYUM → 1 hücre,
    // 1 hücre = 1 atlama. Böylece crafting oyunun ilerleme yolunun PARÇASI olur (yoksa cevherler
    // sadece sayı olarak kalırdı). SIRA ÖNEMLİ: MENZİL kapısı hücre kapısından ÖNCE gelir çünkü
    // menzil dışı bir istek hiçbir koşulda geçerli değildir (istemci de aynı sırayı kullanır;
    // ters sıra `warp_range` bekleyen testi kırardı — baştan bir kez yaşandı).

    // AI'A NOT: MENZİL KONTROLÜ. Mesafe YILDIZ-yıldız ölçülür (oyuncunun sistem içi konumu
    // değil): warp bir yıldızdan diğerine atlamadır. Client menzil dışını soluk gösterir,
    // burada ise kesin karar verilir.
    const from = starById(this._starOf(player.roomId));
    if (from) {
      const jumpDist = Math.hypot(star.x - from.x, star.y - from.y);
      if (jumpDist > JUMP_RANGE) {
        return this._sys(player, 'warp_range',
          `Menzil disi: ${star.n} ${Math.round(jumpDist)} birim uzakta (en fazla ${JUMP_RANGE}).`,
          { star: star.n, d: Math.round(jumpDist), max: JUMP_RANGE });
      }
    }
    // M2h: menzil GEÇTİ → hücre kapısı (yoksa net mesaj + maliyet bilgisi; sessiz ret yok).
    if ((player.cargo[WARP_CELL_ITEM] || 0) < 1) {
      return this._sys(player, 'warp_nocell',
        `Warp hucresi yok — ${RECIPES[0].cost[FUEL_MATERIAL]} ${FUEL_MATERIAL}'dan uret (C).`,
        { item: WARP_CELL_ITEM, ore: FUEL_MATERIAL, need: RECIPES[0].cost[FUEL_MATERIAL] });
    }
    player.cargo[WARP_CELL_ITEM] -= 1;
    if ((player.cargo[WARP_CELL_ITEM] || 0) <= 0) delete player.cargo[WARP_CELL_ITEM];
    if (player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ t: 'loot', ore: WARP_CELL_ITEM, amount: -1, cargo: player.cargo }));
    }
    player.fuelAccum = 0;
    player.refuelOn = false;      // M2e: warp dolumu keser (yeni sistemde kendiliğinden sürmez)

    const oldRoom = this.rooms.get(player.roomId);
    // Spawn noktası yıldız çevresinde; DETERMINISTIK (her warp aynı yere) → oyuncular buluşabilir.
    player.x = 400; player.y = -160;
    this.assignRoom(player, roomIdForStar(starId));

    if (oldRoom && oldRoom.players.size) {
      oldRoom.sysAll(`${player.callsign} warp ile sistemden ayrildi.`, 'warp_away', null, { name: player.callsign });
      oldRoom.pushEvent({ kind: 'warp', actorId: player.id, data: { to: player.roomId } });
    }
    this._sys(player, 'warp_ok', `Warp tamamlandi: ${star.n} (${star.k} sinifi)`, { star: star.n, cls: star.k });
  }

  _starOf(roomId) { return Number(String(roomId).replace(/^s/, '').split('-')[0]); }
  _sys(player, code, text, p) {
    // AI'A NOT: `p` = ÇEVİRİ PARAMETRELERİ. İstemci `code`u kendi dilinde metne çevirir; kod
    // tanınmazsa `msg` (Türkçe) gösterilir → eski/yeni sürüm karışımı da çalışır.
    // AI'A NOT (TUZAK — canlıda sunucuyu DÜŞÜRDÜ): `by` alanı artık bir KORSAN (NPC) olabilir;
    // NPC'nin `ws` alanı YOKTUR. Savunmasız `player.ws.readyState` okuması, korsan bir oyuncuyu
    // yok ettiği anda `TypeError` atıp TÜM SUNUCUYU öldürdü (tick içinden atılan hata process'i
    // bitirir — istemci hatası gibi "donma" değil, gerçek çökme). Gönderen her fonksiyon
    // "hedef bir bağlantı olmayabilir" varsayımıyla yazılmalı.
    if (!player || !player.ws || player.ws.readyState !== 1) return;
    player.ws.send(JSON.stringify({ t: 'sys', code, msg: text, p: p || null }));
  }

  // -------------------------------------------------------------------------
  // OYUNCU MESAJ HANDLER'LARI
  // -------------------------------------------------------------------------
  // AI'A NOT: handleMove — client-authoritative önizleme + SUNUCU DOĞRULAMASI.
  // Client 20Hz pozisyon gönderir; sunucu hız limitini aşan atlayışı KIRPAR (clamp).
  // Bu "reconciliation" değil "validation": client kendi tahminini gösterir, sunucu
  // değeri diff ile geri döner, client yumuşakça yakınsar (lerp — bkz. game-client).
  handleMove(player, msg) {
    const room = this.rooms.get(player.roomId);
    if (!room) return;
    const x = Number(msg.x), y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return; // NaN/Infinity spam'ini kes

    const now = Date.now();
    const dt = Math.max((now - player.lastAcceptedAt) / 1000, 0.001);
    // M2h: SHIFT BOOST. İstemci `boost` bayrağını gönderir; sunucu hem hız tavanını hem de
    // mesafe başına yakıt eşiğini değiştirir. Yakıt yoksa hız artmaz (yakıt kapısı aşağıda).
    const boost = msg.boost === 1 || msg.boost === true;
    const allowed = MAX_SPEED * (boost ? BOOST_MUL : 1) * dt;
    const perFuel = boost ? FUEL_PER_DISTANCE / BOOST_FUEL_MUL : FUEL_PER_DISTANCE;
    const dx = x - player.x, dy = y - player.y;
    const dist = Math.hypot(dx, dy);

    let step = dist;
    if (dist > allowed) {
      // AI'A NOT: Hız ihlali → konumu kırp + sayacı artır. Sayaç admin panelde görünür
      // ve (Milestone 3) telemetry'ye yazılır. Ban yok — meşru lag da buraya düşebilir.
      step = allowed;
      player.speedWarnings++;
    }
    // AI'A NOT: YAKIT KAPISI — TAM ORANLI. Gidilebilecek mesafe kalan yakıtla sınırlıdır
    // (1 yakıt = 600 birim; BOOST'ta 300): depo bitti → adım 0. Böylece acil damlanın verdiği
    // kırıntıyla sonsuza kadar sızma (creep) mümkün olmaz; kural sunucuda da istemcide de aynıdır.
    const fuelBudget = player.fuel * perFuel - player.fuelAccum;
    if (step > fuelBudget) step = Math.max(0, fuelBudget);

    if (step > 0 && dist > 0) {
      const k = step / dist;
      player.x += dx * k; player.y += dy * k;
      // TÜKETİM: biriken mesafe eşiği geçince 1 yakıt düşer (boost'ta eşik yarısı → 2 kat tüketim).
      player.fuelAccum += step;
      while (player.fuelAccum >= perFuel && player.fuel > 0) {
        player.fuelAccum -= perFuel;
        player.fuel -= 1;
      }
    }
    player.boosting = boost && step > 0;
    if (Number.isFinite(msg.r)) player.r = msg.r;
    player.lastAcceptedAt = now;
    room.markDirty(player.id);
  }

  // YAKIT DOLUMU (M2e → M3c DÜZELTME): Y BASILI tutuldukça, YILDIZIN DİBİNDE, YAVAŞ YAVAŞ
  // doldurur. Yakıt **DOĞRUDAN YILDIZDAN** çekilir — hiçbir malzeme HARCANMAZ.
  // AI'A NOT (KULLANICI DÜZELTMESİ, birebir): "Y'ye basınca doteryum convert yapmayacak yıldızdan
  // yakıt çekecek". Önceki sürüm Y'yi "15 yakıt = 1 DOTERYUM dönüşümü" yapıyordu — bu mekanik
  // kullanıcının istediği DEĞİLDİ ve kaldırıldı. DOTERYUM yalnız ZANAATTA kullanılan bir cevher
  // olarak kalır (WARPCELL + YAKIT KUTUSU tarifleri).
  // Yakıtın bedeli artık MALZEME değil, ZAMAN + KONUM: yalnız yıldızın dibinde (REFUEL_RANGE)
  // dolarsın, yani yıldızsız boşlukta yakıt biterse sıkışırsın. Sunucu otoriterliği korunur:
  // istemci yalnız "başlat/durdur" yollar; miktar ve hız sunucuda tick'te uygulanır (_refuelTick).
  handleRefuel(player, msg) {
    const room = this.rooms.get(player.roomId);
    if (!room) return;
    if (msg && msg.on === false) {            // Y bırakıldı → dolumu durdur
      if (player.refuelOn) {
        player.refuelOn = false;
        this._sys(player, 'refuel_off', `Yakit dolumu durdu (depo ${Math.round(player.fuel)}/${FUEL_TANK}).`,
          { fuel: Math.round(player.fuel), max: FUEL_TANK });
      }
      return;
    }
    if (player.refuelOn) return;              // zaten doluyor
    // Kapılar: MESAFE → DEPO. (Malzeme kapısı YOK — yıldız yakıtı bedava, bkz. üstteki not.)
    // Her ret AÇIK SEBEPLE döner (sessiz başarısızlık yok); en temel engel en önce gelir
    // (bkz. warp menzil/hücre dersi — Tuzak 40).
    const dist = Math.hypot(player.x, player.y);   // sistem yıldızı (0,0)
    if (dist > REFUEL_RANGE) {
      return this._sys(player, 'refuel_far',
        `Dolum icin yildizin dibine gel (${Math.round(dist)} birim uzaktasin, sinir ${REFUEL_RANGE}).`,
        { d: Math.round(dist), range: REFUEL_RANGE });
    }
    if (player.fuel >= FUEL_TANK - 0.01) return this._sys(player, 'refuel_full', 'Yakit deposu dolu.');
    player.refuelOn = true;
    this._sys(player, 'refuel_start', `Yildizdan yakit cekiliyor — depo ${Math.round(player.fuel)}/${FUEL_TANK}.`,
      { fuel: Math.round(player.fuel), max: FUEL_TANK });
  }

  // AI'A NOT: tick'ten çağrılır — dolumun SÜREKLİ kısmı. I/O yok, yalnız durum güncellemesi.
  // Koşullardan biri bozulursa dolum KENDİLİĞİNDEN durur ve oyuncuya sebebi yazılır.
  _refuelTick(p, dt) {
    const dist = Math.hypot(p.x, p.y);
    if (dist > REFUEL_RANGE) {
      p.refuelOn = false;
      return this._sys(p, 'refuel_far', 'Yildizdan uzaklastin — dolum durdu.',
        { d: Math.round(dist), range: REFUEL_RANGE });
    }
    const add = Math.min(REFUEL_RATE * dt, FUEL_TANK - p.fuel);
    if (add <= 0.0001) {                      // depo doldu
      p.refuelOn = false;
      return this._sys(p, 'refuel_full_tick', `Depo doldu (${FUEL_TANK}/${FUEL_TANK}) — dolum durdu.`,
        { max: FUEL_TANK });
    }
    p.fuel += add;
  }

  // -------------------------------------------------------------------------
  // M2h — ZANAAT + EŞYA KULLANIMI
  // -------------------------------------------------------------------------
  // AI'A NOT: Zanaat SUNUCUDA uygulanır (materyal düşme/ekleme = gerçek kaynak). İstemci yalnız
  // "üret" der; maliyeti, çıktıyı ve reddi sunucu belirler. Eşyalar cargo'ya yazılır → mevcut
  // snapshot/loot/HUD zinciri aynen çalışır. Her sonuç AÇIK bir koda döner (sessiz ret yok).
  handleCraft(player, msg) {
    const id = String(msg && msg.id || '');
    const rec = RECIPES.find((r) => r.id === id);
    if (!rec) return this._sys(player, 'craft_unknown', 'Bilinmeyen tarif.', { item: id });
    const missing = Object.entries(rec.cost).filter(([ore, n]) => (player.cargo[ore] || 0) < n);
    if (missing.length) {
      const list = missing.map(([ore, n]) => `${ore} ${player.cargo[ore] || 0}/${n}`).join(', ');
      return this._sys(player, 'craft_fail', `Malzeme yetersiz: ${list}.`, { item: id, list });
    }
    for (const [ore, n] of Object.entries(rec.cost)) {
      player.cargo[ore] -= n;
      if ((player.cargo[ore] || 0) <= 0) delete player.cargo[ore];
    }
    player.cargo[rec.id] = (player.cargo[rec.id] || 0) + rec.out;
    // Tek paket: kargo tam hâliyle gider → istemci HUD'u anında doğru sayıyı gösterir.
    if (player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ t: 'loot', ore: rec.id, amount: rec.out, cargo: player.cargo }));
    }
    const room = this.rooms.get(player.roomId);
    if (room) room.pushEvent({ kind: 'craft', actorId: player.id, data: { item: rec.id } });
    this._sys(player, 'craft_ok', `${rec.id} uretildi (${rec.out}).`, { item: rec.id, out: rec.out });
  }

  // AI'A NOT: Eşya kullanımı — TAMIR SETI (gövde+kalkan), YAKIT KUTUSU (yıldıza gitmeden 15 yakıt),
  // ISARET FISEGI (30 sn sınırsız tarama). "Gereksizse harcama" kuralı: iade YOK, önce reddet.
  handleUse(player, msg) {
    const id = String(msg && msg.id || '');
    const have = player.cargo[id] || 0;
    if (have < 1) return this._sys(player, 'use_need', 'Bu eşyadan yok.', { item: id });
    const room = this.rooms.get(player.roomId);
    const push = (kind, data) => { if (room) room.pushEvent({ kind, actorId: player.id, data }); };

    if (id === ITEMS.REPAIRKIT) {
      if (player.hull >= 100 && player.shield >= 100) {
        return this._sys(player, 'use_full', 'Gövde ve kalkan zaten tam — set harcanmadı.', {});
      }
      this._takeItem(player, id);
      player.hull = Math.min(100, player.hull + REPAIR_HULL);
      player.shield = Math.min(100, player.shield + REPAIR_SHIELD);
      push('repair', { hull: player.hull });
      return this._sys(player, 'use_repair', `Tamir edildi: govde ${player.hull} kalkan ${player.shield}.`,
        { hull: player.hull, shield: player.shield });
    }
    if (id === ITEMS.FUELCAN) {
      if (player.fuel >= FUEL_TANK - 0.01) {
        return this._sys(player, 'use_full', 'Depo dolu — kutu harcanmadı.', {});
      }
      this._takeItem(player, id);
      player.fuel = Math.min(FUEL_TANK, player.fuel + FUELCAN_FUEL);
      push('fuelcan', { fuel: Math.round(player.fuel) });
      return this._sys(player, 'use_fuel', `Yakit kutusu kullanildi: depo ${Math.round(player.fuel)}/${FUEL_TANK}.`,
        { fuel: Math.round(player.fuel), max: FUEL_TANK });
    }
    if (id === ITEMS.BEACON) {
      this._takeItem(player, id);
      // AI'A NOT: Tarama zaten istemcide (oda verisi istemcide) → sunucu yalnız SÜREYİ ve
      // malzeme harcamasını yönetir; istemci 30 sn boyunca sınırsız menzilde işaretler.
      player.beaconUntil = Date.now() + BEACON_SEC * 1000;
      push('beacon', { sec: BEACON_SEC });
      return this._sys(player, 'use_beacon', `Isaret fisegi: ${BEACON_SEC} sn sinirsiz tarama.`, { sec: BEACON_SEC });
    }
    return this._sys(player, 'use_unknown', 'Kullanilamayan esya.', { item: id });
  }

  _takeItem(player, id) {
    player.cargo[id] -= 1;
    if ((player.cargo[id] || 0) <= 0) delete player.cargo[id];
    if (player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ t: 'loot', ore: id, amount: -1, cargo: player.cargo }));
    }
  }

  // -------------------------------------------------------------------------
  // M2 — ÇATIŞMA VE MADENCİLİK
  // -------------------------------------------------------------------------
  // AI'A NOT: Ateş yönü GEMİNİN BURNUNDAN hesaplanır. Sprite r=0'da YUKARI bakar →
  // ileri vektör = (sin r, -cos r). İstemci ışını kendi tarafında da çizer (anlık his);
  // ama hasarı YALNIZ bu fonksiyon uygular → hile imkânsız.
  handleFire(player, msg) {
    const room = this.rooms.get(player.roomId);
    if (!room || player.hull <= 0) return;
    const now = Date.now();
    if (now - player.lastFireAt < FIRE_COOLDOWN_MS) return;   // cooldown → spam paketi boşa düşer
    player.lastFireAt = now;

    // AI'A NOT: KULLANICI İSTEĞİ: "mouse ile basılan yere ateş etsin". İstemci nişan açısını
    // msg.r (dünya radyanı) ile yollar. Gelmezse GEMİ BURNU kullanılır — demo ve testler böyle
    // çalışır (geriye uyumlu). Açı doğrulanır: NaN/sonsuz gelirse burna düşülür; ayrıca hasarı
    // yine yalnız bu fonksiyon uyguladığı için spoof edilmiş bir açı hile sağlamaz.
    const aim = Number.isFinite(msg && msg.r) ? msg.r : player.r;
    const fx = Math.sin(aim), fy = -Math.cos(aim);
    const hit = room.rayPick(player, fx, fy, FIRE_RANGE);

    if (!hit) {
      // Boşa atış: ışın menzilin sonuna kadar gider (görsel olarak da önemli).
      room.bcast({ t: 'shot', id: player.id, hk: null,
        hx: Math.round(player.x + fx * FIRE_RANGE), hy: Math.round(player.y + fy * FIRE_RANGE) });
      return;
    }
    if (hit.isRock) {
      const rock = hit.target;
      rock.hp -= MINE_DMG;
      room.bcast({ t: 'shot', id: player.id, hk: 'rock', hx: Math.round(rock.x), hy: Math.round(rock.y) });
      if (rock.hp <= 0) this._breakRock(room, rock, player);
      else room.bcast({ t: 'rockhp', id: rock.id, hp: rock.hp, max: rock.maxHp });
    } else if (hit.kind === 'npc') {
      // M2i: KORSAN gemisi vuruldu — hasar korsana gider (oyuncu hasarı DEĞİL).
      const npc = hit.target;
      room.bcast({ t: 'shot', id: player.id, hk: 'npc', hx: Math.round(npc.x), hy: Math.round(npc.y) });
      room._damageNpc(npc, FIRE_DMG, player);
    } else if (hit.kind === 'station') {
      // M2i: KORSAN İSTASYONU — yıkılırsa takviye kesilir (MINE_DMG: madencilik silahıyla aynı).
      const st = hit.target;
      room.bcast({ t: 'shot', id: player.id, hk: 'station', hx: Math.round(st.x), hy: Math.round(st.y) });
      room._damageStation(MINE_DMG, player);
    } else if (hit.kind === 'anomaly') {
      // M4/M5: ANOMALİ nesnesi vuruldu — kalıntı yağması veya kalkan geri beslemesi
      const anom = hit.target;
      room.bcast({ t: 'shot', id: player.id, hk: 'anomaly', hx: Math.round(anom.x), hy: Math.round(anom.y) });
      room._damageAnomaly(MINE_DMG, player);
    } else {
      const target = hit.target;
      room.bcast({ t: 'shot', id: player.id, hk: 'player', hx: Math.round(target.x), hy: Math.round(target.y) });
      this._damagePlayer(room, target, FIRE_DMG, player);
    }
  }

  // Tractor beam: hedefi (KAYA veya DÜŞEN KAPSÜL veya ANOMALİ) oyuncuya işaretle (fizik Room.tick'te).
  // AI'A NOT: Kullanıcı isteği — "tractor beam de çekebilecek pickupları". Hedef arama sırası
  // önce kapsüller (küçük ve hareketli), sonra kayalar, sonra anomaliler.
  handleTractorBeam(player, msg) {
    const room = this.rooms.get(player.roomId);
    if (!room) return;
    const on = typeof msg.on === 'boolean' ? msg.on : !player.tractor;
    if (!on) { player.tractor = null; this._sys(player, 'tb', 'Tractor beam kapandi.', { mode: 'off' }); return; }
    const pick = room.pickups.get(msg.tid);
    const rock = pick ? null : room.entities.get(msg.tid);
    const anom = (pick || rock) ? null : ((room.anomaly && room.anomaly.id === msg.tid) ? room.anomaly : null);
    if (!pick && !rock && !anom) { this._sys(player, 'tb', 'Tractor hedefi bulunamadi.', { mode: 'none' }); return; }
    if (anom) {
      if (anom.kind !== 'DERELICT' && anom.kind !== 'GRAVEYARD' && anom.kind !== 'RUIN') {
        return this._sys(player, 'tb', 'Bu anomali cekilemez.', { mode: 'none' });
      }
      player.tractor = { rockId: anom.id, stuck: 0, isAnom: true };
      return this._sys(player, 'tb', `Tractor beam: ${anom.kind} kalintisi yagmalaniyor.`, { mode: 'anom', ore: anom.kind });
    }
    player.tractor = { rockId: (pick || rock).id, stuck: 0 };
    // AI'A NOT: Metin sunucuda TÜRKÇE duruyor (SSOT kuralı: metin + parametre) ama İSTEMCİ
    // sözlükten çizer. `mode`/`ore` parametreleri bu yüzden ZORUNLU: tek `tb` kodu 4 farklı durumu
    // anlatıyor ve istemci hangisi olduğunu ancak parametreyle bilebilir. (Parametresizken
    // İngilizce oynayan kullanıcı ham Türkçe satır görüyordu — bkz. test-i18n.)
    this._sys(player, 'tb', pick
      ? `Tractor beam: dusen kapsul (${pick.ore}) cekiliyor.`
      : `Tractor beam: ${rock.ore} kayasi cekiliyor.`,
    pick ? { mode: 'pick', ore: pick.ore } : { mode: 'rock', ore: rock.ore });
  }

  // M4/M5: Sinyal ve frekans çözme mini-oyunu (SILENT_BEACON ve OBSCURED_SIGNAL)
  handleSolveAnomaly(player, msg) {
    const room = this.rooms.get(player.roomId);
    if (!room || !room.anomaly) return;
    const anom = room.anomaly;
    if (anom.kind !== 'SILENT_BEACON' && anom.kind !== 'OBSCURED_SIGNAL') {
      return this._sys(player, 'anom_none', 'Bu anomalide cozumleme yapilamaz.');
    }
    const dist = Math.hypot(player.x - anom.x, player.y - anom.y);
    if (dist > 450) {
      return this._sys(player, 'anom_far', `Anomaliye cok uzaktasin (en fazla 450 birim, su an ${Math.round(dist)}).`, { d: Math.round(dist) });
    }
    if (anom.solved) {
      return this._sys(player, 'anom_already', 'Sinyal daha once cozulmus.');
    }
    const code = Number(msg.code);
    if (code === anom.code) {
      anom.solved = true;
      room.addPickup(anom.x + 20, anom.y - 15, 'WARPCELL', 2);
      room.addPickup(anom.x - 20, anom.y + 15, 'REZONANS', 2);
      room.addPickup(anom.x + 10, anom.y + 25, 'SILICON', 2);
      room.bcast({ t: 'anom_solved', id: anom.id, by: player.id });
      room.pushEvent({ kind: 'anom_solved', actorId: player.id, data: { kind: anom.kind, starId: room.starId } });
      this._sys(player, 'anom_solved', 'Sinyal frekansi basariyla eslestirildi! Nadir veri ve hucreler elde edildi.');
      room.sysAll(`${player.callsign} ${anom.kind} sinyalini basariyla cozdu!`, 'anom_solved_all', player.id, { name: player.callsign, kind: anom.kind });
    } else {
      // M4a: yanlış denemede KAÇ HANENİN doğru olduğu söylenir → 10 adaylık bir tahmin oyunu
      // (ipucu 3 haneyi veriyor), "kör dövüş" değil. Deneme SINIRI yok: ceza = zaman kaybı.
      let ok = 0;
      const g = String(msg.code == null ? '' : msg.code);
      const s = String(anom.code);
      for (let i = 0; i < 4; i++) if (g[i] && g[i] === s[i]) ok++;
      room.pushEvent({ kind: 'anom_wrong', actorId: player.id, data: { kind: anom.kind, ok } });
      this._sys(player, 'anom_wrong', `Frekans uyusmadi (${ok}/4 hane dogru).`, { ok });
    }
  }

  // M4a — E TARAMASI: anomaliyi tarar ve SİNYAL türlerinde frekans İPUCUNU verir.
  // AI'A NOT: İpucu sunucudan gelir (kod istemciye ASLA gitmez); istemci kendi başına ipucu
  // uyduramaz. Kalıntı türlerinde "nasıl yağmalanır" bilgisi döner — oyuncu ne yapacağını
  // tahmin etmek zorunda kalmaz (sessiz kapı = oyuncu hatayı kendinde arar).
  handleScanAnomaly(player, msg) {
    const room = this.rooms.get(player.roomId);
    const anom = room && room.anomaly;
    if (!anom) return this._sys(player, 'anom_absent', 'Bu sistemde anomali yok.');
    if (anom.solved) return this._sys(player, 'anom_already', 'Sinyal daha once cozulmus.');
    const dist = Math.hypot(player.x - anom.x, player.y - anom.y);
    if (!anom.signal) {
      return this._sys(player, 'anom_loot_hint',
        `${anom.kind}: bir kalinti. Ateşle parcala ya da F ile tractor cekip parca parca yagmala.`,
        { kind: anom.kind, d: Math.round(dist) });
    }
    if (dist > ANOM_HINT_RANGE) {
      return this._sys(player, 'anom_far', `Anomaliye cok uzaktasin (en fazla ${ANOM_HINT_RANGE} birim, su an ${Math.round(dist)}).`, { d: Math.round(dist), range: ANOM_HINT_RANGE });
    }
    player.ws.send(JSON.stringify({ t: 'anom_hint', id: anom.id, kind: anom.kind, hint: anom.hint }));
    room.pushEvent({ kind: 'anom_hint', actorId: player.id, data: { kind: anom.kind } });
    this._sys(player, 'anom_hint', `Frekans ipucu alindi: ${anom.hint} — 450 birim icinde R ile kodu gir.`, { hint: anom.hint });
  }

  // Kalkan → gövde hasar akışı. Kalkan önce emer, taşan kısım gövdeye geçer.
  _damagePlayer(room, target, dmg, by) {
    target.lastHitAt = Date.now();     // M3d: kalkan regen SAYACI burada SIFIRLANIR
    target.shield -= dmg;
    let overflow = 0;
    if (target.shield < 0) { overflow = -target.shield; target.shield = 0; }
    target.hull -= overflow;
    room.pushEvent({ kind: 'hit', actorId: target.id,
      data: { dmg, by: by ? by.id : null, hull: Math.round(target.hull), shield: Math.round(target.shield) } });
    // Hasar paketi hem HEDEFE hem odaya gider: hedef HUD'unu, diğerleri kıvılcımı çizer.
    room.bcast({ t: 'dmg', id: target.id, dmg,
    x: Math.round(target.x), y: Math.round(target.y),
    shield: Math.round(target.shield), hull: Math.round(target.hull) });
    if (target.hull <= 0) this._destroyPlayer(target, by);
  }

  // Yok edilme → patlama + ölüm anonsu + KURTARMA (ana sisteme dönüş, tamir).
  // AI'A NOT: Yeniden doğuş her zaman ANA sisteme olur ve hasar sıfırlanır. Neden: spawn
  // kampı (spawn camping) ve "sonsuz ölüm döngüsü"nü engeller; ölen oyuncu güvenli bir
  // noktada toparlanır. Envanter (cargo) korunur — ölüm cezası şimdilik yok.
  _destroyPlayer(target, by) {
    const room = this.rooms.get(target.roomId);
    if (room) {
      room.bcast({ t: 'boom', id: target.id, x: Math.round(target.x), y: Math.round(target.y) });
      room.pushEvent({ kind: 'death', actorId: target.id, data: { by: by ? by.id : null } });
      room.sysAll(`${target.callsign} yok edildi${by ? ` — ${by.callsign} tarafindan` : ''}.`, 'destroyed', null,
        { name: target.callsign, by: by ? by.callsign : null });
    }
    target.deaths++;
    if (by) { by.kills++; this._sys(by, 'kill', `${target.callsign} yok edildi (${by.kills} kill).`, { name: target.callsign, kills: by.kills }); }

    target.hull = 100; target.shield = 100; target.tractor = null;
    target.shieldSent = 100; target.lastHitAt = 0;   // M3d: kalkan HUD'u + regen sayacı sıfırlanır
    target.refuelOn = false;      // M2e: ölüm dolumu keser
    const a = Math.random() * Math.PI * 2, rr = 380 + Math.random() * 240;
    target.x = Math.round(Math.cos(a) * rr);
    target.y = Math.round(Math.sin(a) * rr);
    this.assignRoom(target, roomIdForStar(this.homeStarId));   // ana sistem + yeni snapshot
    this._sys(target, 'death', 'Gemin yok edildi. Kurtarma gemisi ana sisteme getirdi.');
  }

  // Kaya kırıldı → GANİMET UZAYA DÜŞER + yok olma paketi + zaman gecikmeli yeniden doğuş.
  // AI'A NOT: KULLANICI İSTEĞİ (birebir): "asteroidlerden veya oyundaki herhangi bir şeyden
  // düşen item önce uzaya düşecek biz gidip gemiyle toplayacaz, tractor beam de çekebilecek
  // pickupları". Eskiden ganimet ANINDA envantere giriyordu (madencilik = sadece ateş etmek);
  // artık kırılan kayanın yerine bir KAPSÜL düşer, süzülür ve oyuncu onu almak için HAREKET
  // ETMEK zorundadır (ya da tractor beam ile çekmek). Toplama kararı sunucuda (Room.tick).
  _breakRock(room, rock, shooter) {
    const amount = 1 + Math.floor(rock.size / 12);
    room.entities.delete(rock.id);
    room.bcast({ t: 'rockgone', id: rock.id });
    room.pushEvent({ kind: 'rock_break', actorId: shooter.id, data: { ore: rock.ore, amount } });

    // Kapsül kayanın hemen yanında doğar (tam üstünde değil: "düşme" hissi) ve yavaşça süzülür.
    const a = Math.random() * Math.PI * 2, off = 10 + Math.random() * 14;
    room.addPickup(rock.x + Math.cos(a) * off, rock.y + Math.sin(a) * off, rock.ore, amount);
    this._sys(shooter, 'loot_drop',
      `${rock.ore} kapsulu uzaya dustu (${amount} birim) — uzerine git ya da F ile cek.`,
      { ore: rock.ore, amount });

    // AI'A NOT: Kuşak tükenmesin. Aynı koordinatta aynı boyutta yeniden doğar; ODA
    // hibernate olduysa kaya geri gelmez (kaynak geri dönmez — dünya sözleşmesi).
    const { roomId } = room;
    const { x, y, size, ore, maxHp } = rock;
    setTimeout(() => {
      const r = this.rooms.get(roomId);
      if (!r) return;
      const id = r.addAsteroid(x, y, size, ore);
      r.bcast({ t: 'rocknew', id, x, y, size, hp: maxHp, ore });
    }, ROCK_RESPAWN_MS);
  }

  // M3 — 4 kanallı sohbet. Sunucu otoriter: kanal yönlendirmesi, rate limit ve metin temizliği
  // burada. (Eski sürüm tek kanaldı ve `sysAll` ile sistem mesajı olarak yolluyordu.)
  handleChat(player, msg) {
    if (!player || !player.ws) return;
    const text = cleanChat(msg.m);
    if (!text) return;
    const ch = CHAT_CH.has(msg.ch) ? msg.ch : 'l';

    // --- RATE LIMIT: önce kısa bekleme, sonra pencere kotası. Ret HER ZAMAN sebeple döner.
    const now = Date.now();
    const gap = now - (player.chatLast || 0);
    if (gap < CHAT_CD_MS) return this._sys(player, 'chat_fast', 'Cok hizli yaziyorsun.');
    player.chatAt = (player.chatAt || []).filter((t) => now - t < CHAT_BURST_MS);
    if (player.chatAt.length >= CHAT_BURST_MAX) {
      return this._sys(player, 'chat_flood',
        `Sohbet siniri: ${CHAT_BURST_MS / 1000} saniyede en fazla ${CHAT_BURST_MAX} mesaj.`,
        { n: CHAT_BURST_MAX, s: CHAT_BURST_MS / 1000 });
    }
    player.chatAt.push(now);
    player.chatLast = now;

    // --- ÖZEL: çağrı işaretine DM
    if (ch === 'p') {
      const want = cleanChat(msg.to);
      if (!want) return this._sys(player, 'chat_notarget', 'Ozel mesaj icin hedef cagri isareti gerekli.');
      const lc = want.toLowerCase();
      let target = null;
      for (const p of this.players.values()) {
        if (p.id !== player.id && p.callsign.toLowerCase() === lc) { target = p; break; }
      }
      if (!target) return this._sys(player, 'chat_noone', `"${want}" bu galakside yok.`, { name: want });
      const pk = { ch: 'p', from: player.callsign, m: text, dm: 1 };
      this._chatTo(target, { ...pk, to: player.callsign });
      this._chatTo(player, { ...pk, echo: 1, to: target.callsign });
      return;
    }

    const packet = { t: 'chat', ch, from: player.callsign, m: text };
    if (ch === 'g') {                                  // GLOBAL: tüm galaksi
      for (const p of this.players.values()) this._chatTo(p, packet);
      return;
    }
    if (ch === 's') {                                  // SEKTÖR: komşu sistemler
      const set = sectorStars(this._starOf(player.roomId));
      for (const p of this.players.values()) {
        if (set.has(this._starOf(p.roomId))) this._chatTo(p, packet);
      }
      return;
    }
    const room = this.rooms.get(player.roomId);        // YEREL: aynı oda
    if (room) room.bcast(packet);
  }

  // AI'A NOT (Tuzak 47): gönderen yardımcı, hedefin bir BAĞLANTI olmadığı varsayımıyla yazılır.
  _chatTo(player, packet) {
    if (!player || !player.ws || player.ws.readyState !== 1) return;
    player.ws.send(JSON.stringify({ t: 'chat', ts: Date.now(), ...packet }));
  }

  killPlayer(id) {
    const p = this.players.get(id);
    if (!p) return false;
    p.hull = 0;
    this._sys(p, 'death', 'Gemin yok edildi. Kurtarma gemisi yolda...');
    if (p.ws && p.ws.readyState === 1) p.ws.close(4009, 'destroyed');
    return true;
  }

  spawnAsteroid(roomId, args = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const x = Number(args.x ?? (Math.round((Math.random() - 0.5) * 600)));
    const y = Number(args.y ?? (Math.round((Math.random() - 0.5) * 600)));
    const size = Number(args.size ?? 20);
    const ore = args.ore || pickOre();
    const id = room.addAsteroid(x, y, size, ore);
    const rock = room.entities.get(id);
    if (rock) {
      room.bcast({ t: 'rocknew', id, x, y, size, hp: rock.maxHp, ore });
      room.pushEvent({ kind: 'spawn_asteroid', actorId: 'admin', data: { id, x, y, size, ore, roomId } });
    }
    return true;
  }

  beginStarKill(starId) {
    const sId = Number(starId);
    if (!Number.isInteger(sId)) return false;
    const star = starById(sId);
    if (!star) return false;
    star.a = 'SUPERNOVA';
    saveDestroyedStar(sId);
    if (this.onStarKill) this.onStarKill(sId);

    // Global duyuru: tüm canlı oyunculara sistem felaketi bildirimi
    for (const p of this.players.values()) {
      this._sys(p, 'star_kill', `DIKKAT: ${star.n} (${sId}) yildizinda hiper-patlama tetiklendi!`, { star: star.n, id: sId });
    }

    const roomId = roomIdForStar(sId);
    const room = this.rooms.get(roomId);
    if (room) {
      room.bcast({ t: 'ev', kind: 'star_kill', data: { starId: sId, name: star.n } });
      room.sysAll(`SUPERNOVA: ${star.n} yildiz sistemi yok edildi!`, 'star_kill', null, { star: star.n });
      room.pushEvent({ kind: 'star_kill', actorId: 'admin', data: { starId: sId, name: star.n } });
      for (const r of room.entities.values()) {
        room.bcast({ t: 'rockgone', id: r.id });
      }
      room.entities.clear();

      for (const p of [...room.players.values()]) {
        this._destroyPlayer(p, null);
      }
    }
    return true;
  }

  galaxyOverview() {
    const g = galaxy();
    const activeRooms = [];
    for (const [id, room] of this.rooms) {
      const star = starById(this._starOf(id));
      activeRooms.push({
        id,
        starId: room.starId,
        starName: star ? star.n : 'Unknown',
        starClass: star ? star.k : 'M',
        anomaly: star ? star.a : null,
        players: room.players.size,
        rocks: room.entities.size,
        pickups: room.pickups.size,
        pirateLvl: room.pirateLvl,
      });
    }

    const players = [];
    for (const p of this.players.values()) {
      const star = starById(this._starOf(p.roomId));
      players.push({
        id: p.id,
        callsign: p.callsign,
        roomId: p.roomId,
        starId: star ? star.i : 0,
        starName: star ? star.n : '',
        gx: star ? star.x : 0,
        gy: star ? star.y : 0,
        x: Math.round(p.x),
        y: Math.round(p.y),
        shield: Math.round(p.shield),
        hull: Math.round(p.hull),
        fuel: Math.round(p.fuel),
      });
    }

    return {
      seed: g.seed,
      radius: g.radius,
      totalStars: g.count,
      activeRooms,
      players,
    };
  }

  // -------------------------------------------------------------------------
  // LİSTELEME / ADMIN API
  // -------------------------------------------------------------------------
  activeRooms() {
    const out = [];
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.adminWatching && (!room.lastAdminWatchAt || now - room.lastAdminWatchAt > 10_000)) {
        room.adminWatching = false;
      }
      if (room.players.size > 0 || room.adminWatching) { room.lastEmptyAt = null; out.push(room); }
      else if (!room.lastEmptyAt) room.lastEmptyAt = now;
      if (room.lastEmptyAt && now - room.lastEmptyAt > HIBERNATE_DELAY_MS) {
        room.hibernate();
        this.rooms.delete(room.roomId);
      }
    }
    return out;
  }

  globalStats() {
    const g = galaxy();
    let warnings = 0;
    for (const p of this.players.values()) warnings += p.speedWarnings || 0;
    return {
      seed: GALAXY_SEED, stars: g.count,
      rooms: this.rooms.size, players: this.players.size,
      speedWarnings: warnings,
      tickMsBudget: 100, uptimeSec: Math.floor(process.uptime()),
    };
  }

  listPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, callsign: p.callsign, room: p.roomId,
      x: Math.round(p.x), y: Math.round(p.y),
      hull: Math.round(p.hull), shield: Math.round(p.shield), warnings: p.speedWarnings || 0,
      fuel: Math.round(p.fuel), cargo: p.cargo, kills: p.kills, deaths: p.deaths,
    }));
  }

  // -------------------------------------------------------------------------
  // ADMIN: ODA LİSTESİ + ODA DÖKÜMÜ ("her şey görünsün")
  // -------------------------------------------------------------------------
  listRooms() {
    const out = [];
    for (const [id, room] of this.rooms) {
      const star = starById(this._starOf(id));
      const rocks = room.entities.size;
      out.push({
        id,
        star: star ? { i: star.i, n: star.n, k: star.k, a: star.a, p: star.p } : null,
        players: room.players.size,
        rocks,
        dirty: room.dirty.size,
        idleMs: room.lastEmptyAt ? Date.now() - room.lastEmptyAt : 0,
      });
    }
    return out.sort((a, b) => b.players - a.players || b.rocks - a.rocks || a.id.localeCompare(b.id));
  }

  roomDetail(id) {
    let room = this.rooms.get(id);
    if (!room) {
      // AI'A NOT: Admin istediği herhangi bir yıldızı/odayı seçip izleyebilsin (kullanıcı isteği).
      // Oda bellekte henüz yoksa deterministik olarak ayağa kaldırılır.
      const starId = this._starOf(id);
      const star = starById(starId);
      if (!star) return null;
      room = new Room(id, this.homeStarId, this);
      this.rooms.set(id, room);
    }
    room.adminWatching = true;
    room.lastAdminWatchAt = Date.now();

    const star = starById(this._starOf(id));
    const rocks = [];
    for (const r of room.entities.values()) {
      rocks.push({ id: r.id, x: Math.round(r.x), y: Math.round(r.y), size: r.size,
        hp: Math.round(r.hp), maxHp: r.maxHp, ore: r.ore });
    }
    const players = [];
    for (const p of room.players.values()) {
      players.push({
        id: p.id, callsign: p.callsign,
        x: Math.round(p.x), y: Math.round(p.y), r: Number(p.r.toFixed(2)),
        shield: Math.round(p.shield), hull: Math.round(p.hull), fuel: Math.round(p.fuel),
        cargo: p.cargo, kills: p.kills, deaths: p.deaths,
        warnings: p.speedWarnings, tractor: p.tractor ? p.tractor.rockId : null,
        lastMsgMs: Date.now() - (p.lastMsgAt || Date.now()),
      });
    }
    const pickups = [];
    for (const k of room.pickups.values()) {
      pickups.push({ id: k.id, x: Math.round(k.x), y: Math.round(k.y), ore: k.ore, amount: k.amount });
    }
    const npcs = [];
    for (const n of room.npcs.values()) {
      npcs.push({
        id: n.id, callsign: n.callsign,
        x: Math.round(n.x), y: Math.round(n.y), r: Number(n.r.toFixed(2)),
        hp: Math.max(0, Math.round(n.hull)), maxHp: PIRATE_HULL
      });
    }
    const station = room.station ? {
      id: room.station.id,
      x: room.station.x,
      y: room.station.y,
      hp: Math.max(0, Math.round(room.station.hp)),
      maxHp: room.station.maxHp,
      radius: STATION_RADIUS,
    } : null;

    return {
      id,
      star: star ? { i: star.i, n: star.n, k: star.k, x: star.x, y: star.y, a: star.a, p: star.p, b: star.b } : null,
      players, rocks, pickups, npcs, station,
      pirateLvl: room.pirateLvl,
      events: room.events.slice(-30),
      lastEmptyAt: room.lastEmptyAt || null,
    };
  }

  describeTarget(kind, id) {
    if (kind === 'player') {
      const p = this.players.get(id);
      if (!p) return null;
      const { ws, ip, ...safe } = p;
      return { type: 'player', ...safe, star: starById(this._starOf(p.roomId))?.n ?? null };
    }
    if (kind === 'room') {
      let r = this.rooms.get(id);
      if (!r) {
        const starId = this._starOf(id);
        const star = starById(starId);
        if (star) {
          r = new Room(id, this.homeStarId, this);
          this.rooms.set(id, r);
        }
      }
      if (!r) return null;
      return { type: 'room', id, players: r.players.size, rocks: r.entities.size, starId: r.starId };
    }
    if (kind === 'star') {
      const s = starById(Number(id));
      return s ? { type: 'star', ...s } : null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// ROOM — tek yıldız sistemi instance'ı
// ---------------------------------------------------------------------------
export class Room {
  constructor(roomId, safeStarId = -1, mgr = null) {
    this.roomId = roomId;
    // M2i: geri referans — korsanların oyuncuya hasar vermesi/olay kaydı için RoomManager'ın
    // `_damagePlayer`/`_sys` yardımcıları gerekir (Room tek başına bunları bilmez).
    this.mgr = mgr;
    this.starId = Number(String(roomId).replace(/^s/, '').split('-')[0]);
    // M2i — KORSANLAR: seviye deterministik; ana sistem (safeStarId) HER ZAMAN sakin.
    this.safeStarId = safeStarId;
    this.pirateLvl = pirateLevel(this.starId, safeStarId);
    this.npcs = new Map();     // id -> korsan gemisi (HAREKETLİ → diff ile yayınlanır)
    this.npcSeq = 0;
    this.lastNpcAt = 0;
    this.station = null;       // seviye 2'de bir korsan istasyonu
    this.players = new Map();
    this.entities = new Map(); // asteroidler — STATİK (yalnız snapshot'ta gönderilir)
    // AI'A NOT: DÜŞEN KAPSÜLLER — kayalardan farklı olarak HAREKETLİ ve ömürlüdür; bu yüzden
    // ayrı koleksiyonda tutulurlar (kuşak `entities`'i statik kalır, sessizlik perf. kuralı).
    this.pickups = new Map();
    this.pickupSeq = 0;
    this.rockSeq = 0;          // monotonic asteroid ID counter (entities.size → çakışma riski vardı)
    this.dirty = new Set();    // bu tick'te değişen oyuncu id'leri → diff
    this.events = [];
    this.lastEmptyAt = null;
    this._genRocks();
    this._genStation();
    this.anomaly = null;      // M4a: sinyal/kalıntı nesnesi (yalnız `a` işaretli yıldızlarda)
    this._genAnomaly();
  }

  // -------------------------------------------------------------------------
  // M4a — ANOMALİ NESNESİ (galaksideki yıldızların ~%4'ü `a` alanıyla işaretli)
  // -------------------------------------------------------------------------
  // AI'A NOT: Bu nesne O SİSTEMDEKİ somut hedeftir; olmadan tüm anomali kod yolları (çözme,
  // kalıntı yağması, ışın isabeti) ÖLÜ kalır — nitekim öyleydi (bkz. analiz). Konum ve frekans
  // kodu DETERMİNİSTİK (korsan istasyonuyla aynı desen): aynı sistem her zaman aynı anomaliyi
  // verir, oyuncu bir kez bulduğunu tekrar bulabilir.
  // İKİ TÜR: (1) SİNYAL — ateşle yıkılmaz, `R` ile frekans kodu girilir ("sinyal çözme mini-oyunu"),
  //          (2) KALINTI — ateş ya da tractor beam ile yağmalanır ("kalıntı yağması").
  _genAnomaly() {
    const star = starById(this.starId);
    if (!star || !star.a) return;
    const kind = star.a;
    const signal = ANOM_SIGNAL_KINDS.includes(kind);
    const ang = pirateHash(this.starId ^ 0x5e7a1b) * Math.PI * 2;
    const rad = 900 + pirateHash(this.starId ^ 0x1c3d5f) * 520;   // kuşağın içi/hemen dışı
    const code = 1000 + Math.floor(pirateHash(this.starId ^ 0x9f2c4d) * 9000);  // 4 hane
    const d = String(code);
    // İPUCU: son hane gizli, ilk üç hane açık ("4 1 7 ?"). Oyuncu tek haneyi deneyerek bulur;
    // yanlış denemede kaç hanenin doğru olduğu söylenir → bulmaca sinir bozucu olmaz.
    this.anomaly = {
      id: 'a1', kind, signal,
      x: Math.round(Math.cos(ang) * rad), y: Math.round(Math.sin(ang) * rad),
      hp: ANOM_HULL, maxHp: ANOM_HULL,
      code, hint: `${d[0]} ${d[1]} ${d[2]} ?`,
      solved: false, looted: 0, nextLootAt: 0,
    };
    // PELLE: kalıntılarda yıkma eşiği vurulabilir olmalı; sinyallerde hp anlamsız.
    if (signal) { this.anomaly.hp = 0; this.anomaly.maxHp = 0; }
  }

  // -------------------------------------------------------------------------
  // M2i — KORSAN İSTASYONU + KORSAN GEMİLERİ (kullanıcı isteği)
  // -------------------------------------------------------------------------
  // İstasyon konumu da DETERMINISTIK: yıldızın etrafında 1150 birim, karma ile seçilen açı.
  // Kuşağın (700-1600) İÇİNDE ama kayalarla çakışmayacak şekilde sabit — aynı sistem her
  // zaman aynı düzeni verir (oyuncu haritayı ezberleyebilir; bu bir keşif oyunu değil, arena).
  _genStation() {
    if (this.pirateLvl < 2) return;
    const ang = pirateHash(this.starId ^ 0x1a2b3c4d) * Math.PI * 2;
    const rad = 1080 + pirateHash(this.starId ^ 0x77aa11) * 220;
    this.station = {
      id: 'st1',
      x: Math.round(Math.cos(ang) * rad),
      y: Math.round(Math.sin(ang) * rad),
      hp: STATION_HULL, maxHp: STATION_HULL,
    };
  }

  _spawnNpc(now) {
    this.npcSeq++;
    const id = 'x' + this.npcSeq;
    const st = this.station;
    let x, y;
    if (st) { x = st.x + 60; y = st.y + 60; }                  // istasyonun yanından çıkar
    else {
      const a = pirateHash(this.starId * 7 + this.npcSeq * 31) * Math.PI * 2;
      x = Math.cos(a) * 980; y = Math.sin(a) * 980;
    }
    const npc = {
      id, callsign: 'KORSAN-' + String(this.npcSeq).padStart(2, '0'),
      x: Math.round(x), y: Math.round(y), r: 0,
      hull: PIRATE_HULL, lastFire: now, dirty: true, pirate: true,
    };
    this.npcs.set(id, npc);
    this.lastNpcAt = now;
    const payload = { t: 'npc', id, callsign: npc.callsign, x: npc.x, y: npc.y, r: npc.r, hp: PIRATE_HULL, max: PIRATE_HULL };
    this.bcast(payload);
    this.sysAll('Korsan sinyali: ' + npc.callsign + ' sistemde!', 'pirate', null, { name: npc.callsign });
  }

  // Oyuncu odadan çıkınca korsanlar da temizlenir (boş odada simülasyon = boşa CPU).
  _clearNpcs() {
    for (const id of this.npcs.keys()) this.bcast({ t: 'npcgone', id, why: 'left' });
    this.npcs.clear();
  }

  // Korsan yapay zekâsı: en yakın oyuncuya yaklaş, menzile girince ateş et, çok yaklaşırsa geri dur.
  // AI'A NOT: Bu bir "boss" değil; amaç oyuncuyu yıldız dibinden uzaklaştırmaya zorlamak ve
  // madencilik sırasında RISK üretmek. Bu yüzden korsan daha yavaş ve daha zayıf ateş eder.
  _pirateTick(dt, now) {
    if (!this.pirateLvl) return;
    if (this.players.size === 0) { if (this.npcs.size) this._clearNpcs(); return; }

    const cap = Math.min(NPC_CAP, Math.max(1, this.players.size + 1));
    // İSTASYON YIKILDIYSA TAKVİYE DURUR (kullanıcı sözü: "istasyon = üreme merkezi"). Seviye 1
    // (istasyonsuz korsan bandı) takviye almaya devam eder: orası gezici bir çete.
    const cleared = this.pirateLvl >= 2 && !this.station;
    const interval = this.station ? STATION_SPAWN_MS : NPC_SPAWN_MS;
    if (!this.lastNpcAt) this.lastNpcAt = now;                // ilk girişte hemen doldurma
    if (!cleared && this.npcs.size < cap && now - this.lastNpcAt > interval) this._spawnNpc(now);

    for (const n of this.npcs.values()) {
      let target = null, bestD = Infinity;
      for (const p of this.players.values()) {
        if (p.hull <= 0) continue;
        const d = Math.hypot(p.x - n.x, p.y - n.y);
        if (d < bestD) { bestD = d; target = p; }
      }
      if (!target) {
        const st = this.station;
        if (st) { const dx = st.x - n.x, dy = st.y - n.y, d = Math.hypot(dx, dy) || 1;
          if (d > 90) { n.x += (dx / d) * PIRATE_SPEED * 0.5 * dt; n.y += (dy / d) * PIRATE_SPEED * 0.5 * dt; n.dirty = true; } }
        continue;
      }
      const dx = target.x - n.x, dy = target.y - n.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      n.r = Math.atan2(ux, -uy);
      if (dist > PIRATE_ACTIVE) {                        // çok uzak (sistemin öbür ucu): devriye
        n.lastFire = now;
      } else if (dist > PIRATE_STANDOFF) {               // yaklaş (korsan oyuncudan YAVAŞ)
        n.x += ux * PIRATE_SPEED * dt; n.y += uy * PIRATE_SPEED * dt; n.dirty = true;
      } else if (dist < PIRATE_STANDOFF * 0.7) {         // fazla yakın: geri dur (ram yok)
        n.x -= ux * PIRATE_SPEED * 0.7 * dt; n.y -= uy * PIRATE_SPEED * 0.7 * dt; n.dirty = true;
      }
      if (dist <= PIRATE_RANGE && now - n.lastFire >= PIRATE_COOLDOWN_MS) {
        n.lastFire = now;
        this.bcast({ t: 'shot', id: n.id, hk: 'player', hx: Math.round(target.x), hy: Math.round(target.y) });
        if (this.mgr) this.mgr._damagePlayer(this, target, PIRATE_DMG, n);
      }
    }
  }

  // Korsan vuruldu: hasar HUD'u için npchp paketi (yalnız vurulunca → trafik yok).
  _damageNpc(npc, dmg, by) {
    npc.hull -= dmg;
    this.bcast({ t: 'npchp', id: npc.id, hp: Math.max(0, Math.round(npc.hull)), max: PIRATE_HULL });
    if (npc.hull <= 0) this._destroyNpc(npc, by);
  }

  // Korsan yok edildi → patlama + ganimet (DOTERYUM ağırlıklı: korsan avı yakıt kazandırır).
  _destroyNpc(npc, by) {
    this.npcs.delete(npc.id);
    this.bcast({ t: 'npcgone', id: npc.id, why: 'killed', x: Math.round(npc.x), y: Math.round(npc.y) });
    this.pushEvent({ kind: 'npc_kill', actorId: by ? by.id : null, data: { npc: npc.id } });
    const loot = Math.random() < 0.3
      ? ['DOTERYUM', 'DOTERYUM', 'SILICON', 'WARPCELL']
      : ['DOTERYUM', 'SILICON', 'TITAN', 'DOTERYUM'];
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, off = 12 + Math.random() * 16;
      this.addPickup(npc.x + Math.cos(a) * off, npc.y + Math.sin(a) * off,
        loot[Math.floor(Math.random() * loot.length)], 1 + Math.floor(Math.random() * 2));
    }
    if (by) {
      by.kills++;
      if (this.mgr) this.mgr._sys(by, 'npc_kill', `${npc.callsign} yok edildi (${by.kills} kill).`, { name: npc.callsign, kills: by.kills });
    }
    this.sysAll(`${npc.callsign} yok edildi — ganimet uzaya dustu.`, 'npc_down', null, { name: npc.callsign });
  }

  // -------------------------------------------------------------------------
  // M4a — ANOMALİ HASARI / YAĞMA (kalıntı türleri)
  // -------------------------------------------------------------------------
  // AI'A NOT: Bu metod çağrılıyordu ama TANIMLI DEĞİLDİ (ışın anomalıye isabet etse sunucu
  // TypeError ile çökerdi — rayPick anomaliyi hiç görmediği için hiç tetiklenmemişti).
  // SİNYAL türleri ateşle yıkılmaz: oyuncuya doğru yolu (R ile frekans girme) söyleyen bir
  // mesaj döner — "vurulmuyor" sessiz kalmaz (Tuzak: kapı sessizse oyuncu hatayı kendinde arar).
  _damageAnomaly(dmg, by) {
    const anom = this.anomaly;
    if (!anom || anom.solved) return;
    if (anom.signal || !ANOM_LOOT_KINDS.includes(anom.kind)) {
      this._sysTo(by, 'anom_signal', 'Sinyal atesle cozulmez — yakinlas ve R ile frekansi gir.');
      return;
    }
    anom.hp -= dmg;
    this.bcast({ t: 'anomhp', id: anom.id, hp: anom.hp, max: anom.maxHp });
    if (anom.hp > 0) return;
    // YIKILDI → ganimet uzaya dağılır ("kalıntı yağması"): parçalar normal kapsül olarak düşer.
    this._lootAnomaly(by, 'destroyed');
  }

  // Kalıntıdan ganimet düşürür ve anomaliyi "çözülmüş" işaretler. İki yol var: ateş (tek seferde
  // hepsi) ve tractor beam (parça parça, aşağıda tick'te). İkisi de AYNI düşürme fonksiyonunu
  // kullanır → iki kod yolu arasında ödül farkı oluşmaz.
  _lootAnomaly(by, why, count = 5) {
    const anom = this.anomaly;
    if (!anom || anom.solved) return;
    const ores = ['DEMIR', 'BAKIR', 'TITAN', 'SILICON', 'REZONANS'];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + pirateHash(anom.x + i) * 0.5;
      const off = 26 + (i % 3) * 14;
      this.addPickup(anom.x + Math.cos(a) * off, anom.y + Math.sin(a) * off,
        ores[i % ores.length], 1 + (i % 3));
    }
    this.addPickup(anom.x, anom.y - 34, 'DOTERYUM', 1);   // nadir: anomali kalıntısı
    anom.solved = true;
    this.bcast({ t: 'anomgone', id: anom.id, why });
    this.pushEvent({ kind: 'anom_looted', actorId: by ? by.id : null,
      data: { kind: anom.kind, starId: this.starId, why } });
    if (by) this._sysTo(by, 'anom_looted', `${anom.kind} kalintisi yagmalandi — ganimet uzayda.`);
    this.sysAll(`${anom.kind} kalintisi parcalandi — ganimet uzaya dagildi.`, 'anom_looted_all', null,
      { kind: anom.kind });
  }

  // M4a — TRACTOR İLE KALINTI YAĞMA: her ANOM_LOOT_STEP_MS'de bir parça kapsül düşer; parçalar
  // DETERMİNİSTİK sırayla gelir (rastgele değil) ve son parça DOTERYUM (nadir). Kalıntı tükenince
  // anomali kapanır. Neden ayrı yol: ateş anında hepsini düşürür, tractor ZAMAN alır → oyuncu
  // "hızlı yık" ile "sabırla çek" arasında seçim yapar (kapı sunucuda, istemci yalnız bildirir).
  _tractorAnomaly(p, now) {
    const anom = this.anomaly;
    if (!anom || anom.solved || !ANOM_LOOT_KINDS.includes(anom.kind)) {
      p.tractor = null;
      this._sysTo(p, 'tb', 'Cekilecek kalinti kalmadi.', { mode: 'none' });
      return;
    }
    const d = Math.hypot(p.x - anom.x, p.y - anom.y);
    if (d > TRACTOR_RANGE) { if (++p.tractor.stuck > 20) p.tractor = null; return; }
    p.tractor.stuck = 0;
    if (now < (anom.nextLootAt || 0)) return;
    anom.nextLootAt = now + ANOM_LOOT_STEP_MS;
    anom.looted++;
    const ores = ['DEMIR', 'BAKIR', 'TITAN', 'SILICON', 'REZONANS'];
    const ore = anom.looted >= ANOM_LOOT_PIECES ? 'DOTERYUM' : ores[(anom.looted - 1) % ores.length];
    const a = pirateHash(anom.x + anom.looted * 37) * Math.PI * 2;
    this.addPickup(anom.x + Math.cos(a) * 30, anom.y + Math.sin(a) * 30, ore, 1 + (anom.looted % 2));
    if (anom.looted >= ANOM_LOOT_PIECES) {
      const by = p;
      anom.solved = true;
      this.bcast({ t: 'anomgone', id: anom.id, why: 'stripped' });
      this.pushEvent({ kind: 'anom_looted', actorId: by.id,
        data: { kind: anom.kind, starId: this.starId, why: 'stripped' } });
      this._sysTo(by, 'anom_looted', `${anom.kind} kalintisi tamamen sokuldu.`);
      this.sysAll(`${anom.kind} kalintisi sokuldu — ganimet uzaya dagildi.`, 'anom_looted_all', null,
        { kind: anom.kind });
    }
  }

  // Room içinde TEK oyuncuya sistem mesajı (RoomManager._sys ile aynı paket biçimi).
  // AI'A NOT: NPC/hedef bir bağlantı olmayabilir → `ws` savunmalı okunur (bkz. Tuzak 44).
  _sysTo(player, code, text, p) {
    if (!player || !player.ws || player.ws.readyState !== 1) return;
    player.ws.send(JSON.stringify({ t: 'sys', code, msg: text, p: p || null }));
  }

  _damageStation(dmg, by) {
    const st = this.station;
    if (!st || st.hp <= 0) return;
    st.hp -= dmg;
    this.bcast({ t: 'stathp', id: st.id, hp: Math.max(0, Math.round(st.hp)), max: st.maxHp });
    if (st.hp <= 0) this._destroyStation(by);
  }

  // İstasyon yıkıldı → takviye DURUR, büyük ganimet düşer, yıldız "temizlenmiş" olur.
  _destroyStation(by) {
    const st = this.station;
    if (!st) return;
    this.bcast({ t: 'stationgone', id: st.id, x: st.x, y: st.y });
    this.pushEvent({ kind: 'station_down', actorId: by ? by.id : null, data: { starId: this.starId } });
    const drops = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2, off = 20 + Math.random() * 40;
      const ore = ['SILICON', 'TITAN', 'REZONANS', 'BAKIR'][Math.floor(Math.random() * 4)];
      this.addPickup(st.x + Math.cos(a) * off, st.y + Math.sin(a) * off, ore, 2 + Math.floor(Math.random() * 3));
      drops.push(ore);
    }
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2, off = 20 + Math.random() * 30;
      this.addPickup(st.x + Math.cos(a) * off, st.y + Math.sin(a) * off, 'WARPCELL', 1);
    }
    this.station = null;         // takviye doğurma durur (odadaki korsanlar kalır)
    this.sysAll('KORSAN ISTASYONU YOK EDILDI! Takviye kesildi, ganimet uzaya dustu.', 'station_down', null,
      { by: by ? by.callsign : null });
  }

  // AI'A NOT: Asteroid üretimi DETERMINISTIK. Aynı yıldız her zaman aynı kuşağı verir —
  // room hibernate edip yeniden açılsa bile DÜNYA AYNI KALIR. Oyuncu güveni için kritik.
  _genRocks() {
    const star = starById(this.starId);
    const beltCount = star?.b ?? 0;
    if (!beltCount) return;
    let s = (this.starId * 2654435761) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const total = 8 + beltCount * 10;
    for (let i = 0; i < total; i++) {
      const ang = rnd() * Math.PI * 2;
      const rad = 700 + rnd() * 900;
      // AI'A NOT: cevher de SEED'li rnd ile seçilir → kuşak tam deterministik (aynı yıldız
      // her zaman aynı kayalari VE aynı cevherleri verir; hibernate/warp sonrası dünya sabit).
      this.addAsteroid(Math.round(Math.cos(ang) * rad), Math.round(Math.sin(ang) * rad),
        10 + Math.round(rnd() * 18), pickOre(rnd));
    }
  }

  addAsteroid(x, y, size, oreOverride = null) {
    const id = 'a' + (this.rockSeq++).toString(36);
    // AI'A NOT: hp boyutla ölçeklenir; ore tipi madencilik değeri (Milestone 2) için.
    // oreOverride: kırılan kayanın YENİDEN doğuşunda aynı cevher tipini korumak için.
    this.entities.set(id, {
      id, x, y, size,
      hp: Math.round(size * 3), maxHp: Math.round(size * 3),
      ore: oreOverride || pickOre(),
    });
    return id;
  }

  // AI'A NOT: UZAYA DÜŞEN KAPSÜL (kullanıcı isteği). Kayadan düşen ganimet ANINDA envantere
  // girmez: düştüğü yerde belirir, hafifçe süzülür (düşme hissi), oyuncu üzerine giderse ya da
  // tractor beam ile çekerse envanterine girer. Ömrü PICKUP_LIFE_MS — uzay temiz kalır.
  addPickup(x, y, ore, amount) {
    const id = 'p' + (this.pickupSeq++).toString(36);
    const a = Math.random() * Math.PI * 2;
    const pk = {
      id, x, y, ore, amount,
      vx: Math.cos(a) * PICKUP_DRIFT, vy: Math.sin(a) * PICKUP_DRIFT,
      bornAt: Date.now(), sentX: Math.round(x), sentY: Math.round(y),
    };
    this.pickups.set(id, pk);
    this.bcast({ t: 'pick', id, x: Math.round(x), y: Math.round(y), ore, amount });
    return id;
  }

  addPlayer(p) {
    this.players.set(p.id, p);
    this.dirty.add(p.id); // mevcut oyuncular bir sonraki diff'te bu gemiyi görür

    // AI'A NOT: SNAPSHOT — yalnız bu oyuncuya, TEK büyük paket. Asteroidler (statik) dahil;
    // sonrası hep diff (<100 byte). ~30 rock x ~30 byte ≈ 1KB: ihmal edilebilir.
    const rocks = [...this.entities.values()].map(r => [r.id, r.x, r.y, r.size, r.hp, r.ore]);
    // Düşen kapsüller de snapshot'a girer: oyuncu sisteme girdiğinde yerdeki ganimeti görür.
    const picks = [...this.pickups.values()].map(k => [k.id, Math.round(k.x), Math.round(k.y), k.ore, k.amount]);
    const others = [...this.players.values()].filter(o => o.id !== p.id)
      .map(o => [o.id, Math.round(o.x), Math.round(o.y), Number(o.r.toFixed(2)), o.callsign]);
    const star = starById(this.starId);
    // M2i: korsanlar + istasyon da snapshot'a girer (geç gelen oyuncu sistemi tam görür).
    const npcs = [...this.npcs.values()].map(n =>
      [n.id, Math.round(n.x), Math.round(n.y), Number(n.r.toFixed(2)), n.callsign]);
    p.ws.send(JSON.stringify({
      t: 'sn', roomId: this.roomId, you: p.id, cs: p.callsign, x: p.x, y: p.y,
      pirateLvl: this.pirateLvl, npcs,
      station: this.station ? { id: this.station.id, x: this.station.x, y: this.station.y, hp: this.station.hp, max: this.station.maxHp } : null,
      // M4a: ANOMALİ de snapshot'a girer (geç gelen oyuncu hedefi görür). Kod İPUCU gönderilir,
      // KODUN KENDİSİ ASLA — sunucu otoriterliği: istemci frekansı bilirse bulmaca anlamsızlaşır.
      anom: this.anomaly ? {
        id: this.anomaly.id, x: this.anomaly.x, y: this.anomaly.y,
        kind: this.anomaly.kind, signal: this.anomaly.signal,
        hp: this.anomaly.hp, max: this.anomaly.maxHp, solved: this.anomaly.solved,
      } : null,
      star: star ? { i: star.i, n: star.n, k: star.k, c: star.c, a: star.a, p: star.p } : null,
      // AI'A NOT: Menzil sunucudan gelir — client sabit gömmez, böylece iki taraf ayrışamaz.
      jumpRange: JUMP_RANGE,
      // AI'A NOT (M2h): ZANAAT TARİFELERİ VE BOOST ÇARPANLARI da sunucudan gelir (jumpRange ile
      // aynı kural): istemci sabit gömmez → iki taraf asla ayrışamaz (bkz. Tuzak 5).
      recipes: RECIPES,
      items: ITEMS,
      boost: { mul: BOOST_MUL, fuel: BOOST_FUEL_MUL },
      // AI'A NOT: HARİTA KİMLİĞİ — istemci elindeki starmap'ın BU galaksiye ait olduğunu
      // doğrular. Uyuşmazlık = istemci bayat harita kullanıyor (tipik sebep: tarayıcı cache'i);
      // o durumda istemci haritayı sürüm sorgusuyla yeniden çeker, yine olmazsa warp'ı kapatıp
      // durumu açıkça yazar. Sessiz "harita bozuk" arızasını bu alan bitirir.
      map: { seed: galaxy().seed, count: galaxy().count },
      cargo: p.cargo || {},     // M2: yeniden bağlanmada envanter kaybolmasın
      // M2: can/kalkan snapshot'ta da gelir — ölüm/kurtarma sonrası istemci doğru gösterir.
      shield: Math.round(p.shield), hull: Math.round(p.hull),
      fuel: Math.round(p.fuel), fuelMax: FUEL_TANK,
      rocks, players: others, pickups: picks,
    }));

    this.pushEvent({ kind: 'join', actorId: p.id, data: { callsign: p.callsign, room: this.roomId } });
    this.sysAll(`${p.callsign} sistemde belirdi.`, 'appear', p.id, { name: p.callsign }); // kendine anons yok
  }

  removePlayer(p) {
    this.players.delete(p.id);
    this.dirty.add(p.id); // tick'te 'X' flag'i ile çıkış bildirilir
    this.pushEvent({ kind: 'leave', actorId: p.id, data: { room: this.roomId } });
  }

  markDirty(id) { this.dirty.add(id); }
  pushEvent(ev) { this.events.push({ ...ev, roomId: this.roomId, ts: Date.now() }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // AI'A NOT: TEK stringify → tüm socket'lere aynı string (per-player personalization YOK).
  sysAll(text, kind = 'info', excludeId = null, p = null) {
    const packet = JSON.stringify({ t: 'sys', code: kind, msg: text, p });
    for (const pl of this.players.values()) {
      if (pl.id === excludeId) continue;
      if (pl.ws.readyState === 1) pl.ws.send(packet);
    }
  }

  // AI'A NOT: bcast — rastgele nesne yayını (M2 paketleri). sysAll'dan farkı: mesaj zarfı
  // hazır gelir. Tek stringify + tüm socket'lere yazma kuralı aynı.
  bcast(obj, excludeId = null) {
    const packet = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === excludeId) continue;
      // AI'A NOT (Tuzak 47 dersi): `ws` savunmasız okunmaz — oda listesine bir gün bağlantısız
      // bir aktör girerse tüm sunucu düşer. Tek satır sigorta, maliyeti yok.
      if (p.ws && p.ws.readyState === 1) p.ws.send(packet);
    }
  }

  // M2i: korsanlardan herhangi biri bu tick'te hareket etti mi?
  _npcDirty() {
    for (const n of this.npcs.values()) if (n.dirty) return true;
    return false;
  }

  // AI'A NOT: rayPick — ışın-küre testi (2D'de: ışına dik mesafe ≤ yarıçap).
  // Kayanın yarıçapı boyutunun yarısı, oyuncununki 8 birim. Işının GERİSİNDEKİ nesneler
  // (along < 0.5) yok sayılır → arkadaki hedefe vurulmaz. En yakın isabet kazanır.
  rayPick(origin, fx, fy, range) {
    let best = null, bestAlong = Infinity;
    // M2i: `kind` eklendi — kaya/oyuncu/korsan/istasyon AYNI ışın testinden geçer, hasarı
    // çağıran taraf türe göre uygular (tek isabet kuralı, tek kod yolu).
    const consider = (t, kind, radius) => {
      const vx = t.x - origin.x, vy = t.y - origin.y;
      const d2 = vx * vx + vy * vy;
      // AI'A NOT: SIFIR MESAFE (tam üst üste) özel durumu. Normalde `along < 0.5` kontrolü
      // "arkadaki hedefe vurulmaz" kuralını sağlar; ama hedef tam üstümüzdeyse along = 0 olur
      // ve hedef YANLIŞLIKLA "arkada" sayılırdı (yaşandı: iki gemi aynı koordinatta → atış
      // hiç isabet etmiyordu). Çok yakın hedef her zaman isabettir: point-blank.
      if (d2 <= radius * radius) { bestAlong = -1; best = { target: t, kind, isRock: kind === 'rock', along: 0 }; return; }
      if (bestAlong === -1) return;                     // point-blank bulundu → o kazanır
      const along = vx * fx + vy * fy;
      if (along < 0.5 || along > range) return;
      const perp = Math.abs(-vx * fy + vy * fx);
      if (perp > radius) return;
      if (along < bestAlong) { bestAlong = along; best = { target: t, kind, isRock: kind === 'rock', along }; }
    };
    for (const p of this.players.values()) {
      if (p.id === origin.id || p.hull <= 0) continue;
      consider(p, 'player', PLAYER_RADIUS);
    }
    for (const n of this.npcs.values()) consider(n, 'npc', PLAYER_RADIUS);
    // M4a: ANOMALİ de bir hedeftir (ışın isabeti). Çözülmüş/tükenmiş anomali hedef DEĞİL —
    // yoksa oyuncu boşluğa ateş eder gibi görünür ve "vuruyorum ama bir şey olmuyor" hissi doğar.
    if (this.anomaly && !this.anomaly.solved) consider(this.anomaly, 'anomaly', ANOM_RADIUS);
    if (this.station && this.station.hp > 0) consider(this.station, 'station', STATION_RADIUS);
    for (const r of this.entities.values()) consider(r, 'rock', r.size / 2 + 2);
    return best;
  }

  // AI'A NOT: tick(dt) — SAF FİZİK + DIFF ÜRETİMİ. I/O YOK, await YOK.
  // Sıra: kalkan regen → (M2: çatışma/madencilik) → diff üret → tek broadcast.
  tick(dt) {
    const now = Date.now();
    // M2i: KORSANLAR — gemi üretimi + yapay zekâ + korsan ateşi (SAF hesap: I/O yok).
    this._pirateTick(dt, now);
    // M2: TRACTOR BEAM — hedef kayayı oyuncuya doğru çeker. ÖNEMLİ: kaya konumu artık
    // DEĞİŞEBİLİR, bu yüzden hareket eden kaya için ayrı paket gider (statik kaya varsayımı
    // korunur: yalnız ÇEKİLEN kayalar yayınlanır, kuşağın geri kalanı sessizdir).
    const pulled = [];
    for (const p of this.players.values()) {
      if (!p.tractor || p.hull <= 0) continue;
      // M4a: ANOMALİ KALINTISI çekiliyorsa kaya/kapsül araması YAPILMAZ — anomali o
      // koleksiyonların hiçbirinde değil; aksi hâlde `rock` null olur ve tractor sessizce iptal
      // edilirdi ("F'ye bastım, hiçbir şey olmuyor" sessiz arızası).
      if (p.tractor.isAnom) { this._tractorAnomaly(p, now); continue; }
      // AI'A NOT: Hedef KAYA ya da DÜŞEN KAPSÜL olabilir (kullanıcı isteği: "tractor beam de
      // çekebilecek pickupları"). Aynı çekme fiziği; tek fark kapsülün TAM ÜSTÜNE çekilmesi
      // (temas = toplama, aşağıdaki kapsül döngüsünde gerçekleşir).
      const rock = this.entities.get(p.tractor.rockId) || this.pickups.get(p.tractor.rockId);
      if (!rock) { p.tractor = null; continue; }
      const isPick = this.pickups.has(rock.id);
      const dx = p.x - rock.x, dy = p.y - rock.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > TRACTOR_RANGE) {                    // menzil dışı: 2 sn sonra bırak (takılmasın)
        if (++p.tractor.stuck > 20) p.tractor = null;
        continue;
      }
      p.tractor.stuck = 0;
      const stopAt = isPick ? 0 : 60;             // kaya: yapışmasın; kapsül: üstüne çek
      if (d < stopAt) continue;
      const step = Math.min(TRACTOR_SPEED * dt, d - stopAt);
      rock.x += (dx / d) * step; rock.y += (dy / d) * step;
      if (!isPick) pulled.push([rock.id, Math.round(rock.x), Math.round(rock.y)]);
    }
    if (pulled.length) this.bcast({ t: 'rockmv', d: pulled });

    // UZAYA DÜŞEN KAPSÜLLER (kullanıcı isteği): süzülme → ömür → TEMASLA toplama.
    // AI'A NOT: Konum değiştiği için yalnız HAREKET ETMİŞ kapsüller yayınlanır (perf. sözleşmesi:
    // kuşağın geri kalanı gibi sessiz kalır). Toplama kararı SUNUCUDA — istemci spoof edemez.
    const pickMv = [];
    for (const [id, pk] of this.pickups) {
      if (now - pk.bornAt > PICKUP_LIFE_MS) {
        this.pickups.delete(id);
        this.bcast({ t: 'pickgone', id, why: 'expired' });
        continue;
      }
      if (pk.vx || pk.vy) {                       // sürtünmeli süzülme → sonsuza gitmez
        pk.x += pk.vx * dt; pk.y += pk.vy * dt;
        // AI'A NOT: Sürtünme dt'ye bağlı olmalı — sabit çarpan tick hızına göre değişir
        // (0.97/tick @ 10Hz = 0.74/sn, ama tick gecikirse farklı sonuç verir).
        const friction = Math.pow(0.97, dt * 10);
        pk.vx *= friction; pk.vy *= friction;
        if (Math.abs(pk.vx) < 0.5 && Math.abs(pk.vy) < 0.5) { pk.vx = 0; pk.vy = 0; }
      }
      let taken = null;
      for (const p of this.players.values()) {
        if (p.hull <= 0) continue;
        if (Math.hypot(p.x - pk.x, p.y - pk.y) <= PICKUP_PICK_RADIUS) { taken = p; break; }
      }
      if (taken) {
        this.pickups.delete(id);
        taken.cargo[pk.ore] = (taken.cargo[pk.ore] || 0) + pk.amount;
        if (taken.tractor && taken.tractor.rockId === id) taken.tractor = null;
        this.bcast({ t: 'pickgone', id, by: taken.id });
        if (taken.ws.readyState === 1) {
          taken.ws.send(JSON.stringify({ t: 'loot', ore: pk.ore, amount: pk.amount, cargo: taken.cargo }));
        }
        this.pushEvent({ kind: 'pickup', actorId: taken.id, data: { ore: pk.ore, amount: pk.amount } });
        continue;
      }
      const nx = Math.round(pk.x), ny = Math.round(pk.y);
      if (nx !== pk.sentX || ny !== pk.sentY) {
        pk.sentX = nx; pk.sentY = ny;
        pickMv.push([id, nx, ny]);
      }
    }
    if (pickMv.length) this.bcast({ t: 'pickmv', d: pickMv });

    for (const p of this.players.values()) {
      // M3d — KALKAN KENDİ KENDİNE DOLAR, AMA SALDIRIDAN BİR SÜRE SONRA (kullanıcı isteği,
      // birebir: "geminin enerjisi kendi kendine dolsun saldırıya uğradıktan bir süre sonra").
      // Kural: son hasardan sonra SHIELD_REGEN_DELAY_MS boyunca HİÇ dolmaz; süre geçince
      // SHIELD_REGEN_RATE hızında dolar. Neden gecikme: dolu dolu regen, savaşı "vur-kaç"
      // yerine "bekle ve dol" oyununa çeviriyordu (korsanın 1,5 sn'de 9 hasarı = 6/sn regen
      // ile tam başa baştı → hiçbir korsan öldüremiyordu). Gecikme, art arda vurulurken
      // kalkanın ERİMESİNİ sağlar; kaçıp saklanan oyuncu ise toparlanır.
      // Gövde (hull) KENDİLİĞİNDEN DOLMAZ — onun yolu TAMIR SETI (H).
      if (p.shield < 100 && now - p.lastHitAt >= SHIELD_REGEN_DELAY_MS) {
        p.shield = Math.min(100, p.shield + SHIELD_REGEN_RATE * dt);
      }
      // M2b YAKIT: acil damlası (mahsur kalmayı önler) + HUD'a yalnız TAM SAYI değişince paket
      // gider → saniyede en fazla 1 küçük paket, sıfır israf.
      if (p.fuel < FUEL_EMERGENCY_CAP) {
        p.fuel = Math.min(FUEL_EMERGENCY_CAP, p.fuel + FUEL_EMERGENCY_RATE * dt);
      }
      const shown = Math.round(p.fuel);
      if (shown !== p.fuelSent) {
        p.fuelSent = shown;
        if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'fuel', v: shown, max: FUEL_TANK }));
      }
      // M3d: KALKAN HUD'u. Hasar paketi (`dmg`) yalnız DÜŞÜŞÜ taşır; kendiliğinden dolan kalkanı
      // istemci göremezdi → sunucu tam sayı her değiştiğinde hafif bir `sh` paketi yollar
      // (yakıtla AYNI desen: saniyede en fazla 1 küçük paket, sıfır israf).
      const sh = Math.round(p.shield);
      if (sh !== p.shieldSent) {
        p.shieldSent = sh;
        if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'sh', v: sh, max: 100 }));
      }
    }

    if (!this.dirty.size && !this._npcDirty()) return;
    const diffs = [];
    for (const id of this.dirty) {
      const p = this.players.get(id);
      if (!p) { diffs.push([id, 0, 0, 0, 'X']); continue; } // ayrıldı/öldü
      diffs.push([id, Math.round(p.x), Math.round(p.y), Number(p.r.toFixed(2)), '']);
    }
    this.dirty.clear();
    // M2i: KORSAN GEMİLERİ aynı diff paketinde 'P' bayrağıyla gider — istemci bunları
    // "uzak oyuncu" ile aynı kanaldan alır (tek hareket yolu, ayrı paket yok).
    for (const n of this.npcs.values()) {
      if (!n.dirty) continue;
      n.dirty = false;
      diffs.push([n.id, Math.round(n.x), Math.round(n.y), Number(n.r.toFixed(2)), 'P']);
    }
    if (!diffs.length) return;

    const packet = JSON.stringify({ t: 'du', d: diffs });
    for (const p of this.players.values()) {
      if (p.ws.readyState === 1) p.ws.send(packet);
    }
  }

  hibernate() {
    const snapshot = { roomId: this.roomId, rocks: this.entities.size, savedAt: Date.now() };
    console.log(`[HIBERNATE] ${this.roomId} (${snapshot.rocks} rocks)`);
    return snapshot;
  }
}
