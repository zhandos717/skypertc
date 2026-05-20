# SkypeRTC

Self-hosted P2P video calls in a Skype-style UI. Single Go binary + static frontend, no database, no SFU. Mesh WebRTC topology with adaptive bitrate, screen sharing, group chat, and public/private rooms.

Live demo: **https://meet.zhandos.top**

## Features

- Multi-party video calls (mesh, 2–6 users comfortably)
- Skype-inspired dark UI
- Adaptive bitrate (AIMD) — auto-adjusts resolution, FPS, and bitrate based on RTT and packet loss
- Screen sharing (`getDisplayMedia` + `replaceTrack`, no renegotiation)
- Group text chat
- Public room listing + private rooms with secret token in URL hash
- Shareable links (`https://host/#room` or `https://host/#room:secret`)
- WebSocket signaling with room-based routing
- ICE config (STUN/TURN) served from env via `/config.json`
- TLS termination support via env (`TLS_CERT`, `TLS_KEY`) or upstream proxy

## Quick start

```bash
git clone https://github.com/zhandos717/skypertc.git
cd skypertc
go run .
# open http://localhost:8080
```

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `` | bind address |
| `PORT` | `8080` | HTTP port |
| `STATIC_DIR` | `./static` | static files dir |
| `TLS_CERT`, `TLS_KEY` | `` | enable HTTPS |
| `STUN_URLS` | Google STUN | comma-separated STUN URLs |
| `TURN_URLS` | `` | comma-separated TURN URLs |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | `` | TURN credentials |

## Deploy

Behind nginx + Let's Encrypt + coturn. Example unit:

```ini
[Service]
ExecStart=/opt/skypertc/webrtc-srv
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
Environment=TURN_USERNAME=skypertc
Environment=TURN_CREDENTIAL=...
```

Nginx vhost needs WebSocket upgrade:

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

## Architecture

```
Browser ─┐                                ┌─ Browser
         ├─ WSS /ws ─► Go signaling ◄─────┤
         │             (offer/answer/ICE) │
         └────── direct WebRTC P2P ───────┘
                        (or via coturn TURN relay)
```

Server only routes signaling messages between peers in the same room. **All media is P2P** — server doesn't see video/audio traffic (unless TURN-relayed, in which case coturn handles it separately).

## Limits

- Mesh topology — bandwidth scales as O(N) per user, ~6 users is practical max. For larger groups add an SFU (e.g. [pion/ion-sfu](https://github.com/pion/ion-sfu) or LiveKit).
- Privacy of "private" rooms relies on URL secret. Anyone with the link can join. No persistent auth.
- iOS Safari doesn't support `getDisplayMedia` (screen share button no-ops there).

## License

MIT — see [LICENSE](LICENSE).
