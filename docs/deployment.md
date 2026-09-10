# Deployment

How this backend gets from the repo onto a public server. One self-hosted VPS
serves both public web players and museum kiosks — see
[architecture.md](architecture.md) for the topology and the reasoning.

The Unity WebGL client is **not** in this repo (it stays a separate Unity
project — see [boundaries.md](boundaries.md)), but its **build output is served
from this same VPS**, behind the same Traefik reverse proxy that fronts the game
server. Two hostnames, one box:

| Hostname | Serves | Backed by |
|---|---|---|
| `museumethnofun.com` | Unity WebGL build | `web` container (nginx), `/docker/museum/site` |
| `api.museumethnofun.com` | Colyseus | Traefik → PM2 on the host, `127.0.0.1:2567` |

The domain is the project's own, so the client takes the apex; `www` redirects to
it. DNS setup under [Hostnames](#hostnames).

Why two hostnames rather than one host with the game server on a subpath: the
JS SDK accepts a `pathname`, but the **Unity C# SDK builds its endpoint from
host + port only**, so a subpath means patching the SDK. A second subdomain is
free. Cross-origin is a non-issue — Colyseus's matchmaker sets its own CORS
headers, see [CORS](#cors--leave-it-to-colyseus).

This doc is the reasoning; [`deploy/README.md`](../deploy/README.md) is the
step-by-step runbook, and [`deploy/`](../deploy/) holds the actual config and
install script. Keep the two in sync.

## What actually runs

`build/index.js` (the `tsc` output of `src/`), supervised by PM2 using
[`ecosystem.config.cjs`](../ecosystem.config.cjs). It listens on `PORT`
(default `2567`) behind an nginx TLS reverse proxy. MySQL runs on the same box.

**One process only.** `instances: 1` in the PM2 config is deliberate: several
Colyseus processes on one port need a shared presence/driver layer (Redis) for
matchmaking, and this server registers none. Without it, join-by-code only finds
rooms that happen to live in the same process, and every process's `beforeListen`
hook wipes the others' `live_sessions` rows. Museum-scale load fits one process
comfortably; add Redis first if that ever stops being true.

## Prerequisites on the VPS

- Node.js >= 20.9 (matches `engines` in `package.json`)
- PM2 (`npm i -g pm2`)
- MySQL 8 (skip if running with `DB_DISABLED=1`)
- A TLS reverse proxy that passes WebSocket upgrades — on the production box,
  Hostinger's Traefik, which owns ports 80/443 and issues certificates itself. Do
  not also install nginx/certbot on the host; they cannot bind those ports.
- Two hostnames pointing at the box — browsers refuse `ws://` from an `https://`
  page, so TLS is not optional. See below.

## Hostnames

The project uses the apex `museumethnofun.com` plus `api` and `www`. At the
registrar's DNS panel, add three **A records** pointing at the VPS's public IPv4
address:

| Type | Name | Value |
|---|---|---|
| A | `@` | `YOUR_VPS_IP` |
| A | `api` | `YOUR_VPS_IP` |
| A | `www` | `YOUR_VPS_IP` |

(Add matching `AAAA` records if the VPS has IPv6 and you want it reachable that
way; skip them entirely otherwise — an `AAAA` record pointing nowhere makes
browsers stall before falling back to IPv4.)

Verify before the first HTTPS request — Traefik asks Let's Encrypt for a
certificate on first use, and a request against DNS that hasn't propagated just
burns a rate-limit slot:

```bash
dig +short museumethnofun.com
dig +short api.museumethnofun.com
```

Both must print the VPS IP. Propagation is usually minutes, occasionally an hour.

If the domain is behind Cloudflare's proxy (orange cloud), WebSockets do pass
through, but set SSL/TLS mode to **Full (strict)** and keep Traefik's certificate
on the origin (switch its resolver to the DNS-01 challenge, since HTTP-01 cannot
reach a proxied origin). Grey-cloud (DNS only) is simpler for the API subdomain and avoids
Cloudflare's idle-connection timeouts on long-lived lobby sockets.

For a venue with no internet at all, see
[Offline / LAN venues](#offline--lan-venues) below.

## Environment

Set these in the process environment (PM2 ecosystem `env`, a systemd unit, or the
deploy user's shell). **Credentials do not belong in a committed file** — see
[database.md](database.md).

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | — | must be `production`; also disables the `/playground` route |
| `PORT` | `2567` | proxied to by nginx |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `3306` | |
| `DB_USER` | `root` | give the app its own user, not root |
| `DB_PASSWORD` | empty | |
| `DB_NAME` | `museum_minigames` | |
| `DB_POOL_SIZE` | `10` | |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | |
| `DB_DISABLED` | unset | `1` runs a venue with no database at all |

## Procedure

```bash
npm ci
npm run build           # clean + tsc -p tsconfig.build.json -> build/
npm run db:migrate      # creates the database if absent, applies db/migrations/*.sql
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup # survive reboot
```

Redeploy of an existing box: ship the new source, then

```bash
npm ci
npm run build
npm run db:migrate      # forward-only, already-applied migrations are skipped
pm2 restart colyseus-app
```

On the production box all of this is scripted: [`deploy/setup-vps.sh`](../deploy/setup-vps.sh)
(`packages`, then `app`) clones the repo to `/srv/museum`, generates the DB
credentials into `.env.production`, and runs the steps above as a dedicated
`museum` user. Redeploys are a `git pull` in that checkout — see
[`deploy/README.md`](../deploy/README.md). `build/` is always produced on the
server; don't ship a locally built one against different Node minor versions.

Restarting drops every live socket, and rooms are in-memory only: a restart ends
all matches in progress. Deploy when the museum is closed, or accept the
interruption.

## Deploying the Unity WebGL client to the same box

The Unity project lives elsewhere; only its **build output** lands here. In Unity:
*File → Build Settings → WebGL → Build*, producing a folder with `index.html` and
a `Build/` subfolder. Ship that folder to the VPS:

```bash
chmod -R a+rX path/to/WebGLBuild
rsync -avz --partial --exclude='.DS_Store' path/to/WebGLBuild/ root@vps:/docker/museum/site/
ssh root@vps 'chmod -R a+rX /docker/museum/site'
```

(`chmod` on every build and no `--delete` — both are traps already sprung; the
reasons are in [`deploy/README.md`](../deploy/README.md) §4.)

Two Unity build settings decide how much nginx configuration you need
(*Project Settings → Player → Publishing Settings*):

- **Compression Format: Disabled** — files are plain `.wasm` / `.js` / `.data`.
  Simplest; nginx only needs the `application/wasm` MIME type. Larger download.
- **Compression Format: Gzip or Brotli** with *Decompression Fallback* **off** —
  files are `.wasm.br`, `.js.br`, `.data.br`. Much smaller, but nginx must return
  them with the right `Content-Encoding`, otherwise the loader fails with
  "Unable to parse Build/*.wasm" or an unhandled-compression error.

Leaving *Decompression Fallback* on instead produces `*.unityweb` filenames. The
`web` container's [`nginx.conf`](../deploy/traefik/nginx.conf) handles the
Brotli/`*.br` layout that `BuildWebGL` produces (and plain `.wasm`); switching to
`*.unityweb` or `*.gz` needs matching `location` blocks added there first.

Leaving *Decompression Fallback* **on** makes the build work on any server
without configuration, at the cost of a bigger loader and slower start — fine as
a first deploy, worth turning off once the nginx side is proven.

## Traefik + TLS

Ports 80/443 on the production box belong to Hostinger's Traefik (its own compose
project): host-networked, routes read from Docker labels only, HTTP → HTTPS
redirect, and an ACME resolver `letsencrypt` that issues and renews certificates
per hostname on first use. There is no certbot and no host nginx.

The routes are labels on the `museum` compose project, versioned in
[`deploy/traefik/`](../deploy/traefik/) (on the box: `/docker/museum/`), so fixes
to them are reviewed rather than hand-edited on the server:

- `web` (`nginx:alpine`) — `museumethnofun.com`, plus a `www` → apex redirect
  middleware; serves the Unity build with the `Content-Encoding` rules it needs.
- `api` — a do-nothing, host-networked container that exists only to carry the
  `api.museumethnofun.com` router. Traefik resolves host-networked containers to
  `127.0.0.1`, so the router's port 2567 reaches the Colyseus process that PM2
  runs on the host. Traefik passes WebSocket upgrades through with no extra
  config, and an idle game socket survives its 60 s entrypoint read timeout
  (checked for 75 s).

The Unity client's production endpoint is `wss://api.museumethnofun.com` —
see [unity-integration.md](unity-integration.md) §2.

## CORS — leave it to Colyseus

`@colyseus/core`'s router already attaches `Access-Control-Allow-Origin` (the
request's own Origin by default) plus the other `Access-Control-*` headers to
every matchmaking response and OPTIONS preflight — see
`DEFAULT_CORS_HEADERS` / `getCorsHeaders` in its `matchmaker/controller.ts` and
`router/node.ts`. Adding the same headers at the nginx layer sends **two** of
each, which browsers reject with "contains multiple values", breaking
`joinOrCreate` in the browser while it still works in the Unity Editor.

To restrict which origin may matchmake, override
`matchMaker.controller.getCorsHeaders` in `src/app.config.ts`. Never in nginx.

## Exposed routes — check before going public

- `/monitor` — the Colyseus admin panel: it lists live rooms and lets an operator
  inspect and destroy them. **Two locks, both needed.** Server-side it is only
  mounted when `MONITOR_ENABLED=1` (see [`src/app.config.ts`](../src/app.config.ts)),
  and a Traefik `basicauth` router must sit in front of it (labels in
  [`deploy/README.md`](../deploy/README.md) §3). Leave `MONITOR_ENABLED`
  unset unless you actually need the panel.
- `/playground` — dev tooling, already gated behind `NODE_ENV !== "production"`.
- `/api/hello`, `/hi` — scaffold leftovers, harmless.

Firewall: expose 443 (and 80 for Traefik's HTTP-01 challenge and redirect). Port
2567 must not be reachable from outside the box (`ufw` blocks it; verified
2026-09-11) — Traefik reaches it on loopback. Bind MySQL to `127.0.0.1`.

## Health check

```bash
curl -sS https://api.museumethnofun.com/hi     # scaffold route, proves the proxy works
curl -sSI https://museumethnofun.com/          # client is served
sudo -u museum pm2 logs colyseus-app --lines 50   # boot errors, DB connection failures
```

If the Unity page loads but stalls on the progress bar, it is almost always the
compression headers — check that `Build/*.br` responses carry
`Content-Encoding: br` (`curl -sSI https://museumethnofun.com/Build/xxx.wasm.br`).

A dead database does not stop the server: writes go through `withDb()`, which
logs and swallows failures. If matches play but no rows appear, look at the logs
rather than the room code.

## Offline / LAN venues

The same build runs on a mini PC or Raspberry Pi at a venue with unreliable
internet, serving both the client and the game server over the local network.
Same server procedure, but no Traefik or certificates: with no public hostname
there is no Let's Encrypt certificate, so serve the Unity client over plain
`http://192.168.x.x` — a non-secure origin may open `ws://`, so the pair still
works with no TLS at all. A single nginx `listen 80` server on the LAN IP (the
`web` container's config is a fine base) serves the client, with the Colyseus
proxy under a distinct port (e.g. `listen 8080`) since there are no hostnames to
split on. Add this per venue only when a venue actually needs it.

## Scaling beyond one box

Colyseus supports several processes behind a shared Redis presence + driver,
still fully self-hosted — no third-party game-networking vendor, per
[boundaries.md](boundaries.md). That change touches `app.config.ts`
(presence/driver registration), the PM2 `instances` count, and the
`clearLiveSessions()` boot hook, which must then run once per cluster rather than
once per process.
