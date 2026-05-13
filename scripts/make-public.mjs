#!/usr/bin/env node
/**
 * make-public.mjs
 * Makes the filatei/otuburu repo public and enables branch protection.
 *
 * Usage:
 *   GH_TOKEN=ghp_xxxx node scripts/make-public.mjs
 */

import https from 'https';

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_USER  = 'filatei';
const GH_REPO  = 'otuburu';

function die(msg) { console.error('❌ ', msg); process.exit(1); }

function ghRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization':  `token ${GH_TOKEN}`,
        'Accept':         'application/vnd.github.v3+json',
        'User-Agent':     'otuburu-setup',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!GH_TOKEN) die('GH_TOKEN is not set.');

  // 1 — Make repo public
  console.log('\n🌐  Making repo public...');
  const { status: s1, body: b1 } = await ghRequest(
    'PATCH',
    `/repos/${GH_USER}/${GH_REPO}`,
    { private: false, visibility: 'public' }
  );
  if (s1 === 200) {
    console.log(`  ✅  ${b1.full_name} is now public: ${b1.html_url}`);
  } else {
    die(`Failed to make repo public — HTTP ${s1}: ${JSON.stringify(b1)}`);
  }

  // 2 — Enable branch protection on main
  console.log('\n🔒  Enabling branch protection on main...');
  const { status: s2, body: b2 } = await ghRequest(
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
    }
  );
  if (s2 === 200) {
    console.log('  ✅  Branch protection enabled — main requires CI green + 1 review to merge.');
  } else {
    console.log(`  ❌  Branch protection — HTTP ${s2}: ${JSON.stringify(b2).slice(0,200)}`);
  }

  console.log('\n✅  Done! Repo: https://github.com/filatei/otuburu\n');
}

main().catch(e => { console.error(e); process.exit(1); });
