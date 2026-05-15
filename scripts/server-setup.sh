#!/usr/bin/env bash
# server-setup.sh — run ONCE as a sudo-capable user to set up the server
# so that subsequent operations need no sudo.
#
# Usage:  sudo bash /path/to/server-setup.sh
# After:  otuburu-logs, otuburu-deploy, otuburu-schema, otuburu-status
#         all work without sudo from user1's shell.

set -euo pipefail

OPT=/opt/otuburu
BIN=/usr/local/bin

log()  { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && die "Run with sudo: sudo bash $0"

# ── 1. Ensure otuburu user + group exist ─────────────────────────────────────
if ! id otuburu &>/dev/null; then
  log "Creating otuburu user..."
  useradd -r -s /bin/bash -d "${OPT}" otuburu
fi

# ── 2. Add user1 to the otuburu group (lets user1 read/write /opt/otuburu) ───
log "Adding user1 to otuburu group..."
usermod -aG otuburu user1

# ── 3. Add user1 to docker group (lets user1 run docker without sudo) ────────
log "Adding user1 to docker group..."
usermod -aG docker user1

# ── 4. Fix /opt/otuburu ownership + permissions ───────────────────────────────
log "Setting /opt/otuburu permissions..."
mkdir -p "${OPT}/backend/infra" "${OPT}/frontend"
chown -R otuburu:otuburu "${OPT}"
# group-writable so user1 (now in otuburu group) can write scripts there
chmod -R g+rwX "${OPT}"

# ── 5. Sudoers: passwordless for specific ops only ───────────────────────────
log "Installing sudoers entries..."
cat > /etc/sudoers.d/otuburu-ops << 'EOF'
# Allow user1 to reload Apache and copy the vhost config — no password needed
user1   ALL=(ALL) NOPASSWD: /bin/systemctl reload apache2
user1   ALL=(ALL) NOPASSWD: /bin/systemctl status apache2
user1   ALL=(ALL) NOPASSWD: /usr/sbin/apache2ctl -t
user1   ALL=(ALL) NOPASSWD: /bin/cp /opt/otuburu/backend/infra/otuburu.torama.money.conf /etc/apache2/sites-available/otuburu.conf
user1   ALL=(ALL) NOPASSWD: /usr/sbin/a2enmod *
user1   ALL=(ALL) NOPASSWD: /usr/sbin/a2ensite *

# Allow otuburu user the same (used by deploy.sh)
otuburu ALL=(ALL) NOPASSWD: /bin/systemctl reload apache2
otuburu ALL=(ALL) NOPASSWD: /bin/cp /opt/otuburu/backend/infra/otuburu.torama.money.conf /etc/apache2/sites-available/otuburu.conf
EOF
chmod 440 /etc/sudoers.d/otuburu-ops

# ── 6. Install wrapper scripts into /usr/local/bin ───────────────────────────

# otuburu-logs — tail wallet logs with auth highlighting
log "Installing otuburu-logs..."
cat > "${BIN}/otuburu-logs" << 'SCRIPT'
#!/usr/bin/env bash
exec bash /opt/otuburu/watch-auth.sh "$@"
SCRIPT

# otuburu-status — show all container statuses + health
cat > "${BIN}/otuburu-status" << 'SCRIPT'
#!/usr/bin/env bash
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Otuburu — Container Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Health checks"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
check() {
  local name=$1 url=$2
  if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
    printf '\033[1;32m  ✓ %s\033[0m\n' "${name}"
  else
    printf '\033[1;31m  ✗ %s  →  %s\033[0m\n' "${name}" "${url}"
  fi
}
check "gateway  (8082)" "http://127.0.0.1:8082/healthz"
check "wallet   (8083)" "http://127.0.0.1:8083/healthz"
check "frontend (80)"   "http://127.0.0.1/index.html"
check "admin panel"     "http://127.0.0.1:8083/admin"
echo ""
SCRIPT

# otuburu-schema — apply DB schema manually (idempotent)
cat > "${BIN}/otuburu-schema" << 'SCRIPT'
#!/usr/bin/env bash
SCHEMA=/opt/otuburu/backend/schema.sql
if [[ ! -f "${SCHEMA}" ]]; then
  echo "ERROR: schema not found at ${SCHEMA}" >&2
  exit 1
fi
echo "Applying schema to backend-postgres-1..."
docker exec -i backend-postgres-1 psql -U otuburu -d otuburu < "${SCHEMA}"
echo "Done."
SCRIPT

# otuburu-deploy — re-run deploy manually without triggering CI
cat > "${BIN}/otuburu-deploy" << 'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/otuburu/backend
echo "Pulling latest images..."
docker compose pull --quiet
echo "Restarting containers..."
docker compose up -d --remove-orphans
echo "Reloading Apache..."
sudo systemctl reload apache2
echo ""
echo "Status:"
docker ps --format 'table {{.Names}}\t{{.Status}}'
SCRIPT

# otuburu-apache — update and reload Apache vhost
cat > "${BIN}/otuburu-apache" << 'SCRIPT'
#!/usr/bin/env bash
SRC=/opt/otuburu/backend/infra/otuburu.torama.money.conf
DST=/etc/apache2/sites-available/otuburu.conf
if [[ ! -f "${SRC}" ]]; then
  echo "ERROR: vhost config not found at ${SRC}" >&2
  exit 1
fi
echo "Copying vhost config..."
sudo cp "${SRC}" "${DST}"
echo "Testing Apache config..."
sudo apache2ctl -t
echo "Reloading Apache..."
sudo systemctl reload apache2
echo "Done."
SCRIPT

# Make all wrappers executable
chmod +x "${BIN}/otuburu-logs" \
         "${BIN}/otuburu-status" \
         "${BIN}/otuburu-schema" \
         "${BIN}/otuburu-deploy" \
         "${BIN}/otuburu-apache"

ok "All wrappers installed in ${BIN}:"
ok "  otuburu-logs    — tail auth + wallet logs"
ok "  otuburu-status  — container health check"
ok "  otuburu-schema  — apply DB schema"
ok "  otuburu-deploy  — pull + restart containers"
ok "  otuburu-apache  — update + reload Apache vhost"
echo ""
log "NOTE: Log out and back in (or run 'newgrp docker') for docker group to take effect."
