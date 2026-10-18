# AstroVector — Mimari ve Görevler (Handoff Dosyası)

> AI'A NOT: Bu dosya projenin TEK GERÇEK KAYNAĞIDIR (single source of truth).
> Her yeni oturumda önce bu dosya okunmalı; kod yorumları bu mimariye atıf yapar.

---

## 1. Seçilen Teknolojiler ve Nedenleri

### Backend: Node.js + `ws` (saf WebSocket, Socket.io DEĞİL)
- **CPU/RAM:** `ws` ~100KB'lık bir pakettir; Socket.io ise üzerine fallback polling katmanı
  + room/event yönetimi koyar ve CPU'suz bedava bir şey sunmaz. Oracle Free Tier'da
  (ARM Ampere: 4 vCPU / 24GB veya x86 1GB micro) her MB RAM değerli. Saf `ws` ile
  10K+ eşzamanlı socket tek node process'te rahat taşınır ( tek process + cluster dışı,
  çünkü Room state'i memory'de tutacağız → process başına tutarlılık gerekiyor).
- **Latency:** Socket.io'nun handshake (polling → upgrade) turu bağlantı kurulumunu
  ~100-300ms geciktirir. `ws` doğrudan WebSocket konuşur → en düşük ilk bağlantı gecikmesi.
- **Bandwidth:** Kendi protokolümüz: tek byte'lık `msgType` + binary JSON yerine kompakt
  string key'ler (`{"t":"mv","x":12.3,"y":4.5}`). Socket.io'nun event-name overhead'i yok.

### Frontend (Oyun): PixiJS v8 (Phaser DEĞİL)
- **Neden Phaser değil:** Phaser kendi game loop'unu, input'u, scene graph'ını getirir
  (~1MB+ gzip JS). Asteroid kuşağı instance'ı aslında bir "bullet-hell worker scene"i;
  Pixi ile render pipeline'ı biz yönetiriz → draw call'ları, dirty flag'leri, ve
  **backoff'lu interest management** (ekran dışı oyuncu güncellemesini düşürme) tam kontrolümüzde.
- **WebGL/WebGPU:** Pixi v8 otomatik WebGPU seçer, fallback WebGL. Binlerce sprite
  (asteroid + oyuncu + efekt) ParticleContainer ile tek draw call'da.
- **Ücretsiz hosting:** Statik dosyalar → GitHub Pages veya Cloudflare Pages (sıfır CPU maliyeti).
  Sunucu sadece WebSocket verir, HTML'i vermez.

### Veritabanı: Supabase (Postgres) — sadece PERSISTENT veri
- Oyun state'i (gemi pozisyonu, asteroid HP) **ASLA** DB'ye anlık yazılmaz; memory'de yaşar.
- DB'ye yazılan: oyuncu profili, envanter, para, madencilik logu, yıldız yok etme event'i.
- Telemetry: batch queue ile (aşağıda).

### Ekosistem / Hosting dağılımı
| Bileşen | Servis | Maliyet |
|---|---|---|
| Game client (statik) | GitHub Pages / Cloudflare Pages | $0 |
| WebSocket + Game loop | Oracle Free Tier VM (Ampere A1) | $0 |
| Persistent DB | Supabase Free (500MB Postgres) | $0 |
| Admin panel | **LOCALHOST SADECE** (bu makinede) | $0 |

---

## 2. Sistem Bileşenleri

### Oyun Döngüsü (Server Tick)
```
Tick = 100ms (10 Hz) — simülasyon authoritative, client sadece render.
  1. Room'ları gez (yalnız AKTİF room'lar — boş room state'i snapshot'lanıp uykuya yatırılır)
  2. Her room'da: pozisyon integrate, asteroid HP, kalkan regen, tractor beam raycast
  3. Delta hesapla → değişen entity'ler için diff paketi üret
  4. Room içindeki tüm socket'lere tek broadcast (join'li string, tek JSON.parse maliyeti)
```
- **AI'A NOT:** Tick loop NEVER async-await with per-room I/O. Pure CPU hesabı, senkron.
  DB/telemetry her zaman ayrı kuyruğa gider → game loop hiç blocklanmaz.

### Room Yönetimi (Interest Management)
- Galaxy = ~4096 yıldız sektöre (64x64 grid) bölünür. Her **asteroid kuşağı** (belt) = 1 Room.
- Oyuncu bir belt'e warp edince server o Room'a subscribe eder; **sadece o room'un
  entity snapshot'ı** gönderilir (binlerce yıldızın haritası zaten statik JSON olarak
  client'ta prefetch edilir — CDN cache).
- Room kapasitesi: 50 oyuncu. Doluysa → aynı belt'in mirror room'una (belt-2) yönlendir.
- Room boşaldığında 30sn sonra state serialize edilip memory'den düşürülür (hibernate).

### Admin "Tanrı Modu" — On-Demand Inspection (KRİTİK MİMARİ)
```
Admin paneli (localhost) ──ws──▶ /admin path + ADMIN_SECRET_KEY handshake
                                  │
                                  ▼
                       AdminGateway (ayrı event namespace, "adm:*")
                                  │
                    ┌─────────────┼──────────────┐
                    ▼             ▼              ▼
              RoomRegistry   PlayerRegistry  EventBus (ring buffer)
```
- Admin tıklama → `adm:inspect {targetId, targetKind}` → server o noktanın
  **canlı stream'ini** açar (`adm:stream` mesajları: savaş eventleri, hareket, loglar).
- **Sunucuyu yormama garantisi:**
  1. Inspection **push-based değil, tap-based**: Room loop'unun zaten ürettiği eventler
     EventBus'a (ring buffer, son 500 event) düşer. Admin inspect isteyince buffer'dan
     sadece o target'la ilgili olanlar filtrelenip akıtılır → ekstra hesap YOK.
  2. Max 3 eşzamanlı admin stream. Fazlası reddedilir (`adm:error RATE_LIMITED`).
  3. Admin mesajları ayri HTTP/ws path'te (`/admin`), oyuncu socket pool'undan izole.
  4. Her admin stream'e `throttleMs=250` uygulanır — admin insan gözü, 4Hz yeter.

### Telemetry & Analytics (DB'yi Yormayan Yazım)
```
Oyuncu eylemi ──▶ in-memory queue (bounded, 1000 item)
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  Flush tetikleyicileri:      Flush yapan:
  - 5 sn'de bir (timer)       tek transaction, COPY / multi-INSERT
  - queue 200'e ulaşınca      (Supabase'e tek round-trip)
  - graceful shutdown'da
```
- Kritik anlık veriler (yıldız yok etme, ödeme) **exempt** → direkt DB'ye yazılır.
- Kuyruk taşarsa (DB down): en eski %10 atılır (telemetry veri kaybı kabul edilebilir;
  oyun state kaybı asla kabul edilmez — o yüzden state DB'ye yalnız checkpoint'lenir).

---

## 3. Veri Yapıları (Lightweight Paketler)

Tüm WS mesajları: `{ "t": "<type>", ... }` — tek harf type key'i, kısa alan adları.
JSON string'e tek seferde stringify, broadcast'te birleşik string (batch).

### Oyuncu → Sunucu (C→S)
| t | Alanlar | Anlam |
|---|---|---|
| `mv` | x,y,r | Gemi pozisyon/yön (client-authoritative önizleme, server doğrular) |
| `st` | tid,kind | Hedef seç (asteroid/oyuncu/yıldız) |
| `fire` | tid | Silah ateşle |
| `tb` | tid | Tractor beam başlat/durdur |
| `warp` | sysId, beltId | Warp isteği |
| `chat` | ch,m | ch=g/s/l/p (global/sektör/yerel/özel), p için ek `to` |
| `hb` | — | Heartbeat |

### Sunucu → Oyuncu (S→C)
| t | Alanlar | Anlam |
|---|---|---|
| `sn` | belts,players,x,y | Warp sonrası room snapshot (tek büyük paket, sonrası diff) |
| `du` | [] | Diff update: `[id, dx, dy, dr, flags]` kompakt array'ler |
| `ev` | kind,data | Olay: shieldHit, asteroidBreak, beamPull, starKill... |
| `chat` | ch,from,m | Sohbet |
| `sys` | code,msg | Hata/bilgi |

### Admin Paketleri (`adm:*` namespace, ayrı izolasyon)
| t | Alanlar | Anlam |
|---|---|---|
| `adm:auth` | key | ADMIN_SECRET_KEY handshake (başarısız → socket kapatılır) |
| `adm:inspect` | kind,id | Canlı inceleme başlat (player/room/star) |
| `adm:uninspect` | — | Stream kapat |
| `adm:tick` | stats | Server'in 10sn'lik özet raporu (tick time, room sayısı, socket sayısı) |
| `adm:stream` | events[] | İncelenen hedefin canlı event akışı (throttle 250ms) |
| `adm:command` | op,args | God mode: spawn asteroid, kill player, trigger star-kill event |

### Kompaktlık örneği
Diff update yerine:
```json
{"t":"du","d":[["p7",120.5,-33.2,0.8,""],["a3",-5,0,0,"hp-12"],["e2",0,0,0,"X"]]}
```
`flags` kısa kodlar: `""`=yok, `X`=öldü, `hp-N`=hasar, `sh`=kalkan kırıldı.

---

## 4. Klasör Yapısı

```
AstroVector/
├── MIMARI_VE_GOREVLER.md      ← Bu dosya
├── package.json
├── .env.example               ← ADMIN_SECRET_KEY şablonu (gerçek .env commit EDİLMEZ)
├── backend/
│   ├── server.js              ← Giriş noktası: public ws + admin ws (ayrı path), tick loop
│   └── src/
│       ├── rooms.js           ← RoomManager: belt instance'ları, hibernate, snapshot
│       ├── telemetry.js       ← Batch queue: DB'ye 5sn'de bir toplu yazım
│       ├── eventbus.js        ← Ring buffer: admin inspection'ın okuyacağı canlı eventler
│       └── protocol.js        ← Mesaj type sabitleri + compact diff üretici
├── game-client/               ← PUBLIC (GitHub Pages/CF Pages'e deploy edilir)
│   └── index.html             ← PixiJS ile asteroid kuşağı sahnesi (CDN'den Pixi)
└── admin-client/              ← LOCAL ONLY (bu makine, localhost:5555'ten servis edilir)
    └── index.html             ← Tanrı modu paneli: galaxy overview + inspect stream
```

Güvenlik notu: Admin ws endpoint'i `ws://<server>/admin` üzerinden erişilir ama handshake'te
ADMIN_SECRET_KEY zorunludur; yanlış key → socket derhal kapatılır ve IP 60sn blacklist'lenir.
Ek katman: production'da admin portu firewall'la yalnız kullanıcının IP'sine açılır
(Oracle NSG kuralı). Localhost kısıtı zaten client tarafında tetiklenmez — güvenlik server'dadır.

---

## 5. Sıradaki Görevler (Roadmap — İteratif)

### Milestone 0 — İskelet Çalışsın ✅ TAMAM
- [x] Klasör yapısı + MIMARI_VE_GOREVLER.md
- [x] server.js: public ws (8081) + admin ws (8090) + 10Hz tick + tap-based inspection
- [x] game-client/index.html: Pixi v8, ws bağlantı, snapshot/diff işleme
- [x] admin-client/index.html: localhost auth + canlı inspect stream + player listesi
- [x] **DOĞRULANDI:** ws diff akışı, admin auth, yanlış-key reddi (canlı test çıktısı alındı)

