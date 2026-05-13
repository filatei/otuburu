#!/usr/bin/env node
/**
 * github-secrets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds GitHub Actions secrets for the Otuburu deploy workflow.
 * Uses only Node.js built-ins (crypto, https, fs) + one npm dep (tweetsodium).
 *
 * Run:
 *   cd otuburu_live
 *   npm install tweetsodium          ← one-time
 *   GH_TOKEN=ghp_xxxx \
 *   LINODE_SSH_KEY_PATH=~/.ssh/id_rsa \
 *   node scripts/github-secrets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import https    from 'https';
import fs       from 'fs';
import path     from 'path';
import os       from 'os';
import readline from 'readline';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── config ───────────────────────────────────────────────────────────────────
const GH_TOKEN   = process.env.GH_TOKEN || '';
const GH_USER    = 'filatei';
const GH_REPO    = 'otuburu';

const LINODE_HOST = '104.237.157.53';
const LINODE_USER = 'user1';
const LINODE_PORT = '2525';

// ── helpers ───────────────────────────────────────────────────────────────────
function die(msg) { console.error('❌ ', msg); process.exit(1); }

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'otuburu-setup',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encryptSecret(base64PublicKey, secretValue) {
  let sodium;
  try { sodium = require('tweetsodium'); }
  catch {
    die('tweetsodium not found.\nRun:  npm install tweetsodium   then re-run this script.');
  }
  const key     = Buffer.from(base64PublicKey, 'base64');
  const message = Buffer.from(secretValue, 'utf-8');
  const encrypted = sodium.seal(message, key);
  return Buffer.from(encrypted).toString('base64');
}

async function getRepoPublicKey() {
  const { status, body } = await ghRequest('GET', `/repos/${GH_USER}/${GH_REPO}/actions/secrets/public-key`);
  if (status !== 200) die(`Could not fetch repo public key (HTTP ${status}): ${JSON.stringify(body)}`);
  return { keyId: body.key_id, key: body.key };
}

async function putSecret(name, value, keyId, pubKey) {
  const encryptedValue = encryptSecret(pubKey, value);
  const { status } = await ghRequest(
    'PUT',
    `/repos/${GH_USER}/${GH_REPO}/actions/secrets/${name}`,
    { encrypted_value: encryptedValue, key_id: keyId },
  );
  if (status === 201 || status === 204) {
    console.log(`  ✅  ${name}`);
  } else {
    console.log(`  ❌  ${name} — HTTP ${status}`);
  }
}

async function enableBranchProtection() {
  const { status, body } = await ghRequest(
    'PUT',
    `/repos/${GH_USER}/${GH_REPO}/branches/main/protection`,
    {
      required_status_checks: {
        strict: true,
        contexts: ['Rust engine', 'Go services', 'Node demo lint', 'Terraform validate'],
      },
      enforce_admins: false,
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    },
  );
  if (status === 200) {
    console.log('  ✅  Branch protection enabled on main');
  } else {
    console.log(`  ⚠️   Branch protection — HTTP ${status}`);
    console.log('       (Requires GitHub Pro/Team for private repos.)');
    console.log('       Set manually: Settings → Branches → Add rule → main');
  }
}

function findSshKey() {
  const envPath = process.env.LINODE_SSH_KEY_PATH;
  if (envPath) {
    const p = envPath.replace('~', os.homedir());
    if (!fs.existsSync(p)) die(`LINODE_SSH_KEY_PATH=${envPath} does not exist`);
    return p;
  }
  const candidates = [
    path.join(os.homedir(), '.ssh', 'id_otuburu_deploy'),
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_rsa'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  die(
    'No SSH private key found.\n' +
    'Set LINODE_SSH_KEY_PATH=/path/to/key or generate one:\n' +
    '  ssh-keygen -t ed25519 -f ~/.ssh/id_otuburu_deploy\n' +
    '  ssh-copy-id -i ~/.ssh/id_otuburu_deploy.pub -p 2525 user1@104.237.157.53'
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!GH_TOKEN) die('GH_TOKEN is not set.\nRun: GH_TOKEN=ghp_xxxx node scripts/github-secrets.mjs');

  // Verify token
  const check = await ghRequest('GET', '/user');
  if (check.status !== 200) die(`GitHub token invalid — HTTP ${check.status}`);
  console.log(`\n🔑  Authenticated as: ${check.body.login}`);
  console.log(`    Setting secrets on ${GH_USER}/${GH_REPO}\n`);

  const sshKeyPath  = findSshKey();
  const sshKeyValue = fs.readFileSync(sshKeyPath, 'utf-8');
  console.log(`Using SSH key: ${sshKeyPath}`);

  const { keyId, key } = await getRepoPublicKey();

  console.log('\nAdding secrets:');
  await putSecret('LINODE_HOST',     LINODE_HOST,  keyId, key);
  await putSecret('LINODE_USER',     LINODE_USER,  keyId, key);
  await putSecret('LINODE_SSH_PORT', LINODE_PORT,  keyId, key);
  await putSecret('LINODE_SSH_KEY',  sshKeyValue,  keyId, key);

  console.log('\nEnabling branch protection:');
  await enableBranchProtection();

  console.log(`
✅  Done!

Verify CI:  https://github.com/${GH_USER}/${GH_REPO}/actions

After this, any push to main will auto-deploy to torama.money.
`);
}

main().catch(e => { console.error(e); process.exit(1); });
