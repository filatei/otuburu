# GitHub Secrets — Staking Service Additions

Add these to: https://github.com/filatei/otuburu/settings/secrets/actions
(Settings → Secrets and variables → Actions → New repository secret)

These are IN ADDITION to the existing secrets already configured.

## Required New Secrets

| Secret Name | Description | Where to get it |
|-------------|-------------|-----------------|
| `PAYSTACK_SECRET_KEY` | Paystack live secret key (sk_live_…) | dashboard.paystack.com → Settings → API Keys |
| `PAYSTACK_PUBLIC_KEY` | Paystack live public key (pk_live_…) | Same as above |
| `SMTP_USER` | SMTP email login | Your email provider |
| `SMTP_PASS` | SMTP password or App Password | Google: Account → Security → App Passwords |

## Optional Secrets (have defaults if omitted)

| Secret Name | Default | Description |
|-------------|---------|-------------|
| `USD_TO_NGN_RATE` | `1600` | Exchange rate for NGN payment amounts |
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS (true for port 465) |
| `SMTP_FROM` | `Otuburu <noreply@torama.money>` | From address in emails |
| `ADMIN_EMAIL` | `filatei@gtsng.com` | Admin notification email |
| `ADMIN_EMAILS` | `filatei@gtsng.com` | Comma-separated admin emails for API access |
| `POSTGRES_USER` | `otuburu` | Postgres username |
| `POSTGRES_DB` | `otuburu` | Postgres database name |

## Existing Secrets (must already be set)

These are consumed by the existing services and must remain:

| Secret | Used by |
|--------|---------|
| `JWT_SECRET` | Wallet service (issues tokens) + Staking service (verifies same tokens) |
| `POSTGRES_PASSWORD` | Wallet service + Postgres |
| `WALLET_MNEMONIC` | Wallet service (TRC20 HD wallet) |
| `TRONGRID_API_KEY` | Wallet service |
| `GOOGLE_CLIENT_ID` | Wallet service (OAuth) + Frontend |
| `ADMIN_SECRET` | Wallet service admin panel |
| `GHCR_TOKEN` | Docker image push (PAT with `write:packages`) |
| `LINODE_HOST` | SSH deploy target |
| `LINODE_SSH_KEY` | SSH private key for deploy |

## Paystack Webhook Registration

After first successful deploy, register the webhook URL in Paystack:
1. Go to https://dashboard.paystack.com/#/settings/developer
2. Click "Add New Webhook URL"
3. Enter: `https://otuburu.torama.money/api/stake/webhook`
4. Enable events: `charge.success`, `charge.failed`
5. Save

## Staking Service Image

Built and pushed by CI as: `ghcr.io/filatei/otuburu-staking:staging`
Port: 8084 (internal, exposed via Apache proxy)
Data: SQLite DB persisted in Docker volume `stakingdata` → `/data/staking.db`
