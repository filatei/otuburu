package payments

// Multi-PSP payment abstraction.
//
// Motivation: the wallet must not depend on a single payment processor. Paystack
// approval can stall for weeks, and any one provider can have an outage. This
// file defines a provider-agnostic interface so NGN deposits and withdrawals can
// be served by whichever processor is healthy and cheapest — Monnify, Flutterwave,
// Korapay, Squad, Fincra, or Paystack — behind a single Router.
//
// Two capabilities are modelled separately because providers differ:
//
//   - VirtualAccountProvider: issues a *static* NUBAN per user. The user sends a
//     normal bank transfer to it from any banking app; the provider fires a
//     webhook; we credit instantly. This is the fastest "instant NGN deposit"
//     rail and needs no checkout redirect. Monnify is the reference impl.
//
//   - PayoutProvider: resolves a destination bank account and disburses NGN to
//     it (withdrawals). Paystack and Monnify both implement this.
//
// A provider may implement one or both. The Router picks the first healthy
// provider for each capability and fails over on error.
//
// FX cost model (unchanged from the Paystack path): the customer is charged at
// interbank * (1 + spread) on deposits and paid interbank * (1 - spread) on
// withdrawals. The spread (default 2%, see paystackSpreadPct / customerRate) is
// what funds our real bank-side FX conversion and absorbs intra-window drift —
// this is the "use the exchange rate to balance cost" lever.

import (
	"context"
	"net/http"
)

// VirtualAccount is a static NUBAN assigned to one of our accounts. The user
// funds it with an ordinary bank transfer; the owning provider notifies us.
type VirtualAccount struct {
	Provider      string // "monnify", "flutterwave", ...
	AccountNumber string // the NUBAN the user transfers to
	BankName      string // e.g. "Wema Bank"
	BankCode      string
	AccountName   string // the name shown on the virtual account
	Reference     string // provider-side account reference (we set it = our account_id)
}

// DepositEvent is the normalised result of parsing a provider deposit webhook.
// AccountID is OUR accounts.id, recovered from the provider reference we set at
// virtual-account creation time. Reference is the provider's unique transaction
// id and doubles as our idempotency key.
type DepositEvent struct {
	Provider   string
	Reference  string  // provider transaction reference (idempotency key)
	AccountID  string  // our accounts.id
	NGNAmount  float64 // gross naira received
	Currency   string  // "NGN"
	Successful bool
}

// PayoutRequest is a normalised NGN bank disbursement (a withdrawal leg).
type PayoutRequest struct {
	AccountName   string
	AccountNumber string
	BankCode      string
	NGNAmount     float64 // gross naira to send
	Reference     string  // our unique reference (idempotency)
	Narration     string
}

// PayoutResult is the normalised response from a disbursement call.
type PayoutResult struct {
	Provider  string
	Reference string // provider-side transfer reference (store in withdrawals.txid)
	Status    string // "pending" | "sent" | "failed"
}

// Provider is the base capability every payment processor satisfies.
type Provider interface {
	// Name is the stable lowercase identifier persisted in provider columns.
	Name() string
	// Healthy reports whether the provider is currently reachable and usable
	// (e.g. credentials valid, auth token obtainable). Used by the Router to
	// skip dead providers. Should be cheap and fast; cache internally.
	Healthy(ctx context.Context) bool
}

// VirtualAccountProvider issues static NUBANs and parses their funding webhooks.
type VirtualAccountProvider interface {
	Provider
	// EnsureVirtualAccount returns the persistent NUBAN for accountID, creating
	// it at the provider on first call. Idempotent: repeated calls return the
	// same account. `reference` stored at the provider is the caller's accountID
	// so the webhook can be mapped back to us.
	EnsureVirtualAccount(ctx context.Context, accountID, userID, email, name string) (*VirtualAccount, error)
	// ParseDepositWebhook authenticates (signature-checks) and parses an inbound
	// webhook into a DepositEvent. Returns an error if the signature is invalid
	// or the body is unparseable. Non-success events return Successful=false with
	// a nil error so the caller can 200-acknowledge and ignore.
	ParseDepositWebhook(r *http.Request, body []byte) (*DepositEvent, error)
}