### Milestone 1 — Hareket + Room + Galaksi ✅ TAMAM
- [x] Client-side input (WASD) + ivme/sürtünme fiziği + ayarlanabilir kamera (look-ahead)
- [x] Server-side hareket DOĞRULAMASI: MAX_SPEED clamp + `speedWarnings` sayacı (admin'de görünür)
- [x] RoomManager: yıldız sistemi başına room (`s<starId>`), mirror room fallback (`-b2..b4`),
      kapasite 50, boş room hibernate (30 sn)
- [x] WARP: galaksi haritasından yıldız seç → sunucu doğrular → yeni snapshot + eski sisteme anons
- [x] Deterministik galaksi: **16384 yıldız**, 2 kollu sarmal, ~%4 anomali (seed 20261017),
      yarıçap **13000** (ortalama en yakın komşu 41.7 birim — eski 4096/4000 düzeninde 25.8),
      `starmap.json` (~1.31 MB) + sunucu gömülü üretici (`galaxy.js`) → sunucu dosyaya bağımlı değil
- [x] Snapshot/diff ayrımı: asteroidler yalnız snapshot'ta (statik, deterministik), oyuncular diff'te
- [x] Heartbeat: `hb` → sunucu `hb` yanıtı (gerçek RTT) + arka plan sekmesinde bağlantı canlı kalır
- [x] **DOĞRULANDI (ölçümler):** hareket spawn (420,-180) → (542,-302), warnings 0 |
      warp `s1515 (Serum)` → `s0 (Oromir-IV)` yeni snapshot ile | geçersiz warp reddi |
      `/starmap.json` HTTP 200 + CORS | 33 sn boyunca bağlantı kimliği sabit (reconnect döngüsü yok)

### Sanat Yönü — ESKİ-USÜL 2D PIXEL ART (kullanıcı talebi)
- [x] Canvas gerçekten **480x270** render eder, CSS ile TAM SAYI katlarda büyütülür
      (`image-rendering: pixelated`). Kesirli ölçek yasak — pikselleri bozar.
- [x] `resolution: 1`, `antialias: false` (aksi halde pixel art ölür, yumuşar)
- [x] Sprite'lar koddaki HARF MATRİSLERİ (`pixelSprite`) — harici asset yok, build adımı yok,
      renk değişimi tek palette takasıyla (kendi gemisi cyan, uzak gemiler mor-hayalet)
- [x] Sınırlı palet: derin lacivert/çivit zemin, soğuk cyan vurgu, nadir amber motor
- [x] Gizem atmosferi: 3 katmanlı ADD-blend nebula, 3 parallax yıldız katmanı, tek tek parıldayan
      26 yıldız, CRT tarama çizgileri + vinyet (CSS, canvas maliyeti sıfır), soluk "fısıltı" satırı
- [x] Anomali sistemlerinde gizemli anonslar (`SILENT_BEACON`, `GRAVEYARD`, `RUIN`...)
- [x] Pixel HUD: kalkan/gövde barı, mini radar (62x62), log satırları, boot/teşhis satırı
- [x] (M4) Anomali içerikleri: keşif, kalıntı yağması, sinyal çözme mini-oyunu — **M4a'da tamamlandı** (2026-10-18): sunucu nesnesi + dispatcher + istemci sprite/tuşlar; ölçüm `npm run test-anomaly` **23/23** + tarayıcı `?probe=1` kanıtı (aşağıda M4a bölümü).

### Milestone 2 — Çatışma ve Madencilik ✅ TAMAM (kuşak yörüngesi hariç)
- [x] Kalkan/hull sistemi + `fire` HITSCAN isabet çözümü (sunucu otoriter; tick içinde I/O yok)
- [x] Asteroid kırma + ganimet (loot) + `hp` bilgisi istemcide görselleşir (kaya hasar çubuğu)
- [x] Tractor beam (menzil + çekme fiziği; yalnız ÇEKİLEN kaya yayınlanır → statik varsayım korunur)
- [x] Ölüm → patlama + KURTARMA (ana sisteme dönüş, tamir; envanter korunur)
- [ ] Asteroid kuşağı yörüngesi (kuşak hâlâ statik — hibernate uyumlu; M5 ölçek işiyle birlikte)
- **DOĞRULANDI:** `npm run test-combat` → 13/13 kontrol (kaya kırma + ganimet, atış cooldown'ı,
  PvP hasarı, ölüm + kurtarma + tamir, kill bildirimi, tractor çekmesi). İstemci tarafı canlı
  tarayıcıda probe ile: 28→23 kaya, envanter `{BAKIR:4, REZONANS:2, TITAN:3, DEMIR:1}`,
  HUD'da `KARGO: TITAN 3 · BAKIR 2`, log'da `+2 TITAN (toplam 3)`.

### Milestone 2b — Genişletme Partisi (kullanıcı isteği) ✅ TAMAM
Kullanıcı isteği (birebir): *"Yıldızlar birbirinden daha uzak olsun, daha fazla yıldız olması
performans için sıkıntı değilse daha fazla olsun 16 bin falan, admin panelinde oda seçme olsun,
her şey görünsün. gemilerin boyutu iki kat daha büyük olsun. haritada imleç değil tüm harita
hareket etsin, harita ortada değil gibi tam oyuncunun bulunduğu yıldız ortada olsun. oyuna yine
gizemli havayı koruyan ses efektleri ekle her şey için. yakıt olsun her 100 birim bi yakıt
harcasın gemide 45 yakıtlık tank olsun. yakıt bi maddeden yapılsın o maddeyi düşüren asteroidler
olsun"*

- [x] **Yıldızlar:** `STAR_COUNT = 16384`, `GALAXY_RADIUS = 13000` (4x yıldız / 10.6x alan →
      aralar gerçekten açıldı). İstemci haritası yalnız PENCERE içindekini çizer/sorgular →
      16384 yıldız istemcide ölçülebilir maliyet değil.
- [x] **Gemi 2x:** `SHIP_SCALE = 2` (TAM SAYI ölçek → pikseller bozulmaz); `PLAYER_RADIUS = 16`
      sunucu `rayPick` ile AYNI (vurdu-saymadı olmaz).
- [x] **Harita PAN modu:** İMLEÇ KALDIRILDI. WASD/OK ve FARE SÜRÜKLEME haritayı kaydırır;
      harita açılışında merkez = OYUNCUNUN YILDIZI (`state.mapOwn`), ENTER ortadaki yıldıza atlar.
      Çizim pan sırasında 45ms'te bir yenilenir (throttle) — 16384 tarama her karede israf olurdu.
- [x] **Ses (tamamen SENTEZ, dosya yok):** WebAudio osilatör + filtrelenmiş gürültü + zarf.
      Katmanlar: ortam drone'u (41.2/41.9/82.4 Hz + yavaş LFO), itişe bağlı motor uğultusu,
      18-52 sn rastgele "uzak ping". Efektler: laser/laserFar/hit/crack/boom/loot/warp/refuel/
      alarm/ui. UZAKLIK KAPISI: 1500-1800 birimden uzak olayın sesi çalınmaz. `P` susturur.
- [x] **Yakıt (M2b → M3c GÜNCEL):** `FUEL_TANK = 45`, `FUEL_PER_DISTANCE = 600`, `WARP_FUEL = 3`.
      **Dolum = YILDIZDAN YAKIT ÇEKME** (M3c): yıldızın dibinde (`REFUEL_RANGE = 700`), `Y` basılı
      tutuldukça `REFUEL_RATE = 2` yakıt/sn akar — **HİÇBİR MALZEME HARCANMAZ**. Yakıtın bedeli
      ZAMAN + KONUM'dur (yıldızsız boşlukta yakıt biterse sıkışırsın). Tükenmişse acil damla
      `0.35/sn`, tavan 5; depo bitince İTİŞ KESİLİR. `DOTERYUM` artık yalnız ZANAAT cevheridir
      (WARPCELL×3, YAKIT KUTUSU×2+TITAN) — eski "1 DOTERYUM = 15 yakıt" dönüşümü KALDIRILDI.
- [x] **Admin paneli:** oda listesi (kimlik, yıldız, oyuncu/kaya sayısı, boşta kalma) + seçilen
      odanın TAM DÖKÜMÜ (oyuncu tablosu: kalkan/gövde/yakıt/kargo/K-D/tractor/uyarı; kaya tablosu:
      hp/cevher; bekleyen eventler). Oyuncu satırlarına yakıt + kargo + K/D eklendi.
- **DOĞRULANDI (gerçek çıktılar):** `npm run test-fuel` → **11/11** (uçuş tüketimi = mesafe/100 ±2,
  DOTERYUM kazma → depo min(tank,+15) → envanter -1, depo 0'a inince istenen 250 birimlik adım
  yalnız ~21 birim gerçekleşti, boş envanterle refuel reddi). `npm run test-combat` → **13/13**
  (2 ardışık koşu). Admin paneli uçtan uca → oda listesi + oda dökümü + yakıt kolonu render.
  Tarayıcıda probe: `view == own` (harita açılışı tam merkezde), pan'da `view` değişir/`own` sabit,
  HUD `YAKIT 32/45` (demo ~1300 birim uçtu → 13 yakıt), log `YILDIZ HARITASI YUKLENDI (16384 YILDIZ)`,
  `hata=yok`, `ses=on` (ses motoru kuruldu).

### Milestone 2c — Kullanıcı Geri Bildirimi Düzeltmeleri ✅ TAMAM
Kullanıcı isteği (birebir): *"harita benim olduğum yıldızı göstermiyor, yakıt çok çabuk bitiyor,
başlangıçta 5 doteryum ver, gemi görselini biraz daha detaylandır"*

- [x] **Yakıt yavaşlatıldı:** `FUEL_PER_DISTANCE` 100 → **300** (depo 45 yakıt = 13.500 birim yol;
  eskiden 4.500'dü ve iki yıldız arası bile yetmiyordu). Acil damla + oranlı kapı aynen kaldı.
- [x] **Doğuş envanteri:** `STARTER_FUEL_ORE = 5` → oyuncu 5 DOTERYUM ile başlar (hemen yakıta
  çevirip keşfe çıkabilsin). Sunucu `cargo: { DOTERYUM: 5 }`; HUD'da `KARGO: DOTERYUM 5`.
- [x] **Gemi sprite'ı detaylandırıldı:** 13x12 → **15x15**; burun ışık vurgusu, iki kademeli kokpit
  camı, gövde panel/gölge dizisi, kanat kökleri, ayrık motor podları (+3 palet tonu: `hullShade`,
  `hullLite`, `glassLite`). Uzak gemi paleti de aynı siluetle güncellendi.
- [x] **Haritada kendi yıldızım HER ZAMAN görünür:** işaret iki durumlu hale getirildi —
  ekranda: parlak nokta + iç içe iki halka + 4 yönde nişangâh çentiği; ekran dışında: kenara
  yapışık ok + "SEN" etiketi. "SEN: <ad>" etiketi artık `mapStars` (yalnız ekrandaki keşfedilmiş
  yıldızlar) listesine bağlı DEĞİL ve parlak beyaz. Ayrıca **R tuşu** haritayı kendi yıldızına
  geri ortalar (`mapRecenter`), alt bilgi satırında "R: BURAYA" yazar.
- **DOĞRULANDI:** `npm run test-fuel` → **12/12** (yeni: "dogusta 5 DOTERYUM verildi —
  envanter={"DOTERYUM":5}"; tüketim 1876 birim → 6 yakıt = mesafe/300 ±2; depo 54 adımda bitti;
  yakıt 0'da 250 birimlik istek 63 birim gerçekleşti; dönüştürme sınırı `refuel_full`).
  `npm run test-combat` → **13/13** (2 ardışık koşu). Probe: harita açılışında
  `view=(1614,8757) == own=(1614,8757)` (tam merkezde), `star=Zarnis`, `yakit=45/45`,
  `kargo={"DOTERYUM":5}`. Ekranda: detaylı gemi silueti + `KARGO: DOTERYUM 5` + haritada parlak
  "SEN: ZARNIS" etiketi ve nişangâh işareti.

### Milestone 2d — HARİTA BAYAT CACHE HATASI (kullanıcı: "harita hala bozuk") ✅ TAMAM
Kullanıcı isteği (birebir): *"harita hala bozuk bulunduğum yıldız ortada değil atlayamıyom"*

**KÖK NEDEN:** `/starmap.json` yanıtı `Cache-Control: public, max-age=86400` ile gönderiliyordu.
Galaksi 4096 → 16384 yıldıza çıkarıldığında tarayıcı 24 saat boyunca **ESKİ** haritayı kullanmaya
devam etti. İstemci `starmap.stars[state.star.i]` bulamayınca (indeks > 4095): harita oyuncunun
yıldızına **merkezlenmedi**, "SEN" işareti çizilmedi ve warp hedefleri sunucudakilerle uyuşmadı →
"atlayamıyorum". Benim taze test ortamım haritayı ilk kez çektiği için SAĞLAM görünüyordu — bu
yüzden bir önceki turda "doğrulandı" demem yanıltıcıydı; kullanıcının uzun ömürlü tarayıcı profili
eski kopyayı tutuyordu.

- [x] **Sunucu:** `/starmap.json` → `Cache-Control: no-cache` + **`ETag: "<seed>-<count>"`**;
      `If-None-Match` eşleşirse **304** (ucuz doğrulama, ASLA bayat veri). `starmapVersion`
      `galaxy().seed/count`'tan üretilir.
- [x] **Protokol:** snapshot artık `map: { seed, count }` gönderir (galaksi kimliği).
- [x] **İstemci:** `mapMeta` + `mapMatches()` (sayı/seed + "kendi yıldızım bu haritada var mı?");
      `loadMap()` `fetch(..., {cache:'no-store'})` ile çeker (tarayıcı cache'ini tamamen atlar);
      uyuşmazlıkta `refreshStaleMap()` sürüm sorgusuyla (`?v=seed-count`) bir kez yeniden çeker;
      yine uyuşmazsa `mapStale` → **warp kapatılır** ve "sayfayı Ctrl+F5 ile yenile" yazılır.
      Probe'a `harita=<count>[/BAYAT] sunucuHarita=<count>` eklendi.
- **DOĞRULANDI (yerinde kanıtlar):** `curl -I /starmap.json` → `no-cache` + `ETag: "20261017-16384"`;
  `If-None-Match` ile → **304**. Bayat cache SİMÜLE EDİLDİ (sunucu geçici olarak 4096 yıldız
  sundu): probe **`harita=4096/BAYAT sunucuHarita=16384`**, `own=(0,0)`, `sec=null` → kullanıcının
  belirtisi birebir yeniden üretildi. Simülasyon kaldırılıp sunucu düzeltilmiş kodla başlatılınca:
  **`harita=16384 sunucuHarita=16384`**, harita açılışında **`view=(1614,8757) == own=(1614,8757)`**
  (tam merkez) ve **`sec=141`** (ortada seçili yıldız var → ENTER/tık warp çalışır). `test-all` 4/4.

### Milestone 2e/2f — 7 Maddelik Kullanıcı Partisi ✅ TAMAM
Kullanıcı isteği (birebir, 7 madde):
1. *"Yıldız geminin arkasında görünsün"*
2. *"Minimap iki kat büyüt"*
3. *"Geminin camı koyu mavi olsun"*
4. *"Oyunun ateş etme sistemini değiştir mouse ile basılan yere ateş etsin space'e basınca olduğu gibi tekrarlayarak"*
5. *"Asteroidlerden veya oyundaki herhangi bi şeyden düşen item önce uzaya düşecek biz gidip gemiyle toplayacaz tractor beam de çekebilecek pickupları."*
6. *"Yakıt yine 2 kat daha yavaş azalsın sadece yıldızın dibindeyken Y'ye basınca yavaş yavaş doldurulabilsin"*
7. *"Admin ekranında oyunun direkt görünmesi lazım sadece tablo değil direkt odayı renderlamalı canlı"*

- [x] **(1) Z-sırası:** `world.addChildAt(starGroup, 0)` — yıldız grubu artık dünyanın **0. indeksinde**
      (ilk çizilen = en arkada). Önceden en son ekleniyordu → gemiyi örtüyordu.
- [x] **(2) Minimap 2×:** radar `R` **62 → 124**; nokta/çerçeve ölçüleri orantılı büyütüldü;
      kapsüller cevher renginde çizilir.
- [x] **(3) Koyu mavi cam:** palet `navyGlass: 0x14406e` (taban) + `navyLite: 0x2f6fa8` (parlama);
      eski camgöbeği (cyan) kokpit kaldırıldı. Uzak oyuncu (pembe) paleti de aynı mantıkla güncellendi.
- [x] **(4) Fare ile ateş:** `state.aim` + `ekranToDunya(ev)`; `mousemove` nişanı günceller, **sol tık**
      nişan noktasına ateş eder, **SPACE basılı tutulunca** aynı nişana tekrarlı atış yapar (cooldown
      sunucuda). Nişangâh: gemi→nişan yön çizgisi + artı işareti (menzil dışında soluk). Protokol:
      `fire` paketi isteğe bağlı `r` (dünya radyanı) taşır; yoksa gemi burnu kullanılır (geriye uyumlu).
- [x] **(5) Uzaya düşen ganimet:** `_breakRock` artık ganimeti **anında envantere koymaz**;
      `addPickup(x,y,ore,amount)` ile kapsül düşer (`PICKUP_DRIFT` süzülme + `PICKUP_LIFE_MS` ömür).
      Toplama iki yolla: **gemiyle temas** (`PICKUP_PICK_RADIUS=30`) veya **tractor beam**
      (kapsülde `stopAt=0` → üstüne çekilir, temas = toplama; kayada `stopAt=60` → yapışmaz).
      Yeni paketler: `pick` / `pickmv` / `pickgone`; snapshot + `roomDetail` `pickups` listesi.
- [x] **(6) Yakıt + dolum:** `FUEL_PER_DISTANCE` **300 → 600** (1 yakıt = 600 birim yol).
      Dolum **anlık değil SÜREKLİ ve yıldıza bağlı**: `REFUEL_RANGE=700`, `REFUEL_RATE=2` yakıt/sn
      (KULLANICI: *"refuel bi anda değil ağır ağır olsun saniyede iki fuel alcak yıldızdan"*;
      45'lik depo ~22,5 sn'de dolar) — dolu depo reddedilir,
      **Y basılı tutuldukça** akar (`refuelOn` + `_refuelTick`, karar SUNUCUDA). **M3c GÜNCELLEMESİ:**
      dolum **YILDIZDAN YAKIT ÇEKER, MALZEME HARCAMAZ** — `REFUEL_AMOUNT`/`refuelAccum` (küsurat)
      mekaniği TAMAMEN KALDIRILDI (kullanıcı düzeltmesi). Kapılar açık kodla:
      `refuel_far` / `refuel_full` / `refuel_start` / `refuel_off` / `refuel_full_tick`
      (`refuel_none` ARTIK YOK). Warp ve ölüm dolumu durdurur.
- [x] **(7) Admin canlı oda render'ı:** `admin-client` artık seçili odayı **canvas'a çizer**
      (`#roomCanvas` 880×470, `image-rendering: pixelated`): yıldız, kuşak kayaları, düşen kapsüller,
      oyuncular (yön oku + seçili oyuncuda nişangâh), `ROOM_POLL_MS=250` odaklı yoklama.
      DOM tabloları 2 sn'de bir tazelenir (`ROOM_TABLE_MS=2000`) — 250 ms'de DOM'u ezmek oda
      seçimini bozar. Legend: "CANLI · oyuncu n · kaya n · kapsül n · son paket saat".

**DOĞRULANDI (yerinde kanıtlar):**
- `node --check` istemci/sunucu/admin → **OK**.
- `test-combat.mjs` → **14/14** (yeni: kaya kırılınca `pick` paketi düşer + kapsüle uçup TEMASLA toplama).
- `test-fuel.mjs` → **20/20** (yeni: doğuşta 5 DOTERYUM; uzaktan dolum `refuel_far` reddi; yıldız dibinde
  **yavaş** dolum ~2/sn (M3f: "ağır ağır"); **her 15 yakıt için tam 1 DOTERYUM**; Y bırakılınca durma; depo doluyken
  `refuel_full`; yakıt bitince itiş kapısı; `FUEL_PER_DISTANCE=600`).
- `test-warp-range.mjs` → **MENZİL DOĞRULAMASI ÇALIŞIYOR**; `test-admin-panel.mjs` → **ADMIN PANELİ
  UÇTAN UCA ÇALIŞIYOR** (yeni: canlı render legend + "Dusen kapsuller" bölümü + canvas çizimi).
- **Canlı tarayıcı (probe, `?probe=1&demo=1`):** `kapsul=1 → 2` (kapsül düşüyor), `kargo=DOTERYUM 5,
  TITAN 3` (kapsül toplandı), `nisan=377/364/865` (fare nişanı izleniyor), `fx=3` (ışın), `tus=SP`
  (Space tekrarlı atış), oyun içi log: "TITAN KAPSÜLÜ UZAYA DÜŞTÜ ... ÜZERİNE GİT YA DA F" +
  "TRACTOR DÜŞEN KAPSÜLÜ ÇEKİYOR". **Ekran görüntüsü kanıtı:** gemi sprite'ı yıldızın **ÜSTÜNDE**
  (6× büyütmede koyu mavi cam + turuncu motor alevi + yıldız diski arkasında), minimap 2× (235 px
  görünür kare), HUD ipucu "WASD SUR · FARE NISAN · TIK/SPACE ATES · F TRACTOR · Y YAKIT",
  kargo "KARGO: DOTERYUM 5 · ISINIYOR · Y ILE DOLDUR (YILDIZ)".

### Milestone 2g — DİL (EN/TR) + MENÜ + KAYDIRMALI SES ✅ TAMAM
Kullanıcı isteği (birebir): *"tüm oyunu ingilizceye çevir, menü butonu ve ingilizce türkçe seçme
yeri olsun orada, ses ayarı da olsun kaydırmalı"*.

| # | İstenen | Nasıl çözüldü |
|---|---|---|
| 1 | Tüm oyun İngilizce (VARSAYILAN) | Metinler koda gömülmez: tek sözlük `STR = { en, tr }` + `t(key, params)`. Eksik anahtar `aktif dil → en → anahtar adı` sırasıyla düşer. HUD, ipuçları, kargo, oyun günlüğü, harita, fısıltılar, ses bildirimleri ve sunucu mesajları: hepsi sözlükten. |
| 2 | Menü butonu | Sağ altta **MENU** düğmesi (canvas içinde, fareyle tıklanır) + **O** kısayolu; açıkken **ESC** kapatır. Menü katmanı **haritanın da ÜSTÜNDE** (stage'e en son eklenir) ve açıkken tıklamayı TÜKETİR (yoksa ses kaydırıcısını sürüklerken ışın atılırdı). |
| 3 | İngilizce/Türkçe seçme yeri | Menüde **LANGUAGE** satırı: `ENGLISH` / `TÜRKÇE` düğmeleri, aktif olan çerçeve + parlak metinle işaretlenir. Etiketler her iki dilde de aynı yazılır (kullanıcı kendi dilini tanısın). Tercih `localStorage['astrovector.lang']`. |
| 4 | Kaydırmalı ses ayarı | **VOLUME** satırı: ray + **fare ile sürüklenen topuz**, sağında `%` değeri. `sfx.setVolume(v)` → `VOLUME` (0..1, `localStorage['astrovector.volume']`). Seviye TEK YERDEN: `masterLevel() = muted ? 0 : 0.62 * VOLUME` → susturma ile seviye birbirini EZMEZ (susturulmuşken seviye kaydırsan da ses 0). **MUTE** düğmesi DURUMU yazar (ON/OFF), `P` tuşuyla aynı bayrağı çevirir. |
| 5 | Sunucu mesajları da dilsiz olsun | Sunucu **kod + parametre** yollar: `{t:'sys', code:'warp_range', msg:'…', p:{star,d,max}}`. İstemci kodu kendi dilinde yazar; **kodu tanımazsa sunucunun `msg`'ini** gösterir → eski sunucu + yeni istemci karışımı da çalışır. |

**KURAL (yeni metin eklerken):** metni koda gömme — `STR.en` ve `STR.tr`'ye anahtar ekle; sunucu
metni gönderirken `code` + `p` ver. Bitmap font ASCII'dir: Türkçe karakterler `trAscii` ile
sadeleşir (İ→I, Ş→S, Ğ→G, Ü→U, Ö→O, Ç→C).

### M3b — ENVANTER + ZANAAT BİRLEŞTİ (kullanıcı isteği, 2026-10-18) ✅ TAMAM
Kontroller günceli: **C = ENVANTER/ZANAAT paneli** (birleşik), **H/G/J = eşya kullan** (panel
satırına tıklamak da aynı işi yapar), HUD'da yalnız `WARP HUCRESI n` yazar.

Kullanıcı istekleri (birebir): *"envanter ve craftingi birleştir o ekranda gemideki tüm itemleri
görelim"*, *"oyun ekranında yazmasına gerek yok sadece warp cell yazsın"*.

| # | İstek | Uygulama |
|---|-------|----------|
| 1 | "envanter ve craftingi birleştir … gemideki tüm itemleri görelim" | **C tuşu tek panel açar**: SOL sütun **ENVANTER** (ambarın tamamı: eşyalar üstte, sonra cevherler; her satırda ad + `xN`; kullanılabilir eşyada `[H]/[G]/[J]` rozeti), SAĞ sütun **ZANAAT** (4 tarif, ad + alt satırda maliyet). Sıfır adetli girdi gösterilmez. |
| 2 | "itemleri … envanterden basarak kullanabilelim" (M2i isteği korunur) | Envanter SATIRININ TAMAMI tıklanabilir → tuşla **AYNI** `useItem()` fonksiyonuna düşer (`useItem(id, fromPanel)`). Panel içinden kullanım, "panel açıkken eşya kullanılmaz" kapısının İSTİSNASI. |
| 3 | "oyun ekranında yazmasına gerek yok sadece warp cell yazsın" | HUD'daki eşya/cevher listesi **tamamen kaldırıldı**; yerinde yalnız **`WARP HUCRESI 5`** + durum etiketleri (tractor/boost/soğuma/dolum/yakıt uyarısı). Tıklama yolu tek yerde: panel satırı. |

**Kanıt:** `?probe=1&selftest=1` → `panel=1 envanter=2satir tarif=4satir` · `esya_satiri=1cip
tik=REPAIRKIT` (panel satırına sentetik mousedown → gerçek handler → `useItem`) · `tarif_tik=OK` ·
`kapali_kutu=0` (panel kapalıyken tıklama kutusu kalmıyor) · `hata=yok`.
Canlı görüntü: panel `ENVANTER + ZANAAT` (sol `WARP HUCRESI x5`, sağ 4 tarif iki satır hâlinde,
taşma/çakışma yok) ve HUD'da yalnız `WARP HUCRESI 5`.

#### Tuzak 54 — `VW` PENCEREYE GÖRE DEĞİŞİR → sütun yerleşimi sabit oranla YAPILMAZ
Sanal genişlik sabit sanılıp maliyet sütunu `colW * 0.5` ile yerleştirilmişti. Selftest geometrisi
gerçeği gösterdi: **`VW=361`** (küçük pencere), `pan=349`, `colW=155`, ad `77`, maliyet `119` px →
tek satırda asla sığmaz ("TAMIR SETIDEMIR 4 BAKIR 2" yapışık çıkıyordu). Çözüm: tarif satırları
**iki satır** (ad üstte, maliyet altta, 26px) — her pencere genişliğinde okunur. Dipnot metni de
347 px ile 349 px'lik panelin dışına taşıyordu → metin kısaltıldı. Kural: panel metinleri
**ölçülür** (`BitmapText.width`) ve gerektiğinde satır kırılır; oranla tahmin edilmez.

#### Tuzak 55 — Tıklama kutularının TEK SAHİBİ olmalı (çizim sırası tuzağı)
`state.invHits` hem `drawHud` hem `drawCraft` içinde sıfırlanıyordu. Çizim sırası
`drawCraft → drawHud` olduğu için HUD'un temizliği panelin kutusunu SİLİYORDU (panel tıklaması
sessizce ölürdü). Kural: bir tıklama kutusu listesini yalnız onu KURAN fonksiyon yönetir; diğer
çizim yolları dokunmaz. Ayrıca panel açıkken tıklama sırası: envanter satırı → tarif satırı →
panel dışı = kapat (ateş yok).

### Milestone 2i — ENVANTER + TUŞLAR MENÜDE + SILICON + 5 WARP + KORSANLAR ✅ TAMAM
Kullanıcı istekleri (birebir): *"cargo yazacağına envanter olsun"*, *"itemleri hem tuşla hem
envanterden basarak kullanabilelim"*, *"tuşları menüde göstersin ekranda hep değil"*, *"kripto'yu
silicon ile değiştir"*, *"oyunun başında 5 doteryum yerine 5 warp fuel versin"*, *"korsanlar olsun,
bazı yıldızlarda da korsan istasyonları. Ama öyle her yıldızda korsan olmasın yani"*.

| # | İstek | Uygulama |
|---|-------|----------|
| 1 | "cargo → envanter" | HUD etiketi **`INVENTORY:` / `ENVANTER:`** (`inv_label`/`inv_empty`). İngilizce varsayılan kuralı korundu (TR menüden). |
| 2 | "itemleri hem tuşla hem envanterden basarak kullanabilelim" | Envanter satırı **ÇİP** listesi: `TAMIR SETI 2 [H] · YAKIT KUTUSU 1 [G]`. Kullanılabilir eşyanın yazısına **tıklamak** `useItem()` çağırır — tuşla **AYNI fonksiyon** (tek yol, iki girdi). Tıklama dikdörtgenleri her kare metinden `BITMAP_CELL` ile üretilir. |
| 3 | "tuşları menüde göstersin ekranda hep değil" | HUD'daki sürekli ipucu satırı KALDIRILDI (yalnız harita açıkken `hint_map`). MENÜ paneline **KONTROLLER/CONTROLS** kutusu (4 satır; panel 142→196 px). |
| 4 | "kripto → silicon" | KRIPTO → **SILICON** (cevher tablosu, tarifeler, paletler, admin). Rolü aynı: SILICON×2 + REZONANS×1 → İŞARET FİŞEĞİ. |
| 5 | "5 doteryum yerine 5 warp fuel" | `STARTER_WARP_CELLS = 5`: doğuşta **5 WARP HUCRESI**, DOTERYUM **yok**. **M3c (sonradan):** DOTERYUM yakıt için de gerekmiyor — dolum yıldızdan çekilir (malzemesiz). `STARTER_FUEL_ORE` kaldırıldı. |
| 6 | "korsanlar olsun" | `backend/src/pirates.js` + `Room._pirateTick`: korsan gemileri doğar, en yakın oyuncuya yaklaşır (132 birim/sn < oyuncu 220), menzil 340'ta **1,5 sn'de bir 9 hasar**, çok yaklaşırsa geri durur, öldürülünce ganimet kapsülü (DOTERYUM ağırlıklı, %30 WARPCELL). Düşman olduğu paletten belli (kırmızı gövde). |
| 7 | "bazı yıldızlarda korsan istasyonları, her yıldızda değil" | **DETERMINISTIK**: yıldızların **%65'i sakin**, **%30'unda gemiler**, **%4'ünde İSTASYON**. Ana sistem **her zaman güvenli**. İstasyon 7 sn'de bir takviye üretir (en fazla 4); **yıkılırsa takviye kesilir** + 5 kapsül ganimet. Kilit (T) ve tarama (E) korsanı ve istasyonu ek kod olmadan kapsar. |

**Kanıt:** `test-pirates` **32/32** (dağılım, determinizm, ana sistem güvenli, yaklaşma/ateş/ganimet, istasyon yıkımı + takviye kesilmesi, NPC-`by` çökme regresyonu) · `test-craft-boost` **19/19** (DOTERYUM artık **madencilikle** toplanıyor → uçtan uca maden→zanaat→warp) · `test-fuel` **20/20** · `test-combat` **14/14** · `test-warp-range` ✅ · `test-admin-panel` ✅.
Canlı: `?warp=7071&hunt=1` → `korsan=2`, `istasyon=320`, kalkan 100→91 (**korsan ateş etti**), `LOCK KORSAN-05 169`; istasyon yıkıldı → `istasyon=0`, 15 kapsül. Envanter tıklaması: `?selftest=1` → **`envanter=1cip tik=REPAIRKIT`**. İstasyon görseli: `?warp=10069&hunt=1&peace=1` → `LOCK PIRATE STATION 24` + gri/turuncu istasyon sprite'ı.

#### Tuzak 46 — Hash sonunda `>>> 0` unutulursa DAĞILIM TERS DÖNER
`pirateHash` finalizer'ı `>>> 0` ile kapatılmayınca sonuç **işaretli** (-0.5..+0.5) oldu; `v*100 >= CHANCE` kapıları anlamsızlaştı ve dünya "yıldızların %52'sinde istasyon" hâline geldi. Kural: tamsayı hash'leri her adımda `>>> 0` ile kapatılır **ve dağılım TESTLE ölçülür**. "Deterministik" ≠ "doğru dağılmış".

#### Tuzak 47 — Bağlantı varsayan yardımcı NPC'yi hedef alınca TÜM SUNUCUYU düşürür
Korsan bir oyuncuyu yok edince akış `_destroyPlayer(target, by=npc)` → `_sys(by,…)`'e girdi; savunmasız `player.ws.readyState` okuması `TypeError` attı ve **process öldü** (istemci hatası "donma" yapar, sunucu hatası sunucuyu KILL eder). Kural: gönderen her fonksiyon "hedef bir bağlantı olmayabilir" varsayımıyla yazılır; yeni AKTÖR TÜRÜ eklenince eski mesaj yollarının tamamı gözden geçirilir. Regresyon: test-pirates §5.

#### Tuzak 48 — Tıklama alanı metinden TÜRETİLMELİ
Envanter çiplerinin dikdörtgenleri `BITMAP_CELL = 6` sabitinden hesaplanır. Elle yazılan "şuradan buraya" dikdörtgen, metin uzunluğu değiştiği anda kayar. Tıklama testi **sentetik `mousedown`** ile GERÇEK handler üzerinden yapılır (selftest), "fonksiyonu doğrudan çağır" değil.

#### Tuzak 49 — Ateş yönü `msg.r` olmadan test edilirse hep ıskalar
Sunucu ışını `msg.r` açısıyla atar (`fx=sin r`, `fy=-cos r`) → `r=0` yalnız KUZEYİ vurur. Test "yön önemsiz" varsayımıyla yazılmıştı ve yalnız 1 cevher toplayabildi. Kural: testte nişan açısı **hesaplanır**: `atan2(dx, -dy)`.

#### Tuzak 50 — Nadir cevher için "deneme sayısı" değil **SÜRE** bütçesi
DOTERYUM ağırlığı %6 → kuşakta genelde tek kaya; kırıldıktan sonra `ROCK_RESPAWN_MS` (15 sn) boyunca o cevher yoktur. Sayaçlı döngü ~9 sn'de pes edip testi kırıyordu. Kural: yeniden doğmayı bekleyen testler **süre bütçesi** kullanır (60 sn) ve hedef listesini her turda yeniden tarar.

#### Kapı sırası düzeltmesi (Tuzak 40'ın devamı)
Dolum kapıları **MESAFE → DEPO → MALZEME** oldu: doğuşta DOTERYUM olmadığı için depo DOLUYKEN "DOTERYUM yok" mesajı geliyordu; doğrusu "depo dolu". Kural aynı: **en temel engel en önce sorulur**.

### Milestone 2h — SCAN + KİLİT + ZANAAT + BOOST ✅ TAMAM
Kullanıcı istekleri (birebir): *"-scan tuşu olsun gemiden etrafa bi dalga yayılsın odada ne varsa
göstersin ama menzili olsun iki ekran kadar"*, *"-kilitlenme tuşu olsun mouse bişeyin üstündeyken
örneğin T'ye basınca kilitlensin ateş atınca sadece ona atsın"*, *"-kripto ney? bana bütün
materyalleri söyle, oyunda crafting olacak bi işe yaramaları lazım. mesela doteryumdan warp fuel
yapılsın öyle atlansın"*, *"-shifte basılı tutarak daha hızlı gitsin gemi ama iki kat yakıt
harcasın"*.

| # | İstenen | Nasıl çözüldü |
|---|---|---|
| 1 | SCAN tuşu + iki ekran menzilli dalga | **E**: gemiden büyüyen halka (`SCAN_WAVE_MS=1200`, easeOut) + menzil içindeki HER nesnenin çevresine işaret karesi (`SCAN_MARK_MS=4000`). Menzil EKRAN cinsinden: `2 × max(VW,VH)` (sabit birim olsaydı küçük panelde "iki ekran" olmazdı). **Ekran dışı** işaretliler kenarda nokta olarak görünür. Soğuma 3 sn; menzil dışı nesne işaretlenmez ama geminin durumu log'da yazar (`scan_log`). |
| 2 | T ile fare altındaki nesneye kilit, ateş yalnız ona | **T** (fare bir nesnenin `HOVER_RADIUS=30` yakınındayken): kilit kaya/kapsül/düşman gemi olabilir. Her karede `updateLock()` **nişanı hedefin konumuna YAZAR** → `FIRE` paketi hedefe gider, fareyi dinlemez. Görsel: 4 köşeli çerçeve + gemi→hedef ince çizgi + mesafe yazısı (`LOCK TITAN 329`); menzil dışıysa yazı `— OUT OF RANGE` ve çerçeve kırmızı. Hedef yok olursa kilit düşer (`lock_lost`). |
| 3 | Tüm materyaller işe yarasın + doteryumdan warp hücresi | 6 cevherin **TAMAMI** tarifeye bağlandı (`RECIPES`, `ITEMS` — sunucuda TEK liste, istemci `sn` ile aynısını gösterir): **DOTERYUM×3 → WARP HUCRESI**, DEMIR+BAKIR → TAMIR SETI (H), DOTERYUM×2+TITAN → YAKIT KUTUSU (G), KRIPTO+REZONANS → ISARET FISEGI (J, 30 sn sınırsız tarama). Üretilen eşya **CARGO'ya** girer (ayrı envanter yok → mevcut senkron/HUD/kapsül kodu değişmeden çalışır). **Warp artık YAKIT değil 1 WARP HUCRESI ister** → zanaat ilerleme yolunun parçası. |
| 4 | Shift ile hızlan ama iki kat yakıt | `_move`: `allowed = MAX_SPEED × (boost ? BOOST_MUL : 1) × dt`; yakıt eşiği `FUEL_PER_DISTANCE / BOOST_FUEL_MUL` → boost'ta **1 yakıt = 300 birim** (normal 600) = tam iki kat. **Bayrak SUNUCUDA doğrulanır** (`msg.boost`); yakıt bütçesi yoksa hız artmaz. HUD kargo satırında `BOOST 2x FUEL` göstergesi. |
| 5 | "scan yapmadan minimapde sadece yıldız görünsün" | Radar artık **sis perdesi**: kaya/kapsül/gemi noktaları yalnız **taranmışsa** görünür — tarama bir "fotoğraf" bırakır: dünya kareleri 4 sn söner (`SCAN_MARK_MS`), **radar 15 sn hatırlar** (`SCAN_RADAR_MS`); ISARET FISEGI açıkken 30 sn her şey görünür. **Gemi ve sistem yıldızı her zaman** görünür (pusula). Hiçbir şey taranmamışken radar çerçevesi soluklaşır ve altında `RADAR SISLI - E: TARAMA` yazar (yoksa "radar bozuk" sanılır). |

**Yeni kontroller:** `E` tarama · `T` kilit · `C` zanaat paneli (1-4 veya tıkla = üret) ·
`H` tamir seti · `G` yakıt kutusu · `J` işaret fişeği · `Shift` boost · **`B` sohbet**
(sohbet T'den B'ye taşındı — T kilit için istendi).
**Yeni mesaj kodları:** `ST`, `CRAFT`, `USE`; `MV` artık `boost` taşır; `warp_nocell`, `craft_ok`,
`craft_fail`, `craft_unknown`, `use_repair`, `use_fuel`, `use_beacon`, `use_full`, `use_need`,
`use_unknown`.
**Kural:** zanaat ve harcama SUNUCUDA uygulanır; istemci yalnız "üret/kullan" der. Tarifeler,
eşya adları ve boost çarpanları `sn` paketinde gelir → istemci sabit gömmez (bkz. Tuzak 5).

### Milestone 3 — Sohbet + Persistence 🟡 SOHBET TAMAM (kalıcılık açık)
- [x] **4 kanallı sohbet + rate limit** ✅ — `g` GLOBAL (tüm galaksi) · `s` SEKTÖR (`JUMP_RANGE`
      içindeki komşu yıldızlar — küme TEMBEL hesaplanıp önbelleğe alınır) · `l` YEREL (aynı sistem)
      · `p` ÖZEL (çağrı işaretine DM; gönderene de kopya döner).
      İstemci: **B** açar · **TAB** kanal değiştirir · `@isim mesaj` her kanalda DM'e döner ve hedef
      hatırlanır. Kanal rozeti + kendi çağrı işaretin giriş kutusunun üstünde görünür.
      Sunucu otoriter: metin temizliği (kontrol karakterleri/açı parantezi/fazla boşluk, 120 karakter),
      **700 ms bekleme + 6 sn'de en fazla 4 mesaj**, hedef yoksa/kişi yoksa AÇIK SEBEP döner.
      Kanallar sunucuda TEK sayaç paylaşır (kanal değiştirerek limit aşılamaz).
- [ ] Supabase entegrasyonu: profil, envanter, telemetry batch flush *(dış hesap gerekiyor)*
- [ ] Login (anon cihaz-id → sonra Supabase Auth'a yükselt)

**Kanıt:** `npm run test-chat` **32/32** — üç istemciyle (A+B aynı sistem, C evden 3 atlama uzakta):
YEREL yalnız A+B'ye gitti · SEKTÖR B'ye gitti C'ye GİTMEDİ · GLOBAL hepsine gitti · ÖZEL yalnız
hedefe + gönderene döndü · olmayan çağrı işareti `chat_noone` · rate limit 6 mesajın 4'ünü geçirdi ·
500 karakterlik kirli metin 120'ye kırpıldı, kontrol karakteri ve `<b>` temizlendi · bilinmeyen kanal
yerel sayıldı · boş mesaj sessizce yutuldu.
Canlı UI kanıtı: `?chat=1&ch=s` → giriş kutusuna **gerçek klavye girişi** yapıldı (önizleme paneli
yazar) → log'da `[S] VAGRANT-EXG3: MERHABA DUNYACANLI` (**tam tur: UI → sunucu → UI**).
`?probe=1&selftest=1` → `sohbet=[SECTOR]/[GLOBAL]/[PRIVATE]/[LOCAL] ozel_hedefsiz=uyari dm_hedef=HEDEF123`.

#### Tuzak 51 — Sözlükte PARAMETRELİ metin DÜZ STRING yazılırsa `?NAME?` olarak çizilir
`t(k, p)` parametre yerine koymaz: `STR` içinde değeri **FONKSİYON** olan anahtarı `v(p)` ile çağırır.
`chat_dm_from: 'from {name} (private)'` gibi bir yazım hiç değiştirilmez; bitmap fontta `{`/`}`
glifi olmadığı için ekranda **`?NAME?`** görünür — yani hata "yerine koyma çalışmıyor" değil
"glif yok" gibi görünür ve yanlış yeri ararsın. Kural: parametre alan sözlük girdisi HER ZAMAN
`(p) => \`...${p.x}...\`` biçiminde fonksiyondur (sunucu metinleri zaten doldurulmuş gelir).

#### Tuzak 52 — Rate limit SUNUCUDA ve TEK sayaçtır → testler pencereyi BEKLEMELİ
Kanallar ayrı kota tutmaz (yoksa kanal değiştirerek limit aşılırdı). Bu yüzden bir testte
"şimdi DM gönderelim" demek yetmez: önceki mesajlar kotayı doldurmuşsa DM yerine `chat_flood`
gelir ve test yanlış yerde kırmızı yanar. Testler mesaj arası ≥850 ms bekler ve blok aralarında
pencereyi (6 sn) tamamen boşaltır. İlk koşuda tam bu yüzden `spam1-4` bloke olup `spam5-6` geçti.

#### Tuzak 53 — [GEÇERSİZ — M3c'de KALDIRILDI] Dolum küsuratı (artık mekanik yok)
Bu tuzak "her 15 yakıt için tam 1 DOTERYUM + küsurat devreder" kuralına aitti. **M3c'de tüm
dönüşüm mekaniği kaldırıldı** (yakıt yıldızdan çekilir, malzeme harcanmaz) → küsurat/geri-alma
diye bir şey YOK. Kayıt, dersin kendisi için duruyor: kapı sırasını düzeltirken eklenen "küsuratı
geri al" satırı yakıtı 45'ten 31'e düşürmüş ve testler haklı olarak kırmızı yanmıştı. Ders:
bir davranışı "daha doğru görünüyor" diye değiştirmeden önce onu **TESTLEYEN satırı** oku.

#### Tuzak 56 — MEKANİK UYDURMA YASAK: olmayan bir kural icat etmek testi de uydurur
M3c'nin asıl dersi (kullanıcı düzeltmesi: *"Y'ye basınca doteryum convert yapmayacak yıldızdan
yakıt çekecek sen niye götünden mekanik uyduruyosun"*). Daha önce `Y` = "15 yakıt karşılığı 1
DOTERYUM dönüşümü" yaptım: kullanıcı yalnız "yıldızın dibinde Y ile yavaş yavaş dolsun" demişti,
dönüşüm oranını BEN ekledim. Üstelik testi de bu uydurma kurala göre yazdım → test yeşil yandı,
ÜRÜN yanlıştı (yeşil test, yanlış mekaniğin bekçisi oldu). Kurallar:
1. Kullanıcının belirtmediği bir KAYNAK/MALİYET kuralı ekleme — en sade okumayı uygula
   ("yıldızdan dolum" = malzemesiz dolum), karmaşık ekonomiyi UYDURMA.
2. Uydurma bir kuralın etrafına test yazmak onu doğrulamaz; test "istenen davranış"ı değil
   "kod ne yapıyorsa onu" ölçer. Test yazarken kaynak: **kullanıcının cümlesi** (SSOT'a birebir geç).
3. Kaldırılan mekanikle gelen yan mekanikler (küsurat, geri alma, malzeme kapısı, `refuel_none`)
   hep birlikte silinir — yarım kalan kalıntı yeni yanlış beklenti üretir.

| **Tuzak 57** | **`.bat` dosyası SAF ASCII + CRLF olmak zorunda.** `start.bat`'ın REM satırına `—`/`→` (UTF-8) yazdım; cmd bu baytları OEM kod sayfasıyla bozuk okudu, bloğu bozdu ve script **PARSE aşamasında öldü**: `kapatildi was unexpected at this time.` Çift tıklayan kullanıcı için pencere **anında kapanır**, hiçbir log kalmaz → teşhis çok zor. Ayrıca MSYS PATH'i öne geçtiğinde `timeout /t` yerine coreutils `timeout` bulunur ("invalid time interval /t") → beklemek için `ping -n 2 127.0.0.1 >nul` kullan. **`npm run test-bat`** bu üç kuralı zorlar (ASCII / CRLF / blok parantez dengesi) ve bozuk sürümü yakaladığı kanıtlandı. `.bat`'ı `write_file` ile yazma — CRLF/LF kararı sessizce bozulur; `mk-start-bat.mjs` gibi bir üretici kullan. |
| **Tuzak 58** | **Port dolu = sessiz ölüm.** Eski sunucu 8081'i tutarken yeni süreç `EADDRINUSE` ile düşerse kullanıcı "yeniden başlattım" sanıp **eski kodla** oynamaya devam eder (yaşandı: Y çalışmadı + çevrilmemiş DOTERYUM). Önlem üç katmanlı: (a) sunucu konsolda `(SURUM ...)` yazar, (b) `EADDRINUSE` yakalanır → net eylem mesajı + `exit(1)` (ham yığın izi YOK), (c) `start.bat` öldürdükten sonra **portun boşalmasını bekler**. |
| **Tuzak 59** | **Yerel yardımcı fonksiyonu modül seviyesinde kullanmak** (`put` menü düzeninin İÇİNDE tanımlıydı; HUD çizimi onu çağırınca `Uncaught ReferenceError: put is not defined` → **her karede throw** ve HUD hiç çizilmedi). Doğrusu: HUD metinleri `BitmapText.set(metin, renk)` + `.sprite.x/y` kullanır. **Node testi bunu GÖRMEZ** (istemci HTML'i çalıştırılmıyor) — yalnız gerçek tarayıcıda `?probe=1` `hata=` alanı yakaladı. Yeni istemci kodu yazınca: `node --check` (parse) **yetmez**, tarayıcıda `hata=yok` görülmeli. |
| **Tuzak 60** | **Probe'u log satırından okumak yanıltır.** İstemci log'u 40 kayıtlık HALKADIR ve `?m2h=` kancası 0,9 sn'de bir tarama yapıp 3 satır yazdığı için saniyede ~3 kayıt akar → 12 sn önceki kanıt (örn. `anom_wrong`) TAMAMEN silinir ("sunucu cevap vermiyor" sanılır — oysa cevap gelmişti). Kalıcı kanıt için **SAYAÇ** kullan: paket sayacı (`__rx`, `__anomKeys`, `__solveTry`) ya da `state.log.filter(...).length`. Yanıltıcı ölçüm, yokluğu kanıt saydırır. |
| **Tuzak 61** | **"Yazılmış kod" ≠ "bağlı kod".** M4 anomali handler'ları (`handleSolveAnomaly`, ödül, i18n) BAŞTAN BERİ vardı; ama `room.anomaly` hiç oluşturulmuyordu, `solve_anom` dispatcher'a bağlı değildi, istemcide çizim/tuş yoktu → özellik **ölü koddu** ve SSOT "M4 ✅ TAMAM" diyordu. Bir özelliği "var" saymadan önce **dört katmanın hepsini** ara: (1) veri nesnesi üretiliyor mu, (2) mesaj dispatcher'da bağlı mı, (3) istemci gösteriyor mu, (4) uçtan uca TEST ölçüyor mu. Ayrıca `rayPick` hedef listesine eklenmeyen nesne "vurulmaz" (silent) kalır. |

### M3f — `start.bat` KILL ADIMI YALAN SÖYLÜYORDU + İKİNCİ TUR EADDRINUSE ✅
Kullanıcı bildirimi (birebir): *"yok hala doldurulacak doteryum yok yazıyor ve yakıt doldurmuyor,
bir de bat şu hatayı veriyor `Error: listen EADDRINUSE: address already in use :::8081`"*.
**İki ayrı kök neden:**
1. **EADDRINUSE mesajı devreye girmiyordu:** `error` dinleyicisini yalnız `gameHttp`/`adminHttp`
   üzerine takmıştım. `ws` paketi bir `WebSocketServer` oluştururken http sunucusuna bindiği için
   hata `WebSocketServer` üzerinden yayılır (`Emitted 'error' event on WebSocketServer instance`)
   → ham yığın izi ekrana düşüyordu. **Dinleyici dört nesneye de takılmalı:** iki http sunucusu +
   iki WSS.
2. **`start.bat`'ın öldürme adımı yalan söylüyordu:** `taskkill /PID %~1 /F >>"%TEMP%\log" 2>&1`
   + `if errorlevel 1` yazmıştım. Çıktı yönlendirmesi çalışmadı (log dosyası hiç oluşmadı),
   taskkill **hiç koşmadı**, `errorlevel` 0 kaldı ve script ELSE dalına girip
   `PID 19216 kapatildi.` yazdı — port doluydu, yeni sunucu EADDRINUSE ile düştü, kullanıcı ESKİ
   kodla oynamaya devam etti. **KURAL: taskkill'in çıkış koduna DEĞİL, SONUCA bakılır** —
   öldürme sonrası `netstat` ile portun boşaldığı DOĞRULANIR; boşalmadıysa açıkça "kapatilamadi"
   denir (yönetici hakkı / farklı oturum tavsiyesi).
**Doğrulama (tahmin yok):** sahte bir dinleyici (node http, port 8085) açıp bat'ın kill yolu ona
yönlendirildi → `port 8085 kullanan PID 19748 kapatiliyor... → PID 19748 kapatildi, port 8085
bosaldi.` ve `netstat` portun gerçekten boşaldığını gösterdi. Ardından canlı 8081'e smoke testi:
`DOLUM: 44 → 45 (+1) kargo={"WARPCELL":5} paketler=[refuel_start refuel_full_tick]` → DOTERYUM yok,
malzeme harcanmadı, `refuel_none` yok.
**Ek:** `?refuel=1` test kancası (dolumu otomatik başlatır; önizleme paneli canvas'a tuş
gönderemiyor → "Y çalışmıyor" şikayeti ekrandan okunabilir hale gelir). SURUM: **2026-10-18f-M3f**.

### M3f-2 — DOLUM HIZI 2 YAKIT/SN + TICK'İN GERÇEK-ZAMAN DÜZELTMESİ ✅
Kullanıcı (birebir): *"refuel bi anda değil ağır ağır olsun saniyede iki fuel alcak yıldızdan"*.
`REFUEL_RATE` **5 → 2** (depo 45 → ~22,5 sn; sunucu + istemci kopyası + test sabiti üçü birlikte).
**Ölçüm yöntemi (neden gerekli):** yakıt sunucudan yalnız TAM SAYI olarak gelir, bu yüzden "3 sn'de
+6" gibi kısa ölçüm ±0,3/sn hata taşır. Bu yüzden hız, **ardışık +1 yakıt paketleri arasındaki
süreyle** ölçülür (2/sn → ~500 ms).
**Bulunan ikinci gerçek hata:** ilk ölçüm 539 ms (≈1,86/sn) çıktı — sebep `tick(TICK_MS/1000)`,
yani SABİT dt varsayımıydı. `setInterval(100)` Windows'ta ~107-108 ms'de tetikleniyor → **oyun saati
duvar saatinden ~%7 yavaş** akıyordu ve bu yalnız dolumu değil **kalkan regen (6/sn) dahil tüm
"…/sn" sabitlerini** aynı oranda saptırıyordu. Fix: tick'e `Math.min((now-lastTickAt)/1000, 0.25)`
(maks 0,25 sn tavanı, uzun bir GC/uyku sonrası ışınlanmayı önler). Yeni ölçüm: **~1,98 yakıt/sn**
(504 ms ortalama aralık). Sözleşme: **"…/sn" değerleri duvar saatine göredir**.
`test-fuel`'a kalıcı ölçüm kontrolü eklendi: `dolum hizi ~2 yakıt/sn` (bant 1,2-3,0 → 5/sn'lik eski
hal ya da "anında dolum" bandın dışında kalır, sessizce geri getirilemez).

### M3e — "Y ÇALIŞMIYOR / ÇEVRİLMEMİŞ DOTERYUM" OLAYI: kök neden + kalıcı önlemler ✅
Kullanıcı bildirimi (birebir): *"y ile fuel hala artmıyor aşağıda da doteryum falan yazıyor
ingilizceye de çevrilmemiş"*.
**Kök neden (ölçüldü, tahmin değil):** canlı 8081'e smoke testi bağlandım → sunucu hâlâ
`sys:refuel_none` yolluyordu, yani **çalışan sunucu ESKİ koddu**. Kullanıcının "yeniden başlattım"
denemesi, eski süreç (PID 19216) portu tutarken yeni sürecin EADDRINUSE ile düşmesiyle sessizce
başarısız olmuştu. Sonuç: **eski sunucu + yeni istemci** → istemci `refuel_none` kodunu sözlükte
bulamadı (M3c'de sildim) ve `sysText` HAM Türkçe metne düştü: "Doldurulacak DOTERYUM yok…" ✗ Y de
eski kurala göre DOTERYUM aradığı için hiç dolum başlamıyordu.
**Düzeltmeler (hepsi kalıcı):**
1. **Sürüm damgası:** sunucu konsolda `Game ws : … (SURUM 2026-10-18e-M3e)`, istemci log'da
   `SURUM 2026-...` ve `?probe=1` çıktısının başında. "Hangi kod çalışıyor" tek bakışta.
2. **EADDRINUSE mesajı:** ham yığın izi yerine net eylem metni (portu tutan PID + ne yapılacak) ve
   `process.exit(1)` → sessiz başarısızlık yok.
3. **`start.bat` temizliği güçlendirildi:** öldür → portun boşalmasını BEKLE (en fazla 8 sn) → başlat;
   sonunda "pencerede (SURUM ...) yazmalı" hatırlatması.
4. **`Cache-Control: no-store, must-revalidate`** (istemci dosyaları) — `no-cache` tek başına
   bfcache'e karşı yetmiyordu; geliştirme istemcisi artık her yüklemede diskten okunur.
5. **Y = AÇ/KAPA (toggle):** "basılı tut" modelinde tek basış ~0,3 yakıt ekliyordu (5/sn) → oyuncu
   "hiç dolmuyor" sanıyordu. Tek basış başlatır, ikinci basış durdurur; menzil/depo sınırı yine
   kendiliğinden durdurur. (M3c kuralı aynı: malzemesiz, yıldızdan.)
6. **YENİ TEST `test-i18n` (8/8) — sözleşme testi:** sunucudaki HER `_sys` kodu iki dilde de
   sözlükte olmalı + EN/TR anahtar paritesi + kaldırılan `refuel_none` geri gelmemeli. İlk koşuda
   **3 GERÇEK HATA** buldu: `warp_invalid` ve `tb` kodları sözlükte YOKTU (İngilizce oynayan ham
   Türkçe görüyordu), `warp_fuel` yalnız EN'de vardı (TR oynayan İngilizce görüyordu). `tb` kodu
   ayrıca 4 farklı durumu tek metinle anlatıyordu → sunucu artık `{mode, ore}` parametresi yolluyor.
   `package.json`: `test-i18n` + `test-all` (8'li).

### M3d — KALKAN (GEMİ ENERJİSİ) SALDIRIDAN SONRA KENDİLİĞİNDEN DOLAR ✅
Kullanıcı isteği (birebir): *"geminin enerjisi kendi kendine dolsun saldırıya uğradıktan bir süre
sonra"*.
- `SHIELD_REGEN_DELAY_MS = 5000`, `SHIELD_REGEN_RATE = 6` (kalkan/sn). Kural: **son HİT'ten sonra
  5 sn boyunca kalkan DOLMAZ**; süre geçince kendiliğinden dolar (tam dolum ~17 sn).
- `_damagePlayer` her hasarda `player.lastHitAt = Date.now()` yazar → regen sayacı sıfırlanır. Sayaç
  hem oyuncu hasarında hem korsan ateşinde aynı yerden geçtiği için istisna yok.
- **Gövde (hull) kendiliğinden DOLMAZ** — onun yolu TAMIR SETI (H). Ölüm/kurtarma her ikisini de
  100'e çeker (o ayrı kural, `_destroyPlayer`).
- **Neden gecikme (tasarım gerekçesi):** eski hâlde kalkan koşulsuz 6/sn doluyordu ve korsanın
  hasarı (1,5 sn'de 9 = 6/sn) regen ile TAM başa baş geliyordu → korsan oyuncuyu asla öldüremiyor,
  savaş "vur-kaç" yerine "bekle, nasılsa dolar" oyununa dönüyordu. Gecikme, art arda vurulurken
  kalkanın ERİMESİNİ sağlar; kaçıp saklanan oyuncu ise toparlanır. PvP ölümü testte 29 turdan
  ~15 tura düştü (hasar artık gerçekten birikiyor).
- **Yeni paket: `sh`** — `{t:'sh', v, max}`. Hasar paketi (`dmg`) yalnız DÜŞÜŞÜ taşır; kendiliğinden
  dolan kalkanı istemci göremezdi. Yakıtla AYNI desen: tam sayı değişince gönderilir (saniyede en
  fazla 1 küçük paket). İstemci `state.shield`'ı bundan günceller.
- İstemci HUD etiketi: kalkan eksikken gecikme boyunca `KALKAN DUSTU — n SN SONRA DOLAR`, sonra
  `KALKAN DOLUYOR`. İstemci `SHIELD_REGEN_DELAY_MS` sabitini AYNALAR (yalnız etiket için; dolum
  kararı sunucuda).
- **Kanıt (`test-combat`, değişen sunucu `PORT_GAME=8082` kopyasında): 19/19** (14 → 19, +5 yeni):
  `kalkan govdeye tasacak kadar hasar aldi — govde=88` ·
  `saldiri sonrasi GECIKME boyunca kalkan DOLMADI — kirilma 0 → 3.6 sn sonra 0 (gecikme 5000 ms)` ·
  `gecikme sonrasi kalkan KENDILIGINDEN doldu — 0 → 10 (~6/sn)` ·
  `dolum SUNUCUDAN sh paketiyle bildirildi — sh paketi 16 → 26` ·
  `govde (hull) KENDILIGINDEN DOLMADI — govde 88 → 88`.

### M3c — `Y` YILDIZDAN YAKIT ÇEKER (kullanıcı düzeltmesi, 2026-10-18) ✅ TAMAM
Kullanıcı (birebir): *"Y'ye basınca doteryum convert yapmayacak yıldızdan yakıt çekecek"*.
- `handleRefuel`/`_refuelTick`: kapılar **MESAFE → DEPO**; malzeme kapısı SİLİNDİ; küsurat ve
  geri-alma kodu SİLİNDİ; `REFUEL_AMOUNT` sabiti ve `refuelAccum` alanı SİLİNDİ.
- `DOTERYUM` yalnız ZANAAT cevheri olarak kaldı (WARPCELL ×3, YAKIT KUTUSU ×2+TITAN ×1); madencilik
  ile toplanır, dolumda harcanmaz.
- İstemci: `startRefuel` içindeki "DOTERYUM var mı" ön kontrolü kaldırıldı; HUD ipucu artık yalnız
  "yıldız dibinde + depo dolu değil" koşuluna bakar → `Y ILE YILDIZDAN YAKIT CEK`; yakıt-bitti uyarısı
  "yıldızın dibine git, Y ile yakıt çek" oldu; `refuel_none` sözlük girdisi ve uyarı listesinden
  çıkarıldı.
- **Kanıt (`test-fuel` 20/20, sunucu `PORT_GAME=8082` kopyasında koşuldu — kullanıcının 8081
  örneğine dokunulmadı):**
  `dolum MALZEME HARCAMADI — DOTERYUM 0 → 0, ambar {"WARPCELL":5} → {"WARPCELL":5}` ·
  `yildiz dibinde dolum BASLADI — ambarda DOTERYUM YOKKEN` ·
  `dolum, ambarda SIFIR DOTERYUM ile calisti (M3c regresyonu — eski malzeme kapisi YOK)` ·
  `dolum YAVAS ve SUREKLI (~2/sn)` · `dolum hizi ~2 yakıt/sn (AGIR AGIR)` · `depo dolunca KENDILIGINDEN durdu (refuel_full_tick)` ·
  `depo doluyken dolum reddedildi (refuel_full)` · `yakit bitince itis kapisi calisiyor`.
  Aynı yeni sunucuda: `combat 14/14`, `chat 32/32`, `pirates 32/32`, `craft-boost 19/19`.
- **Test hijyeni:** madencilik bölümü `test-fuel`'dan ÇIKARILDI (artık gereksiz, hem de testin en
  kırılgan/en yavaş parçasıydı) — yerine "ambarda DOTERYUM yokken dolum çalışır" İDDİASI konuldu
  (uydurma kuralın geri gelmesini engelleyen regresyon). Testler artık `WS_URL` ile başka bir
  sunucu örneğine yönlendirilebilir (mevcut oyuncu oturumunu düşürmeden koşmak için).

#### Test kararlılığı — kaynak kıtlığında "tek tur" yetmez [M3c: artık gündem dışı]
`test-fuel` artık madencilik YAPMIYOR (dolum malzeme harcamadığı için gereksizdi — hem de en
kırılgan parçasıydı). Kayıt, dersin kendisi için: DOTERYUM ağırlığı %6 → kuşakta genelde tek kaya;
kırıldıktan sonra `ROCK_RESPAWN_MS` (15 sn) boyunca o cevher yoktur, bu yüzden sayılı tur yerine
**süre bütçesi** (60-90 sn) ve hedef-toplanana-kadar kırma döngüsü kullanılır.
`test-fuel` doğuşta DOTERYUM verilmediği için cevheri kazar; ama dolum bölümleri toplamda 2-3 cevher
harcar ve tek kayanın ganimeti boyuta göre 1-3'dür → tek turluk akış `20/20 → 17/19 → 12/18` diye
KARARSIZ yandı. Artık hedef miktar TOPLANANA kadar (kaya 15 sn sonra aynı noktada yeniden doğar)
kırılır; süre bütçesi kullanılır (bkz. Tuzak 50).

### M4a — ANOMALİ OYNANIŞI: ölü kodu canlandırma ✅ (2026-10-18)
**Bulgu (analiz):** M4 "✅ TAMAM" diyordu ama anomali özelliği **4 katmanın 3'ünde eksikti** ve
tamamen ÖLÜ KODDU:
1. `room.anomaly` **hiçbir yerde oluşturulmuyordu** → `handleSolveAnomaly` ilk satırda çıkıyordu,
2. `solve_anom` mesajı `server.js` dispatcher'a **bağlı değildi** (protokolde sabiti vardı),
3. istemci anomaliyi **çizmiyordu**, frekans girme girdisi ve `anom_solved`/`anomgone` işleyicisi yoktu,
4. `rayPick` anomaliyi hedef listesine **almıyordu** (`_damageAnomaly` ayrıca TANIMSIZDI — çağrılsa
   TypeError ile tick çökerdi).
**Yapılan (sunucu, `backend/src/rooms.js`):** `_genAnomaly()` (deterministik konum/frekans —
korsan deseniyle aynı `pirateHash`); SİNYAL (`SILENT_BEACON`, `OBSCURED_SIGNAL`) ve KALINTI (`RUIN`,
`GRAVEYARD`, `DERELICT`) türleri; `rayPick`'e hedef olarak eklendi; `_damageAnomaly` + `_lootAnomaly`
(ateşle yıkma) + `_tractorAnomaly` (F ile parça parça yağma, son parça DOTERYUM); snapshot'a `anom`;
`handleScanAnomaly` (E → **maskeleli** frekans ipucu, ör. `1 5 1 ?`) + `handleSolveAnomaly`'ye "kaç
hane doğru" geri bildirimi. `server.js`: `MSG.SCAN_ANOM` / `MSG.SOLVE_ANOM` dispatcher satırları.
**Kararlar:** (a) **kod istemciye ASLA gitmez** — snapshot yalnız tür/konum/hp taşır, ipucu sunucuda
üretilir; (b) sinyal **ateşle yıkılmaz** → oyuncuya doğru yol söylenir (sessiz kapı yok); (c) kalıntı
iki yolla yağmalanır (ateş = hızlı/toplu, tractor = yavaş/parça parça, aynı düşürme fonksiyonu);
(d) çözüm/yağma anonsu **çözeni hariç** tutar (`sysAll` excludeId) → tek başına oynayan oyuncu anonsu
kendine görmez, ödülü `anom_solved` olarak alır.
**İstemci (`game-client/index.html`):** 5 tür için elle çizilmiş **mor/lila** pixel sprite (matris +
`padRows` genişlik garantisi), `syncAnomaly()` (çözülünce nesne SİLİNİR), E ile tarama, **R ile
frekans girişi** (0-9/Backspace/Enter/Esc; giriş açıkken DİĞER TÜM kısayollar devre dışı — Tuzak 43),
HUD kutusu, kalıntı can çubuğu, i18n 17 yeni anahtar ×2 dil.
**Ölçüm:** `npm run test-anomaly` → **23/23** (snapshot/kod sızıntısı yok, menzil kapıları, maskeli
ipucu, ateşle yıkılmama, `ok=3/4` geri bildirimi, ipuçtan türetilen kodla çözüm + ödül kapsülleri +
odaya anons + tekrar çözüm reddi, kalıntı hp→yıkım→ganimet). **Tarayıcı kanıtı** (`?probe=1`):
`anom=OBSCURED_SIGNAL/S/hp=0-0 anomMesafe=250 ipucu=1 5 1 ? kodGiris=1`, gerçek `keydown` yoluyla
`anomTus=Digit1;Digit5;Digit1;Digit9;Enter;` → `kodGonderme=a1:1519;` → sunucu `anom_wrong` →
`yanlisDeneme=1`, `hata=yok`. Galaksi: **646/16384 = %3.94** anomali işaretli yıldız (`_genAnomaly`
doğrulaması).
**Test kancaları (üretimde etkisiz):** sunucu `TEST_HOME_STAR=<id>` (doğuş sistemini sabitler),
`TEST_ANOM_NEAR=1` (doğuşu anomalinin 260 birim yanına taşır — anomali normalde 900-1420 birimde
doğar, önizleme paneli canvas'a tuş gönderemediği için görsel doğrulama ancak böyle mümkün);
istemci `?anom=1` (frekans kutusunu açar), `?keyseq=<rakamlar>` (GERÇEK `keydown` yolunu sentetik
`KeyboardEvent` ile sürer + Enter ile gönderir).

### Milestone 4 — Admin Tanrı Modu (tam güç) ✅ TAMAM — *anomali oynanışı M4a'da tamamlandı (bu bölüm admin/God Mode kapsar)*
- [x] **Galaxy overview render (admin'de tüm sistemler):** 16384 yıldızın sarmal haritası + canlı odalar (pulsing neon halkalar, oyuncu sayısı rozeti) + anomali ve korsan bölgeleri tek ekranda. Pan & Zoom (fare sürükleme, tekerlek, +/-/Fit düğmeleri), üzerine gelince yıldız bilgi kutusu (gezegen, kuşak, canlı durum), yıldıza veya canlı odaya tıklayınca doğrudan odaya geçiş.
- [x] **adm:inspect canlı stream UI:** Hedef bilgi kartı (oyuncu gövde/kalkan/yakıt çubukları, K/D, oda, uyarı sayısı veya oda bilgisi), kategori filtreleri (Tümü, Savaş, Hareket, Oda, Admin), anlık metin arama filtresi, akışı durdur/devam et düğmesi, temizle düğmesi.
- [x] **adm:command (God Mode kontrolleri):**
      - `kill_player`: Seçili oyuncuyu anında imha edip ana sisteme kurtarma gönderir.
      - `spawn_asteroid`: Hedef odaya istenen cevherde (DOTERYUM, TITAN, vb.) ve boyutta anında kaya doğurur; odadaki oyunculara `rocknew` yayınlar ve `adm:command_res` ile döner.
      - `trigger_star_kill`: Belirtilen yıldıza supernova tetikler; haritada `SUPERNOVA` anomalisi işaretlenir, tüm oyunculara acil durum felaket uyarısı gider (`sys:star_kill`), hedef odadaki tüm asteroidler silinir ve oyuncular kurtarma gemisiyle ana sisteme döner.
      - Tüm god mode komutları denetim izi için `telemetry.critical(...)` ile loglanır.
- [x] **Herhangi Bir Yıldızı Seçip Odayı Canlı İzleme (On-Demand Universe Inspection):**
      - Admin 16.384 yıldızdan istediğini Galaxy haritasından tıklayarak veya sol paneldeki "Yıldız / Oda Seçici" kutusuna ID/isim girerek seçebilir.
      - Seçilen oda bellekte henüz aktif olmasa bile (içinde hiç oyuncu olmasa dahi) deterministik olarak ayağa kaldırılır (`Room` instance'ı), kuşağı ve korsan istasyonu oluşturulur, admin tarafından 250ms akışla canlı izlenir (`room.adminWatching = true`).
      - Admin odadan ayrıldığında oda 10 sn sonra normal uyku döngüsüne bırakılır ve 30 sn boşta kalma sonrası otomatik hibernasyonla bellekten temizlenir (sıfır sızıntı).
      - Canlı render ve döküm tablolarına **Korsan İstasyonu (Station)** ve **Korsan Gemileri (NPC)** tam durumları (gövde barı, koordinat, açı, yön) ile eklendi.
- **DOĞRULANDI:** `npm run test-m4` → **11/11** uçtan uca kontrol (oyuncu snapshot, admin auth, 16384 yıldızlı galaxy overview, aktif oda/oyuncu konumları, player inspect snapshot, spawn_asteroid + rocknew canlı yayını, trigger_star_kill supernova yayını, kill_player). `node backend/scripts/test-admin-any-star.mjs` → **4/4** (oyuncusuz Star 0 ve korsan istasyonlu Star 7071 on-demand izleme). `npm run test-admin` → **OK**. `npm run test-i18n` → **28/28 kod OK**.

### Milestone 5 — End-Game + Ölçek
- [ ] Yıldız Yok Etme Silahı: global event protocol + kalıcı harita değişikliği (DB'ye yazılır)
- [ ] Room mirror (50+ oyuncu belt), hibernate optimizasyonu
- [ ] Deploy: Oracle VM (systemd + Caddy ws proxy) + Pages

### Kapsam Dışı (Future Enhancements — şimdilik DOKUNMA)
- PvP lonca/ekonomi sistemi, mobil native build, ses/müzik, i18n

---

## 6. Doğrulama Kaydı ve Bilinen Tuzaklar

Bu bölüm, geliştirme sırasında DİBİNE DÜŞÜLEN tuzakların kaydı — tekrarını önler.

### Tuzak 1 — `EADDRINUSE`: eski server port tutuyor
Windows/MSYS'te arka planda başlatılan `node` process'i, başlatan kabuk öldüğünde bile YAŞAMAYA
DEVAM EDER (stdin olmadığı için wrapper anında düşer, gerçek `node.exe` ayrı PID'de kalır).
Belirti: yeni server sessizce `EADDRINUSE` ile ölür, ama eski KOD çalışmaya devam eder —
"yeni özellik yok" gibi yanıltıcı bir tablo çıkar.
**Çözüm:** her başlatmadan önce `./dev.sh stop` (veya `start.bat`). Gerçek PID: `netstat -ano | grep :8081`.

### Tuzak 2 — top-level `await` klasik `<script>` içinde çalışmaz
`await app.init(...)` kullanan dosyada `<script>` etiketi **`type="module"` olmak zorunda**.
Klasik script'te SyntaxError oluşur ve sayfa SESSİZCE siyah kalır (hiçbir uyarı görünmez).
**Ek önlem:** `window.onerror` + `unhandledrejection` yakalanıp sayfadaki `#status` satırına yazılır;
canvas görüntüsü okunamasa da hata DOM metni olarak DIŞARIDAN okunabilir.

### Tuzak 3 — heartbeat yanıtlanmazsa reconnect döngüsü
Sunucu `hb` mesajını yanıtlamazsa client "bağlantı öldü" sanıp yeniden bağlanır. Sabit duran ya da
sekmesi arka planda olan (requestAnimationFrame durur → hiç diff üretilmez → hiç mesaj gelmez) her
oyuncu için sonsuz reconnect + sunucuda hayalet oyuncu birikimi oluşur.
**Kural:** sunucu her `hb`'ye aynı `c` değeriyle yanıt verir → gerçek RTT ölçümü de bundan gelir.
Canlılık kontrolü ASLA "diff geldi mi"ye bağlanmaz.

### Tuzak 4 — pixel art'ta kesirli ölçek
Kamera/ölçek `Math.round` edilmezse ve `image-rendering: pixelated` kullanılmazsa pikseller
eşit olmayan bloklara bölünür; görüntü "pixel art" değil "bulanık retro" olur.
**Kural:** 480x270 render + tam sayı kat + `resolution:1` + `antialias:false`.

### Tuzak 5 — hız sınırı tutarsızlığı = rubber-banding
Client'ta `SHIP_SPEED` (220), sunucuda `MAX_SPEED` (220 * 1.5 tolerans). Client limiti sunucudan
büyük olursa oyuncu sürekli geri çekilir. **Kural:** iki sabit birlikte değişir, yorumlarda çapraz atıf var.

### Tuzak 6 — Pixi `Container.visible` varsayılanı `true`
Harita katmanı `visible = false` ile başlatılmazsa: yıldız haritası yüklendiği anda tüm ekranı
kaplar, `M`'e basınca da TERSİNE döner → `state.mapOpen = true` kalır (tıklama warp yapar) ama
katman görünmez olur. Belirti: *"harita açıldı diyor, tıklayınca warp yapıyor ama harita görünmüyor."*
**Kural:** overlay katmanı oluşturulurken `visible = false` yazılır ve katman yeniden kurulduğunda
durum tek yerden (`state.mapOpen`) tekrar uygulanır. HUD'un altında kalan her katman için geçerli.

### Tuzak 7 — gerçek ADMIN_SECRET_KEY ajan tarafından okunamaz
`.env` `read_file` için engelli, terminal çıktısında maskeli. Bu bir güvenlik özelliği, aşılması
gerekmez. Admin yolunu doğrulamak için `npm run test-admin`: 8091/8092'de kendi anahtarıyla ikinci
bir sunucu açar ve panelin KENDİ JS'ini stub DOM global'leriyle ona karşı çalıştırır
(auth → stats → oyuncu listesi render doğrulanır). Kullanıcı için anahtar `start.bat` ile
doğrudan PANOYA kopyalanır.

### Tuzak 8 — piksel metin ya bitmap font ya hiç
Pixi'nin `Text` sınıfı glifleri YUMUŞAK (antialiased) rasterize eder; canvas 3-4x büyütülünce
metin bulanık görünür ("yazılar bulanık" şikâyetinin tek sebebi). Çözüm: 5x7 harf matrisi +
offscreen canvas + `nearest` doku (`game-client/index.html` §2 `BitmapText`). Tuval boyutu
SABİT tutulur (Pixi v8'de canvas boyutu değişince `texture.source.resize()` gerekir, unutulursa
metin kesilir). Ortalama gerekiyorsa `BitmapText.width` (ölçülen genişlik) kullanılır — TUVAL
genişliğiyle ortalama yapılırsa kısa metin ekranın soluna kayar ve kırpılır (yaşandı).
Fontta olmayan her karakter `?` olarak çizilir → tire/uzun çizgi/akıllı tırnak gibi Unicode
noktalama `TR_MAP` ile ASCII'ye indirilmelidir, yoksa "SINYAL ? ARANIYOR" gibi bozuk metin çıkar.

### Tuzak 9 — sabit sanal çözünürlük "ekrana oturmaz"
Sabit 480x270 + `floor()` ölçek 1920x960 ekranda 1440x810 verir → yanlarda siyah bant.
Çözüm: `SCALE = round(ekranYüksekliği / 280)`, sanal boyut = ekran/SCALE → canvas piksel-piksel
ekranı kaplar ve tüm pikseller AYNI boyutta kalır (tam sayı ölçek korunur). Aşırı dar/dikey
pencerede sanal genişlik 340'ın altına düşerse 16:9 letterbox'a düşülür (HUD üst üste binmesin).

### Tuzak 10 — toggle tuşlarında `e.repeat`
`M`'e basılı tutmak keydown'ı tekrarlar → harita açılıp ANINDA kapanır; kullanıcı "harita
açılmıyor" der ama durum satırında `ACIK/gorunur` → `kapali/gizli` geçişi görünür. Kural:
toggle tuşlarında `if (e.repeat) return;`.

### Tuzak 11 — "tüm galaksiyi göster" keşif hissini öldürür
4096 yıldızın tamamını tek haritada göstermek hem okunamaz (yıldızlar 1-2 px'te yığılır) hem de
anlamsızdır. Doğru tasarım: oyuncunun çevresinde `JUMP_RANGE*1.2` yarıçaplı KÜÇÜK pencere +
keşfedilmemiş yıldızlar için SİS. Keşif localStorage'da birikir (`astrovector.seen`), sisteme
varınca yıldız + `JUMP_RANGE*1.5` komşuları açılır → harita oynadıkça dolar (255/4096 gibi bir
sayaçla göster).

### Tuzak 12 — harita etiketleri üst üste biner
Zoom'lu haritada komşu yıldızların ad etiketleri aynı piksele düşer ve okunamaz. Çözüm: her
etiket için dikdörtgen tahsis et, ÇAKIŞANI ATLA (greedy), en önemliyi (oyuncunun kendi yıldızı:
`SEN: <ad>`) İLK yerleştir.

### Tuzak 13 — menzil kontrolü yıldız-yıldız yapılır
Warp mesafesi oyuncunun sistem içi konumundan DEĞİL, bulunduğu yıldızın galaksi konumundan
ölçülür (warp bir yıldızdan diğerine atlamadır). Client menzil dışını soluk gösterip isteği hiç
göndermez; son kararı sunucu verir (`JUMP_RANGE`, sn paketinde client'a da bildirilir — sabit
çift yerde tutulmaz). Test: `npm run test-warp` (900 birim → reddedilir, 647 birim → geçer).

### Tuzak 14 — görsel ölçeği tek sabit belirler
`HEDEF_SATIR_YUKSEKLIGI` (sanal yükseklik hedefi) tüm görsel ölçeği belirler: 280 → 520 yapmak
sanal çözünürlüğü iki katına çıkarır, piksel başına ekran alanını YARIYA indirir ve hem yazıları
hem oyun öğelerini ekranda yarı boyutta gösterir. "Yazılar büyük" şikâyetinin doğru çözümü budur
— fontu küçültmek değil (5x7 zaten minimum okunaklı glif).

### Tuzak 15 — hitscan ışında SIFIR MESAFE özel durumu
Işın testinde "arkadaki hedefe vurulmaz" kuralı `along < 0.5` ile sağlanır. Ama hedef TAM
üstümüzdeyse `along = 0` olur ve hedef yanlışlıkla "arkada" sayılır → iki gemi aynı koordinatta
üst üste uçtuğunda atış HİÇ isabet etmez (yaşandı; PvP testi bu yüzden düşüyordu). Kural: hedef
kendi yarıçapından yakınsa (`d² ≤ r²`) her zaman isabet (point-blank) ve o hedef kazanır.

### Tuzak 16 — hasar/ganimet HUD'u SUNUCUDAN gelir
Kalkan, gövde ve envanter istemcide simüle edilmez; sunucu `dmg` ve `loot` paketleriyle bildirir,
`sn` (snapshot) da bu üçünü içerir — yoksa ölüm/kurtarma veya yeniden bağlanma sonrası istemci
bayat değer gösterir (test bunu `kurtarma sonrasi tamir` kontrolüyle yakalar).

### Tuzak 17 — statik nesne varsayımı kayan nesnede bozulur
Odalar asteroidleri yalnız snapshot'ta gönderir (statik varsayım → 10Hz diff'e girmez). Tractor
beam kayayı OYNATINCA bu varsayım çöker: hareket eden kaya için ayrı `rockmv` paketi yayınlanır,
kuşağın geri kalanı sessiz kalır. Kırılan kaya için de `rockgone`/`rocknew` vardır (15 sn sonra
aynı yerde yeniden doğar).

### Tuzak 18 — test kancaları URL ile gelir, üretimde etkisizdir
`?map=1` haritayı açıp imleci ileri-geri salar, `?demo=1` gemiyi en yakın kayaya yöneltip kazar
(burun yönü HIZDAN geldiği için nişan "dönmüş olma" kontrolü ister: `dot(nose, hedef) > 0.98`),
`?probe=1` durumu her 200 ms'de DOM'a yazar. **Neden DOM'a yazar:** canvas HUD'u dış araçlarla
OKUNAMAZ; sayısal doğrulama (gemi sabit / imleç 260 px/sn) ancak böyle yapılabilir. Parametre
yoksa hepsi etkisizdir. Kancalar yalnız `http://localhost:8081/` üzerinden çalışır — bu yüzden
sunucu geliştirmede `game-client/` klasörünü statik servis eder (preview paneli dosya yoluna
`?query` eklenince sayfayı bulamıyordu).

### Tuzak 19 — önizleme paneli KÜÇÜK sanal çözünürlük verir
Preview paneli ~488x275 CSS px → `SCALE = max(1, round(275/520)) = 1` ve sanal genişlik 488.
İmleç merkezi (244,137); `(484,259)` gibi bir değer "merkez" DEĞİL, sağ-alt SINIRDIR (VW-4).
Ekran görüntüsünde test yaparken ölçülen sayıların panel boyutuna bağlı olduğunu unutma.

### Tuzak 20 — canlı YAKIT `sn` (snapshot) paketinde DEĞİL
`sn` yalnız bağlanma/warp anındaki yakıtı taşır; değişimler ayrı `{t:'fuel',v,max}` paketiyle
(sunucu tam sayı her değiştiğinde) gelir — üstelik bir SONRAKİ tick'te (≤100ms). Test/istemci
güncel değeri `fuel` paketinden okumalı. `test-fuel`'ün ilk koşusu `sn.fuel` okuduğu için
"uçuşta 0 yakıt harcandı" gibi tamamen yanlış bir sonuç verdi.

### Tuzak 21 — yakıt kapısı TAM ORANLI olmalı
`if (player.fuel <= 0) step = 0` yeterli DEĞİL: acil damla (0.35/sn) yakıtı sürekli 0'ın üstüne
çıkardığı için oyuncu istenen TAM adımı atıp depoyu 0'da tutabiliyordu (sonsuz sızma).
Doğrusu bütçe: `step = min(step, fuel*FUEL_PER_DISTANCE - fuelAccum)`. Aynı formül istemcide de
itiş kapısıdır (`state.fuel * FUEL_PER_DISTANCE - state.fuelAccum > 0`).

### Tuzak 22 — galaksi büyütünce başlangıç yıldızı KUŞAKSIZ düşebilir
`GALAXY_RADIUS`/`STAR_COUNT` değişince galaksinin %37'sindeki yıldız artık başka bir yıldızdır ve
`b = 0` (asteroit kuşağı yok) olabilir → oyuncu 0 kayalı boş bir sistemde doğar, madencilik/yakıt
hammaddesi imkânsız olur (`test-combat`: "kaya=0"). `_pickHomeStar()` %37'den başlayıp ilk
**kuşaklı** yıldızı seçer.

### Tuzak 23 — cevher seçimi de SEED'li olmalı
Kuşak üretimi deterministikti ama cevher `Math.random()` ile dağıtılıyordu → "hibernate/warp
sonrası dünya aynı kalır" iddiası yalan oluyordu. `pickOre(rnd)` seed'li PRNG'yi alır.

### Tuzak 24 — odadaki BAŞKA istemci testleri yalancı negatife düşürür
`shot`/`rockgone`/`boom`/`dmg` paketleri ODAYA yayınlanır. Açık bir tarayıcı sekmesi (ör. `?demo=1`)
aynı sistemde ateş ederken: cooldown testi 4 paket görür, madencilik döngüsü başkasının kırdığı
kayayı "kırıldı" sayar, PvP'de ışın arada duran gemiyi vurur. Paketleri **id ile filtrele** ve
testleri SESSİZ odada koş (ya da bilinçli olarak eşzamanlı istemci senaryosu olarak kabul et).

### Tuzak 25 — WebAudio yalnız KULLANICI ETKİLEŞİMİNDE açılır
`AudioContext` sayfa yüklenirken `suspended` kalır; osilatörleri modül kurulumunda başlatmak
sessiz bir grafik bırakır. `ensure()` (ilk tuş/tık) içinde kurulur + `resume()` edilir. `P` susturur.
Dış araçla "ses çalışıyor" KANITLANAMAZ — bu yüzden probe `sfx.ready()` (ctx.state === 'running')
durumunu yazar; sesin kendisi ancak kulakla doğrulanır.

### Tuzak 26 — `state.star` gelmeden harita açılırsa merkez (0,0) olur
`playerGalaxyPos()` `starmap` + `state.star` ister; ikisi de yoksa `null` döner ve `mapOwn`
(0,0) kalır → harita "kendi yıldızım ortada" yerine galaksi merkezini gösterir. Harita testkancası
snapshot gelmeden tetiklenirse tam bu olur (`own=(0,0)`). Haritayı açmadan önce `state.star`'ı bekle.

### Tuzak 27 — `dev.sh start` çalışmıyordu: native node'a MUTLAK MSYS yolu
`ROOT="$(cd "$(dirname "$0")" && pwd)"` = `/d/tool projects/AstroVector`; bu yol native node'a
verilince node onu `D:\d\tool projects\AstroVector\backend\server.js` diye çözer →
`MODULE_NOT_FOUND` + exit 1. Yani `./dev.sh start` HİÇ başlamıyordu ve belirti yanıltıcıydı
("background process exited 1" — sanki sunucu çökmüş gibi). Bu ortamda native programlara MSYS
yol çevirimi YOK: ya `cd` yapıp GÖRECELİ yol ver, ya da `D:/...` biçiminde forward-slash native
yol geçir. (Aynı sınıf hata: `git -C /c/...`, `node /tmp/x.js`.)

### Tuzak 28 — port kontrolü TIME_WAIT satırlarını "dolu" sayıyordu
`netstat -ano | grep ':8081'` deseni, istemcinin sunucuya açtığı bağlantıların **TIME_WAIT**
satırlarını da yakalar: orada 8081 YABANCI adres kolonundadır ve PID `0`'dır. Sonuç: sunucu
kapalıyken bile `./dev.sh start` "Port zaten kullanimda (PID: 0)" diyip çıkıyor, `stop` ise
boşuna PID 0'ı öldürmeye çalışıyordu. Port sahibi bulunurken yalnız **yerel adresin son kolonu**
bu port olan TCP satırları sayılır (ve PID 0 atılır). Aynı tuzağın izi `netstat` çıktısında
"TIME_WAIT 0" satırıdır.

### Tuzak 29 — testin ATIŞ TAVANI kalkan yenilenmesiyle yarışır (yalancı negatif)
PvP testi "200 hp / 14 vuruş = 15 isabet" diye düşünüp döngü tavanını 26 tura koymuştu. Gerçek
hesap: kalkan 6/sn yenilenir, tur ~1.1 sn sürer → tur başına NET hasar ~7 → **~29 tur** gerekir.
Tavan sınırdayken AYNI kodla bazen 13/13 bazen "hedef yok edildi" başarısız oluyordu (ölçüm
hatası değil, zamanlama kararı). Tavan 50'ye çıkarıldı ve her tur `hk`/`dmg` değerleri loglanıyor
(hasar birikimi ile yenilenme yarışı böyle GÖRÜNÜR olur); `boom` gelince döngü zaten erken biter.
Ders: döngü tavanı, YENİLENEN kaynakları hesaba katmalı.

### Tuzak 30 — önizleme panelinde rAF duraklayınca ticker DONAR
Pane occluded/arka plandayken `requestAnimationFrame` duraklatılır: probe'da `tk=<sayaç>` iki okuma
arasında AYNI kalır ve ticker'a bağlı her şey (harita pan'ı, uçuş, FX) ilerlemez. Bu bir oyun hatası
DEĞİL, tarayıcı davranışıdır; ama "harita kaymıyor / gemi hareket etmiyor" gibi yanlış tanıya yol
açar. Tick'e bağlı davranışı headless ws istemcisiyle (`test-*.mjs`) doğrula; probe'da `tk`
artmıyorsa önce pane'in canlı olup olmadığını kontrol et (sayfayı yenile/tab'ı öne al).

### Tuzak 31 — uzun ömürlü CACHE + değişen veri = sessiz "bozuk harita"
`/starmap.json` `public, max-age=86400` ile servis ediliyordu; galaksi 4096 → 16384 yıldıza
çıkarılınca tarayıcı ESKİ haritayı kullanmayı sürdürdü → istemci kendi yıldızının indeksini
bulamadı: harita merkezlenmedi, "SEN" yok, warp tutmadı. KURAL: (1) değişebilen veriyi asla uzun
`max-age` ile gönderme — `no-cache` + `ETag` ver (304 ucuz, bayat imkânsız); (2) istemci `fetch`'i
`cache:'no-store'` ile yapsın; (3) sunucu veriye SÜRÜM kimliği koysun (burada `seed-count`) ve
snapshot'ta bildirsin, istemci karşılaştırıp uyuşmazlıkta yeniden çeksin; (4) uyuşmazlık
sürerse KAPAT ve nedenini YAZ — sessiz arıza en pahalı arıza. Ayrıca: kendi ortamında "çalışıyor"
görmek yetmez; uzun ömürlü tarayıcı profili (cache/localStorage) ile test etmediysen doğrulama
eksiktir.

### Tuzak 32 — `dev.sh stop` → `start` yarışı: sunucu hiç başlamıyor
`taskkill` ASENKRON çalışır: PID ölür ama port birkaç yüz ms daha tutulur; `stop`'un ardından
hemen `start` çağrılırsa "Port zaten kullanimda (PID: …)" ile geri döner ve sunucu HİÇ başlamaz
(belirti: "server kapalı" + `curl` bağlantı hatası). Sabit `sleep` yerine port boşalana kadar
BEKLE (yoklama döngüsü). Bu, `stop && start` zincirini güvenilir yapar.

### Tuzak 33 — Canvas 2D metotları ZİNCİRLENEMEZ (Pixi alışkanlığı)
`g.moveTo(...).lineTo(...)` **Pixi `Graphics`** API'sidir. `CanvasRenderingContext2D` tarafında bu
metotlar `undefined` döner → `TypeError: Cannot read properties of undefined (reading 'lineTo')`.
Belirti sinsi: çizim yarıda kalır (o ana kadar çizilenler görünür, sonrası kaybolur) ve hata yalnız
konsola düşer. KURAL: canvas bağlamında **her çağrıyı ayrı satıra** yaz. Test harness'i (`Proxy`
ile no-op ctx) bu sınıf hatayı ANINDA yakalar — canvas çizen panelleri taklit DOM'la test etmek
süs değil, gerçek regresyon kalkanıdır.

### Tuzak 34 — Test eşiği sabit bir sabiteye GÖMÜLÜRSE ölçek değişince yalancı negatif verir
Yakıt kapısı testi "yakıt 0'da adım < 100 birim" diye kalibre edilmişti; `FUEL_PER_DISTANCE`
300 → 600 olunca izin verilen mesafe de iki katına çıktı (acil damla × 600 ≈ 150-200 birim) ve
test **çalışan** bir kapıyı "başarısız" ilan etti. KURAL: eşiği **sabitten türet**, gömmе
(`damla × FUEL_PER_DISTANCE`), ya da sözleşmeyi ölç (6 adım < kapısız beklentinin %75'i).
Aynı sınıf hata: acil damla yakıt 5'in altında tüketimle yarıştığı için depo boşaltma döngüsünün
adım tavanı (108+20) yetmedi → "depo bitmedi" yalancı negatifi. Tavan, damla kuyruğu için pay
bırakmalı (108+60).

### Tuzak 35 — Nesne alanları YANLIŞ adla destructure edilirse sessizce `undefined` olur
`MENU.panel = { x, y, w, h }` iken `const { px, py, pw, ph } = MENU.panel` yazıldı → dördü de
`undefined` (hata YOK, uyarı YOK). Sonuç: `undefined + 12 = NaN` → yazıların `x`'i NaN olur ve
Pixi `NaN` konumlu sprite'ı **hiç çizmez**. Belirti çok yanıltıcıydı: panelin zemini/çerçevesi ve
**sol sütun etiketleri** yok, ama **sağdaki düğmeler** (doğrudan `MENU.en.x` gibi alan okumaları)
vardı → "menünün yarısı çizilmiyor" sanıldı; ilk akla gelen (kırpma/katman) yanlış çıktı.
KURAL: destructure ederken alan adını BİREBİR eşleştir (`{ x: px, y: py }`) ya da nesneye erişerek
oku (`MENU.panel.x`). Şüphelenince `JSON.stringify(objesi)` yap — `undefined` alanlar JSON'da
**hiç görünmez**, NaN ise `null` olur: ikisi arasındaki fark teşhisi bir adımda çözer.

### Tuzak 36 — Aynı metnin İKİ sözlükte AYRICA kopyası varsa biri güncellenmeden kalır
i18n'e geçerken `STR.en.hud` `t('hud_shield')` kullanan sürüme çevrildi ama `STR.tr.hud` içinde
eski **gömülü kopya** (`shield ${p.shield}  hull ${p.hull}`) kaldı. Belirti: arayüz Türkçe
(`YAKIT/TEMAS/KAYA`) ama o iki etiket İngilizce (`SHIELD/HULL`) — "çeviri yarım" gibi görünür.
KURAL: bir metin iki dilde farklı cümleler olabilir, ama **dinamik parçaları (etiketler, birimler)
gömme**: her iki sözlük de aynı anahtarlara başvursun. Çeviri sonrası KONTROL: aktif dili TR yapıp
HUD'un her satırını gözle oku (otel yalnız `t()` çağrılarının sayısını görür, İçerik karışımını
görmez).

### Tuzak 37 — Sabit boyutlu panel küçük görünüm alanında taşar
Menü paneli sabit `336 px` genişlikteydi; Hermes önizleme panelinde sanal genişlik `VW=361`,
gerçek tarayıcı penceresi ~1280 → `VW≈640`. Küçük görünümde panel ekranı taşırdı (sağdaki düğmeler
kenardan kesilir, sol sütun dışarı çıkar). KURAL: overlay panelleri `VW/VH`'ye göre ÖLÇEKLENDİR
(`pw = min(340, VW - 20)`), kontrol kolonunu panel genişliğinden türet. Sanal çözünürlük ekran
boyutuna bağlı olduğu için **her iki uçta** (küçük panel + tam ekran) test edilmeli.

### Tuzak 38 — `const` bir değişkeni TANIMINDAN ÖNCE kullanmak (TDZ) hesabı patlatır
Boost'ta `state.boosting` hesabı, ona girdi veren `fuelBudget`/`perFuel` satırlarından ÖNCE yazılmıştı
→ `ReferenceError: Cannot access 'fuelBudget' before initialization`. Tarayıcı hatayı yalnız o satır
çalışınca verir (derleme/sözdizimi temiz görünür). KURAL: bir ifadede kullanılan her türetilmiş değeri
ÖNCE hesapla, sonra ona bağlı kararı ver; bağımlılık sırasını yorumda yaz (`sıra ÖNEMLİ`).
Not: `node --check` bunu YAKALAMAZ (çalışma zamanı hatası) — istemci tarafı bu yüzden probe/`selftest`
ile CANLI denenmeli.

### Tuzak 39 — Testin zamanlaması sözleşmeden türetilmeli (sunucu `dt`'yi SON paketten ölçer)
Boost hız testi "320 ms aralık → boost'suz kırpılır" varsayımıyla yazıldı ve HİÇ kırpma görmedi:
`_move` içinde `dt = now - player.lastAcceptedAt`, ve testte okuma beklemesi (220 ms) de araya
girdiği için gerçek `dt` ≈ 1,2–1,9 sn oluyordu (`allowed = 330 × dt` → 400–620 birim > istenen 500).
Ayrıca İLK paketin `dt`'si oyuncunun doğuş anından ölçülür (çok büyük) → ısınma paketi şart.
KURAL: mutlak eşik yerine **aynı `dt`'de iki modun ORANINI** ölç (`boost/normal = BOOST_MUL`, dt'den
bağımsız ve kesin); ilk ölçümden önce küçük bir "ısınma" paketi gönder.

### Tuzak 40 — Ölçüm başka bir tasarım kuralıyla kirlenirse yanlış sayı üretir
Boost yakıt testi "dolu depo ile 13500 birim" ölçtü ama 19456 buldu; iki sebep: (a) yakıt kapısı
`fuel * perFuel` oranıyla çalışır ve `perFuel` MODA bağlıdır → aynı depoda mod değiştirmek hesabı
karıştırır ("aynı oyuncuda önce normal sonra boost" yanlış), (b) depo bitmeye yakın **acil yakıt
damlası** devreye girer ve kuyruğa ekstra yol ekler. KURAL: ölçümü TAZE kimlik + TEK modda yap;
bilinen yan kanalları ya kapat ya sınırını açıkça yazıp toleransa yansıt (ve yorumda NEDEN'ini
belirt — toleransı sessizce gevşetmek yalancı yeşil üretir).

### Tuzak 41 — Bitmap metin panel genişliğini aşarsa SESSİZCE kırpılır
Zanaat panelinin alt yazısı (`craft_foot`) ve kilit yazısı (`lockText`, `maxW=160`) küçük görünümde
kesildi ("... J BEACON · C", "LOCK TITAN 750 — OUT OF R"). Ne hata ne uyarı: bitmap font canvas
genişliğinden sonrasını çizmez. KURAL: metin canvas'ının `maxW`'sini **en uzun beklenen dizeye** göre
seç (5 px glif + 1 boşluk) ya da metni kısalt; dar görünümde (VW≈361) doğrula.

### Tuzak 42 — Kapı SIRASI sözleşmenin parçasıdır (hangi kod döner)
Warp'a yeni "hücre var mı" kapısı menzil kontrolünün ÖNÜNE konunca, menzil dışı bir istek artık
`warp_range` değil `warp_nocell` dönüyordu → `test-warp-range` kırıldı (menzil duvarı bekliyordu).
Karar: **MENZİL önce** (menzil dışı istek hiçbir koşulda geçerli değil; istemci de aynı sırayı
kullanır). KURAL: yeni bir doğrulama kapısı eklerken (a) hangi hatayı önce döndürmesi gerektiğini
sözleşmeden belirle, (b) bunu yorumda yaz, (c) kapı sırasına bağlı testi güncelle.

### Tuzak 43 — Yeni kısayol başka bir tuşu EZERSE sessizce kaybolur
Kilit için `T` istendiği anda sohbet de `T`'deydi (kullanıcı gözünde çalışmayan bir özellik). KURAL:
kısayol eklerken mevcut tuş haritasını tara, çakışmada İSTENENİ öne al ve eskiyi taşı (sohbet `B`ye),
sonra hem ipucu metnini hem SSOT kontrol listesini güncelle — yoksa kullanıcı bulamaz.

### Tuzak 44 — Farklı koleksiyonların alan adları aynı sanılırsa OYUN DONAR (throw + donmuş ticker)
Kullanıcı bildirimi: *"bir asteroide kilitlenip ateş edip patlattığımda oyun dondu"*. Sebep:
`roomObjects()` kapsülün konumunu `p.g`den okuyordu ama kapsüller `{ group, ... }` tutar (kayalar
`r.g`, gemiler `o.group`, kapsüller `p.group`). Kaya patlayınca **kapsül doğar** → o an
`p.g.x` undefined'dan okunur → `TypeError: Cannot read properties of undefined (reading 'x')`.
Hata ticker callback'i içinde atıldığı için karenin KALANI hiç çalışmaz: görüntü donar, oyun
"kilitlenmiş" gibi kalır (hata yalnız konsolda).
TEŞHİS (bu artık kalıcı): probe hatası **stack'in ilk karesini** yazar
(`hata=TypeError ... @at roomObjects (…:2237:72)`) ve `tk=` (kare başı) ile `son=` (kare sonu,
`__tkEnd`) sayaçları ayrı sayılır — `tk` artarken `son` duruyorsa "ticker'ın ORTASINDA throw"tur.
KURAL: aynı ada sahip alanları koleksiyonlar arasında varsayma (bkz. Tuzak 35); liste üreten
yardımcıları **savunmacı** yaz (`if (!r || !r.g) continue`) → veri şekli değişirse nesne listeden
düşer, oyun çökmez. Yeni bir "nesne listesi" yazan her kod, nesne DOĞARKEN ve ÖLÜRKEN denenmeli.

### Tuzak 45 — Bilgi gösteren yardımcı "duvar arkası görüş" hilesine dönüşebilir
Radar (minimap) baştan odadaki tüm kayaları/gemileri gösteriyordu: arama/keşif anlamını
öldürüyordu ve yeni SCAN tuşunu gereksiz kılıyordu. KURAL: bir görünüm "her şeyi bilmek" ile
"hiçbir şey bilmemek" arasında seçilmez — bilgi bir EYLEMİN sonucuna bağlanır (tara → açılır,
süresi biter → kapanır). Aynı ders haritada (Tuzak 11) ve sessizlik/açlık durumlarında da geçerli.
Ek kural: sis perdesi "bozuk" sanılmasın diye **kendini açıklamalı** (soluk çerçeve + `E: TARAMA`
yazısı) — sessiz bir boş ekran hata raporu üretir.

### Doğrulama Araçları
| Araç | Ne yapar |
|---|---|
| `./dev.sh start\|stop\|status\|restart` | Portları temizleyip server'ı doğru şekilde başlatır |
| `start.bat` | Çift tıkla: temizlik + server + iki client'ı açar |
| `npm run genmap` | `game-client/starmap.json` üretir (seed'li, deterministik, 16384 yıldız) |
| `node backend/scripts/admin-peek.mjs` | Sunucudaki oyuncuların canlı pozisyon/durum listesi |
| `node backend/scripts/admin-inspect.mjs` | Tek oyuncunun tam durumu + son `mv` paketi yaşı (ağ teşhisi) |
| `npm run test-bat` | **BAŞLATMA SÖZLEŞMESİ (tarayıcısız, hızlı):** `start.bat` saf ASCII mi (Türkçe/UTF-8 karakter cmd'yi parse aşamasında öldürür), CRLF mi, blok parantezleri dengeli mi, `timeout /t` yerine `ping -n 2` mi — **5/5**; bozuk sürümü yakaladığı kanıtlandı |
| `npm run test-i18n` | **i18n SÖZLEŞMESİ (tarayıcısız, hızlı):** sunucudaki HER `sys` kodu EN ve TR sözlüğünde var mı + EN/TR anahtar paritesi + kaldırılan `refuel_none` geri gelmesin — **8/8** ("İngilizce oynarken ham Türkçe satır" sınıfını kapatır) |
| `npm run test-combat` | **M2/M3d uçtan uca:** kaya kırma + ganimet, cooldown, PvP, ölüm/kurtarma, **kalkan regen (saldırıdan sonra gecikmeli kendiliğinden dolum + gövdenin DOLMAMASI)**, tractor — **19/19** |
| `npm run test-fuel` | **M2b/M2e/M3c uçtan uca:** yakıt (mesafe/600), **M2i: doğuşta 5 WARP HUCRESI** (DOTERYUM doğuşta YOK), yıldız dibinde Y ile **sürekli yavaş dolum** — **M3c: MALZEME HARCAMAZ** (ambarda sıfır DOTERYUM ile dolum çalışır = regresyon), depo bitince itiş kapısı — **20/20** |
| `npm run test-craft-boost` | **M2h/M2i uçtan uca:** boost hız/yakıt oranı + zanaat + warp hücre kapıları. M2i: DOTERYUM **madencilikle** toplanır (kaya kır → kapsül topla → 3 DOTERYUM → WARPCELL → warp) — 19/19 |
| `npm run test-pirates` | **M2i KORSANLAR:** deterministik dağılım (sakin %65 / korsan %30 / istasyon %4), ana sistem güvenli, gemi doğumu→yaklaşma→**ateş**→ganimet, istasyon hasarı→yıkım→**takviye kesilmesi**, NPC-`by` çökme regresyonu — **32/32** |
| `npm run test-chat` | **M3 SOHBET:** 3 istemciyle 4 kanal yönlendirmesi (yerel/sektör/global/özel), DM + echo, olmayan çağrı işareti, **rate limit** (6 sn'de 4 mesaj), metin temizliği (120 kırpma + kontrol karakteri + `<b>`), bilinmeyen kanal, boş mesaj — **32/32** |
| `?m2h=2` görsel kontrolü | **M3b:** birleşik panelin sütunları/taşması ekran görüntüsüyle; tıklama yolları `selftest` ile (önizleme paneli tıklayamaz) |
| `npm run test-all` | Yedisini sırayla koşar (admin + warp + combat + fuel + craft-boost + pirates + chat) |
| `npm run test-craft-boost` | **M2h uçtan uca:** boost hız oranı (`kırpılan_boost / kırpılan_normal = BOOST_MUL`), boost'ta dolu depo ≈ 13500 birim (2× yakıt), tarifler/eşya adları `sn`'de, `craft_ok`/`craft_fail`/`craft_unknown`, `use_need`, warp hücresi tüketimi + `warp_nocell` |
| `node backend/scripts/test-debug-pvp.mjs` | PvP ışınının NEYE çarptığını gösterir (`shot.hk` teşhisi) |
| `?probe=1&selftest=1` | **M2g/M2h/M2i öz-testi:** dil düğmeleri / MUTE / kaydırıcı / MENU düğmesi + zanaat paneli / üretim isteği / tarama / kilit / **envanter çipine sentetik TIKLAMA** yolunu GERÇEK kodla çağırır (`SELFTEST[… tarama=1/8 kilit=rock/a7 nisan=hedefte envanter=1cip tik=REPAIRKIT]`) |
| `?m2h=1` | **M2h görsel test:** taramayı 0,9 sn'de bir tetikler (dalga ekranda kalsın diye menzili bir ekrana indirir) + en yakın kayaya kilitler. Ekran görüntüsüyle doğrulanır |
| `?m2h=2` | Aynı + **birleşik paneli** açar (ENVANTER + ZANAAT: sütun yerleşimi, dil/uzunluk, taşma doğrulaması) |
| `?probe=1` | Durum satırı; **başında `SURUM=`** (hangi istemci kodu çalışıyor) |
| `?refuel=1` | **Dolumu otomatik başlatır** (M3f): önizleme paneli canvas'a tuş gönderemiyor → "Y çalışmıyor" şikayeti ekrandan/`probe`'dan okunur hale gelir |
| `npm run test-anomaly` | **M4a anomali uçtan uca (23/23):** kendi sunucusunu `TEST_HOME_STAR=<anomali yıldızı>` ile açar — sinyal + kalıntı fazı. Sunucu otoriterliği (kod sızmaz), menzil kapıları, maskeli ipucu, ateşle yıkılmama, `ok=3/4` geri bildirimi, ipuçtan çözüm + ödül + odaya anons (2. istemciyle), tekrar çözüm reddi, kalıntı hp→yıkım→ganimet |
| `TEST_HOME_STAR=<id>` (sunucu env) | Doğuş sistemini sabitler (anomali testi deterministik bir sistem gerektirir). Üretimde etkisiz |
| `TEST_ANOM_NEAR=1` (sunucu env) | Doğuşu anomalinin 260 birim yanına taşır → önizleme panelinde anomali **görünür** (canvas'a tuş gönderilemez, uçmak imkânsız). Üretimde etkisiz |
| `?anom=1` / `?keyseq=<rakamlar>` | **M4a görsel test:** kutu açılır / GERÇEK `keydown` yolunu sentetik olaylarla sürer (rakamlar → `buf`, Enter → `solve_anom`). `?probe=1` ile `anomTus=` `kodGonderme=` `yanlisDeneme=` `hata=` okunur |
| `?probe=1&selftest=1` → `panel=` / `geo` alanları | **M3b teşhis:** `panel=1 envanter=2satir tarif=4satir`, `geo VW=… colW=… ad=… maliyet=… dipnot=…` (metin genişlikleri ölçülür → taşma matematikle görülür), `esya_satiri=… tik=REPAIRKIT`, `kapali_kutu=0` |
| `?m2h=3` | **HATA YENİDEN ÜRETME:** kayaya kilitlen, ona doğru uç, menzile girince ATEŞ et → kaya patlar, kapsül doğar. "Kilitli hedefi patlatınca donma" hatası bu kancayla yakalandı; `hata=` + `tk/son` sayaçlarıyla doğrulanır |
| `?chat=1&ch=<g\|s\|l\|p>` | **M3 görsel test:** sohbet giriş kutusu kanal rozetiyle açılır + 4 örnek kanal mesajı log'a basılır (ekran görüntüsü doğrulaması). Önizleme paneli YAZABİLDİĞİ için gerçek klavye turu da denenebilir (kutuya yaz → Enter → log'da kendi kanal etiketin görünür) |
| `?warp=<starId>` | **M2i:** tek seferlik warp (korsan sistemine gitmek için). Örn. `?warp=7071` = korsan İSTASYONU olan komşu yıldız |
| `?hunt=1` | **M2i:** en yakın KORSANA (yoksa istasyona) kilitlen, peşine düş, menzilde ATEŞ et. `&peace=1` eklenirse İSTASYONU hedefler ve **ateş ETMEZ** → istasyon sprite'ının ekran görüntüsü alınabilir |
| `hata=<mesaj> @<stack>` | Probe artık hatanın İLK STACK KARESİNİ yazar (hangi fonksiyon/satır). `tk` (kare başı) ile `son` (kare sonu) ayrı sayılır: `tk` artıp `son` duruyorsa ticker ORTASINDA throw var = oyun donar |
| `cap.ps1 -Match 'Opera' -Out x.png` | Occluded tarayıcı penceresini PrintWindow ile yakalar |

**Geliştirme:** istemci `http://localhost:8081/` adresinden de açılır (sunucu `game-client/`'ı
statik servis eder) — test kancaları (`?probe=1&demo=1`, `?probe=1&map=1`) yalnız böyle çalışır.

`?demo=1` URL parametresi: **ilk 5 sn yıldıza yaklaşır** (z-sırası: gemi yıldızın üstünde görünür),
sonra en yakın kayaya yönelip **nişan kilitli** kazar (attract mode / otomatik madencilik + fare
nişanı doğrulaması). `?map=1`: haritayı açıp PAN'ı ileri-geri sürer (view değişir, own sabit).
`?probe=1`: durumu DOM'a yazar (`view`, `own`, `sec`, `yakit`, `ses`, `dil`, `vol`, `menu`, `hata`...).
Parametresiz üretimde üçü de etkisizdir.

**M2g ayar/menü kancaları** (otomasyon önizleme panelinden fare/klavye gönderemediği için):
`?menu=1` menüyü 1,5 sn sonra açar / 12 sn sonra kapatır; `?lang=en|tr` ve `?vol=0..100` dil ve ses
seviyesini URL'den kurar (menüye tıklamanın yaptığı işin AYNISI); `?probe=1&selftest=1` menünün
tıklama yolunu öz-test eder. Hepsi yalnız `http://localhost:8081/` üzerinden çalışır.
**Not:** Hermes preview paneli yerel dosya yoluna `?`/`#` eklenince sayfayı bulamıyor → kancaları
`http://localhost:8081/` üzerinden (sunucunun statik servisi) çalıştır.