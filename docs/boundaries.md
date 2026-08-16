# Boundaries

Explicit constraints — do not violate without a direct user decision to change them.

## Do not introduce

- **No third-party game-networking vendor**: no Photon, no Unity Gaming Services (Lobby/Relay), no PlayFab. Per-CCU pricing and third-party outage risk are exactly what this stack avoids. If a task seems to need one, it doesn't — reach for Colyseus room/server features instead.
- **No client-authoritative state** for anything that matters (moves, scores, win conditions). Server validates and applies; clients send input events only.
- **No WebRTC/raw UDP.** Unity WebGL builds cannot use raw sockets — WebSockets are the only transport, and are sufficient for Dakon and Egrang.
- **No recurring cost added casually.** A single VPS plus the `fajrsyauqi.com` domain registration is the accepted recurring cost baseline (~$5–15/mo); TLS is Let's Encrypt, so it adds nothing. No separate static host is needed — the client is served from the same box. Don't add other paid SaaS dependencies without flagging it.

## Scope of this repo

Backend only — Colyseus server, room logic, state schemas, tests, load tests. The Unity WebGL client is a separate project; don't add Unity/client build artifacts here. Note that "separate project" is about the *repo*, not the *server*: the client's build output is deployed onto the same VPS as this backend, served by the same nginx under its own hostname ([deployment.md](deployment.md)).

## Out of scope unless asked

- Per-venue LAN/offline fallback setup — only relevant for specific museums with unreliable internet, not a default requirement.
- Kiosk hardware/browser provisioning — a deployment/ops concern, not backend code.
- Analytics, abuse/rate-limiting — planned for a later phase (dev-plan §6, Phase 6), don't front-load unless asked.
