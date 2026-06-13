package payments

// Monnify adapter — virtual accounts (instant NGN deposits) + disbursements
// (NGN withdrawals). Monnify is owned by Moniepoint and prices bank-transfer /
// reserved-account collections aggressively, which is exactly the rail we want
// as the default instant NGN deposit method while Paystack approval is pending.
//
// API surface used (https://docs.teamapt.com / developers.monnify.com):
//
//	POST /api/v1/auth/login                          — Basic(apiKey:secretKey) → bearer token (~1h)
//	POST /api/v2/bank-transfer/reserved-accounts     — create a reserved (static) NUBAN
//	GET  /api/v2/bank-transfer/reserved-accounts/{ref}
//	GET  /api/v1/disbursements/account/validate      — name enquiry
//	POST /api/v2/disbursements/single                — single NGN transfer (payout)
//
// Webhook auth: Monnify signs the raw request body with HMAC-SHA512 keyed by the
// client secret and sends it in the `monnify-signature` header. We recompute and
// constant-time compare before trusting any event.
//
// The reserved account's accountReference is set to OUR accounts.id, so the
// SUCCESSFUL_TRANSACTION webhook's eventData.product.reference maps the inbound
// transfer straight back to the account to credit.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	monnifyName        = "monnify"
	monnifyLiveBaseURL = "https://api.monnify.com"
	// Token is refreshed when within this window of expiry.
	monnifyTokenSkew = 60 * time.Second
)

