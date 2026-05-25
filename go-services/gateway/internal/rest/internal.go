package rest

// Internal server-to-server endpoints.
//
// These routes are NOT accessible from the internet — they should be placed
// behind an internal network boundary (e.g. Docker private network) and
// protected by X-Internal-Secret header rather than a user JWT.
//
// Current routes:
//   POST /internal/balance-sync  — push a new wallet balance into the engine book.
//     Called by the wallet service after every credited deposit.

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/enginepb"
)

var internalSecret = os.Getenv("INTERNAL_SECRET")

// RegisterInternalRoutes attaches the internal API to a route group.
// Typically called with r.Group("/internal").
func RegisterInternalRoutes(rg *gin.RouterGroup) {
	rg.POST("/balance-sync", handleBalanceSync)
}

// handleBalanceSync updates the engine book balance for a real account.
//
// Request body:
//
//	{ "account_id": "<uuid>", "balance": 1234.56 }
//
// Protected by X-Internal-Secret header — never expose this group to the internet.
func handleBalanceSync(c *gin.Context) {
	// Verify the shared secret.  An empty configured secret disables the endpoint.
	secret := c.GetHeader("X-Internal-Secret")
	if internalSecret == "" || secret != internalSecret {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "forbidden"})
		return
	}

	var req struct {
		AccountID string  `json:"account_id" binding:"required"`
		Balance   float64 `json:"balance"    binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().CreateAccount(ctx, &enginepb.CreateAccountRequest{
		AccountId:      req.AccountID,
		Label:          "Real",
		IsDemo:         false,
		InitialBalance: req.Balance,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
}
