#!/usr/bin/env bash
# Otuburu — one-shot server bootstrap.
# Run ONCE on the Linode (or any time you need to re-prep). Idempotent.
#
# Usage:
#   1. scp this file up (or paste it):
#        scp -P 2525 scripts/server-bootstrap.sh user1@HOST:/tmp/
#   2. sudo bash /tmp/server-bootstrap.sh
#   3. Copy the printed SSH public key into
#        GitHub → repo → Settings → Deploy keys → Add deploy key
#      (allow read-only — do NOT tick "Allow write access")
#   4. Re-run with REPO_URL set to clone the repo:
#        sudo REPO_URL=git@github.com:USER/otuburu.git bash /tmp/server-bootstrap.sh
#
# What it sets up:
#   - otuburu system user with /home/otuburu, app/ and logs/ dirs
#   - SSH keypair for that user under /home/otuburu/.ssh/id_ed25519
#   - github.com host-key pre-trust in known_hosts (no manual y/n prompt)
#   - Node 20 (via NodeSource) if not already present
#   - Repo cloned to /home/otuburu/app  (only if REPO_URL is set)

set -euo pipefail

APP_USER="${APP_USER:-otuburu}"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/app"
LOG_DIR="${APP_HOME}/logs"
SSH_DIR="${APP_HOME}/.ssh"
KEY_FILE="${SSH_DIR}/id_ed25519"
REPO_URL="${REPO_URL:-}"

log() { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash $0"

# 1. otuburu user -----------------------------------------------------------
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  log "creating system user ${APP_USER}"
  adduser --system --group --home "${APP_HOME}" --shell /bin/bash "${APP_USER}"
else
  log "user ${APP_USER} exists"
fi
mkdir -p "${APP_DIR}" "${LOG_DIR}" "${SSH_DIR}"
chmod 700 "${SSH_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}"

# 2. SSH deploy key for github ----------------------------------------------
if [ ! -f "${KEY_FILE}" ]; then
  log "generating SSH deploy key at ${KEY_FILE}"
  sudo -u "${APP_USER}" ssh-keygen -t ed25519 -N '' -C "otuburu-deploy@$(hostname)" -f "${KEY_FILE}" >/dev/null
fi

# Trust github.com so the first clone doesn't hang on a y/n prompt.
KNOWN_HOSTS="${SSH_DIR}/known_hosts"
if ! sudo -u "${APP_USER}" ssh-keygen -F github.com -f "${KNOWN_HOSTS}" >/dev/null 2>&1; then
  log "adding github.com to known_hosts"
  sudo -u "${APP_USER}" bash -c "ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >> '${KNOWN_HOSTS}'"
  chmod 600 "${KNOWN_HOSTS}"
  chown "${APP_USER}:${APP_USER}" "${KNOWN_HOSTS}"
fi

# Per-user ssh config so `git clone` Just Works.
SSH_CONFIG="${SSH_DIR}/config"
if [ ! -f "${SSH_CONFIG}" ]; then
  log "writing ssh config"
  cat > "${SSH_CONFIG}" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${KEY_FILE}
  IdentitiesOnly yes
EOF
  chmod 600 "${SSH_CONFIG}"
  chown "${APP_USER}:${APP_USER}" "${SSH_CONFIG}"
fi

# 3. Node 20 ----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v(20|22)\.'; then
  log "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
log "node $(node --version)"

# 4. Repo clone (only if REPO_URL is provided) ------------------------------
if [ -n "${REPO_URL}" ]; then
  if [ ! -d "${APP_DIR}/.git" ]; then
    # Make sure target is empty for clone
    if [ -n "$(ls -A "${APP_DIR}" 2>/dev/null)" ]; then
      die "${APP_DIR} is non-empty — move existing contents aside before cloning"
    fi
    log "cloning ${REPO_URL} into ${APP_DIR}"
    sudo -u "${APP_USER}" git clone "${REPO_URL}" "${APP_DIR}"
    log "installing production deps"
    sudo -u "${APP_USER}" bash -c "cd '${APP_DIR}' && npm install --omit=dev --no-audit --no-fund"
    log "next step:"
    log "  sudo ${APP_DIR}/scripts/deploy.sh"
  else
    log "${APP_DIR} is already a git checkout — skipping clone"
  fi
else
  log "REPO_URL not set — skipping clone step"
fi

echo
echo "======================================================================"
echo "Public key to add as a Deploy Key on the GitHub repo (read-only):"
echo "----------------------------------------------------------------------"
cat "${KEY_FILE}.pub"
echo "----------------------------------------------------------------------"
echo
echo "Next:"
echo "  1. Copy the line above."
echo "  2. GitHub → your-org/otuburu → Settings → Deploy keys → Add deploy key"
echo "     Title: linode-104.237.157.53"
echo "     Allow write access: LEAVE UNCHECKED"
echo "  3. Re-run with REPO_URL set:"
echo "       sudo REPO_URL=git@github.com:YOUR_USER/otuburu.git bash $0"
echo "======================================================================"