// PayoutProvider resolves destination accounts and disburses NGN to them.
type PayoutProvider interface {
	Provider
	// ResolveAccount returns the account holder's name for a bank_code +
	// account_number pair, so the UI can confirm before sending.
	ResolveAccount(ctx context.Context, bankCode, accountNumber string) (string, error)
	// Payout initiates a single NGN bank transfer.
	Payout(ctx context.Context, req PayoutRequest) (*PayoutResult, error)
}

// ── Router ─────────────────────────────────────────────────────────────────────

// Router holds the ordered, prioritised list of providers for each capability.
// Order = priority: index 0 is tried first. Register cheapest/most-reliable
// first. The Router is read-only after wiring, so it needs no locking.
type Router struct {
	va     []VirtualAccountProvider
	payout []PayoutProvider
}

// NewRouter returns an empty Router. Register providers in priority order.
func NewRouter() *Router {
	return &Router{}
}

// RegisterVA appends a virtual-account provider in priority order. Nil is a
// no-op so callers can register optionally-configured providers unconditionally.
func (r *Router) RegisterVA(p VirtualAccountProvider) {
	if p == nil {
		return
	}
	r.va = append(r.va, p)
}

// RegisterPayout appends a payout provider in priority order. Nil is a no-op.
func (r *Router) RegisterPayout(p PayoutProvider) {
	if p == nil {
		return
	}
	r.payout = append(r.payout, p)
}

// VAProvider returns the highest-priority healthy virtual-account provider, or
// nil if none are configured/healthy. Callers should 503 on nil.
//
// A user's existing virtual account stays pinned to whichever provider issued
// it (the mapping lives in the virtual_accounts table); this selection only
// governs which provider issues a *new* account.
func (r *Router) VAProvider(ctx context.Context) VirtualAccountProvider {
	for _, p := range r.va {
		if p.Healthy(ctx) {
			return p
		}
	}
	return nil
}

// VAProviderByName returns the registered VA provider with the given Name(), or
// nil. Used to route an inbound webhook to the provider that owns it, and to
// re-issue against the provider that already holds a user's account.
func (r *Router) VAProviderByName(name string) VirtualAccountProvider {
	for _, p := range r.va {
		if p.Name() == name {
			return p
		}
	}
	return nil
}

// Payout attempts the disbursement against each healthy payout provider in
// priority order, returning on the first success. The supplied reference is the
// idempotency key — it is passed through unchanged to every provider attempt, so
// a provider that already saw it (on a retry) can dedupe. Returns the last error
// if every provider fails or none are configured.
func (r *Router) Payout(ctx context.Context, req PayoutRequest) (*PayoutResult, error) {
	var lastErr error
	tried := false
	for _, p := range r.payout {
		if !p.Healthy(ctx) {
			continue
		}
		tried = true
		res, err := p.Payout(ctx, req)
		if err == nil {
			return res, nil
		}
		lastErr = err
	}
	if !tried {
		return nil, ErrNoPayoutProvider
	}
	return nil, lastErr
}

// ResolveAccount returns the destination account holder's name using the first
// healthy payout provider that can resolve it, failing over on error. Use this
// from the withdrawal handler so the name-enquiry step matches the provider that
// will actually disburse.
func (r *Router) ResolveAccount(ctx context.Context, bankCode, accountNumber string) (string, error) {
	var lastErr error
	tried := false
	for _, p := range r.payout {
		if !p.Healthy(ctx) {
			continue
		}
		tried = true
		name, err := p.ResolveAccount(ctx, bankCode, accountNumber)
		if err == nil {
			return name, nil
		}
		lastErr = err
	}
	if !tried {
		return "", ErrNoPayoutProvider
	}
	return "", lastErr
}

// HasPayout reports whether at least one payout provider is registered (healthy
// or not). Lets the wallet handler decide whether to expose NGN withdrawal.
func (r *Router) HasPayout() bool { return len(r.payout) > 0 }

// HasVA reports whether at least one virtual-account provider is registered.
func (r *Router) HasVA() bool { return len(r.va) > 0 }
