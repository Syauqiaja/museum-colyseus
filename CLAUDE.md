# museum-minigames — backend

Colyseus (v0.17) game server backend for browser-playable Unity WebGL mini-games (**Dakon** — turn-based Congklak/Mancala, **Egrang** — light real-time stilt-race). Rooms are created/joined by short code; the server is authoritative for all game state.

## Docs — read and write these for every change

All project knowledge, decisions, and agent instructions live in [`docs/`](docs/README.md). Before starting work, read the relevant doc(s) there (overview, tech-stack, architecture, boundaries). After any change that alters what a doc describes (new room/game, stack change, deployment change, new constraint), update that doc in the same change — don't let `docs/` drift from reality. See [`docs/agent-instructions.md`](docs/agent-instructions.md) for the full process.

## Stack

- Node.js (>=20.9, dev on v24), TypeScript, ESM (`"type": "module"` — always import with `.js` extensions in relative imports, per NodeNext resolution).
- `colyseus` + `@colyseus/tools` (server), `@colyseus/schema` (state sync), `express` (underlying HTTP).
- `tsx` for dev (`npm start` = watch mode), plain `tsc` for prod build.
- `mocha` + `@colyseus/testing` for tests, `@colyseus/loadtest` for concurrent-room load testing.

## Commands

- `npm start` — dev server w/ watch, http://localhost:2567
- `npm run build` — compile to `build/` via `tsconfig.build.json`
- `npm test` — mocha test suite (`test/**.test.ts`)
- `npm run loadtest` — scripted client load test (`loadtest/example.ts`)

## Structure

- `src/index.ts` — entry point, calls `listen(app)`. Don't hand-edit beyond what's there if targeting Colyseus Cloud; self-hosting is fine to extend.
- `src/app.config.ts` — `defineServer({...})`: room registration, HTTP routes, express middleware (`/monitor`, `/playground` dev-only).
- `src/rooms/*.ts` — one `Room` subclass per game (`onCreate`/`onJoin`/`onLeave`/`onDispose`, `messages` map for client→server events).
- `src/rooms/schema/*.ts` — `@colyseus/schema` state classes synced to clients.
- `test/`, `loadtest/` — mirror room names.

## Conventions

- Server-authoritative always: validate moves/state transitions in the Room, never trust client-sent state directly — both Dakon and Egrang are cheap enough to fully re-simulate server-side.
- One Room class per game type, registered in `app.config.ts` via `defineRoom(...)`.
- Keep game logic in plain TS classes separate from Colyseus lifecycle hooks where practical — makes testing without a live room easier.
- No third-party game-networking vendor (Photon/UGS/PlayFab) — self-hosted only, per [`docs/boundaries.md`](docs/boundaries.md). Don't introduce one.

## Deployment context

Single self-hosted VPS serves both public web players and museum kiosks. Same box runs the Colyseus server *and* nginx serving the static Unity WebGL build, on two hostnames: `museumethnofun.com` (client) and `api.museumethnofun.com` (`wss://` API), Let's Encrypt TLS. This repo is backend only — the Unity project stays separate, only its build output is copied to the VPS. Topology: [`docs/architecture.md`](docs/architecture.md). Step-by-step deploy (build, PM2, env, nginx/TLS): [`docs/deployment.md`](docs/deployment.md).
