package admin

// Admin HTTP handlers for the Otuburu back-office.
// Protected by a static ADMIN_SECRET bearer token (set via env var).
//
// Routes (all require Authorization: Bearer <ADMIN_SECRET>):
//   GET  /admin               → embedded dashboard HTML
//   GET  /admin/dashboard     → treasury stats, liability, P&L
//   GET  /admin/users         → all users with balances
//   GET  /admin/deposits      → recent deposits + sweep status
//   GET  /admin/withdrawals   → withdrawal queue (?status=pending|approved|sent|rejected)
//   POST /admin/withdrawals/:id/approve → approve + broadcast USDT from treasury
//   POST /admin/withdrawals/:id/reject  → reject
//   POST /admin/sweep         → trigger immediate sweep cycle

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/sweep"
	"otuburu.money/wallet/internal/wallet"
)

// Handler provides admin API endpoints.
type Handler struct {
	db      *pgxpool.Pool
	hd      *wallet.HDWallet
	sweeper *sweep.Sweeper
	apiKey  string
	client  *http.Client
}

// New creates an admin Handler.
func New(db *pgxpool.Pool, hd *wallet.HDWallet, sw *sweep.Sweeper) *Handler {
	return &Handler{
		db:      db,
		hd:      hd,
		sweeper: sw,
		apiKey:  os.Getenv("TRONGRID_API_KEY"),
		client:  &http.Client{Timeout: 15 * time.Second},
	}
}

