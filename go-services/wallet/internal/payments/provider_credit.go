package payments

// Provider-agnostic deposit crediting + virtual-account persistence.
//
// This mirrors the FX/scaling/ledger/engine-sync logic of creditPaystack but is
// driven by a normalised DepositEvent, so any VirtualAccountProvider (Monnify,
// Flutterwave, ...) credits through one code path. Paystack keeps its own
// creditPaystack for now to avoid disturbing a working production path; both
// converge on the same accounts/ledger tables.
//
// Idempotency lives in provider_deposits(provider, reference) UNIQUE — a webhook
// replay inserts nothing new and the credit is skipped.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/accountkind"
	"otuburu.money/wallet/internal/email"
)

// Sentinel errors returned by the Router / Crediter.
var (
	// ErrNoPayoutProvider means no payout provider is registered at all.
	ErrNoPayoutProvider = errors.New("no NGN payout provider configured")
	// ErrNoVAProvider means no virtual-account provider is registered/healthy.
	ErrNoVAProvider = errors.New("no virtual-account provider available")
)

// Crediter holds the shared dependencies the generic deposit path needs. It is
// constructed once in main.go and handed to the provider HTTP handlers.
type Crediter struct {
	db             *pgxpool.Pool
	rates          *RateFetcher
	gatewayURL     string
	internalSecret string
	mailer         *email.Mailer
	client         *http.Client
}

// NewCrediter builds the shared deposit crediter. rates must already be Started.
func NewCrediter(db *pgxpool.Pool, rates *RateFetcher, gatewayURL, internalSecret string, mailer *email.Mailer) *Crediter {
	return &Crediter{
		db:             db,
		rates:          rates,
		gatewayURL:     gatewayURL,
		internalSecret: internalSecret,
		mailer:         mailer,
		client:         &http.Client{Timeout: 15 * time.Second},
	}
}

// SaveVirtualAccount upserts the provider→account mapping so future webhooks and
// re-issues resolve to the same NUBAN. Keyed by (provider, account_id).
func (c *Crediter) SaveVirtualAccount(ctx context.Context, va *VirtualAccount, accountID, userID string) error {
	_, err := c.db.Exec(ctx,
		`INSERT INTO virtual_accounts
		   (account_id, user_id, provider, account_number, bank_name, bank_code, account_name, reference)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 ON CONFLICT (provider, account_id) DO UPDATE SET
		   account_number = EXCLUDED.account_number,
		   bank_name      = EXCLUDED.bank_name,
		   bank_code      = EXCLUDED.bank_code,
		   account_name   = EXCLUDED.account_name,
		   reference      = EXCLUDED.reference`,
		accountID, userID, va.Provider, va.AccountNumber, va.BankName,
		va.BankCode, va.AccountName, va.Reference,
	)
	return err
}

// LookupVirtualAccount returns the stored NUBAN for (provider, account_id), or
// (nil, nil) if none exists yet.
func (c *Crediter) LookupVirtualAccount(ctx context.Context, provider, accountID string) (*VirtualAccount, error) {
	va := &VirtualAccount{Provider: provider}
	err := c.db.QueryRow(ctx,
		`SELECT account_number, bank_name, bank_code, account_name, reference
		   FROM virtual_accounts WHERE provider=$1 AND account_id=$2`,
		provider, accountID,
	).Scan(&va.AccountNumber, &va.BankName, &va.BankCode, &va.AccountName, &va.Reference)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return va, nil
}

