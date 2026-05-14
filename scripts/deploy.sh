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
log "Starting services..."
docker compose up -d --remove-orphans

# ── 3. Prune old images ──────────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 4. Reload Apache (picks up any vhost changes) ────────────────────────────
log "Reloading Apache..."
sudo systemctl reload apache2

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
check "frontend" "http://127.0.0.1/index.html"

ok "Deploy complete — https://${DOMAIN}"
