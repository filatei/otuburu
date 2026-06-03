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
	rg.POST("/adjust-balance", makeAdjustBalanceHandler(secret))
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

// makeAdjustBalanceHandler returns a Gin handler that proxies internal
// AdjustBalance gRPC calls. Used by the wallet's transfer flow to move free
// margin into / out of a trading account without disturbing open positions.
//
// Request body:
//
//	{ "account_id": "<uuid>", "delta": -50.0, "reason": "transfer to savings" }
//
// Engine response shape (proto-JSON):
//
//	{ "accepted": true,  "newBalance": 950, "newFreeMargin": 250 }
//	{ "accepted": false, "rejectReason": "insufficient free margin: ...",
//	  "newBalance": 1000, "newFreeMargin": 0 }
//
// A 200 with accepted=false is NOT an error — it's a normal rejection that
// the caller surfaces to the user. Only network / engine outages bubble up
// as 5xx.
func makeAdjustBalanceHandler(secret string) gin.HandlerFunc {
	secretBytes := []byte(secret)
	return func(c *gin.Context) {
		got := []byte(c.GetHeader("X-Internal-Secret"))
		if subtle.ConstantTimeCompare(got, secretBytes) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "forbidden"})
			return
		}

		var req struct {
			AccountID string  `json:"account_id" binding:"required"`
			Delta     float64 `json:"delta"`
			Reason    string  `json:"reason"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if req.Delta == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "delta must be non-zero"})
			return
		}

		ctx, cancel := rpcCtx()
		defer cancel()

		resp, err := engineClient.Service().AdjustBalance(ctx, &enginepb.AdjustBalanceRequest{
			AccountId: req.AccountID,
			Delta:     req.Delta,
			Reason:    req.Reason,
		})
		if err != nil {
			engineErr(c, err)
			return
		}
		writeProtoJSON(c, http.StatusOK, resp)
	}
}
