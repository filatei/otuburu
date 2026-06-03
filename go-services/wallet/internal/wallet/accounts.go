package wallet

// Account management — list and create endpoints for the Phase-2 multi-account
// model. A user has exactly one demo (singleton via partial unique index in
// schema.sql) and any number of named real accounts. Trades, deposits, and
// withdrawals all scope to a single account_id; the frontend picks which.

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"otuburu.money/wallet/internal/auth"
)

// Hard cap to keep one user from creating thousands of accounts. 10 is way
// more than retail traders actually use (Exness allows 100, but that's a
// pro tier we don't have an equivalent for yet).
const maxRealAccountsPerUser = 10

type accountDTO struct {
	ID      string  `json:"id"`
	Label   string  `json:"label"`
	Type    string  `json:"type"`
	Balance float64 `json:"balance"`
	Kind    string  `json:"kind"`
}

// validKinds bounds the values POST /wallet/accounts will accept. Demo is
// rejected here because demo accounts are auto-created by /auth/google and
// can't be user-spawned. The check matches accounts.kind's CHECK constraint.
var validKinds = map[string]struct{}{
	"real_standard": {},
	"real_cent":     {},
	"real_micro":    {},
}

// GET /wallet/accounts — list every account the user owns (demo + all real).
// Ordered: real accounts first, by creation, then demo.
func (h *Handler) ListAccounts(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	rows, err := h.db.Query(ctx,
		`SELECT id, label, type, balance, kind FROM accounts
		 WHERE user_id = $1
		 ORDER BY type DESC, created_at`,
		claims.UserID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var out []accountDTO
	for rows.Next() {
		var a accountDTO
		if err := rows.Scan(&a.ID, &a.Label, &a.Type, &a.Balance, &a.Kind); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		out = append(out, a)
	}
	if out == nil {
		out = []accountDTO{}
	}
	c.JSON(http.StatusOK, gin.H{"accounts": out})
}

// POST /wallet/accounts — create a new real account.
//
//	Body: { "label": "Strategy A" }
//
// Returns the created account plus a fresh JWT that includes the new
// account_id in its AccountIDs slice so the client can immediately trade
// against it without re-authenticating. The engine book itself is created
// lazily by the frontend's existing provisionAccount() call — kept that way
// to avoid coupling the wallet to the engine gRPC client.
func (h *Handler) CreateAccount(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)

	var req struct {
		Label string `json:"label" binding:"required"`
		// kind selects the scaling factor on deposits + transfers into
		// this account. Defaults to 'real_standard' when omitted so older
		// clients that only send {label} keep working.
		Kind string `json:"kind"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "label required"})
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" || len(label) > 40 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "label must be 1–40 chars"})
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = "real_standard"
	}
	if _, ok := validKinds[kind]; !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be real_standard, real_cent, or real_micro"})
		return
	}

	ctx := c.Request.Context()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Cap check — keep one user from spamming the table.
	var existing int
	if err = tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM accounts WHERE user_id=$1 AND type='real'`,
		claims.UserID,
	).Scan(&existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if existing >= maxRealAccountsPerUser {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "account limit reached",
			"limit": maxRealAccountsPerUser,
		})
		return
	}

	// Insert the new account (balance 0 — must be funded via deposit).
	var newID string
	if err = tx.QueryRow(ctx,
		`INSERT INTO accounts (user_id, type, label, balance, kind)
		 VALUES ($1, 'real', $2, 0, $3)
		 RETURNING id`,
		claims.UserID, label, kind,
	).Scan(&newID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert: " + err.Error()})
		return
	}

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	// Mint a refreshed JWT so the new account is immediately tradeable.
	// We rebuild AccountIDs from the JWT's current slice + the new ID, which
	// is faster than a re-query and stays consistent with what the user
	// already has cached client-side.
	newSlice := append(append([]string{}, claims.AccountIDs...), newID)
	if len(claims.AccountIDs) == 0 && claims.AccountID != "" {
		// Token from before AccountIDs landed — recover the primary.
		newSlice = []string{claims.AccountID, newID}
	}
	tok, err := auth.Sign(claims.UserID, newSlice, claims.DemoID, claims.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token mint: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"account": accountDTO{
			ID:      newID,
			Label:   label,
			Type:    "real",
			Balance: 0,
			Kind:    kind,
		},
		"token": tok,
	})
}
