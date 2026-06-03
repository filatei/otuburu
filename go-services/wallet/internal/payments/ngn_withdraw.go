package payments

// NGN withdrawal via Paystack Transfer API.
//
// Flow:
//   1. Frontend collects { amount_usd, bank_code, bank_account_number }
//   2. We hit Paystack /bank/resolve to verify the account number matches a
//      real account at that bank, and we get the bank_account_name back
//   3. We compute NGN payout: usd × interbank × (1 − spread_pct).
//      Withdrawal spread is the same magnitude as deposit (2% by default)
//      but inverts: customer gets LESS NGN per USD than interbank.
//   4. We debit USD from the user's account in the same db tx as the
//      withdrawals insert (status='pending')
//   5. We POST /transferrecipient to create a Paystack recipient_code
//   6. We POST /transfer to initiate the payout (status='approved')
//   7. Paystack's webhook flips status='sent' on transfer.success or
//      status='failed' on transfer.failed/.reversed (the latter also
//      refunds the USD balance)
//
// Steps 5-6 happen inside the request handler so a user click triggers a
// real Paystack call; this means the API takes ~2-5s. Acceptable for a
// "send money to my bank" action — users expect bank transfers to feel
// substantial, not instant.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// Same spread magnitude as the deposit path but applied inversely:
	// customers receive (1 - spread)x interbank NGN per USD withdrawn.
	// Net round-trip cost (deposit + immediate withdraw) ≈ 2 × 2% = 4%.
	ngnWithdrawSpreadPct = 0.02
	// Paystack minimum transfer amount is ₦100; below that the API rejects.
	// At interbank-1600 that's roughly $0.06 USD — our minimum withdrawal
	// of $10 USD comfortably clears it.
	paystackMinNGN = 100.0
)

// CustomerWithdrawRate returns the NGN-per-USD rate the customer effectively
// receives on a withdrawal. Lower than interbank by exactly the spread.
func CustomerWithdrawRate(interbank float64) float64 {
	return interbank * (1.0 - ngnWithdrawSpreadPct)
}

// ResolveAccount verifies that the supplied account number is a real account
// at the bank identified by bank_code, and returns the account holder's name.
//
//	GET https://api.paystack.co/bank/resolve?account_number=X&bank_code=Y
//
// Used so the frontend can show the user "Account: ADAMU BELLO" before they
// confirm the transfer — gives them a chance to bail if it's not their
// account. Paystack's KYC layer is what's actually doing the verification;
// we just relay it.
func (h *Handler) ResolveAccount(ctx context.Context, bankCode, accountNumber string) (string, error) {
	if h == nil {
		return "", errors.New("paystack handler unavailable")
	}
	url := fmt.Sprintf("%s/bank/resolve?account_number=%s&bank_code=%s",
		paystackBaseURL, accountNumber, bankCode)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+h.secretKey)

	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var payload struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			AccountName   string `json:"account_name"`
			AccountNumber string `json:"account_number"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	if !payload.Status || payload.Data.AccountName == "" {
		return "", fmt.Errorf("paystack: %s", payload.Message)
	}
	return payload.Data.AccountName, nil
}

// CreateRecipient registers the bank account with Paystack as a transfer
// target. Returns the recipient_code that subsequent /transfer calls use.
// Idempotent on Paystack's side — calling with the same details returns the
// same recipient_code.
func (h *Handler) CreateRecipient(ctx context.Context, accountName, accountNumber, bankCode string) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"type":           "nuban", // NUBAN is the standard Nigerian account number format
		"name":           accountName,
		"account_number": accountNumber,
		"bank_code":      bankCode,
		"currency":       "NGN",
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		paystackBaseURL+"/transferrecipient", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+h.secretKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	var payload struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			RecipientCode string `json:"recipient_code"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rb, &payload); err != nil {
		return "", err
	}
	if !payload.Status || payload.Data.RecipientCode == "" {
		return "", fmt.Errorf("paystack recipient create: %s", payload.Message)
	}
	return payload.Data.RecipientCode, nil
}

// InitiateTransfer kicks off the actual money movement to the recipient.
// Returns the transfer_code which is what Paystack uses to identify the
// transfer in its webhooks (transfer.success / transfer.failed).
func (h *Handler) InitiateTransfer(ctx context.Context, recipientCode string, ngnAmount float64, reason string) (string, error) {
	if ngnAmount < paystackMinNGN {
		return "", fmt.Errorf("amount below paystack minimum ₦%.0f", paystackMinNGN)
	}
	body, _ := json.Marshal(map[string]any{
		"source":    "balance",
		"reason":    reason,
		"amount":    int64(ngnAmount * 100), // kobo
		"recipient": recipientCode,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		paystackBaseURL+"/transfer", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+h.secretKey)
	req.Header.Set("Content-Type", "application/json")
	// 10s — Paystack transfer init usually returns in 1-3s but can spike.
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req = req.WithContext(reqCtx)

	resp, err := h.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	var payload struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			TransferCode string `json:"transfer_code"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rb, &payload); err != nil {
		return "", err
	}
	if !payload.Status || payload.Data.TransferCode == "" {
		return "", fmt.Errorf("paystack transfer init: %s", payload.Message)
	}
	return payload.Data.TransferCode, nil
}

// CurrentNGNCustomerRate exposes the rate the customer would receive RIGHT
// NOW. Convenience so the wallet/withdraw handler can show a preview.
// Falls back to 0 (caller treats as "rate unavailable") if rates aren't ready.
func (h *Handler) CurrentNGNCustomerRate() float64 {
	if h == nil || h.rates == nil {
		return 0
	}
	return CustomerWithdrawRate(h.rates.GetUSDToNGN())
}

