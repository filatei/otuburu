package rest

// Admin endpoints for engine state. Sprint 5.5e — flipping account
// routing_mode between Synthetic and Passthrough.
//
// Auth: `Authorization: Bearer <ADMIN_SECRET>` header. The middleware
// (`adminMiddleware`) mirrors the pattern used by the wallet service's
// admin handler so a single shared secret rotates both services
// together.
//
// Routes are registered via `RegisterAdminRoutes(rg)`, called from
// `cmd/main.go` after `RegisterRoutes`. Kept in a separate file from
// the user-facing proxy routes so it's obvious which surface area is
// security-sensitive.
//
// Audit: every call writes a row to `admin_audit_log` via the
// audit.Logger injected at boot (Sprint 5.5f). Audit writes are
// best-effort — if the DB is unreachable, slog.Error fires but the
// admin action still succeeds. See internal/audit/audit.go for the
// rationale.

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/audit"
	"otuburu.money/gateway/internal/enginepb"
)

// auditLogger is set at boot from cmd/main.go via InitAudit. Nil-safe:
// audit.Logger handles a nil pool internally and degrades to slog.Error.
var auditLogger *audit.Logger

// InitAudit wires the audit.Logger into this package. Call once at
// boot, before RegisterAdminRoutes.
func InitAudit(l *audit.Logger) {
	auditLogger = l
}

// adminMiddleware validates the Bearer ADMIN_SECRET header on admin
// endpoints. Returns 503 when ADMIN_SECRET is unset (so a misconfigured
// deploy fails closed rather than allowing unrestricted admin), and
// 401 on mismatched tokens.
func adminMiddleware() gin.HandlerFunc {
	secret := os.Getenv("ADMIN_SECRET")
	return func(c *gin.Context) {
		if secret == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "admin not configured — set ADMIN_SECRET",
			})
			return
		}
		if c.GetHeader("Authorization") != "Bearer "+secret {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "unauthorized",
			})
			return
		}
		c.Next()
	}
}

// RegisterAdminRoutes attaches admin endpoints to the given router
// group. Call this from cmd/main.go after RegisterRoutes and after
// InitAudit.
//
// Routes (all require Authorization: Bearer <ADMIN_SECRET>):
//
//	POST /admin/accounts/:id/routing-mode
//	     body: {"routing_mode": "synthetic" | "passthrough"}
func RegisterAdminRoutes(rg *gin.RouterGroup) {
	admin := rg.Group("/admin", adminMiddleware())
	{
		admin.POST("/accounts/:id/routing-mode", handleAdminSetRoutingMode)
	}
}

// handleAdminSetRoutingMode flips an engine account between
// Synthetic and Passthrough routing. Sprint 5.5e — when an account
// is Passthrough, the engine's place_order RPC also forwards new
// orders to the configured LP adapter via liquidity-bridge.
//
// Body: {"routing_mode": "synthetic" | "passthrough"}
// Path: /admin/accounts/:id/routing-mode  (account UUID)
//
// Returns 200 with {"previous": "...", "current": "..."} on success.
// Returns 400 on validation error (invalid mode, account not found,
// etc.) with {"error": "..."}.
//
// Writes one row to admin_audit_log either way (Sprint 5.5f).
func handleAdminSetRoutingMode(c *gin.Context) {
	accountID := c.Param("id")
	var req struct {
		RoutingMode string `json:"routing_mode" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		auditLogger.LogFromGin(c, audit.Event{
			Action:   "set_account_routing_mode",
			Target:   accountID,
			After:    map[string]string{"requested": req.RoutingMode},
			Status:   http.StatusBadRequest,
			ErrorMsg: err.Error(),
		})
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()
	resp, err := engineClient.Service().SetAccountRoutingMode(ctx, &enginepb.SetAccountRoutingModeRequest{
		AccountId:   accountID,
		RoutingMode: req.RoutingMode,
	})
	if err != nil {
		// Transport-level failure (engine unreachable, timeout, etc.).
		// engineErr writes the response; capture status from gin and
		// audit the failure so transient outages have a trail.
		engineErr(c, err)
		auditLogger.LogFromGin(c, audit.Event{
			Action:   "set_account_routing_mode",
			Target:   accountID,
			After:    map[string]string{"requested": req.RoutingMode},
			Status:   c.Writer.Status(),
			ErrorMsg: err.Error(),
		})
		return
	}

	if !resp.Accepted {
		// Engine-level rejection (invalid mode string, account not
		// found in engine, etc.). 400 to the caller, audited.
		c.JSON(http.StatusBadRequest, gin.H{"error": resp.Error})
		auditLogger.LogFromGin(c, audit.Event{
			Action:   "set_account_routing_mode",
			Target:   accountID,
			After:    map[string]string{"requested": req.RoutingMode},
			Status:   http.StatusBadRequest,
			ErrorMsg: resp.Error,
		})
		return
	}

	// Success — echo previous + current to the caller, audit the diff.
	c.JSON(http.StatusOK, gin.H{
		"previous": resp.Previous,
		"current":  resp.Current,
	})
	auditLogger.LogFromGin(c, audit.Event{
		Action: "set_account_routing_mode",
		Target: accountID,
		Before: map[string]string{"routing_mode": resp.Previous},
		After:  map[string]string{"routing_mode": resp.Current},
		Status: http.StatusOK,
	})
}