// MonnifyProvider implements VirtualAccountProvider and PayoutProvider.
type MonnifyProvider struct {
	apiKey        string
	secretKey     string
	contractCode  string // collections contract code (reserved accounts)
	walletAccount string // our Monnify wallet/source account number (disbursements)
	baseURL       string
	client        *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

// NewMonnify builds the Monnify provider from env, returning nil (disabled) if
// the required credentials are absent — symmetric with payments.New for Paystack.
//
// Env:
//
//	MONNIFY_API_KEY         — collections API key
//	MONNIFY_SECRET_KEY      — secret (also the webhook HMAC key)
//	MONNIFY_CONTRACT_CODE   — collections contract code
//	MONNIFY_WALLET_ACCOUNT  — source account number for disbursements (optional;
//	                          payouts disabled if unset, deposits still work)
//	MONNIFY_BASE_URL        — override (defaults to live); set the sandbox URL in staging
func NewMonnify() *MonnifyProvider {
	apiKey := os.Getenv("MONNIFY_API_KEY")
	secret := os.Getenv("MONNIFY_SECRET_KEY")
	contract := os.Getenv("MONNIFY_CONTRACT_CODE")
	if apiKey == "" || secret == "" || contract == "" {
		return nil
	}
	base := os.Getenv("MONNIFY_BASE_URL")
	if base == "" {
		base = monnifyLiveBaseURL
	}
	return &MonnifyProvider{
		apiKey:        apiKey,
		secretKey:     secret,
		contractCode:  contract,
		walletAccount: os.Getenv("MONNIFY_WALLET_ACCOUNT"),
		baseURL:       strings.TrimRight(base, "/"),
		client:        &http.Client{Timeout: 15 * time.Second},
	}
}

// Name implements Provider.
func (m *MonnifyProvider) Name() string { return monnifyName }

// Healthy implements Provider — true if we can obtain a valid auth token.
// Nil-safe so a typed-nil provider (defensive) reports unhealthy rather than
// panicking.
func (m *MonnifyProvider) Healthy(ctx context.Context) bool {
	if m == nil {
		return false
	}
	_, err := m.authToken(ctx)
	return err == nil
}

// ── Auth ────────────────────────────────────────────────────────────────────

// authToken returns a cached bearer token, refreshing it via Basic-auth login
// when missing or near expiry. Thread-safe.
func (m *MonnifyProvider) authToken(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.token != "" && time.Now().Add(monnifyTokenSkew).Before(m.tokenExp) {
		return m.token, nil
	}

	basic := base64.StdEncoding.EncodeToString([]byte(m.apiKey + ":" + m.secretKey))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.baseURL+"/api/v1/auth/login", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var out struct {
		RequestSuccessful bool   `json:"requestSuccessful"`
		ResponseMessage   string `json:"responseMessage"`
		ResponseBody      struct {
			AccessToken string `json:"accessToken"`
			ExpiresIn   int64  `json:"expiresIn"` // seconds
		} `json:"responseBody"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("monnify auth: decode: %w", err)
	}
	if !out.RequestSuccessful || out.ResponseBody.AccessToken == "" {
		return "", fmt.Errorf("monnify auth failed: %s", out.ResponseMessage)
	}

	m.token = out.ResponseBody.AccessToken
	exp := out.ResponseBody.ExpiresIn
	if exp <= 0 {
		exp = 3000 // ~50min conservative default
	}
	m.tokenExp = time.Now().Add(time.Duration(exp) * time.Second)
	return m.token, nil
}

// doJSON performs an authenticated JSON request and decodes the response into v.
func (m *MonnifyProvider) doJSON(ctx context.Context, method, path string, reqBody any, v any) error {
	tok, err := m.authToken(ctx)
	if err != nil {
		return err
	}
	var rdr io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, m.baseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("monnify %s %s: HTTP %d: %s", method, path, resp.StatusCode, string(body))
	}
	if v == nil {
		return nil
	}
	return json.Unmarshal(body, v)
}

// ── Virtual accounts ──────────────────────────────────────────────────────────

// EnsureVirtualAccount implements VirtualAccountProvider. Reserved accounts are
// idempotent on accountReference at Monnify's side, so we always send accountID
// as the reference; a repeat call returns the same NUBAN(s). We surface the
// first returned account (Monnify can issue several across banks).
func (m *MonnifyProvider) EnsureVirtualAccount(ctx context.Context, accountID, userID, custEmail, name string) (*VirtualAccount, error) {
	if name == "" {
		name = "Otuburu User"
	}
	if custEmail == "" {
		custEmail = userID + "@users.otuburu.money"
	}
	reqBody := map[string]any{
		"accountReference":     accountID,
		"accountName":          name,
		"currencyCode":         "NGN",
		"contractCode":         m.contractCode,
		"customerEmail":        custEmail,
		"customerName":         name,
		"getAllAvailableBanks": true,
	}

	var out struct {
		RequestSuccessful bool   `json:"requestSuccessful"`
		ResponseMessage   string `json:"responseMessage"`
		ResponseBody      struct {
			Accounts []struct {
				BankCode      string `json:"bankCode"`
				BankName      string `json:"bankName"`
				AccountNumber string `json:"accountNumber"`
				AccountName   string `json:"accountName"`
			} `json:"accounts"`
		} `json:"responseBody"`
	}
	if err := m.doJSON(ctx, http.MethodPost, "/api/v2/bank-transfer/reserved-accounts", reqBody, &out); err != nil {
		return nil, err
	}
	if !out.RequestSuccessful || len(out.ResponseBody.Accounts) == 0 {
		return nil, fmt.Errorf("monnify reserve account: %s", out.ResponseMessage)
	}
	a := out.ResponseBody.Accounts[0]
	return &VirtualAccount{
		Provider:      monnifyName,
		AccountNumber: a.AccountNumber,
		BankName:      a.BankName,
		BankCode:      a.BankCode,
		AccountName:   a.AccountName,
		Reference:     accountID,
	}, nil
}

// ParseDepositWebhook implements VirtualAccountProvider. It verifies the
// monnify-signature HMAC over the raw body, then extracts the credited account
// and amount from a SUCCESSFUL_TRANSACTION event.
func (m *MonnifyProvider) ParseDepositWebhook(r *http.Request, body []byte) (*DepositEvent, error) {
	if err := m.verifySig(r, body); err != nil {
		return nil, err
	}

	var ev struct {
		EventType string `json:"eventType"`
		EventData struct {
			PaymentReference     string  `json:"paymentReference"`
			TransactionReference string  `json:"transactionReference"`
			AmountPaid           float64 `json:"amountPaid"`
			Currency             string  `json:"currency"`
			PaymentStatus        string  `json:"paymentStatus"`
			Product              struct {
				Reference string `json:"reference"` // = accountReference = our accounts.id
				Type      string `json:"type"`
			} `json:"product"`
		} `json:"eventData"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, fmt.Errorf("monnify webhook: decode: %w", err)
	}

	// Only reserved-account funding credits a balance. Non-success or unrelated
	// events return Successful=false / nil error so the caller 200-acknowledges.
	success := ev.EventType == "SUCCESSFUL_TRANSACTION" &&
		strings.EqualFold(ev.EventData.PaymentStatus, "PAID")

	ref := ev.EventData.TransactionReference
	if ref == "" {
		ref = ev.EventData.PaymentReference
	}

	return &DepositEvent{
		Provider:   monnifyName,
		Reference:  ref,
		AccountID:  ev.EventData.Product.Reference,
		NGNAmount:  ev.EventData.AmountPaid,
		Currency:   ev.EventData.Currency,
		Successful: success,
	}, nil
}

// ── Disbursements (payout) ────────────────────────────────────────────────────

// ResolveAccount implements PayoutProvider — Monnify name enquiry.
func (m *MonnifyProvider) ResolveAccount(ctx context.Context, bankCode, accountNumber string) (string, error) {
	path := fmt.Sprintf("/api/v1/disbursements/account/validate?accountNumber=%s&bankCode=%s",
		accountNumber, bankCode)
	var out struct {
		RequestSuccessful bool   `json:"requestSuccessful"`
		ResponseMessage   string `json:"responseMessage"`
		ResponseBody      struct {
			AccountName   string `json:"accountName"`
			AccountNumber string `json:"accountNumber"`
		} `json:"responseBody"`
	}
	if err := m.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return "", err
	}
	if !out.RequestSuccessful || out.ResponseBody.AccountName == "" {
		return "", fmt.Errorf("monnify resolve: %s", out.ResponseMessage)
	}
	return out.ResponseBody.AccountName, nil
}

