/**
 * Otuburu Algorithm Staking — Express Routes
 *
 * Mounted by server.js. Auth uses the SAME JWT that go-services/wallet issues:
 *   Algorithm: HS256
 *   Secret:    JWT_SECRET env var  (same value as in docker-compose)
 *   Claims:    uid (user_id), aid (account_id), did (demo_id), email
 *   Storage:   sessionStorage['otuburu_token'] in the frontend
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const db       = require('./db');
const paystack = require('./paystack');
const mailer   = require('./mailer');

const BASE_URL     = process.env.BASE_URL     || 'https://otuburu.torama.money';
// JWT_SECRET is validated at boot in server.js via mustEnv(), so it is
// guaranteed present and well-formed by the time this module is required.
// No fallback default — a hard-coded secret would let an attacker who knows
// the source forge tokens.
const JWT_SECRET   = process.env.JWT_SECRET;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'filatei@gtsng.com').split(',').map(e => e.trim());

// ─── Auth middleware ──────────────────────────────────────────────────────────
// Verifies the Bearer JWT issued by go-services/wallet using the same JWT_SECRET.
// Injects req.stakingUser = { id, email, accountId, demoId }

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = header.slice(7);
  try {
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // wallet JWT claims: uid, aid, did, email
    req.stakingUser = {
      id:        claims.uid,
      email:     claims.email,
      accountId: claims.aid,
      demoId:    claims.did,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── GET /api/stake/algorithms ────────────────────────────────────────────────

router.get('/algorithms', (req, res) => {
  try {
    res.json({ algorithms: db.getAlgorithms() });
  } catch (e) {
    console.error('[Staking] getAlgorithms:', e);
    res.status(500).json({ error: 'Could not fetch algorithms' });
  }
});

// ─── GET /api/stake/my-stakes ─────────────────────────────────────────────────

router.get('/my-stakes', requireAuth, (req, res) => {
  try {
    const { id, email, accountId } = req.stakingUser;
    // Upsert so we have a local record even if never staked before
    db.upsertUser({ id, email, name: email, photo_url: '' });
    res.json({ stakes: db.getUserStakes(id) });
  } catch (e) {
    console.error('[Staking] getUserStakes:', e);
    res.status(500).json({ error: 'Could not fetch stakes' });
  }
});

// ─── POST /api/stake/init ─────────────────────────────────────────────────────
// Body: { algorithm_id: string, amount_usd: number }
// Returns: { authorization_url, reference, amount_ngn, fx_rate }

router.post('/init', requireAuth, async (req, res) => {
  try {
    const { id: userId, email } = req.stakingUser;
    const { algorithm_id, amount_usd } = req.body;

    const algo = db.getAlgorithm(algorithm_id);
    if (!algo)                 return res.status(400).json({ error: 'Invalid algorithm' });
    if (algo.status !== 'ACTIVE') return res.status(400).json({ error: 'Algorithm not currently accepting stakes' });

    const amt = parseFloat(amount_usd);
    if (isNaN(amt) || amt < algo.min_stake_usd)
      return res.status(400).json({ error: `Minimum stake is $${algo.min_stake_usd}` });
    if (algo.max_stake_usd && amt > algo.max_stake_usd)
      return res.status(400).json({ error: `Maximum stake is $${algo.max_stake_usd.toLocaleString()}` });

    db.upsertUser({ id: userId, email, name: email, photo_url: '' });

    const stakeId     = uuidv4();
    const paystackData = await paystack.initializeTransaction({
      email,
      amount_usd: amt,
      reference:  stakeId,
      algorithm_name: algo.name,
      callback_url: `${BASE_URL}/api/stake/callback?ref=${stakeId}`,
      metadata: { stake_id: stakeId, user_id: userId, algorithm_id },
    });

    db.createStake({
      id:           stakeId,
      user_id:      userId,
      algorithm_id,
      amount_usd:   amt,
      currency:     'NGN',
      amount_local: paystackData.amount_ngn,
      fx_rate:      paystackData.fx_rate,
      paystack_ref: stakeId,
    });

    db.createPayment({
      id:          stakeId,
      stake_id:    stakeId,
      user_id:     userId,
      amount_kobo: paystackData.amount_kobo,
      currency:    'NGN',
    });

    res.json({
      authorization_url: paystackData.authorization_url,
      reference:         stakeId,
      amount_ngn:        paystackData.amount_ngn,
      fx_rate:           paystackData.fx_rate,
    });
  } catch (e) {
    console.error('[Staking] init error:', e);
    res.status(500).json({ error: e.message || 'Payment initialization failed' });
  }
});

// ─── POST /api/stake/webhook ──────────────────────────────────────────────────
// Paystack webhook — registered at: https://otuburu.torama.money/api/stake/webhook
// IMPORTANT: mounted with express.raw() BEFORE express.json() in server.js

router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200); // Respond fast; Paystack retries on non-200

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!paystack.validateWebhookSignature(req.body, signature)) {
      console.warn('[Staking] Webhook: bad signature — ignoring');
      return;
    }

    const event = JSON.parse(req.body.toString());
    console.log('[Staking] Webhook event:', event.event, event.data?.reference);

    if (event.event === 'charge.success') {
      const data      = event.data;
      const ref       = data.reference;
      const verified  = await paystack.verifyTransaction(ref);

      if (verified.status !== 'success') {
        console.warn('[Staking] Cross-verify failed for ref:', ref);
        return;
      }

      const stake = db.getStakeByPaystackRef(ref);
      if (!stake)                          { console.warn('[Staking] No stake for ref:', ref); return; }
      if (stake.status !== 'PENDING_PAYMENT') { console.log('[Staking] Already processed:', stake.id); return; }

      db.activateStake(stake.id);
      db.updatePayment({
        id:             ref,
        status:         'SUCCESS',
        gateway_status: data.status,
        gateway_ref:    String(data.id),
        paid_at:        Math.floor(new Date(data.paid_at).getTime() / 1000),
        meta:           data,
      });

      const algo = db.getAlgorithm(stake.algorithm_id);
      const user = {
        email: data.customer.email,
        name:  data.customer.name || data.metadata?.name || data.customer.email,
        id:    stake.user_id,
      };

      mailer.notifyAdminNewStake({ stake, user, algorithm: algo })
        .catch(e => console.error('[Staking] Admin email:', e));
      mailer.notifyUserStakeActivated({ stake, user, algorithm: algo })
        .catch(e => console.error('[Staking] User email:', e));

      console.log(`[Staking] ✅ Activated: ${stake.id} | ${algo.name} | $${stake.amount_usd}`);
    }

    if (event.event === 'charge.failed') {
      const ref   = event.data.reference;
      const stake = db.getStakeByPaystackRef(ref);
      if (stake) {
        db.failStake(stake.id);
        db.updatePayment({ id: ref, status: 'FAILED', gateway_status: event.data.status,
                           gateway_ref: String(event.data.id), paid_at: null, meta: event.data });
        mailer.notifyUserPaymentFailed({ user: { email: event.data.customer.email }, reference: ref })
          .catch(e => console.error('[Staking] Failure email:', e));
      }
    }
  } catch (e) {
    console.error('[Staking] Webhook error:', e);
  }
});

// ─── GET /api/stake/callback ──────────────────────────────────────────────────
// Paystack redirects here after payment. Verify then redirect to staking UI.

router.get('/callback', async (req, res) => {
  const reference = req.query.ref || req.query.trxref;
  try {
    if (reference) {
      const verified = await paystack.verifyTransaction(reference);
      if (verified.status === 'success')
        return res.redirect(`${BASE_URL}/staking?status=success&ref=${reference}`);
    }
  } catch (e) {
    console.error('[Staking] Callback verify:', e);
  }
  res.redirect(`${BASE_URL}/staking?status=failed&ref=${reference}`);
});

// ─── GET /api/stake/profits/:stakeId ─────────────────────────────────────────

router.get('/profits/:stakeId', requireAuth, (req, res) => {
  try {
    const profits        = db.getProfitsByStake(req.params.stakeId);
    const totalUserShare = profits.reduce((s, p) => s + p.user_share_usd, 0);
    res.json({ profits, total_user_share_usd: totalUserShare });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch profits' });
  }
});

// ─── POST /api/stake/admin/set-exness ────────────────────────────────────────
// Admin only: record Exness sub-account number against a stake.

router.post('/admin/set-exness', requireAuth, (req, res) => {
  if (!ADMIN_EMAILS.includes(req.stakingUser.email))
    return res.status(403).json({ error: 'Not authorised' });

  const { stake_id, exness_account } = req.body;
  if (!stake_id || !exness_account)
    return res.status(400).json({ error: 'stake_id and exness_account required' });

  db.setExnessAccount(stake_id, exness_account);
  res.json({ ok: true });
});

// ─── GET /api/stake/admin/stakes ─────────────────────────────────────────────
// Admin dashboard data: all stakes.

router.get('/admin/stakes', requireAuth, (req, res) => {
  if (!ADMIN_EMAILS.includes(req.stakingUser.email))
    return res.status(403).json({ error: 'Not authorised' });

  try {
    const stakes = db.getDb().prepare(`
      SELECT s.*, a.name as algo_name, u.email as user_email, u.name as user_name
      FROM stakes s
      JOIN algorithms a ON s.algorithm_id = a.id
      JOIN staking_users u ON s.user_id = u.id
      ORDER BY s.created_at DESC
    `).all();
    res.json({ stakes });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch admin stakes' });
  }
});

module.exports = router;
