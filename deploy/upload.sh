#!/usr/bin/env bash
# =============================================================================
# AstroVector — YEREL MAKİNEDEN SUNUCUYA YÜKLEME + BAŞLATMA (tek komut)
# =============================================================================
# AI'A NOT: Windows/MSYS'te rsync genelde YOKTUR ve scp'nin hariç tutma özelliği yoktur.
# Bu yüzden: yerelde tar (node_modules/.env HARİÇ) → scp → sunucuda aç → bootstrap → compose up.
# `.env` ve `.env.production` ASLA yüklenmez (sırlar sunucuda kalır).
#
# KULLANIM:
#   bash deploy/upload.sh <SUNUCU_IP> <SSH_ANAHTAR_YOLU> [kullanici]
#   ör: bash deploy/upload.sh 130.61.10.20 "C:/Users/PC/.ssh/astrovector.key"
set -euo pipefail

HOST="${1:?kullanim: upload.sh <SUNUCU_IP> <SSH_ANAHTAR_YOLU> [kullanici]}"
KEY="${2:?SSH anahtar yolu gerekli}"
USER_SSH="${3:-ubuntu}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="${TMPDIR:-/tmp}/astrovector-deploy.tgz"

echo "== 1/4 paketleniyor (node_modules/.env HARİÇ) =="
tar -czf "$TARBALL" -C "$ROOT" \
  --exclude=node_modules --exclude=.env --exclude=.env.production --exclude=.git \
  --exclude=data --exclude='*.log' \
  backend game-client deploy package.json package-lock.json MIMARI_VE_GOREVLER.md .dockerignore .gitignore
ls -lh "$TARBALL"

echo "== 2/4 sunucuya kopyalanıyor ($USER_SSH@$HOST) =="
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$TARBALL" "$USER_SSH@$HOST:/tmp/"

echo "== 3/4 açılıyor + kurulum (bootstrap.sh) =="
ssh -i "$KEY" "$USER_SSH@$HOST" bash -s <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/astrovector
sudo tar xzf /tmp/astrovector-deploy.tgz -C /opt/astrovector --overwrite
sudo chown -R "$USER:" /opt/astrovector
bash /opt/astrovector/deploy/bootstrap.sh
REMOTE

echo "== 4/4 servis başlatılıyor =="
ssh -i "$KEY" "$USER_SSH@$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/astrovector
sudo docker compose -f deploy/docker-compose.yml up -d --build
sleep 6
echo "--- sunucu konsolu ---"
sudo docker compose -f deploy/docker-compose.yml logs --tail=8 game
echo "--- dinleme adresleri (8090 YALNIZ 127.0.0.1 olmalı) ---"
sudo ss -ltnp | grep -E ':(80|443|8081|8090)' || true
echo "--- yerel sağlık kontrolü ---"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1/ || true
REMOTE

echo
echo "== BİTTİ =="
echo "Oyun:  http://$HOST/"
echo "Admin: kendi makinenden  ssh -i \"$KEY\" -L 8090:127.0.0.1:8090 $USER_SSH@$HOST"
echo "       sonra tarayıcıda http://localhost:8090 (admin-client/index.html)"
