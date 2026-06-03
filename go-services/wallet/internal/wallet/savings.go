package wallet

// Savings wallet — a single USD pool per user, separate from any trading
// account. The SOLE origin for withdrawals (see Withdraw / WithdrawNGN).
// Users move funds Account → Savings before cashing out, which protects open
// positions and surfaces a clean payout obligation.
//
// Schema is defined in db/schema.sql under savings_wallets. Created lazily
// on the first /wallet/savings hit so we never need a backfill migration.

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"otuburu.money/wallet/internal/auth"
)

// dbExec is the subset of *pgxpool.Pool / pgx.Tx used by helpers in this
// package. Both types satisfy it without an adapter — identical signatures.
// Lets ensureSavingsBalance run either on a pool (read-only callers) or
// inside a transfer transaction (so it participates in the same row lock).
type dbExec interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ensureSavingsBalance returns the user's savings balance, creating the row
// on demand. The INSERT ... ON CONFLICT DO NOTHING + SELECT pattern is
// idempotent across concurrent calls and survives the race where two
// callers hit the empty path simultaneously.
func ensureSavingsBalance(ctx context.Context, q dbExec, userID string) (float64, error) {
	if _, err := q.Exec(ctx,
		`INSERT INTO savings_wallets (user_id) VALUES ($1)
		 ON CONFLICT (user_id) DO NOTHING`,
		userID,
	); err != nil {
		return 0, err
	}
	var bal float64
	if err := q.QueryRow(ctx,
		`SELECT balance FROM savings_wallets WHERE user_id=$1`, userID,
	).Scan(&bal); err != nil {
		return 0, err
	}
	return bal, nil
}

// GET /wallet/savings — returns the caller's savings balance, lazy-creating
// the row on first access.
//
//	{ "balance": 1234.56 }
func (h *Handler) Savings(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	bal, err := ensureSavingsBalance(c.Request.Context(), h.db, claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"balance": bal})
}
