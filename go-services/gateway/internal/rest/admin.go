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

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/enginepb"
)

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
// group. Call this from cmd/main.go after RegisterRoutes.
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
// Returns 200 with {"routing_mode": "synthetic"|"passthrough"} on
// success. Returns 400 on validation error (invalid mode, account
// not found, etc.) with {"error": "..."}.
func handleAdminSetRoutingMode(c *gin.Context) {
	accountID := c.Param("id")
	var req struct {
		RoutingMode string `json:"routing_mode" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()
	resp, err := engineClient.Service().SetAccountRoutingMode(ctx, &enginepb.SetAccountRoutingModeRequest{
		AccountId:   accountID,
		RoutingMode: req.RoutingMode,
	})
	if err != nil {
		engineErr(c, err)
		return
	}

	switch r := resp.Result.(type) {
	case *enginepb.SetAccountRoutingModeResponse_Current:
		c.JSON(http.StatusOK, gin.H{"routing_mode": r.Current})
	case *enginepb.SetAccountRoutingModeResponse_Error:
		c.JSON(http.StatusBadRequest, gin.H{"error": r.Error})
	default:
		// Defensive — proto oneof should always populate exactly one
		// arm. If we ever see neither, something's wrong with the
		// engine response shape.
		c.JSON(http.StatusInternalServerError, gin.H{"error": "engine returned empty response"})
	}
}
