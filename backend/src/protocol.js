// AI'A NOT: protocol.js — WS mesaj tiplerinin TEK KAYNAĞI.
// Client (game + admin) ve server aynı sabitleri kullanmalı. Burada tek yerde tutulur;
// değişiklik olursa hem backend hem iki client güncellenir (bkz. MIMARI_VE_GOREVLER.md §Veri Yapıları).
//
// PAKET FORMATI KURALI: { "t": "<tip>", ... } — tek harf tip key'i + kısa alan adları.
// Neden: JSON.stringify'da key isimleri HER pakette tekrarlanır. 10K oyuncu x 10Hz'te
// "type" → "t" dönüşümü bile saniyede yüz binlerce byte bandwith tasarrufu demektir.

// --- Oyuncu -> Sunucu (C→S) --------------------------------------------
export const MSG = {
  MV: 'mv',       // {t:'mv', x, y, r, boost}      pozisyon/yön önizleme + Shift boost bayrağı
  ST: 'st',       // {t:'st', tid, kind}            hedef seç
  FIRE: 'fire',   // {t:'fire', tid}                silah ateşle
  TB: 'tb',       // {t:'tb', tid}                  tractor beam başlat/durdur
  WARP: 'warp',   // {t:'warp', sysId, beltId}      warp isteği (1 WARP HUCRESI harcar)
  REFUEL: 'refuel', // {t:'refuel'}                 yıldız dibinde sürekli dolum (Y)
  CRAFT: 'craft', // {t:'craft', id:'WARPCELL'}    zanaat: malzemeden eşya üret
  USE: 'use',     // {t:'use', id:'REPAIRKIT'}     üretilen eşyayı kullan
  CHAT: 'chat',   // {t:'chat', ch:'g|s|l|p', m, to} 4 kanallı sohbet
  HB: 'hb',       // {t:'hb'}                       heartbeat (dead socket temizliği)
  SOLVE_ANOM: 'solve_anom', // {t:'solve_anom', id, code}  anomali frekans/sinyal çözme
  SCAN_ANOM: 'scan_anom',   // {t:'scan_anom'}             E taraması: anomali ipucu (M4a)
};

// --- Sunucu -> Oyuncu (S→C) --------------------------------------------
export const SERVER_MSG = {
  SNAPSHOT: 'sn', // {t:'sn', roomId, x, y, entities:[]}  room'a girişte büyük paket
  DIFF: 'du',     // {t:'du', d:[[id,dx,dy,dr,flags],...]} kompakt diff (10Hz)
  EVENT: 'ev',    // {t:'ev', kind, data}                  shieldHit, asteroidBreak...
  CHAT: 'chat',   // {t:'chat', ch, from, m}
  SYS: 'sys',     // {t:'sys', code, msg}                  hata/bilgi
};

// --- Admin namespace ("adm:*") — OYUNCU MESAJLARINDAN AYRI İZOLASYON ----
// AI'A NOT: Admin mesajları yalnız ADMIN_WS'te (port 8090) kabul edilir; public ws'te
// "adm:" öneki gelen paketler sessizce düşürülür → dışarıdan tanrı moduna sızma yolu yok.
export const ADMIN_MSG = {
  AUTH: 'adm:auth',        // {t:'adm:auth', key}        ADMIN_SECRET_KEY handshake
  AUTH_OK: 'adm:auth_ok',  // {t:'adm:auth_ok', stats}
  INSPECT: 'adm:inspect',  // {t:'adm:inspect', kind, id}
  SNAPSHOT: 'adm:snap',    // {t:'adm:snap', snapshot, recent}
  STREAM: 'adm:stream',    // {t:'adm:stream', events[]} canlı akış (250ms throttle)
  UNINSPECT: 'adm:uninspect',
  UNINSPECTED: 'adm:uninspected',
  COMMAND: 'adm:command',  // {t:'adm:command', op, args}
  COMMAND_RES: 'adm:command_res', // {t:'adm:command_res', op, ok, ...}
  GALAXY: 'adm:galaxy',    // {t:'adm:galaxy', overview} galaksi genel bakişi
  PLAYERS: 'adm:players',  // {t:'adm:players', players[]} oyuncu listesi (list_players komutuna yanıt)
  ROOMS: 'adm:rooms',      // {t:'adm:rooms', rooms[]} TÜM odalar (kimlik, yıldız, kaya/oyuncu sayısı)
  ROOM: 'adm:room',        // {t:'adm:room', room, rocks[], players[]} tek odanın tam dökümü
  TICK: 'adm:tick',        // {t:'adm:tick', stats}      server özet raporu
  ERROR: 'adm:error',      // {t:'adm:error', code}
};

// --- Diff flags (kompakt kodlar) ----------------------------------------
// AI'A NOT: flags string'i 1-2 harf; genişletmek kolay ve JSON'da ucuz.
export const FLAGS = {
  NONE: '',
  DIED: 'X',
  DAMAGE: 'hp-',        // + sayı eklenir, örn 'hp-12'
  SHIELD_DOWN: 'sh',
  BEAM_ON: 'tb',
};