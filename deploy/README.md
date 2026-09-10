# Deployment runbook — single VPS

One VPS serves both halves of the project:

| Host | Serves | Backed by |
|---|---|---|
| `museumethnofun.com` | Unity WebGL client | Nginx static files from `/var/www/museum` |
| `api.museumethnofun.com` | Colyseus rooms + matchmaking | Node under PM2 on `127.0.0.1:2567`, proxied |

Split hosts so the client can move to a CDN later without touching the client's
`ServerConfig` endpoint.

---

## 1. DNS

Two A records at the registrar, both pointing at the VPS public IP:

```
museum      A   <VPS_IP>
api.museum  A   <VPS_IP>
```

Wait for propagation before running certbot — it validates over HTTP against
these names.

```bash
dig +short museumethnofun.com
dig +short api.museumethnofun.com
```

## 2. VPS prerequisites

```bash
sudo apt update
sudo apt install -y nginx mysql-server certbot python3-certbot-nginx git apache2-utils
# Node 20+ (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Firewall: allow 80 and 443 only. Port 2567 stays bound to loopback — Nginx is
the only thing that talks to it.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 3. Database

```bash
sudo mysql
```
```sql
CREATE DATABASE museum_minigames CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'museum'@'localhost' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON museum_minigames.* TO 'museum'@'localhost';
FLUSH PRIVILEGES;
```

Leave MySQL bound to `127.0.0.1` (the Debian/Ubuntu default). Nothing outside
the box needs it.

## 4. Server code

The server repo is not yet under version control locally. Initialise and push
it somewhere private first — deploying by `git pull` beats `scp`, because it
makes rollback a checkout.

```bash
# on the VPS
sudo mkdir -p /srv/museum && sudo chown $USER /srv/museum
git clone <your-remote> /srv/museum
cd /srv/museum

cp .env.production.example .env.production
$EDITOR .env.production          # fill DB_PASSWORD and the rest

npm ci
npm run db:migrate
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                      # run the command it prints, for boot survival
```

Verify locally before involving Nginx:

```bash
curl -s localhost:2567/hi        # expect the placeholder greeting
pm2 logs colyseus-app --lines 50
```

## 5. Nginx + TLS

Order matters: **certificate first, site config second.** The config ships with
explicit 443 blocks pointing at the cert, so certbot never needs to rewrite it.

```bash
sudo certbot certonly --nginx -d museumethnofun.com -d api.museumethnofun.com -d www.museumethnofun.com

sudo mkdir -p /var/www/museum
sudo cp deploy/nginx/museumethnofun.com.conf /etc/nginx/sites-available/
sudo ln -s ../sites-available/museumethnofun.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`$connection_upgrade` may only be defined once across all enabled sites — if
another site already defines it, `nginx -t` fails with "duplicate map" and you
delete the `map` block from the museum config. Check with
`grep -rn connection_upgrade /etc/nginx/`.

Renewal is a systemd timer installed with the certbot package; confirm with
`sudo certbot renew --dry-run`. Renewal replaces the certificate files only and
never edits site configs, so it is safe. Do **not** re-run `certbot --nginx`
after the site is installed — it appends duplicate 443 server blocks.

### The previous VPS was shared with `qurantv_webrtc` (not the current box)

Two consequences, both already hit once:

- `qurantv_webrtc` holds `listen 80 default_server` and `server_name _`, so it
  catches every hostname without an explicit block. When certbot ran *before*
  this site existed, it injected `museumethnofun.com` /
  `api.museumethnofun.com` server blocks into
  `/etc/nginx/sites-available/qurantv_webrtc` — serving the QuranTV site on the
  museum hostnames. Those cloned blocks were removed by hand. If you ever re-run
  `certbot --nginx` while the museum site is disabled, check that file again.
- `$connection_upgrade` may only be defined once across all enabled sites. The
  install script warns if another site already defines it; the map block in the
  museum config is the one to delete in that case.

```bash
grep -rn connection_upgrade /etc/nginx/
sudo grep -n server_name /etc/nginx/sites-available/qurantv_webrtc   # should list only _ and the nip.io name
```

If you want the monitor panel, create its password file:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-museum admin
```
…and set `MONITOR_ENABLED=1` in `.env.production`, then `pm2 restart colyseus-app`.
Both locks are needed — the env var mounts the route, Nginx guards it.

## 6. Client build

In Unity (`6000.3.19f1`): **Museum → Build → WebGL (Production)**, or headless:

```bash
Unity -quit -batchmode -projectPath . -executeMethod Museum.Build.Editor.BuildWebGL.Production
```

The build script forces Brotli compression, "Explicitly Thrown Exceptions Only",
and flips `ServerConfig.useDevEndpoint` off for the duration of the build, so
the shipped client points at `wss://api.museumethnofun.com`.

Upload. **Two flags matter, and both were learned the hard way (2026-09-09):**

