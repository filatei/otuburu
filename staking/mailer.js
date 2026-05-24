/**
 * Otuburu — Email Notification Service
 *
 * Uses Google Workspace SMTP relay (smtp-relay.gmail.com).
 * Authentication is IP-based — the Linode server IP (104.237.157.53) must be
 * added to the relay rule in Google Admin → Apps → Gmail → Routing → SMTP relay.
 * No SMTP_PASS needed when using relay; auth{} is omitted entirely.
 *
 * If SMTP_PASS is set in env, falls back to credential-based auth (App Password).
 */

const nodemailer = require('nodemailer');

let _transporter;

function getTransporter() {
  if (_transporter) return _transporter;

  const host   = process.env.SMTP_HOST   || 'smtp-relay.gmail.com';
  const port   = parseInt(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true';
  const pass   = process.env.SMTP_PASS;
  const user   = process.env.SMTP_USER;

  // If SMTP_PASS is set use credential auth; otherwise rely on IP-based relay
  const auth = (pass && user) ? { user, pass } : undefined;

  _transporter = nodemailer.createTransport({ host, port, secure, auth });

  // Log which mode we're in at startup
  console.log(`[Mailer] SMTP: ${host}:${port} | auth: ${auth ? 'credentials' : 'IP-relay (no password)'}`);

  return _transporter;
}

const FROM = process.env.SMTP_FROM || 'Otuburu <noreply@torama.money>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'filatei@gtsng.com';

// ─── Admin alert: new confirmed stake ─────────────────────────────────────────

async function notifyAdminNewStake({ stake, user, algorithm }) {
  const usd = stake.amount_usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  await getTransporter().sendMail({
    from: FROM,
    to: ADMIN_EMAIL,
    subject: `🟢 NEW STAKE — ${algorithm.name} | ${usd} | ${user.email}`,
    html: `
      <div style="font-family:monospace;background:#111;color:#e0e0e0;padding:24px;border-radius:8px">
        <h2 style="color:#f59e0b">OTUBURU — New Algorithm Stake Confirmed</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:6px;color:#888">User</td><td style="padding:6px"><strong>${user.name}</strong> &lt;${user.email}&gt;</td></tr>
          <tr><td style="padding:6px;color:#888">Algorithm</td><td style="padding:6px"><strong>${algorithm.name}</strong></td></tr>
          <tr><td style="padding:6px;color:#888">Stake (USD)</td><td style="padding:6px"><strong style="color:#22c55e">${usd}</strong></td></tr>
          <tr><td style="padding:6px;color:#888">Stake ID</td><td style="padding:6px"><code>${stake.id}</code></td></tr>
          <tr><td style="padding:6px;color:#888">Paystack Ref</td><td style="padding:6px"><code>${stake.paystack_ref}</code></td></tr>
          <tr><td style="padding:6px;color:#888">Profit Split</td><td style="padding:6px">80% user / 20% Otuburu</td></tr>
        </table>
        <hr style="border-color:#333;margin:16px 0"/>
        <h3 style="color:#f59e0b">⚡ ACTION REQUIRED</h3>
        <ol style="color:#ccc">
          <li>Log in to your Exness Partner account</li>
          <li>Create a sub-account under the global Otuburu account</li>
          <li>Label it: <code>${user.email} — ${algorithm.name} — ${stake.id.slice(0,8)}</code></li>
          <li>Deploy the <strong>${algorithm.name}</strong> EA on that account with initial balance <strong>${usd}</strong></li>
          <li>Update the stake record via admin panel: <a href="https://otuburu.torama.money/admin/stakes/${stake.id}" style="color:#3b82f6">Set Exness Account</a></li>
          <li>Email credentials to: <strong>${user.email}</strong></li>
        </ol>
      </div>
    `,
  });
}

// ─── User confirmation: stake activated ───────────────────────────────────────

async function notifyUserStakeActivated({ stake, user, algorithm }) {
  const usd = stake.amount_usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  await getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: `✅ Your ${algorithm.name} stake is active — Otuburu`,
    html: `
      <div style="font-family:sans-serif;background:#111;color:#e0e0e0;padding:32px;border-radius:8px;max-width:560px;margin:auto">
        <div style="text-align:center;margin-bottom:24px">
          <span style="font-size:28px;font-weight:900;color:#f59e0b;letter-spacing:2px">OTUBURU</span>
          <div style="font-size:11px;color:#666;letter-spacing:4px;margin-top:2px">SYNTHETIC TRADING</div>
        </div>
        <h2 style="color:#22c55e;margin-bottom:4px">Payment Confirmed!</h2>
        <p style="color:#9ca3af">Your algorithm stake has been received and is being set up.</p>
        <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin:20px 0">
          <div style="margin-bottom:8px"><span style="color:#6b7280">Algorithm</span><br/><strong style="color:#f59e0b">${algorithm.name}</strong></div>
          <div style="margin-bottom:8px"><span style="color:#6b7280">Amount Staked</span><br/><strong style="font-size:20px;color:#22c55e">${usd}</strong></div>
          <div style="margin-bottom:8px"><span style="color:#6b7280">Your Profit Share</span><br/><strong>80%</strong> of all profits</div>
          <div><span style="color:#6b7280">Reference</span><br/><code style="color:#9ca3af;font-size:12px">${stake.id}</code></div>
        </div>
        <p style="color:#6b7280;font-size:13px">
          Our team will set up a dedicated Exness trading account for your stake within 24 hours.
          You'll receive another email once trading begins, including your account credentials.
        </p>
        <p style="color:#6b7280;font-size:13px">
          Track your stake anytime at: <a href="https://otuburu.torama.money/staking" style="color:#3b82f6">otuburu.torama.money/staking</a>
        </p>
        <hr style="border-color:#2a2a2a;margin:24px 0"/>
        <p style="color:#4b5563;font-size:12px;text-align:center">
          Otuburu · torama.money · Profits distributed monthly · 80/20 split
        </p>
      </div>
    `,
  });
}

// ─── User: payment failed ─────────────────────────────────────────────────────

async function notifyUserPaymentFailed({ user, reference }) {
  await getTransporter().sendMail({
    from: FROM,
    to: user.email,
    subject: `⚠️ Payment failed — Otuburu`,
    html: `
      <div style="font-family:sans-serif;background:#111;color:#e0e0e0;padding:32px;border-radius:8px;max-width:560px;margin:auto">
        <h2 style="color:#ef4444">Payment Not Completed</h2>
        <p>Your payment (ref: <code>${reference}</code>) was not completed successfully.</p>
        <p>If you believe this is an error, please <a href="mailto:support@torama.money" style="color:#3b82f6">contact support</a> with your reference number.</p>
        <p><a href="https://otuburu.torama.money/staking" style="background:#f59e0b;color:#000;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold">Try Again</a></p>
      </div>
    `,
  });
}

module.exports = { notifyAdminNewStake, notifyUserStakeActivated, notifyUserPaymentFailed };
