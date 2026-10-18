# AstroVector

A 2D **old-school pixel-art** space exploration / trading game with a mysterious-space atmosphere.
Server-authoritative multiplayer over raw WebSockets.

- **Server:** Node.js + [`ws`](https://github.com/websockets/ws) — one process serves both the
  WebSocket game loop and the static client, so everything lives on **one origin** (no CORS, no
  mixed content; the client derives its socket URL from `location.host`).
- **Client:** PixiJS v8, rendered inside a single `game-client/index.html`.
- **Art:** hand-drawn 5×7 bitmap font and sprite matrices (no `PIXI.Text`, no font files).
- **Sound:** fully synthesised with WebAudio — zero audio assets.

## Run locally

```bash
npm install
node backend/server.js          # game: ws://localhost:8081
```

Windows, one click: **`start.bat`** (kills stale listeners, starts the server, opens the browser).

## Tests

```bash
npm run test-all                # 11 suites in series (each starts its own server)
WS_URL=wss://host npm run smoke # real WebSocket round-trip against a running (or live) server
```

Covers the bitmap-font launcher, i18n key parity, admin God Mode, milestone-4 rooms, anomaly
gameplay, warp range, combat, fuel, crafting boost, pirates and chat.
`npm run smoke` is the deployment check: it opens an actual WebSocket, waits for the first `sn`
snapshot and asserts the server-authoritative fields (`jumpRange`, `recipes`, `items`) really
arrived — "the image built" is not the same claim as "the game is playable".

## Deploy

The image is built from the **root `Dockerfile`** (cloud platforms look for it there).
It is deliberately **`$PORT`-aware**: platforms that inject `PORT` are honoured automatically
(`PORT_GAME || PORT || 8081`); otherwise the app listens on 8081.

`deploy/` holds the self-hosted path: `docker-compose.yml` (app + Caddy for automatic TLS/`wss://`),
`Caddyfile`, `astrovector.service` (systemd) and `bootstrap.sh` / `upload.sh` (fresh-VM setup and
upload). See `deploy/README.md`.

## Security contract

- **`admin-client/` is never deployed to a web service.** It only opens on the operator's own
  machine. The admin socket binds `127.0.0.1` **and** rejects non-loopback peers at connection
  time (`4003`), so no single misconfigured environment variable can expose it.
- `admin-client/` is excluded from the image and from `.dockerignore` on purpose.
- Secrets are read from `.env` / `.env.production` at runtime and are **never** committed.
- If `ADMIN_SECRET_KEY` is absent (a PaaS container ships no `.env`), the server **does not crash**:
  it logs a loud warning and **never opens the admin socket at all** — no port, nothing to
  authenticate against, which is strictly safer than running with a blank key.

## Layout

```
backend/        server.js + src/ (galaxy, rooms, protocol, pirates, telemetry, eventbus)
game-client/    index.html (PixiJS client, i18n TR/EN)
admin-client/   local-only operator panel
deploy/         Docker Compose + Caddy + systemd + bootstrap/upload scripts
MIMARI_VE_GOREVLER.md   architecture + roadmap + trap log (single source of truth, Turkish)
```
