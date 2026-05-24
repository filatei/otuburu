#!/usr/bin/env node
/**
 * set-staking-secrets.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Sets GitHub Actions secrets needed for the Otuburu staking service.
 * Uses the same pattern as github-secrets.mjs (tweetsodium + GitHub API).
 *
 * Run from the otuburu_live directory:
 *   GH_TOKEN=ghp_xxxx node scripts/set-staking-secrets.mjs
 *
 * Get a GitHub PAT at: https://github.com/settings/tokens
 *   → "Generate new token (classic)"
 *   → scopes: repo  (or fine-grained: secrets: read/write)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_USER  = 'filatei';
const GH_REPO  = 'otuburu';

// ── Placeholder values — user replaces PAYSTACK + SMTP secrets in GitHub UI ──
const SECRETS = {
  // ── Paystack TEST keys (Torama Global Services account — Test Mode) ─────────
  // Switch to Live keys once Paystack approves the account ("Awaiting Review")
  PAYSTACK_SECRET_KEY: 'sk_test_85778e884df27d8e18e865376f97f123b58e8c41',
  PAYSTACK_PUBLIC_KEY: 'pk_test_39b9c20eeae37f2b70a2494febf75cc4976cf465',

  // ── FX rate (update as NGN rate changes) ──────────────────────────────────
  USD_TO_NGN_RATE: '1600',

  // ── SMTP — using Gmail (REPLACE SMTP_PASS with an App Password) ───────────
  // Gmail App Password: myaccount.google.com → Security → App Passwords
  SMTP_HOST:   'smtp.gmail.com',
  SMTP_PORT:   '587',
  SMTP_SECURE: 'false',
  SMTP_USER:   'filatei@gtsng.com',
  SMTP_PASS:   'REPLACE_WITH_GMAIL_APP_PASSWORD',
  SMTP_FROM:   'Otuburu <noreply@torama.money>',

  // ── Admin ─────────────────────────────────────────────────────────────────
  ADMIN_EMAIL:  'filatei@gtsng.com',
  ADMIN_EMAILS: 'filatei@gtsng.com',
};

// ── Secrets that need real values before go-live ─────────────────────────────
// PAYSTACK keys are test keys — swap for Live keys once Paystack approves account
const MUST_REPLACE = ['SMTP_PASS'];

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
        'User-Agent':   'otuburu-staking-setup',
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
    die('tweetsodium not found.\nRun from otuburu_live/:  npm install\nthen re-run this script.');
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
  const isPlaceholder = MUST_REPLACE.includes(name);
  if (status === 201 || status === 204) {
    if (isPlaceholder) {
      console.log(`  ⚠️   ${name}  ← PLACEHOLDER — update in GitHub UI with real value`);
    } else {
      console.log(`  ✅  ${name}`);
    }
  } else {
    console.log(`  ❌  ${name} — HTTP ${status}`);
  }
}

async function updateBranchProtection() {
  // Update branch protection to require the new 'staking' CI job
  const { status } = await ghRequest(
    'PUT',
    `/repos/${GH_USER}/${GH_REPO}/branches/main/protection`,
    {
      required_status_checks: {
        strict: true,
        contexts: [
          'Rust engine',
          'Go services',
          'Node demo lint',
          'Staking service',
          'Frontend typecheck + lint',
          'Terraform validate',
        ],
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
    console.log('  ✅  Branch protection updated (staking + frontend CI jobs now required)');
  } else {
    console.log(`  ⚠️   Branch protection — HTTP ${status} (requires GitHub Pro/Team for private repos)`);
    console.log('       Update manually: Settings → Branches → main → Edit → Status checks');
  }
}

async function main() {
  if (!GH_TOKEN)
    die('GH_TOKEN is not set.\nRun: GH_TOKEN=ghp_xxxx node scripts/set-staking-secrets.mjs');

  // Verify token
  const check = await ghRequest('GET', '/user');
  if (check.status !== 200)
    die(`GitHub token invalid — HTTP ${check.status}`);

  console.log(`\n🔑  Authenticated as: ${check.body.login}`);
  console.log(`    Repository: ${GH_USER}/${GH_REPO}\n`);

  const { keyId, key } = await getRepoPublicKey();

  console.log('Setting staking secrets:');
  for (const [name, value] of Object.entries(SECRETS)) {
    await putSecret(name, value, keyId, key);
  }

  console.log('\nUpdating branch protection:');
  await updateBranchProtection();

  console.log(`
✅  Staking secrets set on ${GH_USER}/${GH_REPO}

⚠️  Update SMTP_PASS before emails will work:
   SMTP_PASS → myaccount.google.com → Security → App Passwords → Mail
   Edit at: https://github.com/${GH_USER}/${GH_REPO}/settings/secrets/actions

🧪  Paystack is in TEST mode (Torama Global Services — Awaiting Review).
   Test card: 4084 0840 8408 4081 | CVV: 408 | Expiry: 01/25 | OTP: 123456
   When Paystack approves the account, swap to Live keys in GitHub secrets.

Push to main to trigger deploy:
   git add -A
   git commit -m "feat: algorithm staking service — Paystack, 80/20 profit sharing"
   git push origin main

After deploy, register Paystack TEST webhook:
   URL:    https://otuburu.torama.money/api/stake/webhook
   Events: charge.success, charge.failed
   Register at: https://dashboard.paystack.com/#/settings/developer
`);
}

main().catch(e => { console.error(e); process.exit(1); });
