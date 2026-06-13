# Multi-PSP payments — virtual-account NGN rail

Provider-agnostic payment layer so the wallet is never blocked on a single
processor's approval or uptime. **Monnify** is wired as the default *instant NGN
deposit* rail via reserved virtual accounts (a static NUBAN per account); Paystack
is wrapped as a fail-over *payout* provider. Adding Flutterwave / Korapay / Squad /
Fincra later means writing one adapter that satisfies the same interfaces.

## What landed

| File | Role |
|------|------|
| `provider.go` | `Provider`, `VirtualAccountProvider`, `PayoutProvider` interfaces; `Router` (priority + failover) |
| `provider_credit.go` | `Crediter` — provider-agnostic deposit credit (FX, scaling, ledger, engine sync, email) + `virtual_accounts` persistence |
| `monnify.go` | Monnify adapter: OAuth token cache, reserved virtual accounts, webhook HMAC verify, name enquiry + disbursement |
| `paystack_adapter.go` | Wraps existing `*Handler` as a `PayoutProvider` (no change to `paystack.go`) |
| `provider_handler.go` | `GET /wallet/ngn/virtual-account`, `POST /payments/monnify/webhook` |
| `monnify_test.go` | Signature verify, status mapping, FX math, router failover |
| `db/schema.sql` | New `virtual_accounts` + `provider_deposits` tables |

The FX cost lever is unchanged: deposits credit `ngn / (interbank × 1.02)`, so the
2% spread (`paystackSpreadPct` / `customerRate`) is retained to fund real bank-side
FX conversion. Tune the spread in one place.

## Environment variables

Add to `/opt/otuburu/backend/.env` (and as GitHub Secrets written by `deploy.yml`):

```
MONNIFY_API_KEY=MK_PROD_xxxxxxxx
MONNIFY_SECRET_KEY=xxxxxxxxxxxxxxxx     # also the webhook HMAC-SHA512 key
MONNIFY_CONTRACT_CODE=1234567890        # collections contract (reserved accounts)
MONNIFY_WALLET_ACCOUNT=3000000000       # source account for disbursements (optional;
                                        # omit to enable deposits only, payouts off)
MONNIFY_BASE_URL=https://api.monnify.com   # use https://sandbox.monnify.com in staging
```

`NewMonnify()` returns nil (provider simply disabled) if API key / secret / contract
are absent, so deploying before the secrets land is safe — nothing breaks, the rail
is just inactive.

### deploy.yml

Add `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE`,
`MONNIFY_WALLET_ACCOUNT`, `MONNIFY_BASE_URL` to the GitHub Secrets list and to the
`.env` heredoc the deploy job writes (same place `PAYSTACK_SECRET_KEY` is written).
Per `feedback_otuburu_env_passthrough.md`, a missing line here is the usual cause of
"provider disabled" surprises.

## Monnify dashboard setup

1. Get API key + secret + contract code from the Monnify dashboard.
2. Set the webhook URL to `https://otuburu.torama.money/payments/monnify/webhook`.
3. Fund the disbursement wallet (or skip — deposits work without it).

## Frontend

In `DepositModal.tsx`, add an "NGN bank transfer" tab that calls
`GET /wallet/ngn/virtual-account` and shows the returned `bank_name` +
`account_number` + `account_name`. The user transfers from any banking app; the
balance updates silently via the existing tick/state push (no spinner — matches the
MT5 silent-UX rule). The NUBAN is permanent, so you can cache and re-show it.

## Withdrawals — router failover (implemented)

`wallet.WithdrawNGN` and `ResolveNGNAccount` now route through `*payments.Router`,
which tries Monnify first and fails over to Paystack. The wallet `Handler` takes
`router` + `rates` instead of a direct `*payments.Handler`. The payout sends
`Reference = withdrawal.id`, so the provider's settlement webhook maps back to the
exact row. On success the withdrawal goes `approved`; the final `sent`/`failed`
transition arrives via the disbursement webhook below.

## Disbursement webhook (implemented)

Monnify delivers funding **and** payout-settlement events to the same URL
(`/payments/monnify/webhook`), so the handler branches on `eventType`
(`MonnifyProvider.IsDisbursementEvent`). Settlement events are parsed by
`ParseDisbursementWebhook` and applied by `Crediter.SettleDisbursement`:

- `SUCCESSFUL_*` → withdrawal `sent`.
- `FAILED_*` / `REVERSED_*` → withdrawal `failed` **and** the debited USD is
  refunded to the user's Savings wallet (idempotent — the refund only fires from a
  non-terminal status, so replays are no-ops).

> **Sandbox-verify:** confirm Monnify's disbursement webhook carries our reference
> in `eventData.reference` (the field `SettleDisbursement` matches on). If your
> tenant uses `transactionReference` instead, adjust `ParseDisbursementWebhook`.

## Known gaps / follow-ups

- **KYC deposit cap.** Checkout deposits reject *before* charging. Virtual-account
  deposits arrive as inbound bank transfers we can't pre-reject, so the cap can't
  gate them the same way. `Crediter.Credit` currently credits regardless; add a
  post-credit check that flags/holds over-cap VA deposits for manual review.
- **Paystack transfer webhook.** The Paystack payout path still relies on its own
  `transfer.success`/`failed` webhook to reach a terminal state; the Monnify
  settlement handler does not cover Paystack references.
- **CI now covers wallet.** `ci.yml` runs `go vet` + `go test` on the wallet
  module (Go bumped to 1.25). Still run `gofmt -w ./internal/payments` locally —
  Go CI doesn't gofmt-check.

## Regulatory note

Virtual-account collections via a licensed provider (Monnify/Moniepoint) keep you on
regulated bank rails — materially safer than crypto-P2P account routing. Keep KYC on
deposits/withdrawals. (P2P netting intentionally deferred.)
