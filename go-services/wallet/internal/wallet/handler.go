package wallet

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/email"
)

type Handler struct {
	db     *pgxpool.Pool
	hd     *HDWallet
	mailer *email.Mailer
}

// NewHandler builds the wallet HTTP handler. `mailer` may be nil — emails
// just become a no-op in that case (no crash).
func NewHandler(db *pgxpool.Pool, hd *HDWallet, mailer *email.Mailer) *Handler {
	return &Handler{db: db, hd: hd, mailer: mailer}
}

// GET /wallet/deposit-address — returns (or creates) the user's TRC20 deposit address.
// Uses a table-level lock to avoid a TOCTOU race on hd_index allocation.
func (h *Handler) DepositAddress(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	// Fast path: address already allocated.
	var address string
	err := h.db.QueryRow(ctx,
		`SELECT address FROM deposit_addresses WHERE user_id=$1`, claims.UserID,
	).Scan(&address)
	if err == nil {
		c.JSON(http.StatusOK, depositAddressResponse(address))
		return
	}

	// Slow path: allocate a new HD index under an exclusive lock so two concurrent
	// requests can't get the same index.
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock the table for the duration of this transaction.
	if _, err = tx.Exec(ctx, `LOCK TABLE deposit_addresses IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "lock failed"})
		return
	}

	// Re-check inside the lock (another goroutine may have inserted already).
	lockErr := tx.QueryRow(ctx,
		`SELECT address FROM deposit_addresses WHERE user_id=$1`, claims.UserID,
	).Scan(&address)
	if lockErr == nil {
		tx.Rollback(ctx) //nolint:errcheck
		c.JSON(http.StatusOK, depositAddressResponse(address))
		return
	}

	var hdIndex int
	if err = tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(hd_index)+1, 0) FROM deposit_addresses`,
	).Scan(&hdIndex); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "index error"})
		return
	}

	addr, err := h.hd.Address(uint32(hdIndex))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "address derivation failed"})
		return
	}

	if _, err = tx.Exec(ctx,
		`INSERT INTO deposit_addresses (user_id, address, hd_index) VALUES ($1,$2,$3)`,
		claims.UserID, addr, hdIndex,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "store failed"})
		return
	}

	if err = tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	c.JSON(http.StatusOK, depositAddressResponse(addr))
}

func depositAddressResponse(address string) gin.H {
	return gin.H{
		"address":  address,
		"network":  "TRC20",
		"token":    "USDT",
		"contract": USDTContract,
		"note":     "Send USDT (TRC20) to this address. Balance credited after 1 confirmation (~1 min).",
	}
}

// GET /wallet/balance — real + demo balances
func (h *Handler) Balance(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	var realBal, demoBal float64
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.AccountID).Scan(&realBal) //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.DemoID).Scan(&demoBal)   //nolint:errcheck

	c.JSON(http.StatusOK, gin.H{
		"real": realBal,
		"demo": demoBal,
	})
}

// GET /wallet/transactions — last 50 ledger entries
func (h *Handler) Transactions(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	rows, err := h.db.Query(ctx,
		`SELECT l.id, l.type, l.amount, l.status, l.ref, l.note, l.created_at
		 FROM ledger l
		 JOIN accounts a ON l.account_id = a.id
		 WHERE a.user_id = $1
		 ORDER BY l.created_at DESC LIMIT 50`,
		claims.UserID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
		return
	}
	defer rows.Close()

	type txRow struct {
		ID        string  `json:"id"`
		Type      string  `json:"type"`
		Amount    float64 `json:"amount"`
		Status    string  `json:"status"`
		Ref       *string `json:"ref,omitempty"`
		Note      *string `json:"note,omitempty"`
		CreatedAt string  `json:"created_at"`
	}

	var txns []txRow
	for rows.Next() {
		var r txRow
		var ref, note *string
		var createdAt time.Time
		if err := rows.Scan(&r.ID, &r.Type, &r.Amount, &r.Status, &ref, &note, &createdAt); err != nil {
			continue
		}
		r.Ref = ref
		r.Note = note
		r.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		txns = append(txns, r)
	}

	if txns == nil {
		txns = []txRow{}
	}
	c.JSON(http.StatusOK, gin.H{"transactions": txns})
}

// POST /wallet/withdraw — request a USDT withdrawal
func (h *Handler) Withdraw(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)

	var req struct {
		Amount  float64 `json:"amount"  binding:"required,min=10"`
		Address string  `json:"address" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Deduct from real balance (optimistic lock via CHECK constraint)
	result, err := tx.Exec(ctx,
		`UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1`,
		req.Amount, claims.AccountID,
	)
	if err != nil || result.RowsAffected() == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "insufficient balance"})
		return
	}

	var wID string
	err = tx.QueryRow(ctx,
		`INSERT INTO withdrawals (user_id, account_id, amount, address)
		 VALUES ($1,$2,$3,$4) RETURNING id`,
		claims.UserID, claims.AccountID, req.Amount, req.Address,
	).Scan(&wID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
		return
	}

	// Ledger debit
	tx.Exec(ctx, //nolint:errcheck
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'withdrawal',$2,'pending',$3,'Withdrawal request pending approval')`,
		claims.AccountID, -req.Amount, wID,
	)

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	// Notify user — best-effort, fire-and-forget.
	if h.mailer != nil {
		var (
			emailAddr, name string
		)
		if err := h.db.QueryRow(ctx,
			`SELECT email, COALESCE(name, '') FROM users WHERE id=$1`,
			claims.UserID,
		).Scan(&emailAddr, &name); err == nil && emailAddr != "" {
			if name == "" {
				name = "there"
			}
			subject := fmt.Sprintf("Withdrawal request received — $%.2f", req.Amount)
			body := email.WithdrawalRequestedHTML(name, req.Amount, req.Address, wID)
			h.mailer.Send(emailAddr, subject, body)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"withdrawal_id": wID,
		"amount":        req.Amount,
		"address":       req.Address,
		"status":        "pending",
		"note":          "Withdrawals are reviewed within 24 hours.",
	})
}
