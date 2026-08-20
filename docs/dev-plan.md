# Development Plan: Unity WebGL Multiplayer Mini-Game (Room-Based)

## 1. Project Summary

**Goal:** A browser-playable (Unity WebGL) mini-game where players can create or join rooms using a room ID/code, with many rooms running simultaneously and multiple players per room.

**Core requirements:**
- Playable in a browser (no install)
- Create Room → get shareable ID/code
- Join Room by entering ID/code
- Many concurrent rooms, each isolated (state doesn't leak between rooms)
- Real-time sync between players in the same room

---

## 2. Key Constraint: Networking on WebGL

This is the most important architectural decision, so it's worth understanding before picking a stack:

- Unity WebGL builds run in the browser sandbox → **no raw UDP sockets**. You cannot use Unity's low-level Transport over raw sockets like a standalone build can.
- Viable transports in-browser: **WebSockets** (simple, reliable, slightly higher latency) or **WebRTC** (lower latency, harder to set up, needed for anything twitchy/competitive).
- For a "mini-game" (casual, turn-based or lightly real-time — think party games, board games, quiz games, simple arcade games) **WebSockets are almost always sufficient** and much simpler to build/debug/host.

---

## 3. Networking Stack — Decision: Self-Hosted, Vendor-Independent

**Constraint:** no dependency on a third-party vendor (Photon, Unity Gaming Services, PlayFab, etc.), and no added recurring cost — important since this targets museums where you want to install once and not owe anyone a subscription.

This rules out **Photon** (per-CCU pricing, your game literally stops working if you don't pay or if Photon's cloud has an outage) and **Unity Gaming Services / Lobby+Relay** (free tier today, but it's still a third party's infrastructure and pricing/ToS you don't control).

### Chosen stack: Node.js + Colyseus (self-hosted), Unity as WebSocket client

- **Colyseus** is open-source (MIT license) — you run it on hardware/servers **you own or control**, no external account required, no per-player fees, ever.
- It already models exactly what you need: `Room` with an id, `createRoom`, `joinById(roomId)`, per-room isolated state, automatic room cleanup.
- Communicates over plain **WebSockets**, which Unity WebGL supports natively (via a WebSocket client library — Colyseus has an official Unity SDK).
- Both Dakon and Egrang are lightweight to sync (see §5b) — you don't need a heavyweight engine like Photon/NGO for this; a fairly small amount of custom server code is enough. This also means you could even skip Colyseus and write a minimal custom WebSocket server in Node.js if you want to be maximally lock-in-free — but Colyseus saves you from re-inventing room lifecycle handling, and since it's OSS, "depending" on it means depending on code you can read, fork, and self-host forever, not a company.
- **The only unavoidable "vendor" is a generic server host** (a VPS, or your own hardware) — but that's commodity infrastructure (like buying electricity), not a locked-in game-networking platform. See §7a for a $0-recurring-cost option for museums specifically.

---

## 4. High-Level Architecture

```
[Browser: Unity WebGL Build]
         |  (WebSocket / Photon SDK)
         v
[Networking Layer: Photon Cloud  OR  Colyseus Node.js server]
         |
   Room Manager
   ├── Room "AB12CD" — players [1,2,3]
   ├── Room "XZ99QW" — players [1,2]
   └── Room "..."    — players [...]
         |
[Optional: Database/Redis for persistence, matchmaking history, stats]
```

Each "room" is an isolated game session/state instance. The server (Photon cloud instance or your Colyseus room instance) owns authoritative game state; clients send inputs and receive state updates.

---

## 5. Room System Design

> **Status: delivered.** Implemented as the reusable `BaseGameRoom` (`src/rooms/`), subclassed by `DakonRoom` and `EgrangRoom`. See [room-system.md](room-system.md) for the as-built reference. Both move engines (§5b) are delivered too: `src/games/dakon/DakonBoard.ts` and `src/games/egrang/EgrangRace.ts`.

- **Room ID generation:** short human-friendly code (e.g., 5–6 alphanumeric chars, avoid ambiguous chars like 0/O, 1/I). Generated server-side on "Create Room," checked for collision against active rooms.
- **Create flow:** Player clicks "Create Room" → client requests server → server allocates room, returns code → host shares code (or a shareable link like `yourgame.com/?room=AB12CD`).
- **Join flow:** Player enters code (or opens link) → client requests join → server validates room exists, isn't full, isn't already started → adds player.
- **Room lifecycle:**
  - `Waiting` (lobby, players joining, host can start)
  - `InProgress` (game running)
  - `Finished` (results shown)
  - `Closed/Destroyed` (cleanup after timeout or all players leave)
- **Edge cases to design for:** room full, room not found/expired, host disconnects (migrate host or end room), player reconnect after dropped connection, idle room cleanup (auto-destroy empty rooms after N minutes).

### 5b. Game-Specific Networking Notes

**Dakon (Congklak/Mancala-style)**
- Turn-based, 2 players, small discrete state: an array of pit counts (typically 14–16 pits) + whose turn it is + scores.
- Extremely low bandwidth — you can send the *entire* board state on every move without worrying about optimization.
- Server-authoritative move validation is trivial (validate the move is legal, apply the sowing algorithm server-side, broadcast new state) — this also prevents cheating by construction.
- No real-time precision needed at all; a basic "send state on change" WebSocket pattern is enough.

**Egrang (stilt-walking race)**
- Likely a timing/balance or race-style minigame (multiple players moving/racing simultaneously).
- Still lightweight compared to a shooter/action game: you're syncing position/progress + simple input events (step timing, balance), not physics-heavy state.
- Server-authoritative position+progress with clients sending input events (e.g., "stepped," "tilt direction") works well and stays cheat-resistant.
- If it ends up feeling laggy with plain state-broadcast, add simple client-side interpolation (smooth movement between received updates) — still doesn't require WebRTC/UDP.

Both games comfortably fit within the WebSocket + Colyseus approach — no need for anything more complex.

---

## 6. Development Phases

### Phase 0 — Prototype & Tech Validation (1–2 weeks)
- Build a throwaway Unity WebGL project with **just** networking: two clients, one room, position sync or simple shared state.
- Deploy to a real web host early (not just Unity Editor) — WebGL networking bugs often only show up in-browser.
- Validate: chosen networking SDK works in WebGL build, latency is acceptable, build size/load time is reasonable.
- **Exit criteria:** two browser tabs can create/join the same room and see each other's actions in real time.

### Phase 1 — Core Game Mechanics (offline/local first)
- Build the actual mini-game logic with **no networking** — fully playable locally/hotseat.
- Keep game logic decoupled from Unity's `MonoBehaviour` update loop where possible (pure C# game-state classes) — this makes it much easier to bolt networking on later and to eventually move logic server-side if needed for authority.

### Phase 2 — Networking Integration
- Wire the room system (create/join/leave) using the chosen SDK.
- Sync game state: decide what's server-authoritative vs client-predicted.
- For simple mini-games, simplest robust pattern: **server/host is authoritative**, clients send input events only, receive full/delta state updates.
- Implement reconnect handling and disconnect/leave cleanup.

### Phase 3 — Lobby & Room UI/UX
- Landing screen: "Create Room" / "Join Room" (with code input) / (optional) "Nickname" entry.
- In-room lobby: player list, ready-up, host start button, copyable room link.
- In-game HUD, results/end screen, "Play Again" / "Return to Lobby" flow.
- Shareable URL support (`?room=CODE`) so links can auto-join.

### Phase 4 — WebGL Build & Hosting Setup
- Configure Unity WebGL build settings (compression: Brotli or gzip, memory size, exception handling = "Explicitly Thrown Exceptions Only" for smaller/faster builds in production).
- Set up hosting for the **static WebGL build** (the client): options — your own server via Nginx/Apache, a static host (Cloudflare Pages, Netlify, Vercel, itch.io for quick sharing), or an S3+CDN setup.
- Set up hosting for the **backend** (only if Option C/Colyseus): a VPS or container host (e.g., Docker on a cloud VM, Fly.io, Railway, Render) — needs to support persistent WebSocket connections.
- Ensure CORS / WebSocket proxy config is correct (e.g., Nginx `proxy_pass` with `Upgrade`/`Connection` headers) if self-hosting.

### Phase 5 — Testing & Scaling
- Load-test with many simulated concurrent rooms (bots/headless clients) to confirm server handles target concurrent room count.
- Test on target browsers (Chrome, Safari, Firefox, mobile browsers) — WebGL performance varies notably by browser/device.
- Test poor-network conditions (simulate latency/packet loss) for reconnect and desync handling.

### Phase 6 — Polish, Analytics, Launch
- Add basic analytics (rooms created, session length, drop-off points) — useful for tuning.
- Add abuse/rate-limit protection (room creation spam, join spam).
- Final QA pass, then deploy production build.

---

## 6b. Deployment Strategy — Public Website + Museum Kiosks, Same Server

Since you now want a public web version too, the simplest architecture is: **one self-hosted server serves everyone** — public players at home and museum kiosks both connect to the same VPS over the internet. Museums are just "kiosks with a browser pointed at your website," nothing special.

### Primary setup (recommended)
- **Server:** Colyseus/Node.js app deployed to a VPS you rent and fully control (e.g., ~$5–12/mo for a small instance — enough for a good number of concurrent rooms given how lightweight Dakon/Egrang state is). Swappable to any provider anytime — no lock-in, since it's just your own app in a Docker container or plain Node process.
- **Domain + HTTPS:** get a domain and a free TLS cert (Let's Encrypt) — required in practice, since browsers require secure `wss://` WebSocket connections from an `https://` page.
- **Client hosting:** the Unity WebGL build (static files) hosted free/near-free on something like Cloudflare Pages, GitHub Pages, or Netlify, or served directly from your own VPS via Nginx.
- **Museum kiosks:** same public URL, opened full-screen in a kiosk-mode browser (e.g., Chrome `--kiosk`) on each museum station. They just need internet access at the venue.
- **Everything stays yours:** no company can cut you off, change pricing, or shut down and take your game with it — you own the server code and can move it to any host.

### Optional fallback: Local/LAN mode for low-connectivity venues
If a specific museum has unreliable internet, you can additionally run the exact same server code on a small local machine there (Raspberry Pi/mini PC) so that venue's kiosks connect over local WiFi instead — $0 recurring for that venue, fully offline-capable. This isn't required to start; add it only for venues that need it.

### Scaling note
As concurrent players grow, if a single VPS ever becomes a bottleneck, Colyseus supports running multiple server processes behind a shared presence layer (e.g., Redis) so rooms can be distributed across machines — still entirely self-hosted, no third-party networking vendor involved at any scale.

## 7. Suggested Timeline (rough, adjust to team size / game complexity)

| Phase | Duration |
|---|---|
| 0. Tech validation | 1–2 weeks |
| 1. Core mechanics (offline) | 1–3 weeks (depends on game complexity) |
| 2. Networking integration | 2–3 weeks |
| 3. Lobby/room UI | 1 week |
| 4. Build & hosting setup (VPS + domain + HTTPS + static hosting) | 1 week |
| 5. Testing & scaling | 1–2 weeks |
| 6. Polish & launch | 1 week |
| 6b. Optional per-venue LAN fallback setup | 1–2 days per venue, as needed |

**Total: ~8–13 weeks** for a solo/small-team simple mini-game. Scale up for more complex game mechanics.

---

## 8. Cost Considerations (Self-Hosted, Vendor-Free)

- **VPS for the server:** ~$5–12/mo, your choice of provider, swappable anytime.
- **Domain:** ~$10–15/year.
- **HTTPS certificate:** free (Let's Encrypt).
- **Static WebGL client hosting:** often free (Cloudflare Pages, GitHub Pages, Netlify) unless traffic is very high.
- **Optional per-venue LAN fallback machine:** one-time ~$50–100 (Raspberry Pi) if a venue needs offline capability; $0 recurring after that.
- **No per-player, per-CCU, or per-room fees at any point**, since there's no third-party networking SaaS in the stack — this is the main saving compared to Photon/UGS at scale across many museums and public players.

---

## 9. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WebGL build size/load time too large | Enable compression, strip unused assets, test load time on real connections early |
| Networking SDK behaves differently in WebGL vs Editor/standalone | Test in an actual browser build starting in Phase 0, not just Editor Play Mode |
| Room state desync between players | Use server-authoritative state, not client-authoritative, for anything competitive |
| Many concurrent rooms overload single server instance | Load-test in Phase 5; design server to be stateless/horizontally scalable if using custom backend |
| Players disconnect mid-game | Design explicit reconnect flow from the start, not as an afterthought |

---

## 10. Next Steps / Open Decisions

Resolved by this update:
- ✅ Networking stack: self-hosted Colyseus/Node.js — no vendor.
- ✅ Games: Dakon (turn-based) + Egrang (light real-time race) — both fit the WebSocket approach easily.
- ✅ Deployment: one public VPS-hosted server serves both home players and museum kiosks; optional LAN fallback per venue if needed.

Still worth deciding:
1. **Domain name / branding** for the public site.
2. **Estimated peak concurrent players** (home + all museum stations combined) — determines your starting VPS size; easy to scale up later since there's no vendor contract to renegotiate.
3. **Which, if any, venues need the offline LAN fallback** — only relevant for museums with unreliable internet.
4. **Kiosk hardware/browser** you'll standardize on for the museum stations (e.g., Chrome in `--kiosk` fullscreen mode is a common, free, reliable choice).
