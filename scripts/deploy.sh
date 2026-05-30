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

# ── 2. Restart containers ────────────────────────────────────────────────────
#
# `--force-recreate` makes compose handle stop + remove + create as one
# atomic per-container operation. That replaces the old hand-rolled
# port-eviction loop that used to live here — the loop raced with
# `compose up`, hitting "removal of container X is already in progress"
# whenever a container we'd just `docker rm`'d hadn't finished cleaning
# up before compose tried to recreate it. The eviction loop existed as a
# workaround for a Docker <24 bug where compose wouldn't reclaim ports
# from stopped-but-not-removed containers; that's been fixed for years.
#
# `--remove-orphans` still drops any container compose no longer owns
# (so removed services don't leak across deploys).
log "Starting services..."
docker compose up -d --force-recreate --remove-orphans

# ── 3. Prune old images ──────────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 4. Install Apache vhost + reload ─────────────────────────────────────────
log "Configuring Apache..."
VHOST_SRC="${BACKEND}/infra/otuburu.torama.money.conf"
VHOST_DST="/etc/apache2/sites-available/otuburu.conf"

if [ -f "${VHOST_SRC}" ]; then
  # Enable required modules (idempotent)
  sudo -n a2enmod proxy proxy_http rewrite headers 2>/dev/null || true

  # Install/update vhost only when it changed
  if ! diff -q "${VHOST_SRC}" "${VHOST_DST}" >/dev/null 2>&1; then
    sudo -n cp "${VHOST_SRC}" "${VHOST_DST}" \
      && log "Apache vhost updated" \
      || log "WARNING: could not copy vhost (needs sudo). Run manually: sudo cp ${VHOST_SRC} ${VHOST_DST}"
  fi

  # Enable site (idempotent)
  sudo -n a2ensite otuburu 2>/dev/null || true
fi

if sudo -n apache2ctl configtest 2>/dev/null && sudo -n systemctl reload apache2 2>/dev/null; then
  ok "Apache reloaded"
else
  log "WARNING: Apache reload failed or needs manual sudo. Run on server:"
  log "  sudo apache2ctl configtest && sudo systemctl reload apache2"
fi

# ── 5. Health checks ─────────────────────────────────────────────────────────
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
