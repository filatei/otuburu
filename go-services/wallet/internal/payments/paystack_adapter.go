package payments

// Adapter making the existing Paystack *Handler satisfy the PayoutProvider
// interface, so the Router can fail over to Paystack for NGN withdrawals once
// it is approved — without modifying the battle-tested paystack.go / ngn_withdraw.go.
//
// Paystack is intentionally NOT registered as a VirtualAccountProvider here:
// its dedicated-NUBAN product ("Dedicated Virtual Account") requires the very
// business approval we're routing around. We only expose its payout capability.

import (
	"context"
	"fmt"
)

// PaystackProvider wraps *Handler to expose it through the Router.
type PaystackProvider struct {
	h *Handler
}

// NewPaystackProvider returns a payout provider backed by the Paystack handler,
// or nil if the handler is nil (Paystack disabled).
func NewPaystackProvider(h *Handler) *PaystackProvider {
	if h == nil {
		return nil
	}
	return &PaystackProvider{h: h}
}

// Name implements Provider.
func (p *PaystackProvider) Name() string { return "paystack" }

// Healthy implements Provider. The handler only exists when PAYSTACK_SECRET_KEY
// is set (see payments.New), so presence is our liveness signal; we avoid a
// network round-trip on every selection.
func (p *PaystackProvider) Healthy(_ context.Context) bool {
	return p != nil && p.h != nil && p.h.secretKey != ""
}

// ResolveAccount implements PayoutProvider — delegates to the existing
// /bank/resolve call.
func (p *PaystackProvider) ResolveAccount(ctx context.Context, bankCode, accountNumber string) (string, error) {
	return p.h.ResolveAccount(ctx, bankCode, accountNumber)
}

// Payout implements PayoutProvider by chaining the handler's two-step transfer:
// create a recipient_code, then initiate the transfer. The returned transfer
// code is stored as withdrawals.txid by the caller.
func (p *PaystackProvider) Payout(ctx context.Context, req PayoutRequest) (*PayoutResult, error) {
	recipient, err := p.h.CreateRecipient(ctx, req.AccountName, req.AccountNumber, req.BankCode)
	if err != nil {
		return nil, fmt.Errorf("paystack recipient: %w", err)
	}
	transferCode, err := p.h.InitiateTransfer(ctx, recipient, req.NGNAmount, req.Narration)
	if err != nil {
		return nil, fmt.Errorf("paystack transfer: %w", err)
	}
	return &PayoutResult{
		Provider:  "paystack",
		Reference: transferCode,
		Status:    "pending", // confirmed later by transfer.success webhook
	}, nil
}
