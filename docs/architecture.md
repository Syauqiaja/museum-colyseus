# Architecture

```
[Browser: Unity WebGL Build]
   ├── Exhibition Museum scene (presence only — room "museum")
   └── Minigame scenes ↴
         |  (WebSocket, Colyseus Unity SDK)
         v
      [Colyseus Node.js server]
         |
   Room Manager
   ├── Room "AB12CD" — Dakon,    players [1,2]
   ├── Room "XZ99QW" — Engklak,  players [1..N]
   ├── Room "PL04ZR" — Egrang,   players [1..N]
   └── Room "..."
```

The Exhibition Museum scene is the entry point/main menu. It joins one public `museum` presence room (`MuseumRoom`, a plain `Room`, not a `BaseGameRoom`) so visitors see each other's avatars — see [protocol.md](protocol.md#exhibition-museum-scene). It launches into one of the 3 multiplayer minigame scenes, each backed by its own Room type.

Each Room is an isolated game session; the server owns authoritative state. Clients send input events only, never raw state. Per-room message/state contract: [protocol.md](protocol.md).

The matchmaking/lifecycle common to all rooms (create private, public join-or-create, join-by-code, short codes, host, reconnect, idle cleanup) is implemented once in a reusable `BaseGameRoom` and subclassed per game — full detail in [room-system.md](room-system.md). `DakonRoom` (lobby + move engine) and `EgrangRoom` (lobby + race engine) are both full implementations.

Match results, player profiles and a live seat view are persisted to MySQL — best-effort, never in the path of a match. See [database.md](database.md).

## Room lifecycle

`Waiting` (lobby, players joining, host can start) → `InProgress` → `Finished` (results) → `Closed/Destroyed` (cleanup on timeout or all-players-left).

Edge cases to handle per room type: room full, room not found/expired, host disconnect (migrate host or end room), player reconnect after drop, idle-room auto-destroy. These are handled generically in `BaseGameRoom` — see [room-system.md](room-system.md).

## Repo layout

- `src/index.ts` — entry point, `listen(app)`. Avoid hand-editing beyond scaffold if targeting Colyseus Cloud.
- `src/app.config.ts` — `defineServer({...})`: room registration, HTTP routes, express middleware.
- `src/rooms/*.ts` — one Room subclass per game.
- `src/rooms/schema/*.ts` — `@colyseus/schema` synced state.
- `test/`, `loadtest/` — mirror room names.

## Deployment topology

One self-hosted VPS runs everything: the Colyseus server **and** nginx serving the static Unity WebGL build, on two hostnames pointing at the same box — `museumethnofun.com` for the client, `api.museumethnofun.com` for the game server. Both public web players and museum kiosks use the same URLs. TLS (Let's Encrypt) is required since browsers require `wss://` from an `https://` page.

The Unity WebGL project itself is still a separate repo (see [boundaries.md](boundaries.md)) — only its build output is copied onto this VPS.

Optional: same server code can run on a local machine (Raspberry Pi/mini PC) at a specific venue for offline/LAN fallback if that venue's internet is unreliable — not needed by default, add per-venue only if required.

Scaling: if a single VPS becomes a bottleneck, Colyseus supports multiple server processes behind a shared presence layer (e.g. Redis) — still fully self-hosted.

Step-by-step procedure: [deployment.md](deployment.md). Background and risks:
[dev-plan.md](dev-plan.md) §4–6b, §9.
