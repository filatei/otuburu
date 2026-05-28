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
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/enginepb"
)

// RegisterInternalRoutes attaches the internal API to a route group, binding
// in the shared secret. Pass a non-empty `secret` — the caller (main.go) is
// responsible for fail-loud at boot if it isn't configured. Module-level
// `os.Getenv` is intentionally avoided here so the dependency is explicit.
func RegisterInternalRoutes(rg *gin.RouterGroup, secret string) {
	rg.POST("/balance-sync", makeBalanceSyncHandler(secret))
}

// makeBalanceSyncHandler closes over the shared secret and returns a Gin
// handler. Splitting the closure out makes the secret dependency explicit
// and keeps the request-time auth check on a constant-time comparison.
//
// Request body:
//
//	{ "account_id": "<uuid>", "balance": 1234.56 }
//
// Protected by X-Internal-Secret header — never expose this group to the internet.
func makeBalanceSyncHandler(secret string) gin.HandlerFunc {
	secretBytes := []byte(secret)
	return func(c *gin.Context) {
		// subtle.ConstantTimeCompare avoids any timing side-channel on the
		// secret comparison. ConstantTimeCompare returns 0 when lengths
		// differ, so it also rejects an empty header against a real secret.
		got := []byte(c.GetHeader("X-Internal-Secret"))
		if subtle.ConstantTimeCompare(got, secretBytes) != 1 {
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
}
