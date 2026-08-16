# Deployment runbook — single VPS

One VPS serves both halves of the project:

| Host | Serves | Backed by |
|---|---|---|
| `museum.fajrsyauqi.com` | Unity WebGL client | Nginx static files from `/var/www/museum` |
| `api.museum.fajrsyauqi.com` | Colyseus rooms + matchmaking | Node under PM2 on `127.0.0.1:2567`, proxied |

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
dig +short museum.fajrsyauqi.com
dig +short api.museum.fajrsyauqi.com
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

```bash
sudo mkdir -p /var/www/museum
sudo cp deploy/nginx/museum.fajrsyauqi.com.conf /etc/nginx/sites-available/
sudo ln -s ../sites-available/museum.fajrsyauqi.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d museum.fajrsyauqi.com -d api.museum.fajrsyauqi.com
```

Certbot rewrites both server blocks in place, adding the 443 listeners and an
http→https redirect. Renewal is installed as a systemd timer; confirm with
`sudo certbot renew --dry-run`.

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
the shipped client points at `wss://api.museum.fajrsyauqi.com`.

Upload:

```bash
rsync -avz --delete Builds/WebGL/ <user>@<VPS_IP>:/var/www/museum/
```

The Nginx config declares `Content-Encoding: br` on the `*.unityweb` files.
Brotli-compressed builds served without those headers fail with
`Unable to parse Build/WebGL.data.unityweb` — if you switch the build to Gzip,
change `br` to `gzip` in the config to match.

## 7. Smoke test

1. `https://museum.fajrsyauqi.com` loads and reaches the main menu.
2. Browser devtools → Network shows the socket to
   `wss://api.museum.fajrsyauqi.com` upgrading (status 101), no mixed-content
   or CORS errors in the console.
3. Two tabs create/join the same room code and see each other.
4. Play a full Dakon game; refresh mid-game and confirm reconnect.
5. Leave a room idle for >5 minutes, then move — confirms the long
   `proxy_read_timeout` is doing its job.

## Redeploy

```bash
cd /srv/museum && git pull && npm ci && npm run build && pm2 restart colyseus-app
```

Client: rebuild in Unity, rsync again. `index.html` is sent `no-cache` and the
`Build/` files are immutable-cached, so a redeploy takes effect on next load.

## Known constraints

- **Single process.** `instances: 1` in `ecosystem.config.cjs` is load-bearing —
  see the comment there. Scaling past one process needs Redis presence + driver.
- **`/hi` and `/api/hello`** are template leftovers in `src/app.config.ts`. Handy
  as health checks; delete them if you'd rather not expose them.
- **No LAN fallback yet.** For a venue with unreliable internet, the same build
  runs against a local server; that's a separate setup (see docs/dev-plan.md §6b).
