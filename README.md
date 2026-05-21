# SkypeRTC

Self-hosted P2P video calls — Go signaling server + vanilla ESM frontend. No database, no SFU. Mesh WebRTC with adaptive bitrate, modern codecs, background blur, and a clean light/dark UI.

**Live demo:** https://meet.zhandos.top

## Features

### Calls
- Multi-party mesh (2–6 users comfortably)
- AV1 / VP9 / H.264 with CPU- and platform-aware codec selection
- Opus with FEC, DTX, and a music mode (stereo, 128 kbps, no AEC/NS/AGC)
- Adaptive bitrate (6 tiers, low → ultra) — reacts to RTT, packet loss, BWE, and `qualityLimitationReason`
- Up to 1080p @ 60 fps capture, `degradationPreference=maintain-framerate` on HD+
- `contentHint=motion` for camera, `detail` for screen share
- Bandwidth probing on a clean link
- Dynamic `playoutDelayHint` (0–200 ms based on RTT)
- Per-tile network quality dot (good / fair / bad)
- Screen sharing via `getDisplayMedia` + `replaceTrack` (no renegotiation)
- Per-tile and Document Picture-in-Picture
- Background blur and background-image replacement (MediaPipe selfie segmenter, GPU)
- Adaptive grid: solo / pair / 2×2 / spotlight with active-speaker focus
- Reactions over DataChannel (P2P) with WS fallback
- Group text chat

### Rooms & signaling
- Public room listing + private rooms via URL-hash secret
- Shareable links: `https://host/#room` or `https://host/#room:secret`
- WebSocket signaling with ping/pong keep-alive (25 s)
- IP-based connection rate limiting
- Auto-reconnect with exponential backoff and ICE restart
- ICE config served from env via `/config.json`

### Security
- Origin check (`ALLOWED_ORIGINS` env)
- CSP and Permissions-Policy meta tags
- Sanitized chat rendering
- TLS termination via env or upstream proxy

### UX
- Light + dark theme (auto by `prefers-color-scheme`, manual override in menu)
- Power-user settings tucked under a three-dot menu
- Toasts instead of `alert()`
- Service Worker caches MediaPipe assets — blur loads instantly after first use
- Visibility-pause: tab in background → camera frame paused

## Quick start

```bash
git clone https://github.com/zhandos717/skypertc.git
cd skypertc
make run           # http://localhost:8080
```

Or directly:
```bash
go run ./cmd/server
```

## Make targets

| Target | Purpose |
|---|---|
| `make run` / `make dev` | Run locally on port 8080 |
| `make build` | Native binary in `bin/` |
| `make build-linux` | Cross-compile linux/amd64 |
| `make deploy` | build-linux → rsync → restart → healthcheck |
| `make deploy-static` | Sync only `static/` (no rebuild) |
| `make logs` | `journalctl -f` on the VPS |
| `make fmt` / `vet` / `test` / `check` | Standard Go workflow |

## Configuration

All via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `` | Bind address |
| `PORT` | `8080` | HTTP port |
| `STATIC_DIR` | `./static` | Static files dir |
| `TLS_CERT`, `TLS_KEY` | `` | Enable HTTPS |
| `STUN_URLS` | Google STUN | Comma-separated STUN URLs |
| `TURN_URLS` | `` | Comma-separated TURN URLs |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | `` | TURN credentials |
| `ALLOWED_ORIGINS` | `` (allow all) | Comma-separated allowed Origins for WS |

## Deploy

### systemd unit

```ini
[Service]
ExecStart=/opt/skypertc/webrtc-srv
WorkingDirectory=/opt/skypertc
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=STATIC_DIR=/opt/skypertc/static
Environment=ALLOWED_ORIGINS=https://meet.example.com
Environment=STUN_URLS=stun:turn.example.com:3478,stun:stun.l.google.com:19302
Environment=TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
Environment=TURN_USERNAME=skypertc
Environment=TURN_CREDENTIAL=...
Restart=always
LimitNOFILE=65535
```

### nginx vhost

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

### CI/CD

`.github/workflows/deploy.yml` ships on push to `main`:
1. Builds `linux/amd64` binary.
2. Rsyncs binary + `static/` to VPS as a dedicated `deploy` user.
3. Restarts the service via `sudo systemctl restart skypertc` (sudoers limited to this single command).
4. Polls `/healthz`.

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_HOST`, `SSH_USER`.

## Architecture

```
Browser ─┐                                ┌─ Browser
         ├─ WSS /ws ─► Go signaling ◄─────┤
         │             (offer/answer/ICE) │
         └────── direct WebRTC P2P ───────┘
                        (or via coturn TURN relay)
```

The server only routes signaling between peers in the same room. **All media is P2P** — server never sees video/audio (relayed through coturn if NAT requires it).

### Layout

```
cmd/server/         Entry point
internal/
  config/           Env-driven configuration
  hub/              Room and client state
  signal/           WebSocket signaling handler
  randutil/         ID generation
  ratelimit/        IP-based connection limiting
static/
  modules/          ESM frontend modules (state, peer, media, abr, ui, …)
  app.js            Bootstrap
  index.html        SPA shell
  style.css         Design tokens + components
  sw.js             Service Worker (MediaPipe caching)
```

## Limits

- Mesh topology — bandwidth scales as O(N) per user, ~6 users is practical max. For larger groups add an SFU ([pion/ion-sfu](https://github.com/pion/ion-sfu), [LiveKit](https://livekit.io)).
- "Private" rooms rely on a URL-hash secret. Anyone with the link can join.
- iOS Safari has restricted `getDisplayMedia` and Picture-in-Picture support.
- Document Picture-in-Picture requires Chromium 116+.

## License

MIT — see [LICENSE](LICENSE).
