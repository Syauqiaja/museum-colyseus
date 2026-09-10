# Deployment runbook — single VPS behind Traefik

One VPS (212.85.25.177, Hostinger) serves both halves of the project:

| Host | Serves | Backed by |
|---|---|---|
| `museumethnofun.com` (`www` → apex) | Unity WebGL client | `web` container (`nginx:alpine`) serving `/docker/museum/site` |
| `api.museumethnofun.com` | Colyseus rooms + matchmaking | Node under PM2 **on the host**, `127.0.0.1:2567` |

**Ports 80/443 belong to Traefik**, not to anything this repo installs. Hostinger's
Docker template runs it as its own compose project (`/docker/traefik-3z6t`):
host-networked, Docker-label provider only (`exposedbydefault=false`), HTTP → HTTPS
redirect, and an ACME resolver named `letsencrypt` that issues and renews every
certificate. So:

- Do **not** install nginx or certbot on the host. Host nginx cannot bind 80/443
  (`bind() to 0.0.0.0:80 failed (98: Address already in use)`), and Traefik already
  owns the certificates.
- Routes are Docker labels on containers in the `museum` compose project
  ([`deploy/traefik/`](traefik/) — the file on the box is
  `/docker/museum/docker-compose.yml`).
- Don't stop Traefik: it also fronts other projects on the box (e.g. `9router-qkir`).

Split hosts so the client can move to a CDN later without touching the client's
`ServerConfig` endpoint.

---

## 1. DNS

Three A records at the registrar, all pointing at the VPS public IP:

```
@    A   <VPS_IP>
api  A   <VPS_IP>
www  A   <VPS_IP>
```

Traefik requests a certificate on the first HTTPS request to each name, over the
HTTP-01 challenge — so the names must resolve to the box first.

```bash
dig +short museumethnofun.com api.museumethnofun.com www.museumethnofun.com
```

## 2. Game server (host)

Run as root. The script installs MySQL, Node 20 and PM2, opens only SSH and
80/443 in `ufw`, creates a `museum` user, a `museum_minigames` database and a
DB user with a generated password (written to `/srv/museum/.env.production`,
never printed), clones the repo to `/srv/museum`, migrates, builds, and starts
PM2 with boot survival:

```bash
curl -fsSL https://raw.githubusercontent.com/Syauqiaja/museum-colyseus/main/deploy/setup-vps.sh -o setup-vps.sh
bash setup-vps.sh packages
bash setup-vps.sh app            # ends with "local /hi: 200"
```

Each phase is safe to re-run. PM2 runs as the `museum` user, so its commands need
that user:

```bash
sudo -u museum pm2 ls
sudo -u museum pm2 logs colyseus-app --lines 50 --nostream
```

Port 2567 stays closed to the internet (`ufw`); only Traefik, on the same host
network, reaches it on `127.0.0.1`.

## 3. Traefik routes

```bash
mkdir -p /docker/museum/site
cp /srv/museum/deploy/traefik/docker-compose.yml /srv/museum/deploy/traefik/nginx.conf /docker/museum/
cd /docker/museum && docker compose config --quiet && docker compose up -d
```

- `web` carries the `museumethnofun.com` router and the `www` → apex redirect.
- `api` is a do-nothing, host-networked `alpine` container that only carries the
  `api.museumethnofun.com` router. Traefik resolves a host-networked container to
  `127.0.0.1`, so the router's port `2567` lands on the PM2 process. Traefik's
  Docker provider cannot route to a non-container on its own; this is the
  smallest thing that gives it one.

Verify (the first request may take a few seconds while the certificate is issued):

```bash
curl -sS https://api.museumethnofun.com/hi                    # placeholder greeting
curl -sSI https://www.museumethnofun.com | grep -i location   # → https://museumethnofun.com/
docker logs traefik-3z6t-traefik-1 --tail 30                  # if either fails
```

Hostinger's Docker Manager also shows (and can edit) the `museum` project. If you
change it there, copy the result back into `deploy/traefik/` so the repo stays the
record.

### Monitor panel

Off by default. Both locks are needed: `MONITOR_ENABLED=1` in `.env.production`
mounts the route, and a Traefik basic-auth router guards it. Add to the `api`
service's labels (hash from `htpasswd -nB admin`; double every `$` in compose):

```yaml
      - traefik.http.routers.museum-monitor.rule=Host(`api.museumethnofun.com`) && PathPrefix(`/monitor`)
      - traefik.http.routers.museum-monitor.entrypoints=websecure
      - traefik.http.routers.museum-monitor.tls.certresolver=letsencrypt
      - traefik.http.routers.museum-monitor.middlewares=museum-monitor-auth
      - traefik.http.routers.museum-monitor.service=museum-api
      - traefik.http.middlewares.museum-monitor-auth.basicauth.users=admin:$$2y$$05$$...
```

## 4. Client build

In Unity (`6000.3.19f1`): **Museum → Build → WebGL (Production)**, or headless
(only with the project closed in the editor):

```bash
Unity -quit -batchmode -projectPath . -executeMethod Museum.Build.Editor.BuildWebGL.Production
```

The build script forces Brotli compression, "Explicitly Thrown Exceptions Only",
and flips `ServerConfig.useDevEndpoint` off for the duration of the build, so the
shipped client points at `ServerConfig.prodEndpoint` = `wss://api.museumethnofun.com`.

**Change the endpoint in the Inspector, never by editing `ServerConfig.asset` on
disk (2026-09-11).** `BuildWebGL` calls `SetDirty` + `SaveAssets` on the editor's
in-memory copy — twice, to flip `useDevEndpoint` and to restore it — so an on-disk
edit made while the project is open is silently overwritten by the next build.

