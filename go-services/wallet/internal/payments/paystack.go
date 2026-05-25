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

	"otuburu.money/wallet/internal/auth"
)

const (
	paystackBaseURL = "https://api.paystack.co"
	minDepositUSD   = 5.0 // minimum $5 equivalent deposit
)

// Handler processes Paystack payment events.
type Handler struct {
	db             *pgxpool.Pool
	secretKey      string       // PAYSTACK_SECRET_KEY env var
	rates          *RateFetcher // live USD→NGN rate (never nil)
	gatewayURL     string       // GATEWAY_URL — for post-deposit engine sync
	internalSecret string       // INTERNAL_SECRET
	client         *http.Client
}

// New creates a Paystack handler.  Returns nil if PAYSTACK_SECRET_KEY is not set.
// The supplied RateFetcher (already Started) provides the live USD/NGN rate.
func New(db *pgxpool.Pool, rates *RateFetcher) *Handler {
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

	amountKobo := int64(req.AmountUSD * h.rates.GetUSDToNGN() * 100) // Paystack uses kobo (1/100 NGN)
	ref := fmt.Sprintf("OTU-%d-%x", time.Now().UnixMilli(), rand.Int31()) //nolint:gosec

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
		"amount_ngn":        req.AmountUSD * h.rates.GetUSDToNGN(),
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

func (h *Handler) creditPaystack(ctx context.Context, ref, accountID string, amountUSD float64, amountKobo int64) error {
	// Idempotency: mark as processing atomically
	result, err := h.db.Exec(ctx,
		`UPDATE paystack_payments SET status='processing' WHERE reference=$1 AND status='pending'`,
		ref,
	)
	if err != nil || result.RowsAffected() == 0 {
		return nil // already processed or unknown reference
	}

	// Recompute USD amount from kobo in case metadata was tampered
	amountUSDSafe := float64(amountKobo) / 100.0 / h.rates.GetUSDToNGN()

	tx, err := h.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
		amountUSDSafe, accountID,
	); err != nil {
		return err
	}

	if _, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'deposit',$2,'confirmed',$3,$4)`,
		accountID, amountUSDSafe, ref,
		fmt.Sprintf("Paystack NGN deposit (ref %s)", ref),
	); err != nil {
		return err
	}

	if _, err = tx.Exec(ctx,
		`UPDATE paystack_payments SET status='confirmed', amount_usd_actual=$1 WHERE reference=$2`,
		amountUSDSafe, ref,
	); err != nil {
		return err
	}

	if err = tx.Commit(ctx); err != nil {
		return err
	}

	slog.Info("paystack deposit credited",
		"account", accountID, "amount_usd", amountUSDSafe, "ref", ref)

	// Push new balance into engine book
	h.syncEngineBalance(ctx, accountID)
	return nil
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
