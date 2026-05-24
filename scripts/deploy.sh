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

# ── 2. Evict any stale containers holding our ports ──────────────────────────
log "Clearing stale port bindings..."
for port in 8082 8083; do
  cid=$(docker ps --filter "publish=${port}" -q 2>/dev/null || true)
  if [ -n "${cid}" ]; then
    log "  Stopping container ${cid} (was holding :${port})"
    docker stop "${cid}" >/dev/null 2>&1 || true
    docker rm   "${cid}" >/dev/null 2>&1 || true
  fi
done

# ── 3. Restart containers ────────────────────────────────────────────────────
log "Starting services..."
docker compose up -d --remove-orphans

# ── 4. Prune old images ──────────────────────────────────────────────────────
docker image prune -f --filter "until=24h" >/dev/null 2>&1 || true

# ── 5. Reload Apache (picks up any vhost changes) ────────────────────────────
log "Reloading Apache..."
if sudo -n systemctl reload apache2 2>/dev/null; then
  ok "Apache reloaded"
else
  log "WARNING: could not reload Apache (no passwordless sudo). Run once on server:"
  log "  echo 'otuburu ALL=(ALL) NOPASSWD: /bin/systemctl reload apache2' | sudo tee /etc/sudoers.d/otuburu-apache"
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
