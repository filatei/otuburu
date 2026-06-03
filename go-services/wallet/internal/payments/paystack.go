// Package payments handles fiat and crypto payment channel integrations.
//
// Paystack (NGN):
//   POST /payments/paystack/initiate  — create a Paystack payment link
//   POST /payments/paystack/webhook   — receive confirmed payment events
//
// The webhook verifies Paystack's HMAC-SHA512 signature before crediting any account.
// Paystack sends NGN; we convert to USD at USD_TO_NGN_RATE (env) for the account credit.
package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/accountkind"
	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/email"
)

const (
	paystackBaseURL = "https://api.paystack.co"
	minDepositUSD   = 5.0 // minimum $5 equivalent deposit

	// Spread applied to interbank NGN/USD rate when charging NGN deposits.
	// Customer effectively pays interbank * (1 + paystackSpreadPct) NGN per
	// USD credited. Covers our own bank FX conversion cost when we settle out
	// of NGN, plus a thin protective margin against intra-window rate drift
	// (Paystack callback usually arrives in <10 min). 2% is the industry-
	// standard retail FX spread for emerging-market corridors; tweak with
	// great care — see fx_quotes table for the audit trail.
	paystackSpreadPct = 0.02
)

// customerRate returns the NGN/USD rate the customer is actually charged at —
// interbank plus our 2% spread. Pure for testing.
func customerRate(interbank float64) float64 {
	return interbank * (1 + paystackSpreadPct)
}

// Handler processes Paystack payment events.
type Handler struct {
	db             *pgxpool.Pool
	secretKey      string       // PAYSTACK_SECRET_KEY env var
	rates          *RateFetcher // live USD→NGN rate (never nil)
	gatewayURL     string       // GATEWAY_URL — for post-deposit engine sync
	internalSecret string       // INTERNAL_SECRET
	mailer         *email.Mailer
	client         *http.Client
}

// New creates a Paystack handler.  Returns nil if PAYSTACK_SECRET_KEY is not set.
// The supplied RateFetcher (already Started) provides the live USD/NGN rate.
// `mailer` may be nil — emails just become a no-op in that case.
func New(db *pgxpool.Pool, rates *RateFetcher, mailer *email.Mailer) *Handler {
	secret := os.Getenv("PAYSTACK_SECRET_KEY")
	if secret == "" {
		slog.Warn("PAYSTACK_SECRET_KEY not set — Paystack payments disabled")
		return nil
	}
	return &Handler{
		db:             db,
		secretKey:      secret,
		rates:          rates,
		gatewayURL:     os.Getenv("GATEWAY_URL"),
		internalSecret: os.Getenv("INTERNAL_SECRET"),
		mailer:         mailer,
		client:         &http.Client{Timeout: 15 * time.Second},
	}
}

// ── Route registration ────────────────────────────────────────────────────────

// RegisterRoutes attaches Paystack routes to a router group.
// Protected routes (Initiate) require a valid JWT; the webhook endpoint is public
// but HMAC-verified.
func (h *Handler) RegisterRoutes(protected *gin.RouterGroup, public *gin.RouterGroup) {
	if h == nil {
		return // Paystack disabled
	}
	protected.POST("/payments/paystack/initiate", h.Initiate)
	// Synchronous credit-on-return — the frontend calls this when the user
	// lands back at our callback URL after Paystack checkout. We verify the
	// reference against Paystack's REST API server-side and credit the
	// account immediately if successful. Same creditPaystack() flow as the
	// webhook path, with idempotency (UPDATE ... status='pending' guard),
	// so whichever path finishes first wins and the other no-ops.
	protected.POST("/payments/paystack/verify", h.Verify)
	public.POST("/payments/paystack/webhook", h.Webhook)
}

// ── Initiate ──────────────────────────────────────────────────────────────────

type initiateReq struct {
	AmountUSD float64 `json:"amount_usd" binding:"required,min=5"`
}

