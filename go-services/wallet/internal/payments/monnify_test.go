package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakePayout is a PayoutProvider test double for Router ordering/failover tests.
type fakePayout struct {
	name    string
	healthy bool
	ref     string
}

func (f *fakePayout) Name() string                 { return f.name }
func (f *fakePayout) Healthy(context.Context) bool { return f.healthy }
func (f *fakePayout) ResolveAccount(context.Context, string, string) (string, error) {
	return "TEST NAME", nil
}
func (f *fakePayout) Payout(context.Context, PayoutRequest) (*PayoutResult, error) {
	if !f.healthy {
		return nil, errors.New("provider down")
	}
	return &PayoutResult{Provider: f.name, Reference: f.ref, Status: "pending"}, nil
}

func sign(secret, body string) string {
	mac := hmac.New(sha512.New, []byte(secret))
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestParseDepositWebhook_ValidSignature(t *testing.T) {
	const secret = "test-secret-key-0123456789"
	m := &MonnifyProvider{secretKey: secret}

	body := `{"eventType":"SUCCESSFUL_TRANSACTION","eventData":{` +
		`"transactionReference":"MNFY|TXN|123","paymentReference":"PAY|123",` +
		`"amountPaid":16000.00,"currency":"NGN","paymentStatus":"PAID",` +
		`"product":{"reference":"acct-uuid-42","type":"RESERVED_ACCOUNT"}}}`

	req := httptest.NewRequest("POST", "/payments/monnify/webhook", strings.NewReader(body))
	req.Header.Set("monnify-signature", sign(secret, body))

	ev, err := m.ParseDepositWebhook(req, []byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ev.Successful {
		t.Fatalf("expected Successful=true")
	}
	if ev.AccountID != "acct-uuid-42" {
		t.Errorf("AccountID = %q, want acct-uuid-42", ev.AccountID)
	}
	if ev.NGNAmount != 16000.00 {
		t.Errorf("NGNAmount = %v, want 16000", ev.NGNAmount)
	}
	if ev.Reference != "MNFY|TXN|123" {
		t.Errorf("Reference = %q, want MNFY|TXN|123", ev.Reference)
	}
}

func TestParseDepositWebhook_BadSignature(t *testing.T) {
	m := &MonnifyProvider{secretKey: "real-secret-0123456789abcd"}
	body := `{"eventType":"SUCCESSFUL_TRANSACTION","eventData":{}}`
	req := httptest.NewRequest("POST", "/payments/monnify/webhook", strings.NewReader(body))
	req.Header.Set("monnify-signature", sign("WRONG-secret", body))

	if _, err := m.ParseDepositWebhook(req, []byte(body)); err == nil {
		t.Fatal("expected error for bad signature, got nil")
	}
}

func TestParseDepositWebhook_NonSuccessAcknowledged(t *testing.T) {
	const secret = "test-secret-key-0123456789"
	m := &MonnifyProvider{secretKey: secret}
	body := `{"eventType":"SUCCESSFUL_TRANSACTION","eventData":{"paymentStatus":"PENDING",` +
		`"amountPaid":100,"product":{"reference":"a"}}}`
	req := httptest.NewRequest("POST", "/x", strings.NewReader(body))
	req.Header.Set("monnify-signature", sign(secret, body))

	ev, err := m.ParseDepositWebhook(req, []byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Successful {
		t.Error("PENDING payment should not be Successful")
	}
}

func TestNormalizeMonnifyStatus(t *testing.T) {
	cases := map[string]string{
		"SUCCESS":             "sent",
		"COMPLETED":           "sent",
		"FAILED":              "failed",
		"REVERSED":            "failed",
		"PENDING":             "pending",
		"AWAITING_PROCESSING": "pending",
		"":                    "pending",
	}
	for in, want := range cases {
		if got := normalizeMonnifyStatus(in); got != want {
			t.Errorf("normalizeMonnifyStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

// customerRate is provider-neutral; confirm the deposit math gives the customer
// fewer USD than interbank (the spread is retained to fund FX conversion).
func TestDepositUSD_RetainsSpread(t *testing.T) {
	const interbank = 1600.0
	const ngnPaid = 16000.0
	usd := ngnPaid / customerRate(interbank)
	atInterbank := ngnPaid / interbank // 10.0
	if usd >= atInterbank {
		t.Fatalf("expected credited USD (%.4f) < interbank USD (%.4f)", usd, atInterbank)
	}
	// 2% spread → customer gets ~10/1.02 = 9.8039 USD.
	if usd < 9.79 || usd > 9.81 {
		t.Errorf("usd = %.4f, want ~9.804", usd)
	}
}

// Router selects the first healthy payout provider and fails over past unhealthy
// ones. fakePayout lets us exercise the ordering without network calls.
func TestRouterPayoutFailover(t *testing.T) {
	down := &fakePayout{name: "down", healthy: false}
	up := &fakePayout{name: "up", healthy: true, ref: "OK-1"}
	r := NewRouter()
	r.RegisterPayout(down)
	r.RegisterPayout(up)

	res, err := r.Payout(t.Context(), PayoutRequest{NGNAmount: 1000})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Provider != "up" || res.Reference != "OK-1" {
		t.Errorf("got %+v, want provider=up ref=OK-1", res)
	}
}

func TestRouterPayoutNoProvider(t *testing.T) {
	r := NewRouter()
	if _, err := r.Payout(t.Context(), PayoutRequest{}); err != ErrNoPayoutProvider {
		t.Fatalf("got %v, want ErrNoPayoutProvider", err)
	}
}
