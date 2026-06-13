package payments

// HTTP surface for the multi-PSP virtual-account deposit rail.
//
//	GET  /wallet/ngn/virtual-account   (JWT)    — ensure + return the caller's NUBAN
//	POST /payments/monnify/webhook     (public)  — Monnify funding notification
//
// Withdrawals continue to flow through the existing wallet handler; that handler
// should call Router.Payout / Router.ResolveAccount so payouts fail over across
// providers (see README_PAYMENTS_MULTIPSP.md for the one-line swap).

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/auth"
)

// ProviderHandler serves the virtual-account + webhook endpoints.
type ProviderHandler struct {
	db       *pgxpool.Pool
	router   *Router
	crediter *Crediter
}

// NewProviderHandler wires the router + crediter into an HTTP handler. Returns
// nil if no virtual-account provider is configured, so the caller can skip route
// registration cleanly.
func NewProviderHandler(db *pgxpool.Pool, router *Router, crediter *Crediter) *ProviderHandler {
	if router == nil || !router.HasVA() {
		return nil
	}
	return &ProviderHandler{db: db, router: router, crediter: crediter}
}

// RegisterRoutes attaches the VA + webhook routes. Webhook is public (HMAC-auth);
// the virtual-account endpoint requires a JWT.
func (ph *ProviderHandler) RegisterRoutes(protected *gin.RouterGroup, public *gin.RouterGroup) {
	if ph == nil {
		return
	}
	protected.GET("/wallet/ngn/virtual-account", ph.VirtualAccount)
	public.POST("/payments/monnify/webhook", ph.MonnifyWebhook)
}

// VirtualAccount returns the caller's persistent NUBAN, creating it on first
// request. Optional ?account_id= selects which owned account to fund (defaults
// to the legacy primary). The returned account is safe to display and reuse —
// every transfer to it credits the same account instantly.
//
//	GET /wallet/ngn/virtual-account[?account_id=...]
//	200 { "provider","account_number","bank_name","bank_code","account_name" }
func (ph *ProviderHandler) VirtualAccount(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)

	accountID := c.Query("account_id")
	if accountID == "" {
		accountID = claims.AccountID
	}
	if accountID == "" || !claims.OwnsAccount(accountID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your account"})
		return
	}

	ctx := c.Request.Context()

	// Pick the provider: reuse whichever one already issued this account's NUBAN
	// (so the number never changes under the user), else the highest-priority
	// healthy provider for a fresh issue.
	provider := ph.providerForAccount(ctx, accountID)
	if provider == nil {
		provider = ph.router.VAProvider(ctx)
	}
	if provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no deposit provider available right now"})
		return
	}

	// Fast path: already stored.
	if va, err := ph.crediter.LookupVirtualAccount(ctx, provider.Name(), accountID); err == nil && va != nil {
		c.JSON(http.StatusOK, vaJSON(va))
		return
	}

	name := ph.userName(ctx, claims.UserID)
	va, err := provider.EnsureVirtualAccount(ctx, accountID, claims.UserID, claims.Email, name)
	if err != nil {
		slog.Error("ensure virtual account", "provider", provider.Name(), "account", accountID, "err", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "could not provision a deposit account"})
		return
	}
	if err := ph.crediter.SaveVirtualAccount(ctx, va, accountID, claims.UserID); err != nil {
		slog.Error("persist virtual account", "err", err)
		// Non-fatal: the NUBAN is valid even if we failed to cache it; the
		// webhook resolves via product.reference regardless.
	}
	c.JSON(http.StatusOK, vaJSON(va))
}

// MonnifyWebhook receives Monnify funding notifications, verifies the signature,
// and credits the account. Always 200 on a well-formed, authentic event so
// Monnify stops retrying; only signature/parse failures return non-200.
func (ph *ProviderHandler) MonnifyWebhook(c *gin.Context) {
	provider := ph.router.VAProviderByName(monnifyName)
	if provider == nil {
		c.Status(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}
	ev, err := provider.ParseDepositWebhook(c.Request, body)
	if err != nil {
		slog.Warn("monnify webhook rejected", "err", err)
		c.Status(http.StatusUnauthorized)
		return
	}
	if !ev.Successful {
		c.Status(http.StatusOK) // acknowledge non-funding / non-success events
		return
	}
	if err := ph.crediter.Credit(context.Background(), ev); err != nil {
		slog.Error("monnify credit failed", "ref", ev.Reference, "err", err)
		c.Status(http.StatusInternalServerError) // let Monnify retry
		return
	}
	c.Status(http.StatusOK)
}

// providerForAccount returns the VA provider that already issued a NUBAN for
// accountID, or nil if none has yet.
func (ph *ProviderHandler) providerForAccount(ctx context.Context, accountID string) VirtualAccountProvider {
	var providerName string
	err := ph.db.QueryRow(ctx,
		`SELECT provider FROM virtual_accounts WHERE account_id=$1 LIMIT 1`, accountID,
	).Scan(&providerName)
	if err != nil {
		return nil
	}
	return ph.router.VAProviderByName(providerName)
}

// userName best-effort resolves the user's display name for the NUBAN label.
func (ph *ProviderHandler) userName(ctx context.Context, userID string) string {
	var name string
	if err := ph.db.QueryRow(ctx,
		`SELECT COALESCE(name,'') FROM users WHERE id=$1`, userID,
	).Scan(&name); err != nil {
		return ""
	}
	return name
}

func vaJSON(va *VirtualAccount) gin.H {
	return gin.H{
		"provider":       va.Provider,
		"account_number": va.AccountNumber,
		"bank_name":      va.BankName,
		"bank_code":      va.BankCode,
		"account_name":   va.AccountName,
	}
}
