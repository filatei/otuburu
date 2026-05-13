#!/usr/bin/env bash
# Run once on a fresh Ubuntu 22.04 Linode VPS (as root).
# Sets up Docker, nginx, the otuburu app user, and passwordless deploy.
#
# Usage (from your Mac):
#   scp scripts/setup-server.sh root@<LINODE_IP>:/tmp/
#   ssh root@<LINODE_IP> bash /tmp/setup-server.sh
set -euo pipefail

DEPLOY_USER="otuburu"
APP_DIR="/home/$DEPLOY_USER/app"

echo "=== Otuburu server setup ==="

# ── System packages ───────────────────────────────────────────────────────────
apt-get update -q
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg ufw nginx gettext-base

# ── Docker ────────────────────────────────────────────────────────────────────
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

# ── App user ──────────────────────────────────────────────────────────────────
id "$DEPLOY_USER" &>/dev/null || useradd -m -s /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"

# Passwordless sudo for deploy script only
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose" \
  > /etc/sudoers.d/otuburu
chmod 440 /etc/sudoers.d/otuburu

mkdir -p "$APP_DIR"
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
echo "✓  User $DEPLOY_USER configured"

# ── App files ─────────────────────────────────────────────────────────────────
# The CI deploy step will copy these; bootstrap them so nginx can start.
cat > "$APP_DIR/docker-compose.yml" <<'COMPOSE'
services:
  engine:
    image: ghcr.io/filatei/otuburu-engine:staging
    restart: always
    environment:
      ENGINE_GRPC_ADDR: "0.0.0.0:9090"
      RUST_LOG: "otuburu_engine=info,warn"
    expose: ["9090"]
    networks: [internal]

  gateway:
    image: ghcr.io/filatei/otuburu-gateway:staging
    restart: always
    environment:
      PORT: "8082"
      ENGINE_ADDR: "engine:9090"
    ports: ["8082:8082"]
    networks: [internal]
    depends_on: [engine]

networks:
  internal:
    driver: bridge
COMPOSE
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/docker-compose.yml"

# Deploy script (called by CI)
cat > "$APP_DIR/deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
set -e
cd /home/otuburu/app
echo "[deploy] pulling images …"
docker compose pull
echo "[deploy] restarting services …"
docker compose up -d --remove-orphans
docker compose ps
echo "[deploy] done"
DEPLOY
chmod +x "$APP_DIR/deploy.sh"
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/deploy.sh"

# ── nginx reverse proxy ───────────────────────────────────────────────────────
cat > /etc/nginx/sites-available/otuburu <<'NGINX'
server {
    listen 80;
    server_name _;          # replace with staging.torama.money later

    # WebSocket upgrade
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

ln -sf /etc/nginx/sites-available/otuburu /etc/nginx/sites-enabled/otuburu
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "✓  nginx configured"

# ── Firewall ──────────────────────────────────────────────────────────────────
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "✓  Firewall enabled"

# ── GitHub Container Registry login ──────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  One manual step — log Docker into GHCR:"
echo "  (run as user $DEPLOY_USER)"
echo ""
echo "  su - $DEPLOY_USER"
echo "  echo <GITHUB_PAT> | docker login ghcr.io -u filatei --password-stdin"
echo ""
echo "  Or add GHCR_TOKEN secret to GitHub and CI will handle it."
echo "════════════════════════════════════════════════"