// Credit applies a confirmed deposit event to the user's account. Idempotent on
// (provider, reference). USD credited = ngn / customerRate(interbank), i.e. the
// customer receives fewer USD than interbank by exactly the spread, which funds
// our FX conversion cost. Safe to call from multiple webhook deliveries.
func (c *Crediter) Credit(ctx context.Context, ev *DepositEvent) error {
	if ev == nil || !ev.Successful {
		return nil
	}
	if ev.AccountID == "" || ev.NGNAmount <= 0 {
		return fmt.Errorf("credit: invalid event (account=%q ngn=%.2f)", ev.AccountID, ev.NGNAmount)
	}

	interbank := c.rates.GetUSDToNGN()
	if interbank <= 0 {
		return errors.New("credit: FX rate unavailable")
	}
	custRate := customerRate(interbank) // interbank * (1 + spread)
	usdCredited := ev.NGNAmount / custRate

	// Apply the account-kind multiplier (e.g. cent accounts) exactly like the
	// Paystack path. kind is immutable post-creation, so no race here. Read
	// before the tx since it's independent.
	var kind string
	if err := c.db.QueryRow(ctx,
		`SELECT kind FROM accounts WHERE id=$1`, ev.AccountID,
	).Scan(&kind); err != nil {
		return fmt.Errorf("credit: account kind lookup: %w", err)
	}
	scaled := usdCredited * accountkind.Scale(kind)

	tx, err := c.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Idempotency gate INSIDE the tx: a duplicate webhook hits the UNIQUE
	// (provider, reference) constraint, ON CONFLICT DO NOTHING yields 0 rows,
	// and we roll back without crediting. Keeping the insert in-tx means a
	// later failure rolls the row back too, so a Monnify retry can credit
	// cleanly — no stuck 'processing' rows. Concurrent deliveries serialize on
	// the unique index: the loser sees the conflict and no-ops.
	tag, err := tx.Exec(ctx,
		`INSERT INTO provider_deposits
		   (provider, reference, account_id, ngn_amount, usd_credited,
		    interbank_rate, spread_pct, customer_rate, status)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')
		 ON CONFLICT (provider, reference) DO NOTHING`,
		ev.Provider, ev.Reference, ev.AccountID, ev.NGNAmount, usdCredited,
		interbank, paystackSpreadPct, custRate,
	)
	if err != nil {
		return fmt.Errorf("credit: insert provider_deposit: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil // already credited — idempotent no-op (tx rolls back cleanly)
	}

	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
		scaled, ev.AccountID,
	); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'deposit',$2,'confirmed',$3,$4)`,
		ev.AccountID, scaled, ev.Reference,
		fmt.Sprintf("%s NGN virtual-account deposit (ref %s)", ev.Provider, ev.Reference),
	); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}

	slog.Info("provider deposit credited",
		"provider", ev.Provider,
		"account", ev.AccountID,
		"usd_credited", usdCredited,
		"ngn", ev.NGNAmount,
		"interbank_rate", interbank,
		"customer_rate", custRate,
		"ref", ev.Reference)

	c.syncEngineBalance(ctx, ev.AccountID)
	c.notifyDepositCredited(ctx, ev.AccountID, usdCredited, ev.Reference)
	return nil
}

// syncEngineBalance pushes the new balance into the engine book via the gateway,
// identical to the Paystack handler's leg. Best-effort.
func (c *Crediter) syncEngineBalance(ctx context.Context, accountID string) {
	if c.gatewayURL == "" || c.internalSecret == "" {
		return
	}
	var balance float64
	if err := c.db.QueryRow(ctx,
		`SELECT balance FROM accounts WHERE id = $1`, accountID,
	).Scan(&balance); err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"account_id": accountID,
		"balance":    balance,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.gatewayURL+"/internal/balance-sync", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Secret", c.internalSecret)
	resp, err := c.client.Do(req)
	if err != nil {
		slog.Warn("provider: engine sync failed", "err", err)
		return
	}
	resp.Body.Close()
}

// notifyDepositCredited sends the best-effort "deposit credited" email.
func (c *Crediter) notifyDepositCredited(ctx context.Context, accountID string, usd float64, ref string) {
	if c.mailer == nil {
		return
	}
	var emailAddr, name string
	err := c.db.QueryRow(ctx,
		`SELECT u.email, COALESCE(u.name, '') FROM users u
		 JOIN accounts a ON a.user_id = u.id
		 WHERE a.id = $1`,
		accountID,
	).Scan(&emailAddr, &name)
	if err != nil || emailAddr == "" {
		slog.Warn("mailer: skip — could not resolve recipient", "account_id", accountID, "err", err)
		return
	}
	if name == "" {
		name = "there"
	}
	subject := fmt.Sprintf("Deposit credited — $%.2f", usd)
	body := email.DepositCreditedHTML(name, usd, "NGN", ref)
	c.mailer.Send(emailAddr, subject, body)
}