// Payout implements PayoutProvider — a single NGN bank transfer. Requires
// MONNIFY_WALLET_ACCOUNT to be set (the funded source account). The async result
// is confirmed by Monnify's disbursement webhook; we report the initial status.
func (m *MonnifyProvider) Payout(ctx context.Context, req PayoutRequest) (*PayoutResult, error) {
	if m.walletAccount == "" {
		return nil, fmt.Errorf("monnify payout disabled: MONNIFY_WALLET_ACCOUNT unset")
	}
	reqBody := map[string]any{
		"amount":                   req.NGNAmount,
		"reference":                req.Reference,
		"narration":                req.Narration,
		"destinationBankCode":      req.BankCode,
		"destinationAccountNumber": req.AccountNumber,
		"currency":                 "NGN",
		"sourceAccountNumber":      m.walletAccount,
	}
	var out struct {
		RequestSuccessful bool   `json:"requestSuccessful"`
		ResponseMessage   string `json:"responseMessage"`
		ResponseBody      struct {
			Reference string `json:"reference"`
			Status    string `json:"status"`
		} `json:"responseBody"`
	}
	if err := m.doJSON(ctx, http.MethodPost, "/api/v2/disbursements/single", reqBody, &out); err != nil {
		return nil, err
	}
	if !out.RequestSuccessful {
		return nil, fmt.Errorf("monnify payout: %s", out.ResponseMessage)
	}
	return &PayoutResult{
		Provider:  monnifyName,
		Reference: out.ResponseBody.Reference,
		Status:    normalizeMonnifyStatus(out.ResponseBody.Status),
	}, nil
}

// normalizeMonnifyStatus maps Monnify disbursement statuses onto our
// withdrawals vocabulary ('pending'|'sent'|'failed').
func normalizeMonnifyStatus(s string) string {
	switch strings.ToUpper(s) {
	case "SUCCESS", "COMPLETED":
		return "sent"
	case "FAILED", "REVERSED":
		return "failed"
	default:
		return "pending" // PENDING, AWAITING_PROCESSING, etc.
	}
}

// ── Webhook signature + disbursement events ───────────────────────────────────

// verifySig recomputes the HMAC-SHA512 of the raw body keyed by the client
// secret and constant-time compares it against the monnify-signature header.
// Shared by the deposit and disbursement webhook parsers.
func (m *MonnifyProvider) verifySig(r *http.Request, body []byte) error {
	sig := r.Header.Get("monnify-signature")
	if sig == "" {
		return fmt.Errorf("monnify webhook: missing signature")
	}
	mac := hmac.New(sha512.New, []byte(m.secretKey))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(sig)) {
		return fmt.Errorf("monnify webhook: bad signature")
	}
	return nil
}

// IsDisbursementEvent peeks the eventType (no signature check) to decide whether
// an inbound webhook is a payout settlement vs a deposit. Monnify delivers all
// events to the same URL, so the handler routes on this before parsing. The
// chosen parser re-verifies the signature, so peeking unverified is safe.
func (m *MonnifyProvider) IsDisbursementEvent(body []byte) bool {
	var probe struct {
		EventType string `json:"eventType"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return false
	}
	return strings.Contains(strings.ToUpper(probe.EventType), "DISBURSEMENT") ||
		strings.Contains(strings.ToUpper(probe.EventType), "TRANSFER")
}

// ParseDisbursementWebhook verifies the signature and parses a payout settlement
// event into a DisbursementEvent. Reference is the value WE sent on the payout
// (the withdrawal id), so the caller can settle the matching withdrawals row.
func (m *MonnifyProvider) ParseDisbursementWebhook(r *http.Request, body []byte) (*DisbursementEvent, error) {
	if err := m.verifySig(r, body); err != nil {
		return nil, err
	}
	var ev struct {
		EventType string `json:"eventType"`
		EventData struct {
			Reference            string `json:"reference"`
			TransactionReference string `json:"transactionReference"`
			Status               string `json:"status"`
		} `json:"eventData"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, fmt.Errorf("monnify disbursement webhook: decode: %w", err)
	}

	// Status can arrive either in eventData.status or be implied by eventType
	// (SUCCESSFUL_DISBURSEMENT / FAILED_DISBURSEMENT / REVERSED_DISBURSEMENT).
	status := normalizeMonnifyStatus(ev.EventData.Status)
	upper := strings.ToUpper(ev.EventType)
	switch {
	case strings.HasPrefix(upper, "SUCCESSFUL"):
		status = "sent"
	case strings.HasPrefix(upper, "FAILED"), strings.HasPrefix(upper, "REVERSED"):
		status = "failed"
	}

	return &DisbursementEvent{
		Provider:  monnifyName,
		Reference: ev.EventData.Reference,
		Status:    status,
	}, nil
}
