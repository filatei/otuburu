#!/usr/bin/env bash
# setup-deploy-key.sh
# ─────────────────────────────────────────────────────────────────────────────
# Generates a fresh ed25519 deploy key, installs the public half on the
# Linode server, and uploads the private half to GitHub Actions secrets.
#
# Usage:
#   GH_TOKEN=ghp_xxxx bash scripts/setup-deploy-key.sh
#
# Requirements on your Mac: ssh, ssh-copy-id, node (for the GitHub API call)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GH_TOKEN="${GH_TOKEN:-}"
GH_USER="filatei"
GH_REPO="otuburu"
SERVER_HOST="otuburu.torama.money"
SERVER_USER="user1"
SERVER_PORT="22"
KEY_FILE="${HOME}/.ssh/otuburu_deploy_ed25519"

# ── 1. Validate GH_TOKEN ─────────────────────────────────────────────────────
if [[ -z "$GH_TOKEN" ]]; then
  echo "❌  GH_TOKEN is not set."
  echo "    Run: GH_TOKEN=ghp_xxxx bash scripts/setup-deploy-key.sh"
  exit 1
fi

# ── 2. Generate fresh ed25519 key pair ───────────────────────────────────────
echo ""
echo "🔑  Generating ed25519 deploy key at ${KEY_FILE} ..."
rm -f "${KEY_FILE}" "${KEY_FILE}.pub"
ssh-keygen -t ed25519 -C "otuburu-github-deploy" -f "${KEY_FILE}" -N ""
echo "    ✅  Key pair created."

# ── 3. Install public key on server ──────────────────────────────────────────
echo ""
echo "📤  Copying public key to ${SERVER_USER}@${SERVER_HOST}:${SERVER_PORT} ..."
echo "    (You may be prompted for your server password)"
ssh-copy-id -i "${KEY_FILE}.pub" -p "${SERVER_PORT}" "${SERVER_USER}@${SERVER_HOST}"
echo "    ✅  Public key installed on server."

# ── 4. Verify connectivity ────────────────────────────────────────────────────
echo ""
echo "🔗  Testing SSH connection ..."
ssh -i "${KEY_FILE}" -p "${SERVER_PORT}" -o StrictHostKeyChecking=no \
    "${SERVER_USER}@${SERVER_HOST}" "echo '    ✅  SSH connection works!'"

# ── 5. Upload secrets to GitHub via API ──────────────────────────────────────
echo ""
echo "🐙  Uploading LINODE_SSH_KEY and LINODE_SSH_PORT to GitHub ..."

node - <<NODEJS
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

const GH_TOKEN = '${GH_TOKEN}';
const GH_USER  = '${GH_USER}';
const GH_REPO  = '${GH_REPO}';

// Read private key — include full PEM with newlines
const privateKey = fs.readFileSync('${KEY_FILE}', 'utf8');
const secrets = {
  LINODE_SSH_KEY:  privateKey,
  LINODE_SSH_PORT: '22',
  LINODE_USER:     '${SERVER_USER}',
  LINODE_HOST:     'otuburu.torama.money',
};

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization:  'token ' + GH_TOKEN,
        Accept:         'application/vnd.github.v3+json',
        'User-Agent':   'otuburu-deploy-setup',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// GitHub requires libsodium/tweetsodium for encryption.
// We use the sodium-native or tweetsodium package if available,
// otherwise fall back to the GitHub API's own encryption endpoint approach.
// Since tweetsodium is already in node_modules from set-staking-secrets.mjs:
function encryptSecret(base64PublicKey, secretValue) {
  let sodium;
  try { sodium = require('./node_modules/tweetsodium'); }
  catch (e) {
    console.error('tweetsodium not found — run: npm install (from otuburu_live/)');
    process.exit(1);
  }
  const key       = Buffer.from(base64PublicKey, 'base64');
  const message   = Buffer.from(secretValue, 'utf-8');
  const encrypted = sodium.seal(message, key);
  return Buffer.from(encrypted).toString('base64');
}

async function main() {
  const pkRes = await ghRequest('GET', '/repos/' + GH_USER + '/' + GH_REPO + '/actions/secrets/public-key');
  if (pkRes.status !== 200) {
    console.error('❌  Could not fetch repo public key — HTTP', pkRes.status);
    process.exit(1);
  }
  const { key_id: keyId, key } = pkRes.body;

  for (const [name, value] of Object.entries(secrets)) {
    const encrypted = encryptSecret(key, value);
    const res = await ghRequest(
      'PUT',
      '/repos/' + GH_USER + '/' + GH_REPO + '/actions/secrets/' + name,
      { encrypted_value: encrypted, key_id: keyId }
    );
    if (res.status === 201 || res.status === 204) {
      const display = name === 'LINODE_SSH_KEY' ? '(private key — redacted)' : value;
      console.log('  ✅  ' + name + ' = ' + display);
    } else {
      console.log('  ❌  ' + name + ' — HTTP ' + res.status, JSON.stringify(res.body));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
NODEJS

echo ""
echo "✅  All done!"
echo ""
echo "Next steps:"
echo "  1. Re-run (or re-trigger) the GitHub Actions deploy workflow:"
echo "     https://github.com/${GH_USER}/${GH_REPO}/actions"
echo ""
echo "  2. Register the Paystack webhook once deploy succeeds:"
echo "     URL:    https://otuburu.torama.money/api/stake/webhook"
echo "     Events: charge.success, charge.failed"
echo "     https://dashboard.paystack.com/#/settings/developer"
echo ""
echo "  3. Add Linode IP to Google Workspace SMTP relay (if not done):"
echo "     admin.google.com → Apps → Gmail → Routing → SMTP relay"
echo "     Add IP: ${SERVER_HOST}/32 to the otuburu.torama.money relay rule"
