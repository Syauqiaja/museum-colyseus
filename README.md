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

## Deploy

```
deploy/deploy.sh      # redeploy production from origin/main (asks before restarting)
deploy/deploy.sh -y   # no prompt
```

What you need:

- `bash`, `git`, `ssh`, `curl`, and Node.js >= 20.9 (the script runs `npm test` locally first).
- SSH access to the VPS as `root@212.85.25.177` (key or password). You are asked to authenticate once per run. Use `DEPLOY_USER` / `DEPLOY_HOST` to deploy as another user or to another box. The user must be able to `sudo -u museum`.
- Your changes committed and pushed. The VPS pulls `main` from GitHub, so the script refuses to run unless your local tree is clean and on exactly `origin/main`.

What it does: runs the tests, shows the commits about to go out, asks before restarting (**a restart ends every live match**, so deploy when the museum is closed), then on the VPS pulls, installs, migrates the database, builds, restarts PM2, and waits for `https://api.museumethnofun.com/hi` to answer. If the server is already on `origin/main` it does nothing.

The Unity client deploys separately with `./deploy.sh` in its own repo. When a release touches both, deploy the server first. Full runbook: [`deploy/README.md`](deploy/README.md).

## Structure

- `src/index.ts` — entry point
- `src/app.config.ts` — room registration, HTTP routes, express middleware (`/monitor`, `/playground` dev-only)
- `src/rooms/*.ts` — one Room class per minigame
- `src/rooms/schema/*.ts` — `@colyseus/schema` synced state
- `test/`, `loadtest/` — mirror room names
- `docs/` — all project documentation (read this before making changes)

## License

UNLICENSED (private project)