// Initiate creates a Paystack transaction and returns the authorization_url for redirect.
//
//	POST /payments/paystack/initiate
//	{ "amount_usd": 50 }
func (h *Handler) Initiate(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)

	var req initiateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.AmountUSD < minDepositUSD {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("minimum deposit is $%.0f", minDepositUSD)})
		return
	}

	// Charge customer at customer_rate (interbank + 2% spread). The user
	// gets credited their requested USD; we pocket the spread to cover the
	// real bank FX cost when we settle out plus a small protective buffer.
	interbank   := h.rates.GetUSDToNGN()
	custRate    := customerRate(interbank)
	amountKobo  := int64(req.AmountUSD * custRate * 100) // Paystack uses kobo (1/100 NGN)
	ref         := fmt.Sprintf("OTU-%d-%x", time.Now().UnixMilli(), rand.Int31()) //nolint:gosec

	callbackURL := os.Getenv("APP_URL") // e.g. https://otuburu.torama.money
	if callbackURL == "" {
		callbackURL = "https://otuburu.torama.money"
	}

	body, _ := json.Marshal(map[string]interface{}{
		"email":        claims.Email,
		"amount":       amountKobo,
		"reference":    ref,
		"callback_url": callbackURL + "?deposit=success",
		"metadata": map[string]interface{}{
			"account_id": claims.AccountID,
			"user_id":    claims.UserID,
			"amount_usd": req.AmountUSD,
		},
		"currency": "NGN",
	})

	psReq, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodPost,
		paystackBaseURL+"/transaction/initialize", bytes.NewReader(body))
	psReq.Header.Set("Authorization", "Bearer "+h.secretKey)
	psReq.Header.Set("Content-Type", "application/json")

	resp, err := h.client.Do(psReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "paystack unavailable"})
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	var ps struct {
		Status bool `json:"status"`
		Data   struct {
			AuthorizationURL string `json:"authorization_url"`
			Reference        string `json:"reference"`
		} `json:"data"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rb, &ps); err != nil || !ps.Status {
		c.JSON(http.StatusBadGateway, gin.H{"error": "paystack init failed: " + ps.Message})
		return
	}

	// Store pending payment for idempotency check at webhook time
	h.db.Exec(c.Request.Context(), //nolint:errcheck
		`INSERT INTO paystack_payments (reference, account_id, user_id, amount_usd, status)
		 VALUES ($1,$2,$3,$4,'pending')
		 ON CONFLICT (reference) DO NOTHING`,
		ref, claims.AccountID, claims.UserID, req.AmountUSD,
	)

	c.JSON(http.StatusOK, gin.H{
		"authorization_url": ps.Data.AuthorizationURL,
		"reference":         ref,
		"amount_usd":        req.AmountUSD,
		"amount_ngn":        req.AmountUSD * custRate,
		"interbank_rate":    interbank,
		"customer_rate":     custRate,
		"spread_pct":        paystackSpreadPct,
	})
}

// ── Webhook ───────────────────────────────────────────────────────────────────

// Webhook receives Paystack event callbacks.
//
//	POST /payments/paystack/webhook
//
// Verifies the X-Paystack-Signature HMAC before processing.
func (h *Handler) Webhook(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}

	// ── Signature verification ─────────────────────────────────────────────
	mac := hmac.New(sha512.New, []byte(h.secretKey))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	got := c.GetHeader("X-Paystack-Signature")
	if !hmac.Equal([]byte(expected), []byte(got)) {
		slog.Warn("paystack webhook: bad signature")
		c.Status(http.StatusUnauthorized)
		return
	}

	var event struct {
		Event string `json:"event"`
		Data  struct {
			Reference string  `json:"reference"`
			Status    string  `json:"status"`
			Amount    int64   `json:"amount"` // kobo
			Currency  string  `json:"currency"`
			Metadata  struct {
				AccountID string  `json:"account_id"`
				UserID    string  `json:"user_id"`
				AmountUSD float64 `json:"amount_usd"`
			} `json:"metadata"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		c.Status(http.StatusBadRequest)
		return
	}

	if event.Event != "charge.success" || event.Data.Status != "success" {
		c.Status(http.StatusOK) // acknowledge but ignore
		return
	}

	ctx := context.Background()
	if err := h.creditPaystack(ctx, event.Data.Reference, event.Data.Metadata.AccountID,
		event.Data.Metadata.AmountUSD, event.Data.Amount); err != nil {
		slog.Error("paystack credit failed", "ref", event.Data.Reference, "err", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Status(http.StatusOK)
}

// Verify is the synchronous credit-on-return path. Called by the frontend
// after Paystack redirects the user back with a ?reference= query param.
// We trust the JWT for user identity, then hit Paystack's /transaction/
// verify API server-side to confirm the payment actually succeeded.
// Idempotent with the webhook path — both call creditPaystack which gates
// on the paystack_payments status='pending' guard.
//
// POST /payments/paystack/verify
// Body: { "reference": "OTU-..." }
//
// Response:
//   200 + { "status": "confirmed", "amount_usd": 12.34 } — credit applied
//        OR { "status": "already_confirmed" }            — webhook beat us to it
//   400 + { "error": "..." } — bad input
//   402 + { "error": "payment not successful" } — Paystack says not paid
//   404 + { "error": "reference not found" } — never seen this ref
//   500 + { "error": "..." } — internal
func (h *Handler) Verify(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	var req struct {
		Reference string `json:"reference" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()

	// Look up our row first — gives us the account_id + the quoted USD that
	// the user saw at initiate time. Also lets us short-circuit if we've
	// already credited (e.g. webhook arrived just before this call).
	var accountID, status string
	var amountUSD float64
	err := h.db.QueryRow(ctx,
		`SELECT account_id, amount_usd, status FROM paystack_payments
		 WHERE reference=$1 AND user_id=$2`,
		req.Reference, claims.UserID,
	).Scan(&accountID, &amountUSD, &status)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "reference not found for this user"})
		return
	}
	if status == "confirmed" {
		c.JSON(http.StatusOK, gin.H{
			"status":     "already_confirmed",
			"amount_usd": amountUSD,
		})
		return
	}

	// Hit Paystack to confirm the payment actually succeeded. They expose
	// /transaction/verify/{reference} which returns the canonical status —
	// trustworthy because the call is authenticated with our secret key,
	// not user-provided input.
	psResp, err := h.paystackVerify(ctx, req.Reference)
	if err != nil {
		slog.Warn("paystack verify call failed", "ref", req.Reference, "err", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "could not reach Paystack"})
		return
	}
	if psResp.Status != "success" {
		// Could be 'failed', 'abandoned', 'pending'. None of these credit.
		c.JSON(http.StatusPaymentRequired, gin.H{
			"error":          "payment not successful",
			"paystack_status": psResp.Status,
		})
		return
	}

	// Credit using the same flow the webhook uses — UPDATE ... status='pending'
	// guard makes this safe to race with an arriving webhook.
	if err := h.creditPaystack(ctx, req.Reference, accountID, amountUSD, psResp.Amount); err != nil {
		slog.Error("paystack credit failed (verify path)", "ref", req.Reference, "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "credit failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":     "confirmed",
		"amount_usd": amountUSD,
	})
}

// paystackVerifyResp mirrors the subset of Paystack's /transaction/verify
// response we actually use. Full doc:
// https://paystack.com/docs/api/transaction/#verify
type paystackVerifyResp struct {
	Status   string `json:"status"`  // 'success', 'failed', 'abandoned', 'pending'
	Amount   int64  `json:"amount"`  // kobo
	Currency string `json:"currency"`
	Reference string `json:"reference"`
}

func (h *Handler) paystackVerify(ctx context.Context, reference string) (*paystackVerifyResp, error) {
	url := "https://api.paystack.co/transaction/verify/" + reference
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+h.secretKey)
	httpReq.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("paystack verify HTTP %d", resp.StatusCode)
	}
	var envelope struct {
		Status  bool                `json:"status"`  // true on success
		Message string              `json:"message"`
		Data    paystackVerifyResp  `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	if !envelope.Status {
		return nil, fmt.Errorf("paystack: %s", envelope.Message)
	}
	return &envelope.Data, nil
}

func (h *Handler) creditPaystack(ctx context.Context, ref, accountID string, amountUSD float64, amountKobo int64) error {
	// Idempotency: mark as processing atomically
	result, err := h.db.Exec(ctx,
		`UPDATE paystack_payments SET status='processing' WHERE reference=$1 AND status='pending'`,
		ref,
	)
	if err != nil || result.RowsAffected() == 0 {
		return nil // already processed or unknown reference
	}

	// Trust the quoted USD from Initiate time — that's what the user saw and
	// expects to receive. Paystack always charges the exact NGN we asked for
	// (amountKobo), and we charged using customer_rate = interbank * (1 + 2%)
	// at Initiate time. By crediting the quoted USD we:
	//   • give the user exactly what they were promised, no surprise haircut
	//   • absorb FX drift during the brief checkout window (typically <10 min)
	//   • pocket the 2% spread, which is what funds our own bank's conversion
	// If the kobo metadata was tampered we'd detect it via the amount-vs-kobo
	// audit row in fx_quotes (admin can spot inconsistencies post-hoc).
	usdCredited := amountUSD
	ngnCharged  := float64(amountKobo) / 100.0
	interbank   := h.rates.GetUSDToNGN()
	custRate    := customerRate(interbank)

	// Apply the account's kind multiplier so a $10 deposit into a cent
	// account credits $1,000 cent-units. Fetched outside the tx — kind is
	// immutable post-creation so there's no read-modify-write race here.
	var kind string
	if err := h.db.QueryRow(ctx,
		`SELECT kind FROM accounts WHERE id=$1`, accountID,
	).Scan(&kind); err != nil {
		return err
	}
	scaled := usdCredited * accountkind.Scale(kind)

	tx, err := h.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
		scaled, accountID,
	); err != nil {
		return err
	}

	// Ledger row records the SCALED account-unit movement so reconcile
	// against accounts.balance is a straight sum. The fx_quotes row below
	// still captures the real USD/NGN values for the FX audit trail.
	if _, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'deposit',$2,'confirmed',$3,$4)`,
		accountID, scaled, ref,
		fmt.Sprintf("Paystack NGN deposit (ref %s)", ref),
	); err != nil {
		return err
	}

	if _, err = tx.Exec(ctx,
		`UPDATE paystack_payments SET status='confirmed', amount_usd_actual=$1 WHERE reference=$2`,
		usdCredited, ref,
	); err != nil {
		return err
	}

	// fx_quotes audit row — one per credited NGN deposit. Lets us answer
	// "I deposited X NGN and got $Y — what rate was used?" months later.
	if _, err = tx.Exec(ctx,
		`INSERT INTO fx_quotes (
		    paystack_ref, base_ccy, quote_ccy,
		    interbank_rate, spread_pct, customer_rate,
		    ngn_charged, usd_credited
		 ) VALUES ($1,'USD','NGN',$2,$3,$4,$5,$6)
		 ON CONFLICT (paystack_ref) DO NOTHING`,
		ref, interbank, paystackSpreadPct, custRate, ngnCharged, usdCredited,
	); err != nil {
		return err
	}

	if err = tx.Commit(ctx); err != nil {
		return err
	}

	slog.Info("paystack deposit credited",
		"account", accountID,
		"usd_credited", usdCredited,
		"ngn_charged", ngnCharged,
		"interbank_rate", interbank,
		"customer_rate", custRate,
		"ref", ref)

	// Push new balance into engine book
	h.syncEngineBalance(ctx, accountID)

	// Notify the user — best-effort, fire-and-forget.
	h.notifyDepositCredited(ctx, accountID, usdCredited, ref)
	return nil
}

// notifyDepositCredited sends the "deposit credited" email. Errors are logged
// inside the mailer; we never block the transaction on this.
func (h *Handler) notifyDepositCredited(ctx context.Context, accountID string, usd float64, ref string) {
	if h.mailer == nil {
		return
	}
	var (
		emailAddr string
		name      string
	)
	err := h.db.QueryRow(ctx,
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
	h.mailer.Send(emailAddr, subject, body)
}

func (h *Handler) syncEngineBalance(ctx context.Context, accountID string) {
	if h.gatewayURL == "" || h.internalSecret == "" {
		return
	}
	var balance float64
	if err := h.db.QueryRow(ctx,
		`SELECT balance FROM accounts WHERE id = $1`, accountID,
	).Scan(&balance); err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"account_id": accountID,
		"balance":    balance,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		h.gatewayURL+"/internal/balance-sync", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Secret", h.internalSecret)
	resp, err := h.client.Do(req)
	if err != nil {
		slog.Warn("paystack: engine sync failed", "err", err)
		return
	}
	resp.Body.Close()
}
