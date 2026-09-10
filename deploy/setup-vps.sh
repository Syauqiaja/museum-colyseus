#!/usr/bin/env bash
# One-time setup of the Colyseus server on a fresh Ubuntu/Debian VPS (run as root).
#
#   bash deploy/setup-vps.sh packages   # MySQL, Node 20, pm2, firewall
#   bash deploy/setup-vps.sh app        # app user, DB + user (generated password), clone,
#                                       # .env.production, migrate, build, pm2 + boot survival
#
# Ports 80/443 are NOT this script's business: on the production box they belong to
# Traefik, which routes by Docker labels and handles TLS — see deploy/traefik/ and
# deploy/README.md. So no nginx or certbot is installed here.
#
# Each phase is safe to re-run after fixing whatever stopped it.
set -euo pipefail

APP_USER=museum
APP_DIR=/srv/museum
REPO=https://github.com/Syauqiaja/museum-colyseus.git
DB_NAME=museum_minigames
DB_USER=museum

phase_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q mysql-server git curl ufw rsync
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -q nodejs
  fi
  command -v pm2 >/dev/null || npm install -g pm2
  # 2567 stays closed: Traefik reaches it on 127.0.0.1.
  ufw allow OpenSSH
  ufw allow 80,443/tcp
  ufw --force enable
  echo "node $(node -v)  npm $(npm -v)  pm2 $(pm2 -v)"
}

phase_app() {
  id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
  mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"

  if [ ! -d "$APP_DIR/.git" ]; then
    sudo -u "$APP_USER" git clone -q "$REPO" "$APP_DIR"
  fi

  local env="$APP_DIR/.env.production"
  if [ ! -f "$env" ]; then
    local pw; pw=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 32)
    mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$pw';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$pw';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
    cat > "$env" <<ENV
# Written by deploy/setup-vps.sh. Gitignored; never commit.
PORT=2567
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$pw
DB_NAME=$DB_NAME
DB_POOL_SIZE=10
DB_CONNECT_TIMEOUT_MS=5000
DB_DISABLED=
MONITOR_ENABLED=
ENV
    chown "$APP_USER:$APP_USER" "$env" && chmod 600 "$env"
    echo ".env.production written (DB password generated, not printed)"
  fi

  sudo -u "$APP_USER" -H bash -lc "
    set -euo pipefail
    cd '$APP_DIR'
    git pull -q
    npm ci --silent
    set -a; . ./.env.production; set +a
    npm run db:migrate --silent
    npm run build --silent
    pm2 startOrRestart ecosystem.config.cjs
    pm2 save
  "
  env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
  sleep 3
  curl -s -o /dev/null -w "local /hi: %{http_code}\n" localhost:2567/hi
}

"phase_${1:?usage: $0 packages|app}"
