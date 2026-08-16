# Tech Stack

## Backend (this repo)

- **Node.js** >=20.9 (dev on v24.1.0), **TypeScript**, ESM (`"type": "module"` in package.json — relative imports need `.js` extension, per `NodeNext` module resolution).
- **Colyseus** `^0.17` + `@colyseus/tools` — game server framework: room lifecycle, matchmaking-by-id, per-room isolated state, built-in `/monitor` and `/playground` (dev-only) UIs.
- **@colyseus/schema** — typed state classes, auto-synced delta updates to clients.
- **express** — underlying HTTP server, used for custom routes/middleware in `app.config.ts`.
- **mysql2** — MySQL driver for match results, player profiles and live seats. Self-hosted alongside the server; see [database.md](database.md). Persistence is best-effort by design and never blocks a match.
- **tsx** — dev runtime (watch mode via `npm start`).
- **mocha** + **@colyseus/testing** — test suite.
- **@colyseus/loadtest** — scripted concurrent-client load testing.

Scaffolded via the official `create-colyseus-app` generator — see `package.json` scripts for `start`/`build`/`test`/`loadtest`.

## Client (separate repo/project, not here)

- Unity WebGL build. Connects over WebSocket via the official Colyseus Unity SDK.
- Hosted as static files (Cloudflare Pages / Netlify / GitHub Pages, or served from the same VPS via Nginx).

## Why this stack (short version)

No third-party game-networking vendor (rules out Photon, Unity Gaming Services/Lobby+Relay) — those charge per-CCU and/or are a company's infrastructure you don't control. Colyseus is MIT-licensed, self-hosted, communicates over plain WebSockets which Unity WebGL supports natively. Full reasoning: [dev-plan.md](dev-plan.md) §2–3.
