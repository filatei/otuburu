// Squad (GTBank / HabariPay) downstream webhook.
//
//	POST /payments/squad/webhook   — receive forwarded Squad transaction events
//
// Otuburu shares ONE Squad account with the other Torama apps (vote, neflo).
// Squad allows only a single webhook URL per account, so vote hosts the hub
// (/webhooks/squad-hub); it verifies each event and forwards the ones it can't
// settle to this endpoint. The forwarded request carries the ORIGINAL body and
// `x-squad-encrypted-body` header, so we re-verify the shared HMAC-SHA512 here
// exactly as if Squad had called us directly — the signature is the auth.
//
// NOTE: Otuburu does not yet create Squad deposits, so this handler currently
// verifies and acknowledges only (idempotent no-op). When a Squad deposit flow
// is added, credit the account where marked TODO — mirror creditPaystack's
// status='pending' idempotency guard so the redirect and webhook paths can't
// double-credit.
package payments

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// SquadHandler verifies forwarded Squad webhook events.
type SquadHandler struct {
	secretKey string // SQUAD_SECRET_KEY env var (shared across the Torama apps)
}

// NewSquad creates the handler. Returns nil if SQUAD_SECRET_KEY is not set, in
// which case the route is not registered (complete no-op).
func NewSquad() *SquadHandler {
	secret := os.Getenv("SQUAD_SECRET_KEY")
	if secret == "" {
		slog.Warn("SQUAD_SECRET_KEY not set — Squad webhook disabled")
		return nil
	}
	return &SquadHandler{secretKey: secret}
}

// verifySig reports whether `header` is the valid Squad signature for `body`:
// the uppercase-hex HMAC-SHA512 of the raw body keyed by the shared secret.
// Case-insensitive (Squad sends uppercase; we normalise both sides).
func (h *SquadHandler) verifySig(body []byte, header string) bool {
	mac := hmac.New(sha512.New, []byte(h.secretKey))
	mac.Write(body)
	expected := strings.ToUpper(hex.EncodeToString(mac.Sum(nil)))
	got := strings.ToUpper(header)
	return hmac.Equal([]byte(expected), []byte(got))
}

// RegisterRoutes attaches the public, HMAC-verified webhook endpoint.
func (h *SquadHandler) RegisterRoutes(public *gin.RouterGroup) {
	if h == nil {
		return // Squad disabled
	}
	public.POST("/payments/squad/webhook", h.Webhook)
}

// Webhook verifies the forwarded Squad event and (for now) acknowledges it.
//
//	POST /payments/squad/webhook
//
// Signature: uppercase-hex HMAC-SHA512 of the raw body, in x-squad-encrypted-body.
func (h *SquadHandler) Webhook(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}

	// ── Signature verification ─────────────────────────────────────────────
	if !h.verifySig(body, c.GetHeader("x-squad-encrypted-body")) {
		slog.Warn("squad webhook: bad signature")
		c.Status(http.StatusUnauthorized)
		return
	}

	var event struct {
		Event string `json:"Event"`
		Body  struct {
			TransactionRef    string `json:"transaction_ref"`
			TransactionStatus string `json:"transaction_status"`
			Email             string `json:"email"`
			Amount            int64  `json:"amount"` // kobo
			Currency          string `json:"currency"`
		} `json:"Body"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		c.Status(http.StatusBadRequest)
		return
	}

	if !strings.Contains(strings.ToLower(event.Body.TransactionStatus), "success") {
		c.Status(http.StatusOK) // acknowledge but ignore
		return
	}

	// TODO: when Squad deposits exist for otuburu, match event.Body.TransactionRef
	// to a pending squad_payments row (or email+amount), verify via Squad's
	// /transaction/verify, then credit the account idempotently.
	slog.Info("squad webhook: verified event (no Squad deposit flow yet — acknowledged)",
		"ref", event.Body.TransactionRef, "amount_kobo", event.Body.Amount, "email", event.Body.Email)
	c.Status(http.StatusOK)
}
