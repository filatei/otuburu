#!/usr/bin/env bash
# Otuburu — git pull deploy script.
# Runs on the Linode. Idempotent. Re-run after every push to main.
#
# Usage on the Linode (as user1 or root):
#   sudo /home/otuburu/app/scripts/deploy.sh
#
# What it does (in order):
#   1. git pull (as the otuburu user — uses the deploy key)
#   2. npm ci --omit=dev
#   3. sync infra files from repo to system locations (vhost, systemd)
#   4. apache2ctl configtest && reload apache
#   5. systemctl restart otuburu
#   6. smoke-test the service on 127.0.0.1:8080

set -euo pipefail

APP_USER="${APP_USER:-otuburu}"
APP_DIR="/home/${APP_USER}/app"
PORT="${PORT:-8080}"
DOMAIN="${DOMAIN:-otuburu.torama.money}"
SERVICE_NAME="otuburu"
VHOST_FILE="/etc/apache2/sites-available/${DOMAIN}.conf"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo $0"
[ -d "${APP_DIR}/.git" ] || die "${APP_DIR} is not a git checkout — run server-bootstrap.sh first"

# 1. Pull as the otuburu user so the deploy key is honoured -----------------
log "git pull"
sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch --quiet origin
sudo -u "${APP_USER}" git -C "${APP_DIR}" reset --hard origin/main

GIT_REV="$(sudo -u "${APP_USER}" git -C "${APP_DIR}" rev-parse --short HEAD)"
log "checked out ${GIT_REV}"

# 2. Install production deps ------------------------------------------------
if [ -f "${APP_DIR}/package-lock.json" ]; then
  log "npm ci"
  sudo -u "${APP_USER}" bash -c "cd '${APP_DIR}' && npm ci --omit=dev --no-audit --no-fund"
else
  log "npm install (no lockfile present)"
  sudo -u "${APP_USER}" bash -c "cd '${APP_DIR}' && npm install --omit=dev --no-audit --no-fund"
fi

# 3. Sync infra files -------------------------------------------------------
REPO_VHOST="${APP_DIR}/infra/apache/${DOMAIN}.conf"
REPO_UNIT="${APP_DIR}/infra/systemd/otuburu.service"

if [ -f "${REPO_VHOST}" ]; then
  # Only overwrite the *:80 block; preserve the certbot-managed *:443 block.
  # Strategy: if the live file has a *:443 block, leave it alone — assume the
  # repo's *:80 block has not changed in a breaking way. To force a full
  # re-install of the vhost, delete the live file and re-run.
  if ! grep -q '<VirtualHost \*:443>' "${VHOST_FILE}" 2>/dev/null; then
    log "installing/updating vhost ${VHOST_FILE}"
    install -m 0644 "${REPO_VHOST}" "${VHOST_FILE}"
    a2ensite "${DOMAIN}.conf" >/dev/null || true
  else
    log "leaving ${VHOST_FILE} alone (TLS block present — delete the file and re-run to force)"
  fi
fi

if [ -f "${REPO_UNIT}" ]; then
  if ! cmp -s "${REPO_UNIT}" "${UNIT_FILE}"; then
    log "installing/updating systemd unit"
    install -m 0644 "${REPO_UNIT}" "${UNIT_FILE}"
    systemctl daemon-reload
  fi
fi

# 4. Apache -----------------------------------------------------------------
log "apache configtest"
apache2ctl configtest
systemctl reload apache2

# 5. Restart the app --------------------------------------------------------
log "restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 1
systemctl --no-pager --lines=0 status "${SERVICE_NAME}" | head -3

# 6. Smoke test -------------------------------------------------------------
log "smoke testing 127.0.0.1:${PORT}/api/symbols"
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/symbols" >/dev/null; then
  log "OK — deployed ${GIT_REV} to https://${DOMAIN}"
else
  die "app NOT responding on 127.0.0.1:${PORT} — check: journalctl -u ${SERVICE_NAME} -n 50"
fi
