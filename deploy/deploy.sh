#!/usr/bin/env bash
# Redeploy the game server on the production VPS from origin/main.
#
#   deploy/deploy.sh        # asks before restarting (a restart ends every live match)
#   deploy/deploy.sh -y     # no prompt
#
# The VPS checkout at /srv/museum pulls from GitHub; it never receives local files.
# So this script refuses to run unless the local HEAD is exactly origin/main —
# otherwise "deploy" would ship something other than what you are looking at.
#
# Env overrides: DEPLOY_USER (default root), DEPLOY_HOST (default 212.85.25.177).
# The user must be able to `sudo -u museum` on the box; root can.
set -euo pipefail

DEPLOY_USER=${DEPLOY_USER:-root}
DEPLOY_HOST=${DEPLOY_HOST:-212.85.25.177}
TARGET="$DEPLOY_USER@$DEPLOY_HOST"
API_URL=https://api.museumethnofun.com
BRANCH=main

yes=0
case "${1:-}" in
  "") ;;
  -y) yes=1 ;;
  *) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

cd "$(dirname "$0")/.."

# One shared connection for every ssh below: authenticate (key passphrase or
# password) once, not once per command.
CONTROL_DIR=$(mktemp -d /tmp/museum-deploy.XXXXXX)   # short: unix socket paths cap at 104 bytes
SSH_OPTS=(-o ConnectTimeout=10 -o ControlMaster=auto -o "ControlPath=$CONTROL_DIR/%C" -o ControlPersist=5m)
cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$TARGET" 2>/dev/null || true; rm -rf "$CONTROL_DIR"; }
trap cleanup EXIT
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking the local tree matches origin/$BRANCH"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes — commit and push first"
git fetch -q origin "$BRANCH"
local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse "origin/$BRANCH")
[ "$local_head" = "$remote_head" ] || die "HEAD ($(git rev-parse --short HEAD)) is not origin/$BRANCH ($(git rev-parse --short "origin/$BRANCH")). Merge and push to $BRANCH first."

say "Running the test suite"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm test

say "Connecting to $TARGET"
remote true || die "cannot ssh to $TARGET"

deployed=$(remote "sudo -u museum git -C /srv/museum rev-parse HEAD")
echo "deployed: ${deployed:0:7}   new: ${remote_head:0:7}"
if [ "$deployed" = "$remote_head" ]; then
  say "Server already runs $(git rev-parse --short HEAD) — nothing to do"
  exit 0
fi
git --no-pager log --oneline "$deployed..$remote_head" 2>/dev/null || true

if [ "$yes" -eq 0 ]; then
  read -r -p "Restarting ends every live match. Deploy now? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"
fi

say "Pulling, migrating, building and restarting on the VPS"
# --ff-only: a diverged server checkout stops the deploy instead of merging on the box.
remote "sudo -u museum -H bash -lc 'set -e; cd /srv/museum \
  && git fetch -q origin $BRANCH && git checkout -q $BRANCH && git merge --ff-only -q origin/$BRANCH \
  && npm ci --no-audit --no-fund \
  && set -a && . ./.env.production && set +a && npm run db:migrate \
  && npm run build && pm2 restart colyseus-app --update-env && pm2 save'"

say "Health check $API_URL/hi"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "$API_URL/hi" >/dev/null; then
    now=$(remote "sudo -u museum git -C /srv/museum rev-parse --short HEAD")
    say "Server is up on $now"
    exit 0
  fi
  sleep 3
done
remote "sudo -u museum pm2 logs colyseus-app --lines 40 --nostream" || true
die "$API_URL/hi did not answer after 30 s — logs above"
