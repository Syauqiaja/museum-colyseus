# museum-minigames — backend

Colyseus (Node.js/TypeScript) backend for a Unity WebGL museum experience: a single-player exhibition hub scene that launches into three multiplayer minigames — **Dakon** (Congklak/Mancala), **Engklak** (hopscotch-style), **Egrang** (stilt-walking race). Served to both museum kiosks and public web players from the same self-hosted server. This repo is backend only — the Unity WebGL client lives in a separate project.

Full project knowledge (architecture, tech stack, boundaries, per-game rules, client↔server protocol, agent instructions) lives in [`docs/`](docs/README.md) — start there.

## Usage

```
npm install
npm start        # dev server w/ watch, http://localhost:2567
npm run build     # compile to build/
npm test          # mocha test suite
npm run loadtest   # scripted concurrent-client load test
```

## Structure

- `src/index.ts` — entry point
- `src/app.config.ts` — room registration, HTTP routes, express middleware (`/monitor`, `/playground` dev-only)
- `src/rooms/*.ts` — one Room class per minigame
- `src/rooms/schema/*.ts` — `@colyseus/schema` synced state
- `test/`, `loadtest/` — mirror room names
- `docs/` — all project documentation (read this before making changes)

## License

UNLICENSED (private project)