Upload. **Two flags matter, and both were learned the hard way (2026-09-09):**

```bash
chmod -R a+rX Builds/WebGL          # every build, not once — see below
rsync -avz --partial --exclude='.DS_Store' \
  Builds/WebGL/ root@<VPS_IP>:/docker/museum/site/
ssh root@<VPS_IP> 'chmod -R a+rX /docker/museum/site'
```

- **`chmod` after *every* build.** Unity writes the `.br` files mode `600`. The
  container's nginx workers run as `nginx`, cannot read them, and return a 403 HTML
  page — which the Unity loader then tries to parse as game data:
  `Unknown data format (id="<html>\n<head><t")`. A rebuild recreates the files at
  `600` again. Do it on both ends: locally before sending (`rsync -a` preserves the
  mode) and on the server after. macOS ships **openrsync**, which has no `--chmod`
  flag, so this is the only way short of `brew install rsync`.
- **No `--delete`.** It removes the old `Build/` files *before* the new ones finish
  arriving. If the transfer then dies, the site is left with an `index.html`
  pointing at files that no longer exist, and every `Build/` request 404s. Upload
  first; clean up afterwards if you actually need to. Note the payload is
  *renamed* when built via `BuildWebGL` (`WebGL.data.br`) versus the Build Profile
  window (`<Product Name>.data.br`), so stale files from the other naming scheme
  can accumulate — remove those in a separate, deliberate step once the new build
  is confirmed serving.
- **`--partial`** keeps what transferred, so a dropped connection resumes instead
  of restarting the whole payload.

Verify the upload byte-for-byte rather than trusting the transfer — and **not**
with `curl --compressed`, which on macOS has no brotli support and silently
returns an empty body (you will hash `e3b0c442…855`, the SHA-256 of nothing, and
think the file is wrong):

```bash
for f in WebGL.data.br WebGL.wasm.br WebGL.framework.js.br WebGL.loader.js; do
  L=$(shasum -a256 "Builds/WebGL/Build/$f" | awk '{print $1}')
  R=$(curl -s -H 'Accept-Encoding: br' \
        "https://museumethnofun.com/Build/$f" -o - | shasum -a256 | awk '{print $1}')
  [ "$L" = "$R" ] && echo "$f MATCH" || echo "$f MISMATCH"
done
```

The container's [`nginx.conf`](traefik/nginx.conf) declares `Content-Encoding: br`
and the right type for `*.data.br`, `*.wasm.br` and `*.js.br` — the layout
`BuildWebGL` produces (Brotli, Decompression Fallback off). A `*.unityweb` or
`*.gz` build would need matching blocks added first. Brotli files served without
those headers fail with `Unable to parse Build/...`, or hang on the progress bar.

```bash
curl -sI https://museumethnofun.com/Build/WebGL.wasm.br | grep -i "content-encoding\|content-type"
```

## 5. Smoke test

1. `https://museumethnofun.com` loads and reaches the main menu.
2. Browser devtools → Network shows the socket to
   `wss://api.museumethnofun.com` upgrading (status 101), no mixed-content
   or CORS errors in the console.
3. Two tabs create/join the same room code and see each other.
4. Play a full Dakon game; refresh mid-game and confirm reconnect.
5. Leave a room idle for >5 minutes, then move. Traefik v3 has a 60 s entrypoint
   read timeout; an idle game socket was checked to survive 75 s on 2026-09-11,
   and this step is the full-length check.

## Redeploy

Server (ends every live match — rooms are in memory):

```bash
sudo -u museum -H bash -lc 'cd /srv/museum && git pull && npm ci \
  && set -a && . ./.env.production && set +a && npm run db:migrate \
  && npm run build && pm2 restart colyseus-app'
```

Client: rebuild in Unity, upload again (§4 — `chmod` after the build, no
`--delete`). `index.html` is `no-cache` and `Build/` files are served
`max-age=0, must-revalidate` with ETags, so a returning browser revalidates
(cheap 304 when unchanged) and picks up a new build on its next load — no cache
clearing needed. The loader URLs also carry the build's `?v=` cache buster.

Refused Dakon drops are logged by the server as `[dakon] refused …` lines in
`sudo -u museum pm2 logs colyseus-app`.

## Known constraints

- **Single process.** `instances: 1` in `ecosystem.config.cjs` is load-bearing —
  see the comment there. Scaling past one process needs Redis presence + driver.
- **`/hi` and `/api/hello`** are template leftovers in `src/app.config.ts`. Handy
  as health checks; delete them if you'd rather not expose them.
- **No LAN fallback yet.** For a venue with unreliable internet, the same build
  runs against a local server; that's a separate setup (see docs/dev-plan.md §6b).
- **CORS is Colyseus's job, not the proxy's.** `@colyseus/core`'s router attaches
  `Access-Control-Allow-Origin` (defaulting to the request Origin) to every
  matchmaking response and preflight. Adding the same headers in Traefik (a
  `headers` middleware) sends two of each and browsers reject the request. To lock
  the origin down, override `matchMaker.controller.getCorsHeaders` in
  `src/app.config.ts`.
- **Shared Traefik.** The box's Traefik also serves other Hostinger projects;
  change routes only through the `museum` project's labels.
- **Previous box.** Until 2026-09-11 the project ran on 101.32.239.188 as
  `museum.fajrsyauqi.com`, with host nginx + certbot on a VPS shared with
  `qurantv_webrtc`. None of that setup applies here.
