# AI'A NOT: AstroVector üretim imajı. Tek servis yeterli: oyun sunucusu hem WebSocket'i hem
# statik istemciyi (game-client/) AYNI origin'den servis eder → CORS yok, `wss://` doğrudan
# çalışır (istemci adresi `location.host`'tan türetiliyor: game-client/index.html → deriveWsUrl).
#
# DİKKAT (GÜVENLİK SÖZLEŞMESİ): `admin-client/` imaja KOPYALANMAZ ve admin portu (8090)
# publish EDİLMEZ. Kullanıcı kuralı: "admin-client ASLA bir web servisine deploy edilmez,
# sadece bu makinede açılır." Sunucu da ADMIN_BIND=127.0.0.1 ile bu kuralı kod düzeyinde zorlar.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Önce yalnız manifest → katman önbelleği (bağımlılık değişmedikçe npm ci tekrar koşmaz).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Yalnız ÇALIŞMA ZAMANI dosyaları
COPY --chown=node:node backend ./backend
COPY --chown=node:node game-client ./game-client

# ADMIN_BIND varsayılanı zaten 127.0.0.1; burada niyeti açıkça yazıyoruz.
ENV PORT_GAME=8081 \
    PORT_ADMIN=8090 \
    GAME_BIND=0.0.0.0 \
    ADMIN_BIND=127.0.0.1

EXPOSE 8081
USER node

# Sağlık: sunucu `/` üzerinde düz metin "ok" yanıtı verir (statik dosya bulunamazsa).
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT_GAME}/ >/dev/null 2>&1 || exit 1

CMD ["node", "backend/server.js"]
