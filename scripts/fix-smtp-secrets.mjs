#!/usr/bin/env node
/**
 * fix-smtp-secrets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Updates SMTP_HOST to smtp-relay.gmail.com (Google Workspace relay, IP-based).
 * Clears SMTP_PASS so the mailer falls back to the no-auth IP relay mode.
 *
 * Run from otuburu_live/:
 *   GH_TOKEN=ghp_xxxx node scripts/fix-smtp-secrets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_USER  = 'filatei';
const GH_REPO  = 'otuburu';

const SECRETS = {
  // ── Point at the Google Workspace relay, NOT smtp.gmail.com ──────────────
  SMTP_HOST: 'smtp-relay.gmail.com',

  // ── Clear the password — IP-based relay needs no credentials ─────────────
  // Setting to empty string means the mailer.js `(pass && user)` guard
  // evaluates false and auth is omitted entirely from nodemailer.
  SMTP_PASS: '',
};

// ─────────────────────────────────────────────────────────────────────────────

function die(msg) { console.error('\n❌  ' + msg + '\n'); process.exit(1); }

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization:  `token ${GH_TOKEN}`,
        Accept:         'application/vnd.github.v3+json',
        'User-Agent':   'otuburu-smtp-fix',
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

function encryptSecret(base64PublicKey, secretValue) {
  let sodium;
  try { sodium = require('tweetsodium'); }
  catch {
    die('tweetsodium not found.\nRun: npm install  (from otuburu_live/)\nthen re-run this script.');
  }
  const key       = Buffer.from(base64PublicKey, 'base64');
  const message   = Buffer.from(secretValue, 'utf-8');
  const encrypted = sodium.seal(message, key);
  return Buffer.from(encrypted).toString('base64');
}

async function getRepoPublicKey() {
  const { status, body } = await ghRequest(
    'GET', `/repos/${GH_USER}/${GH_REPO}/actions/secrets/public-key`
  );
  if (status !== 200)
    die(`Could not fetch repo public key (HTTP ${status}).\nCheck your GH_TOKEN has 'repo' scope.`);
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
    console.log(`  ✅  ${name} = "${value || '(empty)'}"`);
  } else {
    console.log(`  ❌  ${name} — HTTP ${status}`);
  }
}

async function main() {
  if (!GH_TOKEN)
    die('GH_TOKEN is not set.\nRun: GH_TOKEN=ghp_xxxx node scripts/fix-smtp-secrets.mjs');

  const check = await ghRequest('GET', '/user');
  if (check.status !== 200)
    die(`GitHub token invalid — HTTP ${check.status}`);

  console.log(`\n🔑  Authenticated as: ${check.body.login}`);
  console.log(`    Repository: ${GH_USER}/${GH_REPO}\n`);

  const { keyId, key } = await getRepoPublicKey();

  console.log('Updating SMTP secrets for Google Workspace relay:');
  for (const [name, value] of Object.entries(SECRETS)) {
    await putSecret(name, value, keyId, key);
  }

  console.log(`
✅  Done.

The staking mailer will now:
  • Connect to smtp-relay.gmail.com:587
  • Send with NO password (IP-based relay — Linode IP 104.237.157.53)
  • FROM: Otuburu <noreply@torama.money>

⚠️  IMPORTANT — before emails will actually work, you must add the
    Linode server IP to the Google Workspace SMTP relay rule:

    1. Go to: https://admin.google.com
    2. Apps → Google Workspace → Gmail → Routing → SMTP relay service
    3. Edit the rule for otuburu.torama.money (rule ID: 55eb8)
    4. Under "Allowed senders" → add IP range: 104.237.157.53/32
    5. Save

    Without this step, Google will reject connections from the server.

Push to trigger deploy:
    git add -A
    git commit -m "fix: SMTP relay — use smtp-relay.gmail.com, IP-based auth, no password"
    git push origin main
`);
}

main().catch(e => { console.error(e); process.exit(1); });