// Middleware validates the ADMIN_SECRET bearer token.
func Middleware() gin.HandlerFunc {
	secret := os.Getenv("ADMIN_SECRET")
	return func(c *gin.Context) {
		if secret == "" {
			c.AbortWithStatusJSON(503, gin.H{"error": "admin not configured — set ADMIN_SECRET"})
			return
		}
		if c.GetHeader("Authorization") != "Bearer "+secret {
			c.AbortWithStatusJSON(401, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

// UI serves the embedded admin dashboard HTML (no auth — JS prompts for secret).
func (h *Handler) UI(c *gin.Context) {
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.String(200, adminHTML)
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

type DashboardResponse struct {
	TreasuryAddress    string  `json:"treasury_address"`
	TreasuryUSDT       float64 `json:"treasury_usdt"`
	TreasuryTRX        float64 `json:"treasury_trx"`
	TotalUserBalances  float64 `json:"total_user_balances"`
	TotalDemoBalances  float64 `json:"total_demo_balances"`
	HousePnL           float64 `json:"house_pnl"`
	TotalDeposited     float64 `json:"total_deposited"`
	TotalWithdrawn     float64 `json:"total_withdrawn"`
	PendingWithdrawals int     `json:"pending_withdrawals"`
	UnsweptDeposits    int     `json:"unswept_deposits"`
	UserCount          int     `json:"user_count"`
	Timestamp          string  `json:"timestamp"`
}

func (h *Handler) Dashboard(c *gin.Context) {
	ctx := c.Request.Context()

	treasuryAddr, err := h.hd.TreasuryAddress()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Fetch on-chain treasury balances concurrently with DB queries.
	type onChain struct{ usdt float64; trx float64 }
	chainCh := make(chan onChain, 1)
	go func() {
		usdt, trxSun, err := h.getOnChainBalances(treasuryAddr)
		if err != nil {
			slog.Warn("treasury balance fetch", "err", err)
			chainCh <- onChain{}
			return
		}
		chainCh <- onChain{usdt: usdt, trx: float64(trxSun) / 1_000_000}
	}()

	var (
		totalReal, totalDemo, totalDeposited, totalWithdrawn float64
		pendingW, unswept, users                             int
	)
	h.db.QueryRow(ctx, `SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type='real'`).Scan(&totalReal)            //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type='demo'`).Scan(&totalDemo)            //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COALESCE(SUM(amount),0)  FROM seen_deposits WHERE credited=true`).Scan(&totalDeposited) //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COALESCE(SUM(amount),0)  FROM withdrawals WHERE status='sent'`).Scan(&totalWithdrawn)   //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COUNT(*) FROM withdrawals  WHERE status='pending'`).Scan(&pendingW)                    //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COUNT(*) FROM seen_deposits WHERE swept_at IS NULL AND credited=true`).Scan(&unswept)   //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&users)                                                     //nolint:errcheck

	chain := <-chainCh

	c.JSON(200, DashboardResponse{
		TreasuryAddress:    treasuryAddr,
		TreasuryUSDT:       chain.usdt,
		TreasuryTRX:        chain.trx,
		TotalUserBalances:  totalReal,
		TotalDemoBalances:  totalDemo,
		HousePnL:           chain.usdt - totalReal,
		TotalDeposited:     totalDeposited,
		TotalWithdrawn:     totalWithdrawn,
		PendingWithdrawals: pendingW,
		UnsweptDeposits:    unswept,
		UserCount:          users,
		Timestamp:          time.Now().UTC().Format(time.RFC3339),
	})
}

// ── Users ─────────────────────────────────────────────────────────────────────

func (h *Handler) Users(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.db.Query(ctx, `
		SELECT u.id, u.email, u.name, u.created_at,
		       COALESCE(MAX(CASE WHEN a.type='real' THEN a.balance END), 0) AS real_bal,
		       COALESCE(MAX(CASE WHEN a.type='demo' THEN a.balance END), 0) AS demo_bal,
		       da.address
		FROM   users u
		LEFT   JOIN accounts a ON a.user_id = u.id
		LEFT   JOIN deposit_addresses da ON da.user_id = u.id
		GROUP  BY u.id, da.address
		ORDER  BY u.created_at DESC
	`)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type row struct {
		ID             string  `json:"id"`
		Email          string  `json:"email"`
		Name           string  `json:"name"`
		CreatedAt      string  `json:"created_at"`
		RealBalance    float64 `json:"real_balance"`
		DemoBalance    float64 `json:"demo_balance"`
		DepositAddress *string `json:"deposit_address"`
	}
	var users []row
	for rows.Next() {
		var u row
		var ts time.Time
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &ts,
			&u.RealBalance, &u.DemoBalance, &u.DepositAddress); err == nil {
			u.CreatedAt = ts.Format(time.RFC3339)
			users = append(users, u)
		}
	}
	c.JSON(200, gin.H{"users": users, "count": len(users)})
}

// ── Deposits ──────────────────────────────────────────────────────────────────

func (h *Handler) Deposits(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := h.db.Query(ctx, `
		SELECT txid, address, amount, credited, swept_at, sweep_txid, sweep_err, created_at
		FROM   seen_deposits
		ORDER  BY created_at DESC
		LIMIT  100
	`)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type dep struct {
		TXID      string  `json:"txid"`
		Address   string  `json:"address"`
		Amount    float64 `json:"amount"`
		Credited  bool    `json:"credited"`
		SweptAt   *string `json:"swept_at"`
		SweepTXID *string `json:"sweep_txid"`
		SweepErr  *string `json:"sweep_err"`
		CreatedAt string  `json:"created_at"`
	}
	var deps []dep
	for rows.Next() {
		var d dep
		var ts time.Time
		var sweptAt *time.Time
		if err := rows.Scan(&d.TXID, &d.Address, &d.Amount, &d.Credited,
			&sweptAt, &d.SweepTXID, &d.SweepErr, &ts); err == nil {
			d.CreatedAt = ts.Format(time.RFC3339)
			if sweptAt != nil {
				s := sweptAt.Format(time.RFC3339)
				d.SweptAt = &s
			}
			deps = append(deps, d)
		}
	}
	c.JSON(200, gin.H{"deposits": deps, "count": len(deps)})
}

// ── Withdrawals ───────────────────────────────────────────────────────────────

func (h *Handler) Withdrawals(c *gin.Context) {
	ctx := c.Request.Context()
	status := c.DefaultQuery("status", "pending")

	rows, err := h.db.Query(ctx, `
		SELECT w.id, u.email, u.name, w.amount, w.address, w.status, w.txid, w.created_at
		FROM   withdrawals w
		JOIN   users u ON u.id = w.user_id
		WHERE  w.status = $1
		ORDER  BY w.created_at DESC
		LIMIT  100
	`, status)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type wd struct {
		ID        string  `json:"id"`
		Email     string  `json:"email"`
		Name      string  `json:"name"`
		Amount    float64 `json:"amount"`
		Address   string  `json:"address"`
		Status    string  `json:"status"`
		TXID      *string `json:"txid"`
		CreatedAt string  `json:"created_at"`
	}
	var wds []wd
	for rows.Next() {
		var w wd
		var ts time.Time
		if err := rows.Scan(&w.ID, &w.Email, &w.Name, &w.Amount,
			&w.Address, &w.Status, &w.TXID, &ts); err == nil {
			w.CreatedAt = ts.Format(time.RFC3339)
			wds = append(wds, w)
		}
	}
	c.JSON(200, gin.H{"withdrawals": wds, "count": len(wds)})
}

// ApproveWithdrawal deducts from user account, broadcasts USDT from treasury, marks sent.
func (h *Handler) ApproveWithdrawal(c *gin.Context) {
	ctx := c.Request.Context()
	wid := c.Param("id")

	var accountID, toAddr, status string
	var amount float64
	err := h.db.QueryRow(ctx,
		`SELECT account_id, amount, address, status FROM withdrawals WHERE id=$1`, wid,
	).Scan(&accountID, &amount, &toAddr, &status)
	if err != nil {
		c.JSON(404, gin.H{"error": "withdrawal not found"})
		return
	}
	if status != "pending" {
		c.JSON(400, gin.H{"error": fmt.Sprintf("already %s", status)})
		return
	}

	var balance float64
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, accountID).Scan(&balance) //nolint:errcheck
	if balance < amount {
		c.JSON(400, gin.H{"error": "insufficient account balance"})
		return
	}

	// Lock — set to approved to prevent double-spend
	if ct, err := h.db.Exec(ctx,
		`UPDATE withdrawals SET status='approved' WHERE id=$1 AND status='pending'`, wid,
	); err != nil || ct.RowsAffected() == 0 {
		c.JSON(409, gin.H{"error": "could not lock withdrawal — try again"})
		return
	}

	txid, err := h.sendUSDTFromTreasury(ctx, toAddr, amount)
	if err != nil {
		// Rollback
		h.db.Exec(ctx, `UPDATE withdrawals SET status='pending' WHERE id=$1`, wid) //nolint:errcheck
		slog.Error("withdrawal broadcast failed", "id", wid, "err", err)
		c.JSON(500, gin.H{"error": fmt.Sprintf("broadcast failed: %v", err)})
		return
	}

	// Commit to DB atomically
	tx, _ := h.db.Begin(ctx)
	defer tx.Rollback(ctx) //nolint:errcheck
	tx.Exec(ctx, `UPDATE accounts    SET balance = balance - $1 WHERE id = $2`, amount, accountID)
	tx.Exec(ctx, `UPDATE withdrawals SET status='sent', txid=$1  WHERE id = $2`, txid, wid)
	tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'withdrawal',$2,'confirmed',$3,'Withdrawal to external address')`,
		accountID, -amount, txid,
	)
	tx.Commit(ctx) //nolint:errcheck

	slog.Info("withdrawal sent", "id", wid, "amount", amount, "to", toAddr, "txid", txid)
	c.JSON(200, gin.H{"status": "sent", "txid": txid})
}

// RejectWithdrawal marks a pending withdrawal as rejected (no funds moved).
func (h *Handler) RejectWithdrawal(c *gin.Context) {
	wid := c.Param("id")
	var body struct {
		Reason string `json:"reason"`
	}
	c.ShouldBindJSON(&body) //nolint:errcheck

	h.db.Exec(c.Request.Context(), //nolint:errcheck
		`UPDATE withdrawals SET status='rejected', txid=$1 WHERE id=$2 AND status='pending'`,
		"Rejected: "+body.Reason, wid,
	)
	c.JSON(200, gin.H{"status": "rejected"})
}

// ManualSweep triggers an immediate sweep cycle.
func (h *Handler) ManualSweep(c *gin.Context) {
	go h.sweeper.TriggerSweep(context.Background())
	c.JSON(200, gin.H{"status": "sweep triggered"})
}

// ── Shared TronGrid helpers ───────────────────────────────────────────────────

func (h *Handler) sendUSDTFromTreasury(ctx context.Context, toAddr string, amount float64) (string, error) {
	treasuryAddr, err := h.hd.TreasuryAddress()
	if err != nil {
		return "", err
	}
	treasuryHex, err := wallet.TronBase58ToHex(treasuryAddr)
	if err != nil {
		return "", err
	}
	usdtHex, err := wallet.TronBase58ToHex(wallet.USDTContract)
	if err != nil {
		return "", err
	}

	amountSun := wallet.USDTToSun(amount)
	param, err := wallet.ABIEncodeTransfer(toAddr, amountSun)
	if err != nil {
		return "", err
	}

	body, _ := json.Marshal(map[string]interface{}{
		"owner_address":     treasuryHex,
		"contract_address":  usdtHex,
		"function_selector": "transfer(address,uint256)",
		"parameter":         param,
		"fee_limit":         100_000_000,
		"call_value":        0,
		"visible":           false,
	})

	tx, err := h.tronPost(ctx, "/wallet/triggersmartcontract", body)
	if err != nil {
		return "", err
	}
	inner, ok := tx["transaction"].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("unexpected response from TronGrid")
	}

	rawDataHex, _ := inner["raw_data_hex"].(string)
	sig, err := wallet.SignTronTx(h.hd.TreasuryPrivKey(), rawDataHex)
	if err != nil {
		return "", err
	}
	inner["signature"] = []string{sig}

	bcast, _ := json.Marshal(inner)
	result, err := h.tronPost(ctx, "/wallet/broadcasttransaction", bcast)
	if err != nil {
		return "", err
	}
	if code, ok := result["code"].(string); ok && code != "" && code != "SUCCESS" {
		return "", fmt.Errorf("broadcast error: %s", code)
	}
	txid, _ := inner["txID"].(string)
	return txid, nil
}

func (h *Handler) getOnChainBalances(addr string) (usdtFloat float64, trxSun int64, err error) {
	url := fmt.Sprintf("%s/v1/accounts/%s", wallet.TronGridBase, addr)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if h.apiKey != "" {
		req.Header.Set("TRON-PRO-API-KEY", h.apiKey)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	var info struct {
		Data []struct {
			Balance int64               `json:"balance"`
			TRC20   []map[string]string `json:"trc20"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || len(info.Data) == 0 {
		return 0, 0, nil
	}
	acct := info.Data[0]
	trxSun = acct.Balance
	for _, m := range acct.TRC20 {
		if val, ok := m[wallet.USDTContract]; ok {
			n := new(big.Int)
			n.SetString(val, 10)
			f := new(big.Float).SetInt(n)
			f.Quo(f, big.NewFloat(1_000_000))
			usdtFloat, _ = f.Float64()
		}
	}
	return usdtFloat, trxSun, nil
}

func (h *Handler) tronPost(ctx context.Context, path string, body []byte) (map[string]interface{}, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, wallet.TronGridBase+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if h.apiKey != "" {
		req.Header.Set("TRON-PRO-API-KEY", h.apiKey)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(b, &result) //nolint:errcheck
	return result, nil
}
