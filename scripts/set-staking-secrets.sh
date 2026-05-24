#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Otuburu — Set GitHub Secrets for the Staking Service
#
# Run from your local machine (not the sandbox) where gh is installed.
# Usage:
#   cd otuburu_live
#   bash scripts/set-staking-secrets.sh
#
# Prerequisites:
#   gh auth login   (if not already authenticated)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="filatei/otuburu"

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
blue() { printf '\033[1;34m%s\033[0m\n' "$*"; }

blue "Setting Otuburu staking secrets on $REPO ..."
echo ""

# ── Paystack ──────────────────────────────────────────────────────────────────
# Placeholders — replace in GitHub UI once you have production keys.
# Get from: https://dashboard.paystack.com/#/settings/developer

gh secret set PAYSTACK_SECRET_KEY \
  --repo "$REPO" \
  --body "sk_live_REPLACE_WITH_REAL_KEY_FROM_PAYSTACK_DASHBOARD"
green "  ✓ PAYSTACK_SECRET_KEY set (placeholder)"

gh secret set PAYSTACK_PUBLIC_KEY \
  --repo "$REPO" \
  --body "pk_live_REPLACE_WITH_REAL_KEY_FROM_PAYSTACK_DASHBOARD"
green "  ✓ PAYSTACK_PUBLIC_KEY set (placeholder)"

# ── FX Rate ───────────────────────────────────────────────────────────────────
gh secret set USD_TO_NGN_RATE \
  --repo "$REPO" \
  --body "1600"
green "  ✓ USD_TO_NGN_RATE set (1600)"

# ── SMTP (email notifications) ────────────────────────────────────────────────
gh secret set SMTP_HOST \
  --repo "$REPO" \
  --body "smtp.gmail.com"
green "  ✓ SMTP_HOST set (smtp.gmail.com)"

gh secret set SMTP_PORT \
  --repo "$REPO" \
  --body "587"
green "  ✓ SMTP_PORT set (587)"

gh secret set SMTP_SECURE \
  --repo "$REPO" \
  --body "false"
green "  ✓ SMTP_SECURE set (false)"

gh secret set SMTP_USER \
  --repo "$REPO" \
  --body "noreply@torama.money"
green "  ✓ SMTP_USER set (noreply@torama.money — update if using Gmail App Password)"

gh secret set SMTP_PASS \
  --repo "$REPO" \
  --body "REPLACE_WITH_GMAIL_APP_PASSWORD_OR_SMTP_CREDENTIALS"
green "  ✓ SMTP_PASS set (placeholder)"

gh secret set SMTP_FROM \
  --repo "$REPO" \
  --body "Otuburu <noreply@torama.money>"
green "  ✓ SMTP_FROM set"

# ── Admin ─────────────────────────────────────────────────────────────────────
gh secret set ADMIN_EMAIL \
  --repo "$REPO" \
  --body "filatei@gtsng.com"
green "  ✓ ADMIN_EMAIL set (filatei@gtsng.com)"

gh secret set ADMIN_EMAILS \
  --repo "$REPO" \
  --body "filatei@gtsng.com"
green "  ✓ ADMIN_EMAILS set (filatei@gtsng.com)"

echo ""
green "All staking secrets set on $REPO"
echo ""
yellow "⚠  NEXT STEPS — replace placeholders:"
echo "   1. PAYSTACK_SECRET_KEY  → get from dashboard.paystack.com → Settings → API Keys (Live)"
echo "   2. PAYSTACK_PUBLIC_KEY  → same location"
echo "   3. SMTP_PASS            → Gmail: Account → Security → App Passwords → generate for 'Mail'"
echo "      (or use your Mailgun/SendGrid SMTP credentials)"
echo ""
yellow "⚠  After first deploy, register Paystack webhook:"
echo "   URL: https://otuburu.torama.money/api/stake/webhook"
echo "   Events: charge.success, charge.failed"
