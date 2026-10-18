#!/usr/bin/env bash
# =============================================================================
# AstroVector — SUNUCU KURULUMU (Ubuntu 22.04/24.04, Oracle Always Free VM)
# =============================================================================
# AI'A NOT: Bu script TAZE bir Ubuntu VM'de bir kez koşar (tekrar koşmak güvenli, idempotent).
# Ne yapar: yerel güvenlik duvarı → Docker → uygulama dizini → .env.production (anahtarı ÜRETİR,
# EKRANA YAZMAZ) → doğrulama. Kodun /opt/astrovector'a kopyalanmış olması beklenir
# (yerel makineden `deploy/upload.sh` bunu yapar).
#
# İKİ KATMANLI FİREWALL UYARISI (Oracle'ın en sık takılan noktası):
#   1) BULUT tarafı: Security List / NSG içinde TCP 80 ve 443 giriş kuralları EKLENMELİ.
#      Bu script onu YAPAMAZ (konsoldan yapılır). 8090 ASLA açılmaz.
#   2) VM tarafı: Oracle'ın Ubuntu imajı iptables ile SSH dışını reddeder → aşağıda açılır.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/astrovector}"
echo "== AstroVector kurulumu: $APP_DIR =="

if [ ! -f "$APP_DIR/backend/server.js" ]; then
  echo "HATA: $APP_DIR/backend/server.js yok — önce kodu yükle (yerelde: deploy/upload.sh)" >&2
  exit 1
fi

echo "-- 1/5 yerel güvenlik duvarı (80/443)"
if command -v iptables >/dev/null; then
  sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
  sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null; then
    sudo netfilter-persistent save >/dev/null 2>&1 || true
    echo "   kurallar kalici hale getirildi"
  else
    echo "   NOT: netfilter-persistent yok → kurallar yeniden baslatmada sifirlanabilir."
    echo "        Kalici yapmak icin: sudo apt-get install -y iptables-persistent"
  fi
fi

echo "-- 2/5 Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "   Docker kuruldu. Grup üyeliği için bu oturumda 'sudo docker' gerekebilir."
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose version >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y docker-compose-v2; }

echo "-- 3/5 uygulama dizini"
sudo mkdir -p "$APP_DIR"
sudo chown "$USER:" "$APP_DIR"

echo "-- 4/5 üretim ortam dosyası (.env.production)"
# AI'A NOT: ADMIN_SECRET_KEY burada ÜRETİLİR ve EKRANA YAZILMAZ (kullanıcı sözleşmesi: gerçek
# anahtar ajan tarafından okunamaz). Dosyayı yalnız sahibi okuyabilir (umask 077).
# Kullanıcı isterse sonradan `cat` ile kendisi görebilir; yönetici paneli bu anahtarı ister.
if [ ! -f "$APP_DIR/.env.production" ]; then
  ( umask 077; {
      echo "ADMIN_SECRET_KEY=$(openssl rand -hex 32)"
      echo "PORT_GAME=8081"
      echo "PORT_ADMIN=8090"
      echo "ADMIN_BIND=127.0.0.1"
      echo "GAME_BIND=0.0.0.0"
    } > "$APP_DIR/.env.production" )
  echo "   .env.production olusturuldu (ADMIN_SECRET_KEY rastgele uretildi, ekrana yazilmadi)"
else
  echo "   .env.production zaten var — DOKUNULMADI"
fi

echo "-- 5/5 Caddy adresi (domain YOK → yalniz http/ws)"
# Domain alınınca: echo "SITE_ADDRESS=oyun.example.com" > deploy/.env  (Caddy TLS'i otomatik alır)
if [ ! -f "$APP_DIR/deploy/.env" ]; then
  echo "SITE_ADDRESS=:80" > "$APP_DIR/deploy/.env"
  echo "   SITE_ADDRESS=:80 yazildi (domain eklenince burasi degistirilir)"
fi

echo
echo "== Kurulum tamam. Servisi başlatmak için: =="
echo "   cd $APP_DIR && $DOCKER compose -f deploy/docker-compose.yml up -d --build"
echo "   $DOCKER compose -f deploy/docker-compose.yml logs -f game     # (SURUM ...) satirini gör"
