# =============================================================================
# AstroVector — ÜRETİM İMAJI (platformlar bu dosyayı kökte arar)
# =============================================================================
# AI'A NOT: Bu dosya TEK GERÇEK kaynak. `deploy/Dockerfile` bilerek yalnız buraya işaret eder
# (drift olmasın). Tek servis yeterli: sunucu hem WebSocket'i hem statik istemciyi
# (game-client/) AYNI origin'den servis eder → CORS yok, `wss://` doğrudan çalışır
# (istemci adresini `location.host`'tan türetir: game-client/index.html → deriveWsUrl).
#
# PORT KURALI (platform uyumu — KRİTİK):
#   Bulut platformları (Back4App, Render, Cloud Run...) `$PORT` env'i VERİR ve trafiği O porta
#   yönlendirir. Bu yüzden burada `PORT_GAME` ENV'i SABİTLENMEZ. Sunucu `PORT_GAME || PORT ||
#   8081` sırasını izler (backend/server.js) → platform ne verirse ona uyar.
#   (Yerel docker-compose senaryosu PORT_GAME'i kendi env'inde açıkça verir.)
#
# GÜVENLİK SÖZLEŞMESİ: `admin-client/` imaja KOPYALANMAZ, admin portu (8090) yayınlanmaz ve
# admin yuvası 127.0.0.1'e bağlanır. Kullanıcı kuralı: "admin-client ASLA bir web servisine
# deploy edilmez, sadece bu makinede açılır." Sunucu bunu ADMIN_BIND ile kod düzeyinde zorlar.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Önce yalnız manifest → katman önbelleği (bağımlılık değişmedikçe npm ci tekrar koşmaz).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Yalnız ÇALIŞMA ZAMANI dosyaları (admin-client/ BİLEREK yok)
COPY --chown=node:node backend ./backend
COPY --chown=node:node game-client ./game-client

# ADMIN_BIND varsayılanı zaten 127.0.0.1; niyeti burada açıkça yazıyoruz.
# PORT_GAME BİLEREK YOK → platformun $PORT'unu kullanır (yukarıdaki PORT KURALI).
ENV GAME_BIND=0.0.0.0 \
    ADMIN_BIND=127.0.0.1 \
    PORT_ADMIN=8090

EXPOSE 8081
USER node

# Sağlık: sunucu `/` üzerinde düz metin "ok" yanıtı verir (statik dosya bulunamazsa).
# PORT_GAME → PORT → 8081 sırası burada da izlenir, aksi hâlde platform $PORT verirken
# healthcheck yanlış porta vurup container'ı "unhealthy" gösterirdi.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT_GAME:-${PORT:-8081}}/" >/dev/null 2>&1 || exit 1

CMD ["node", "backend/server.js"]
