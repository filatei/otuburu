#!/usr/bin/env bash
# Deploy Otuburu alongside existing apps on a Linode server.
# Safe to run on a server already running other services — only ADDS new config.
#
# Usage (from your Mac):
#   scp scripts/setup-server.sh root@104.237.157.53:/tmp/
#   ssh root@104.237.157.53 bash /tmp/setup-server.sh
set -euo pipefail

DEPLOY_USER="otuburu"
APP_DIR="/home/$DEPLOY_USER/app"

echo "=== Otuburu server setup (safe for existing apps) ==="

# ── Docker (install only if missing) ─────────────────────────────────────────
if command -v docker &>/dev/null; then
  echo "✓  Docker already installed: $(docker --version)"
else
  echo "==> Installing Docker …"
  apt-get update -q
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
  echo "✓  Docker installed"
fi

# ── Install gettext (for envsubst) if needed ─────────────────────────────────
command -v envsubst &>/dev/null || apt-get install -y --no-install-recommends gettext-base

# ── App user ──────────────────────────────────────────────────────────────────
if id "$DEPLOY_USER" &>/dev/null; then
  echo "✓  User $DEPLOY_USER already exists"
else
  useradd -m -s /bin/bash "$DEPLOY_USER"
  echo "✓  Created user $DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

# Passwordless docker for deploy (no sudo needed for other commands)
cat > /etc/sudoers.d/otuburu <<'SUDOERS'
otuburu ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose
SUDOERS
chmod 440 /etc/sudoers.d/otuburu
echo "✓  Passwordless docker configured for $DEPLOY_USER"

# ── App directory + files ─────────────────────────────────────────────────────
mkdir -p "$APP_DIR"

cat > "$APP_DIR/docker-compose.yml" <<'COMPOSE'
services:
  otuburu-engine:
    image: ghcr.io/filatei/otuburu-engine:staging
    restart: always
    container_name: otuburu-engine
    environment:
      ENGINE_GRPC_ADDR: "0.0.0.0:9090"
      RUST_LOG: "otuburu_engine=info,warn"
    expose:
      - "9090"
    networks:
      - otuburu-net

  otuburu-gateway:
    image: ghcr.io/filatei/otuburu-gateway:staging
    restart: always
    container_name: otuburu-gateway
    environment:
      PORT: "8082"
      ENGINE_ADDR: "otuburu-engine:9090"
    ports:
      - "127.0.0.1:8082:8082"
    networks:
      - otuburu-net
    depends_on:
      - otuburu-engine

networks:
  otuburu-net:
    driver: bridge
COMPOSE

cat > "$APP_DIR/deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
set -e
cd /home/otuburu/app
echo "[otuburu-deploy] pulling images …"
docker compose pull
echo "[otuburu-deploy] restarting …"
docker compose up -d --remove-orphans
docker compose ps
echo "[otuburu-deploy] done ✓"
DEPLOY

chmod +x "$APP_DIR/deploy.sh"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
echo "✓  App files written to $APP_DIR"

# ── nginx — add Otuburu site only (don't touch existing sites) ────────────────
if ! command -v nginx &>/dev/null; then
  apt-get install -y --no-install-recommends nginx
fi

cat > /etc/nginx/sites-available/otuburu-staging <<'NGINX'
server {
    listen 8080;          # separate port so existing sites are untouched
    server_name _;        # update to staging.torama.money once DNS is set

    # WebSocket upgrade for /ws
    location /ws {
        proxy_pass         http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass       http://127.0.0.1:8082;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/otuburu-staging \
       /etc/nginx/sites-enabled/otuburu-staging
nginx -t && systemctl reload nginx
echo "✓  nginx site added on port 8080 (existing sites untouched)"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Server setup complete!"
echo ""
echo "  Otuburu staging API will be at:"
echo "  http://104.237.157.53:8080/api/symbols"
echo "  ws://104.237.157.53:8080/ws"
echo ""
echo "  Next — add these 3 secrets to GitHub:"
echo "  Settings → Secrets → Actions"
echo ""
echo "  LINODE_HOST    = 104.237.157.53"
echo "  LINODE_SSH_KEY = (your private SSH key)"
echo "  GHCR_TOKEN     = (GitHub PAT with read:packages)"
echo ""
echo "  Generate GHCR_TOKEN at:"
echo "  https://github.com/settings/tokens/new"
echo "  → Scopes: read:packages"
echo "══════════════════════════════════════════════════════"
