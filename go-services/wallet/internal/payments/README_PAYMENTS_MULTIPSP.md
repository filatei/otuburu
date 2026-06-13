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

## Withdrawals — one-line swap to gain failover

`monnify.go` + `paystack_adapter.go` already make both providers satisfy
`PayoutProvider`. To route NGN withdrawals through the Router (Monnify first,
Paystack fallback) instead of calling Paystack directly, inject `*payments.Router`
into the wallet handler and replace the direct `ResolveAccount` / `CreateRecipient`
+ `InitiateTransfer` calls in `wallet.WithdrawNGN` with:

```go
name, err := router.ResolveAccount(ctx, bankCode, acctNo)  // first healthy provider
res,  err := router.Payout(ctx, payments.PayoutRequest{
    AccountName: name, AccountNumber: acctNo, BankCode: bankCode,
    NGNAmount: ngn, Reference: ref, Narration: "Otuburu withdrawal",
})
// store res.Reference in withdrawals.txid, res.Status in withdrawals.status
```

This file deliberately does **not** modify `wallet/internal/payments/ngn_withdraw.go`
or the wallet handler, so the working Paystack payout path is untouched until you
choose to flip it.

## Known gaps / follow-ups

- **Disbursement webhook.** Monnify confirms payouts asynchronously. A
  `POST /payments/monnify/disbursement-webhook` handler to flip
  `withdrawals.status` `pending → sent/failed` (and refund on failure) is not yet
  written — payouts will sit `pending` until added. Paystack's existing transfer
  webhook already does this for the Paystack path.
- **KYC deposit cap.** Checkout deposits reject *before* charging. Virtual-account
  deposits arrive as inbound bank transfers we can't pre-reject, so the cap can't
  gate them the same way. `Crediter.Credit` currently credits regardless; add a
  post-credit check that flags/holds over-cap VA deposits for manual review.
- **Run `gofmt -w ./internal/payments` and `go vet ./...`** before committing. The
  wallet module is not in the CI vet matrix (`ci.yml` covers account/gateway/
  risk-monitor only), so nothing else will catch a formatting or vet issue.

## Regulatory note

Virtual-account collections via a licensed provider (Monnify/Moniepoint) keep you on
regulated bank rails — materially safer than crypto-P2P account routing. Keep KYC on
deposits/withdrawals. (P2P netting intentionally deferred.)
