# Deployment

How this backend gets from the repo onto a public server. One self-hosted VPS
serves both public web players and museum kiosks — see
[architecture.md](architecture.md) for the topology and the reasoning.

The Unity WebGL client is **not** in this repo (it stays a separate Unity
project — see [boundaries.md](boundaries.md)), but its **build output is served
from this same VPS** by the same nginx that fronts the game server. Two
hostnames, one box:

| Hostname | Serves | Backed by |
|---|---|---|
| `museumethnofun.com` | Unity WebGL build | nginx static, `/var/www/museum` |
| `api.museumethnofun.com` | Colyseus | nginx → `127.0.0.1:2567` |

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
- nginx + certbot
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

Verify before running certbot — a certificate request against DNS that hasn't
propagated just burns a rate-limit slot:

```bash
dig +short museumethnofun.com
dig +short api.museumethnofun.com
```

Both must print the VPS IP. Propagation is usually minutes, occasionally an hour.

If the domain is behind Cloudflare's proxy (orange cloud), WebSockets do pass
through, but set SSL/TLS mode to **Full (strict)** and keep certbot's certificate
on the origin. Grey-cloud (DNS only) is simpler for the API subdomain and avoids
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

The repo is not a git checkout on the server by default — transfer with `rsync`
(or `git init` + a remote and pull, if you prefer). Either way `build/` is
produced on the server; don't ship a locally built one against different Node
minor versions.

Restarting drops every live socket, and rooms are in-memory only: a restart ends
all matches in progress. Deploy when the museum is closed, or accept the
interruption.

## Deploying the Unity WebGL client to the same box

The Unity project lives elsewhere; only its **build output** lands here. In Unity:
*File → Build Settings → WebGL → Build*, producing a folder with `index.html` and
a `Build/` subfolder. Ship that folder to the VPS:

```bash
rsync -av --delete path/to/WebGLBuild/ user@vps:/var/www/museum/
```

Two Unity build settings decide how much nginx configuration you need
(*Project Settings → Player → Publishing Settings*):

- **Compression Format: Disabled** — files are plain `.wasm` / `.js` / `.data`.
  Simplest; nginx only needs the `application/wasm` MIME type. Larger download.
- **Compression Format: Gzip or Brotli** with *Decompression Fallback* **off** —
  files are `.wasm.br`, `.js.br`, `.data.br`. Much smaller, but nginx must return
  them with the right `Content-Encoding`, otherwise the loader fails with
  "Unable to parse Build/*.wasm" or an unhandled-compression error.

Leaving *Decompression Fallback* on instead produces `*.unityweb` filenames. The
shipped nginx config handles all three layouts, so no server-side change is
needed whichever you pick.

Leaving *Decompression Fallback* **on** makes the build work on any server
without configuration, at the cost of a bigger loader and slower start — fine as
a first deploy, worth turning off once the nginx side is proven.

## nginx + TLS

The site config is a file in this repo — [`deploy/nginx/museumethnofun.com.conf`](../deploy/nginx/museumethnofun.com.conf) —
not something to hand-write on the box, so that fixes to it are versioned. It
carries explicit 443 blocks, the WebSocket upgrade plumbing, the long
`proxy_read_timeout` that idle lobbies need, basic-auth on `/monitor`, and the
`Content-Encoding` rules for every Unity compression layout.

Certificate first, config second:

```bash
sudo certbot certonly --nginx -d museumethnofun.com -d api.museumethnofun.com -d www.museumethnofun.com

sudo mkdir -p /var/www/museum
sudo cp deploy/nginx/museumethnofun.com.conf /etc/nginx/sites-available/
sudo ln -s ../sites-available/museumethnofun.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Put `museumethnofun.com` first in the certbot command — that name decides the
`/etc/letsencrypt/live/<name>/` directory the config points at. One certificate
covers both hostnames.

Two traps the previous VPS (shared with another project) sprung, both written up in
[`deploy/README.md`](../deploy/README.md) §5:

- **Certbot writes into whatever block already matches.** This VPS also hosts
  `qurantv_webrtc`, which owns `listen 80 default_server` / `server_name _`.
  Running `certbot --nginx` before the museum site existed injected museum server
  blocks into *that* project's config. Install the site config first, or check
  that file afterwards.
- **Do not re-run `certbot --nginx` once the site is installed** — it appends
  duplicate 443 blocks. Automatic renewal (`certbot renew`, the systemd timer)
  only replaces certificate files and never edits configs, so it is safe; it
  reloads nginx, not the game server, leaving live matches alone.

The Unity client's production endpoint is then `wss://api.museumethnofun.com` —
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
  and the nginx config puts HTTP basic auth in front of it
  (`sudo htpasswd -c /etc/nginx/.htpasswd-museum admin`). Leave `MONITOR_ENABLED`
  unset unless you actually need the panel.
- `/playground` — dev tooling, already gated behind `NODE_ENV !== "production"`.
- `/api/hello`, `/hi` — scaffold leftovers, harmless.

Firewall: expose 443 (and 80 for certbot's renewal challenge). Port 2567 should
not be reachable from outside the box; bind MySQL to `127.0.0.1`.

## Health check

```bash
curl -sS https://api.museumethnofun.com/hi     # scaffold route, proves the proxy works
curl -sSI https://museumethnofun.com/          # client is served
pm2 logs colyseus-app --lines 50               # boot errors, DB connection failures
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
Same procedure minus certbot: with no public hostname there is no Let's Encrypt
certificate, so serve the Unity client over plain `http://192.168.x.x` — a
non-secure origin may open `ws://`, so the pair still works with no TLS at all.
Both nginx blocks collapse into one `listen 80` server on the LAN IP, with the
Colyseus proxy under a distinct port (e.g. `listen 8080`) since there are no
hostnames to split on. Add this per venue only when a venue actually needs it.

## Scaling beyond one box

Colyseus supports several processes behind a shared Redis presence + driver,
still fully self-hosted — no third-party game-networking vendor, per
[boundaries.md](boundaries.md). That change touches `app.config.ts`
(presence/driver registration), the PM2 `instances` count, and the
`clearLiveSessions()` boot hook, which must then run once per cluster rather than
once per process.
