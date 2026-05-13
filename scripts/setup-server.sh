#!/usr/bin/env bash
# Deploy Otuburu alongside existing apps on a Linode server.
# Run with sudo as a non-root user:
#   sudo bash /tmp/setup-server.sh
set -euo pipefail

DEPLOY_USER="otuburu"
APP_DIR="/home/$DEPLOY_USER/app"

echo "=== Otuburu server setup (Apache, safe for existing apps) ==="

# ── Docker (already installed — skip) ────────────────────────────────────────
if command -v docker &>/dev/null; then
  echo "✓  Docker: $(docker --version)"
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

# ── App user + docker group ───────────────────────────────────────────────────
id "$DEPLOY_USER" &>/dev/null && echo "✓  User $DEPLOY_USER exists" \
  || { useradd -m -s /bin/bash "$DEPLOY_USER"; echo "✓  Created $DEPLOY_USER"; }
usermod -aG docker "$DEPLOY_USER"

# Passwordless docker only — no blanket sudo
cat > /etc/sudoers.d/otuburu <<'SUDOERS'
otuburu ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose
SUDOERS
chmod 440 /etc/sudoers.d/otuburu
echo "✓  Passwordless docker for $DEPLOY_USER"

# ── SSH key for CI (generates a deploy keypair if one doesn't exist) ──────────
SSH_DIR="/home/$DEPLOY_USER/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [[ ! -f "$SSH_DIR/id_ed25519" ]]; then
  ssh-keygen -t ed25519 -C "otuburu-deploy" -N "" -f "$SSH_DIR/id_ed25519"
  echo "✓  Generated deploy keypair"
fi
# Authorise the public key for SSH login
cat "$SSH_DIR/id_ed25519.pub" >> "$SSH_DIR/authorized_keys"
sort -u "$SSH_DIR/authorized_keys" -o "$SSH_DIR/authorized_keys"
chmod 600 "$SSH_DIR/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR"
echo "✓  SSH authorized_keys configured"

# ── App files ─────────────────────────────────────────────────────────────────
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

# ── Apache reverse proxy ──────────────────────────────────────────────────────
apt-get install -y --no-install-recommends apache2

# Enable required modules
a2enmod proxy proxy_http proxy_wstunnel rewrite headers

# Add port 8080 if not already listening
grep -q "^Listen 8080" /etc/apache2/ports.conf \
  || echo "Listen 8080" >> /etc/apache2/ports.conf

cat > /etc/apache2/sites-available/otuburu-staging.conf <<'APACHE'
<VirtualHost *:8080>
    ServerName otuburu-staging

    ProxyPreserveHost On
    RewriteEngine On

    # WebSocket upgrade for /ws
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule ^/ws$  ws://127.0.0.1:8082/ws  [P,L]

    ProxyPass        /ws  ws://127.0.0.1:8082/ws
    ProxyPassReverse /ws  ws://127.0.0.1:8082/ws

    ProxyPass        /   http://127.0.0.1:8082/
    ProxyPassReverse /   http://127.0.0.1:8082/

    ErrorLog  ${APACHE_LOG_DIR}/otuburu-error.log
    CustomLog ${APACHE_LOG_DIR}/otuburu-access.log combined
</VirtualHost>
APACHE

a2ensite otuburu-staging
apache2ctl configtest && systemctl reload apache2
echo "✓  Apache site enabled on port 8080"

# ── Print the deploy private key for GitHub secret ────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Add these secrets to GitHub:"
echo "  repo → Settings → Secrets → Actions"
echo ""
echo "  LINODE_HOST    = 104.237.157.53"
echo "  LINODE_SSH_KEY = (private key below — copy ALL lines including header)"
echo ""
cat "$SSH_DIR/id_ed25519"
echo ""
echo "  GHCR_TOKEN = GitHub PAT with read:packages"
echo "  https://github.com/settings/tokens/new"
echo ""
echo "  Otuburu will be live at:"
echo "  http://104.237.157.53:8080/api/symbols"
echo "  ws://104.237.157.53:8080/ws"
echo "══════════════════════════════════════════════════════"
