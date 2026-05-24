/**
 * Otuburu — Paystack Payment Service
 *
 * Swap PAYSTACK_SECRET_KEY in .env with your production key.
 * Webhook URL to register in Paystack dashboard:
 *   https://otuburu.torama.money/api/stake/webhook
 */

const https = require('https');
const crypto = require('crypto');

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.PAYSTACK_SECRET_KEY; // Paystack uses same secret for HMAC

if (!SECRET_KEY) {
  console.warn('[Paystack] WARNING: PAYSTACK_SECRET_KEY not set. Payment calls will fail.');
}

// ─── Low-level HTTPS helper (no extra deps) ────────────────────────────────────

function paystackRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.status) {
            return reject(new Error(parsed.message || 'Paystack request failed'));
          }
          resolve(parsed.data);
        } catch (e) {
          reject(new Error('Invalid JSON from Paystack'));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Initialize Transaction ────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.email          - Customer email
 * @param {number} opts.amount_usd     - Amount in USD (we convert to NGN)
 * @param {string} opts.reference      - Unique reference (= stake ID)
 * @param {string} opts.algorithm_name - For the transaction label
 * @param {string} opts.callback_url   - Redirect after payment
 * @param {object} opts.metadata       - Any extra data (stored in Paystack)
 *
 * Returns: { authorization_url, access_code, reference }
 */
async function initializeTransaction({ email, amount_usd, reference, algorithm_name, callback_url, metadata = {} }) {
  // Convert USD → Kobo (NGN). Rate is fetched from env or defaulted.
  // In production, wire up a real FX feed. For now use env variable.
  const USD_TO_NGN = parseFloat(process.env.USD_TO_NGN_RATE || '1600');
  const amount_ngn = Math.round(amount_usd * USD_TO_NGN);
  const amount_kobo = amount_ngn * 100; // Paystack uses kobo (smallest unit)

  const payload = {
    email,
    amount: amount_kobo,
    currency: 'NGN',
    reference,
    callback_url,
    metadata: {
      ...metadata,
      algorithm_name,
      amount_usd,
      custom_fields: [
        { display_name: 'Algorithm', variable_name: 'algorithm', value: algorithm_name },
        { display_name: 'Amount (USD)', variable_name: 'amount_usd', value: `$${amount_usd.toLocaleString()}` },
      ],
    },
    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
    label: `Otuburu ${algorithm_name} Stake`,
  };

  const data = await paystackRequest('POST', '/transaction/initialize', payload);
  return {
    authorization_url: data.authorization_url,
    access_code: data.access_code,
    reference: data.reference,
    amount_ngn,
    amount_kobo,
    fx_rate: USD_TO_NGN,
  };
}

// ─── Verify Transaction ────────────────────────────────────────────────────────

/**
 * Verify a transaction by reference. Use after redirect OR to cross-check webhook.
 * Returns the full Paystack transaction object.
 */
async function verifyTransaction(reference) {
  const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  return data;
}

// ─── Webhook Signature Validation ─────────────────────────────────────────────

/**
 * Validate that a webhook came from Paystack.
 * Call this BEFORE processing any webhook body.
 *
 * @param {string} rawBody     - Raw request body (Buffer or string)
 * @param {string} signature   - x-paystack-signature header value
 * @returns {boolean}
 */
function validateWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac('sha512', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

// ─── List Transactions (admin use) ────────────────────────────────────────────

async function listTransactions({ page = 1, perPage = 50, status } = {}) {
  let path = `/transaction?page=${page}&perPage=${perPage}`;
  if (status) path += `&status=${status}`;
  return paystackRequest('GET', path);
}

// ─── Fetch Banks (for bank transfer payments) ─────────────────────────────────

async function listBanks(country = 'nigeria') {
  return paystackRequest('GET', `/bank?country=${country}`);
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  validateWebhookSignature,
  listTransactions,
  listBanks,
};
