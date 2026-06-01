#!/usr/bin/env bash
# /opt/otuburu/backend/deploy.sh
# Runs on the server after each CI deploy.
# Called by the GitHub Actions SSH step.
#
# Expects:
#   /opt/otuburu/backend/docker-compose.yml  — copied fresh by CI
#   /opt/otuburu/backend/.env                — written fresh by CI
#   /opt/otuburu/frontend/                   — static files deployed by CI

set -euo pipefail

BACKEND=/opt/otuburu/backend
FRONTEND=/opt/otuburu/frontend
DOMAIN=otuburu.torama.money

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }

# ── 1. Pull latest images from GHCR ─────────────────────────────────────────
log "Pulling images..."
cd "${BACKEND}"
docker compose pull --quiet

# ── 2. Clean up orphan containers from interrupted prior deploys ────────────
#
# When `docker compose up` is killed mid-recreate (e.g. SSH timeout, OOM),
# Docker can leave a container with a hashed-prefix fallback name like
# `<hash>_backend-engine-1`. Subsequent compose runs see the canonical
# name as free and try to take it, but Docker's name-uniqueness check
# also matches the prefixed orphan's underlying name and rejects with:
#   "Conflict. The container name '/<hash>_backend-engine-1' is already
#    in use by container <id>. You have to remove (or rename)..."
# This loop kills any container whose name CONTAINS one of our service
# suffixes — covers both clean and hash-prefixed orphans. Safe because
# compose recreates them all anyway in step 3.
log "Cleaning up orphan containers from previous deploys..."
for svc in postgres engine gateway wallet staking; do
  orphans=$(docker ps -aq --filter "name=backend-${svc}-1" 2>/dev/null || true)
  if [ -n "${orphans}" ]; then
    log "  Removing ${svc} container(s): ${orphans}"
    docker rm -f ${orphans} >/dev/null 2>&1 || true
  fi
done

# ── 3. Restart containers ────────────────────────────────────────────────────
#
# `--force-recreate` makes compose handle stop + remove + create as one
# atomic per-container operation. Combined with the orphan cleanup above,
# this handles both clean redeploys and recovery from interrupted ones.
#
# `--remove-orphans` still drops any container compose no longer owns
# (so removed services don't leak across deploys).
log "Starting services..."
docker compose up -d --force-recreate --remove-orphans

# ── 4. Prune old images ──────────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 5. Install Apache vhost + reload ─────────────────────────────────────────
#
# Vhost target is `aaa-otuburu.conf` not `otuburu.conf` so it loads
# alphabetically before certbot's auto-generated `otuburu-le-ssl.conf`.
# Apache picks the first matching :443 vhost it encounters for a given
# ServerName — letterboxing ours first prevents certbot's stale config
# from shadowing our managed one (which broke /payments/* for a deploy
# cycle until manually diagnosed). We also dissite the certbot vhost
# proactively in case it gets recreated by a future renew run.
log "Configuring Apache..."
VHOST_SRC="${BACKEND}/infra/otuburu.torama.money.conf"
VHOST_DST="/etc/apache2/sites-available/aaa-otuburu.conf"

if [ -f "${VHOST_SRC}" ]; then
  # Enable required modules (idempotent)
  sudo -n a2enmod proxy proxy_http rewrite headers 2>/dev/null || true

  # Install/update vhost only when it changed
  if ! diff -q "${VHOST_SRC}" "${VHOST_DST}" >/dev/null 2>&1; then
    sudo -n cp "${VHOST_SRC}" "${VHOST_DST}" \
      && log "Apache vhost updated" \
      || log "WARNING: could not copy vhost (needs sudo). Run manually: sudo cp ${VHOST_SRC} ${VHOST_DST}"
  fi

  # Enable our site (idempotent)
  sudo -n a2ensite aaa-otuburu 2>/dev/null || true

  # Disable certbot's auto-generated shadow vhost if it exists. Certbot
  # creates `otuburu-le-ssl.conf` during initial SSL provisioning and may
  # recreate it during a `certbot renew --apache` if the apache hook
  # detects no SSL vhost for the cert. We already ship full SSL config in
  # our managed vhost (cert + key + options-ssl-apache include) so the
  # shadow is redundant — and harmful, since it precedes ours alphabetically
  # and used to shadow all our proxy rules.
  sudo -n a2dissite otuburu-le-ssl 2>/dev/null || true
  # Also disable the legacy non-prefixed name if it exists from older deploys
  sudo -n a2dissite otuburu 2>/dev/null || true
fi

if sudo -n apache2ctl configtest 2>/dev/null && sudo -n systemctl reload apache2 2>/dev/null; then
  ok "Apache reloaded"
else
  log "WARNING: Apache reload failed or needs manual sudo. Run on server:"
  log "  sudo apache2ctl configtest && sudo systemctl reload apache2"
fi

# ── 6. Health checks ─────────────────────────────────────────────────────────
log "Waiting for services..."
sleep 5

check() {
  local name=$1 url=$2
  if curl -fsS --max-time 5 "${url}" >/dev/null 2>&1; then
    ok "${name} OK"
  else
    die "${name} not responding at ${url} — run: docker compose -f ${BACKEND}/docker-compose.yml logs"
  fi
}

check "gateway"  "http://127.0.0.1:8082/healthz"
check "wallet"   "http://127.0.0.1:8083/healthz"
check "staking"  "http://127.0.0.1:8084/healthz"
check "frontend" "http://127.0.0.1/index.html"

ok "Deploy complete — https://${DOMAIN}"
