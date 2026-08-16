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
| `museum.fajrsyauqi.com` | Unity WebGL build | nginx static, `/var/www/museum-client` |
| `api.museum.fajrsyauqi.com` | Colyseus | nginx → `127.0.0.1:2567` |

The apex `fajrsyauqi.com` is deliberately left free for anything else. DNS setup
under [Hostnames](#hostnames).

Why two hostnames rather than one host with the game server on a subpath: the
JS SDK accepts a `pathname`, but the **Unity C# SDK builds its endpoint from
host + port only**, so a subpath means patching the SDK. A second subdomain is
free. Cross-origin is a non-issue — Colyseus's matchmaker replies with
`Access-Control-Allow-Origin: *` by default.

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

The project uses two subdomains of `fajrsyauqi.com`. At the registrar's DNS
panel, add two **A records** pointing at the VPS's public IPv4 address:

| Type | Name | Value |
|---|---|---|
| A | `museum` | `YOUR_VPS_IP` |
| A | `api.museum` | `YOUR_VPS_IP` |

(Add matching `AAAA` records if the VPS has IPv6 and you want it reachable that
way; skip them entirely otherwise — an `AAAA` record pointing nowhere makes
browsers stall before falling back to IPv4.)

Verify before running certbot — a certificate request against DNS that hasn't
propagated just burns a rate-limit slot:

```bash
dig +short museum.fajrsyauqi.com
dig +short api.museum.fajrsyauqi.com
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
rsync -av --delete path/to/WebGLBuild/ user@vps:/var/www/museum-client/
```

Two Unity build settings decide how much nginx configuration you need
(*Project Settings → Player → Publishing Settings*):

- **Compression Format: Disabled** — files are plain `.wasm` / `.js` / `.data`.
  Simplest; nginx only needs the `application/wasm` MIME type. Larger download.
- **Compression Format: Gzip or Brotli** with *Decompression Fallback* **off** —
  files are `.wasm.br`, `.js.br`, `.data.br`. Much smaller, but nginx must return
  them with the right `Content-Encoding`, otherwise the loader fails with
  "Unable to parse Build/*.wasm" or an unhandled-compression error. The
  `location` blocks below cover this.

Leaving *Decompression Fallback* **on** makes the build work on any server
without configuration, at the cost of a bigger loader and slower start — fine as
a first deploy, worth turning off once the nginx side is proven.

## nginx + TLS

One nginx, two server blocks. For the game server, the WebSocket upgrade headers
and a long read timeout are the parts that matter — the default 60s
`proxy_read_timeout` will cut idle lobbies.

```nginx
# /etc/nginx/conf.d/museum.conf

# --- Unity WebGL client -----------------------------------------------------
server {
    listen 443 ssl http2;
    server_name museum.fajrsyauqi.com;

    ssl_certificate     /etc/letsencrypt/live/museum.fajrsyauqi.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/museum.fajrsyauqi.com/privkey.pem;

    root /var/www/museum-client;
    index index.html;

    types { application/wasm wasm; }

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Pre-compressed Unity build files: serve as-is, tell the browser how.
    # Only needed when Compression Format is Brotli/Gzip with fallback off.
    location ~ \.wasm\.br$ { add_header Content-Encoding br;   default_type application/wasm; }
    location ~ \.js\.br$   { add_header Content-Encoding br;   default_type application/javascript; }
    location ~ \.br$       { add_header Content-Encoding br;   default_type application/octet-stream; }
    location ~ \.wasm\.gz$ { add_header Content-Encoding gzip; default_type application/wasm; }
    location ~ \.js\.gz$   { add_header Content-Encoding gzip; default_type application/javascript; }
    location ~ \.gz$       { add_header Content-Encoding gzip; default_type application/octet-stream; }

    # The build hashes its filenames; index.html must not be cached.
    location = /index.html { add_header Cache-Control "no-store"; }
    location /Build/      { expires 1y; add_header Cache-Control "public, immutable"; }
}

# --- Colyseus game server ---------------------------------------------------
server {
    listen 443 ssl http2;
    server_name api.museum.fajrsyauqi.com;

    ssl_certificate     /etc/letsencrypt/live/museum.fajrsyauqi.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/museum.fajrsyauqi.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:2567;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

One certificate covers both names:

```bash
certbot --nginx -d museum.fajrsyauqi.com -d api.museum.fajrsyauqi.com
```

(with `-d museum.fajrsyauqi.com` first, so `/etc/letsencrypt/live/museum.fajrsyauqi.com/`
is the path both blocks reference above). `--nginx` also adds the port-80
`server` blocks that redirect plain HTTP to HTTPS, so
`http://museum.fajrsyauqi.com` lands on the secure page — don't hand-write those.
Renewal is the certbot systemd timer installed with the package; confirm with
`certbot renew --dry-run`, and note that renewal reloads nginx, not the game
server, so live matches are unaffected.

The Unity client's production endpoint is then `wss://api.museum.fajrsyauqi.com` —
see [unity-integration.md](unity-integration.md) §2.

## Exposed routes — check before going public

- `/monitor` — the Colyseus admin panel, mounted **unconditionally** in
  [`src/app.config.ts`](../src/app.config.ts). It lists live rooms and lets an
  operator inspect and kill them. It has no password. Before the server is
  reachable from the internet, either put HTTP basic auth on it
  (`monitor()` accepts credentials, or restrict the location block in nginx) or
  block `/monitor` at the proxy.
- `/playground` — dev tooling, already gated behind `NODE_ENV !== "production"`.
- `/api/hello`, `/hi` — scaffold leftovers, harmless.

Firewall: expose 443 (and 80 for certbot's renewal challenge). Port 2567 should
not be reachable from outside the box; bind MySQL to `127.0.0.1`.

## Health check

```bash
curl -sS https://api.museum.fajrsyauqi.com/hi     # scaffold route, proves the proxy works
curl -sSI https://museum.fajrsyauqi.com/          # client is served
pm2 logs colyseus-app --lines 50               # boot errors, DB connection failures
```

If the Unity page loads but stalls on the progress bar, it is almost always the
compression headers — check that `Build/*.br` responses carry
`Content-Encoding: br` (`curl -sSI https://museum.fajrsyauqi.com/Build/xxx.wasm.br`).

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
