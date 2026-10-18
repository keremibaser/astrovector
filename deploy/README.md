# AstroVector — Yayın (deploy) kılavuzu

Tek bir Node süreci hem **WebSocket oyun sunucusunu** hem **statik oyun istemcisini** aynı
origin'den servis eder; önünde **Caddy** TLS'i (`wss://`) sonlandırır. Ayrı host'a (Pages/CDN) gerek
yok — tek origin olduğu için CORS ve `mixed content` sorunları hiç oluşmaz.

```
oyuncu tarayıcısı ──https/wss──> Caddy (80/443, TLS) ──> game:8081 (node)
                                                           └─ statik game-client/ + /starmap.json

yönetici ──ssh -L 8090 ──> 127.0.0.1:8090 (admin ws, DIŞARI KAPALI)
```

## GÜVENLİK SÖZLEŞMESİ (kod düzeyinde zorlanıyor)

| Kural | Nasıl zorlanıyor |
|---|---|
| `admin-client` asla web'e deploy edilmez | İmaja/`.dockerignore`a **girmiyor**; `deploy/Dockerfile` yalnız `backend/` + `game-client/` kopyalar |
| Admin portu internete açılmaz | `ADMIN_BIND=127.0.0.1` (varsayılan) + bağlantı anında **loopback kontrolü** (`server.js`, red: `4003`) |
| `ADMIN_SECRET_KEY` repoya/imaja girmez | `.gitignore` + `.dockerignore`; üretimde `.env.production` (repoda yok) |
| Yönetici erişimi | SSH tüneli: `ssh -L 8090:127.0.0.1:8090 kullanici@sunucu` → tarayıcı `http://localhost:8090` |

Doğrulama (sunucuda): `netstat -ano | grep 8090` → **`127.0.0.1:8090`** görmelisin.
`0.0.0.0:8090` görüyorsan bu bir yapılandırma hatasıdır, hemen kapat.

## 1) Yerel çalıştırma (Windows)

```bash
start.bat            # portları temizler, sunucuyu açar; konsolda (SURUM ...) yazmalı
# oyun:  http://localhost:8081/     admin: http://localhost:8090/  (yalnız bu makinede)
```

## 2) Docker ile çalıştırma (her makinede aynı sonuç)

```bash
cp deploy/.env.production.example .env.production
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → ADMIN_SECRET_KEY
# .env.production içine yaz (bu dosyayı ASLA commit etme)

SITE_ADDRESS=:80 docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f game      # (SURUM ...) satırını gör
```

Domain gösterilmişse: `SITE_ADDRESS=oyun.example.com` → Caddy sertifikayı otomatik alır, istemci
otomatik olarak `wss://` kullanır (kod değişmez; adres `location.host`'tan türer).

## 3) VPS (ör. Oracle Cloud Always Free — Ampere A1, $0)

1. **VM oluştur**: Ubuntu 22.04+ / Ampere A1 (ARM) veya AMD mikro. Genel IP ata.
2. **Güvenlik listesi (NSG/Security List)**: yalnız **80** ve **443** açık olsun. **8090 ASLA
   açılmaz.** SSH (22) senin IP'ne kısıtlı olsun.
3. **Sunucuda**:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
   sudo usermod -aG docker $USER && newgrp docker
   sudo mkdir -p /opt/astrovector && sudo chown $USER: /opt/astrovector
   ```
4. **Kodu kopyala** (bu makineden): `rsync -av --exclude node_modules --exclude .env \
   "D:/tool projects/AstroVector/" kullanici@SUNUCU:/opt/astrovector/`
   (veya `git push` + sunucuda `git clone` — repo başlatmak için aşağıya bak).
5. `.env.production`'ı sunucuda oluştur (anahtar orada üretilsin; ajan bu değeri okumaz).
6. `docker compose up -d --build` → `http://SUNUCU_IP/` açılıyor mu? Domain varsa DNS A kaydını
   gösterip `SITE_ADDRESS`'i domain yap → otomatik HTTPS/wss.
7. **Admin**: `ssh -L 8090:127.0.0.1:8090 kullanici@SUNUCU` (kendi makinenden) → tarayıcı
   `http://localhost:8090` → admin-client'ı **yerelden** aç (`admin-client/index.html` dosyasını
   tarayıcıda açmak da olur, tünel üzerinden 8090'a bağlanır).

Docker istemiyorsan: `deploy/astrovector.service` (systemd) + Caddy'yi sistem paketi olarak kur;
birim dosyasındaki yorumlar adımları içeriyor.

## 4) Yayın sonrası kontrol listesi (iddia değil ölçüm)

```bash
curl -s http://SUNUCU/ | grep -c ANOM_PAL        # istemci gerçekten servis ediliyor mu
curl -sI https://oyun.example.com/ | head -3     # 200 + güvenlik başlıkları
ss -ltnp | grep -E ':(8081|8090)'                # 8081 her yerde olabilir; 8090 YALNIZ 127.0.0.1
```
Tarayıcıda: `https://.../?probe=1` → `SURUM=...` + `hata=yok`; sunucu konsolundaki `(SURUM ...)`
ile **aynı** olmalı (farklıysa eski süreç çalışıyor → bkz. Tuzak 58).

## 5) Sık karşılaşılan sorunlar

| Belirti | Neden / çözüm |
|---|---|
| `WebSocket connection failed` / konsolda mixed content uyarısı | Sayfa HTTPS ama adres `ws://` → istemci artık `location.host`'tan türetiyor; eski sürümü önbellekten çekiyorsan Ctrl+F5 |
| Uzaktan hiç bağlanmıyor | NSG/Security List'te 80/443 kapalı, ya da `GAME_BIND` yanlış |
| `EADDRINUSE` | Eski süreç portu tutuyor → `docker compose restart game` / `start.bat` |
| Admin paneli "bağlanamadı" diyor | Tünel açık mı? (`ssh -L 8090:...`) — uzaktan doğrudan erişim **bilinçli olarak** kapalı |
| SUNUCU ile istemci SURUM farklı | Eski süreç ayakta ya da tarayıcı eski HTML'i tutuyor |

## 6) Sürüm kontrolü (önerilir)

Proje şu an **git deposu değil**. `git init` + ilk commit, hem yedeği hem "hangi kod yayında"
sorusunun cevabını verir. `.env` ve `.env.production` `.gitignore` kapsamındadır — commit'e
girmediklerini `git status --short` ile **doğrula**.
