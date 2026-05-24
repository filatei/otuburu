/**
 * Otuburu Staking Service — Express entry point
 *
 * Runs as its own container (port 8084).
 * Apache proxies:
 *   /api/stake/  → http://127.0.0.1:8084/api/stake/
 *   /staking     → http://127.0.0.1:8084/staking
 */

'use strict';

const path    = require('path');
const http    = require('http');
const express = require('express');
const fs      = require('fs');

const stakingRoutes = require('./routes');

const PORT = process.env.PORT || 8084;
const app  = express();

// ── CORS (consistent with wallet service) ─────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Webhook MUST receive raw body — mount BEFORE express.json() ───────────────
app.use('/api/stake/webhook', express.raw({ type: '*/*' }));

// ── JSON body parser for all other routes ─────────────────────────────────────
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_, res) => res.json({ status: 'ok', service: 'staking' }));

// ── Staking API routes ────────────────────────────────────────────────────────
app.use('/api/stake', stakingRoutes);

// ── Staking UI page ───────────────────────────────────────────────────────────
// The HTML contains __PAYSTACK_PUBLIC_KEY__ and __USD_TO_NGN_RATE__ placeholders
// which are replaced at runtime from env vars (safe — public key is not secret).
const STAKING_HTML = path.join(__dirname, 'staking.html');

let _stakingHtml = null; // cached after first read + replacement

function getStakingHtml() {
  if (_stakingHtml) return _stakingHtml;
  if (!fs.existsSync(STAKING_HTML)) return null;

  const PK   = process.env.PAYSTACK_PUBLIC_KEY || '';
  const RATE = process.env.USD_TO_NGN_RATE     || '1600';

  _stakingHtml = fs.readFileSync(STAKING_HTML, 'utf8')
    .replace(/__PAYSTACK_PUBLIC_KEY__/g, PK)
    .replace(/__USD_TO_NGN_RATE__/g,    RATE);

  return _stakingHtml;
}

app.get('/staking', (req, res) => {
  const html = getStakingHtml();
  if (!html) return res.status(503).send('Staking page not available');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Paystack redirects to /staking/callback params — forward to /api/stake/callback
app.get('/staking/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/stake/callback?${qs}`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`[Staking] Service running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Staking] SIGTERM received, shutting down gracefully...');
  server.close(() => process.exit(0));
});