```bash
chmod -R a+rX Builds/WebGL          # every build, not once — see below
rsync -avz --partial --exclude='.DS_Store' \
  Builds/WebGL/ <user>@<VPS_IP>:/var/www/museum/
ssh <host> 'chmod -R a+rX /var/www/museum'
```

- **`chmod` after *every* build.** Unity writes the `.br` files mode `600`. Nginx
  runs as `www-data`, cannot read them, and returns its 403 HTML page — which the
  Unity loader then tries to parse as game data:
  `Unknown data format (id="<html>\n<head><t")`. This is not a one-time fix to the
  output folder; a rebuild recreates the files at `600` again. Do it on both ends:
  locally before sending (`rsync -a` preserves the mode) and on the server after.
  macOS ships **openrsync**, which has no `--chmod` flag, so this is the only way
  short of `brew install rsync`.
- **No `--delete`.** It removes the old `Build/` files *before* the new ones finish
  arriving. If the transfer then dies — and a 142 MB payload over a
  `ControlMaster` session is long enough for that to happen — the site is left
  with an `index.html` pointing at four files that no longer exist, and every
  `Build/` request 404s. Upload first; clean up afterwards if you actually need to.
  Note the payload is *renamed* when built via `BuildWebGL` (`WebGL.data.br`)
  versus the Build Profile window (`<Product Name>.data.br`), so stale files from
  the other naming scheme can accumulate — remove those in a separate, deliberate
  step once the new build is confirmed serving.
- **`--partial`** keeps what transferred, so a dropped connection resumes instead
  of restarting 142 MB.

Verify the upload byte-for-byte rather than trusting the transfer — and **not**
with `curl --compressed`, which on macOS has no brotli support and silently
returns an empty body (you will hash `e3b0c442…855`, the SHA-256 of nothing, and
think the file is wrong):

```bash
for f in WebGL.data.br WebGL.wasm.br WebGL.framework.js.br; do
  L=$(shasum -a256 "Builds/WebGL/Build/$f" | awk '{print $1}')
  R=$(curl -s -H 'Accept-Encoding: br' \
        "https://museumethnofun.com/Build/$f" -o - | shasum -a256 | awk '{print $1}')
  [ "$L" = "$R" ] && echo "$f MATCH" || echo "$f MISMATCH"
done
```

The Nginx config declares the right `Content-Encoding` for both Unity naming
schemes — `*.unityweb` (Decompression Fallback ON) and `*.br` / `*.gz`
(fallback OFF) — so either build setting works without touching nginx.
Brotli-compressed builds served without those headers fail with
`Unable to parse Build/WebGL.data.unityweb`, or hang on the progress bar.

Check a build file's headers after uploading:

```bash
curl -sI https://museumethnofun.com/Build/WebGL.wasm.br | grep -i "content-encoding\|content-type"
```

## 7. Smoke test

1. `https://museumethnofun.com` loads and reaches the main menu.
2. Browser devtools → Network shows the socket to
   `wss://api.museumethnofun.com` upgrading (status 101), no mixed-content
   or CORS errors in the console.
3. Two tabs create/join the same room code and see each other.
4. Play a full Dakon game; refresh mid-game and confirm reconnect.
5. Leave a room idle for >5 minutes, then move — confirms the long
   `proxy_read_timeout` is doing its job.

## Redeploy

```bash
cd /srv/museum && git pull && npm ci && npm run build && pm2 restart colyseus-app
```

Client: rebuild in Unity, rsync again (§6 — `chmod` after the build, no
`--delete`). `index.html` is sent `no-cache` and the `Build/` files are
immutable-cached, so a redeploy takes effect on next load.

**Test a redeploy in a private window.** `Build/` files carry
`Cache-Control: public, max-age=31536000, immutable`. A browser that cached a
broken response — a 403 from the permission trap, or a 404 from a half-finished
`--delete` — keeps serving it, and Cmd+Shift+R does *not* evict it; that is what
`immutable` means. Clear via DevTools → Application → Clear site data.

## Known constraints

- **Single process.** `instances: 1` in `ecosystem.config.cjs` is load-bearing —
  see the comment there. Scaling past one process needs Redis presence + driver.
- **`/hi` and `/api/hello`** are template leftovers in `src/app.config.ts`. Handy
  as health checks; delete them if you'd rather not expose them.
- **No LAN fallback yet.** For a venue with unreliable internet, the same build
  runs against a local server; that's a separate setup (see docs/dev-plan.md §6b).
- **CORS is Colyseus's job, not nginx's.** `@colyseus/core`'s router attaches
  `Access-Control-Allow-Origin` (defaulting to the request Origin) to every
  matchmaking response and preflight. Adding the same headers in nginx sends two
  of each and browsers reject the request. To lock the origin down, override
  `matchMaker.controller.getCorsHeaders` in `src/app.config.ts`.
- **Dedicated box.** The current VPS (212.85.25.177) hosts only this project; the §5 `qurantv_webrtc` notes are history from the previous one.
