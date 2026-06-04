package wallet

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/email"
	"otuburu.money/wallet/internal/kyc"
	"otuburu.money/wallet/internal/payments"
)

type Handler struct {
	db             *pgxpool.Pool
	hd             *HDWallet
	mailer         *email.Mailer
	paystack       *payments.Handler // optional, may be nil if Paystack disabled
	kyc            kyc.Provider      // Smile Identity client (stub when env unset)
	gatewayURL     string            // wallet→gateway URL for /internal/*
	internalSecret string            // shared with gateway for X-Internal-Secret
	httpClient     *http.Client      // reused across transfer + balance-sync calls
}

// NewHandler builds the wallet HTTP handler. `mailer` and `paystack` may be
// nil — emails / NGN withdrawal just become no-op endpoints in that case.
// `gatewayURL` + `internalSecret` are required for transfers (POST
// /wallet/transfers calls gateway's /internal/adjust-balance to move funds
// in/out of trading accounts).
func NewHandler(
	db *pgxpool.Pool,
	hd *HDWallet,
	mailer *email.Mailer,
	paystack *payments.Handler,
	gatewayURL string,
	internalSecret string,
) *Handler {
	return &Handler{
		db:             db,
		hd:             hd,
		mailer:         mailer,
		paystack:       paystack,
		kyc:            kyc.NewProvider(),
		gatewayURL:     gatewayURL,
		internalSecret: internalSecret,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
	}
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

// GET /wallet/balance — real + demo + savings balances.
// Bundled together so useAuth.refreshBalances() doesn't need three round-trips.
func (h *Handler) Balance(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	var realBal, demoBal float64
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.AccountID).Scan(&realBal) //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.DemoID).Scan(&demoBal)   //nolint:errcheck

	// ensureSavingsBalance lazy-creates the row. Errors don't fail the whole
	// response — we report 0 and let the dedicated /wallet/savings endpoint
	// surface any persistent DB issue.
	savingsBal, _ := ensureSavingsBalance(ctx, h.db, claims.UserID)

	c.JSON(http.StatusOK, gin.H{
		"real":    realBal,
		"demo":    demoBal,
		"savings": savingsBal,
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

// POST /wallet/withdraw — request a USDT withdrawal.
// Body: { amount, address }
//
// Phase-4 change: withdrawals always originate from the user's Savings
// wallet. Callers no longer pass account_id — if they do, it's ignored.
// The frontend's "withdraw from this trading account" flow is now two
// steps: (1) POST /wallet/transfers (account → savings), (2) this endpoint.
// Forcing the park-first step protects open positions and gives the user
// a clean reconcile target for payout obligations.
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

	// Lazy-create the savings row, then lock it for the debit. The CHECK
	// (balance >= 0) on savings_wallets gives us the same belt-and-braces
	// guard against draining below zero that the accounts table had.
	if _, err = tx.Exec(ctx,
		`INSERT INTO savings_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
		claims.UserID,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "savings init failed"})
		return
	}
	result, err := tx.Exec(ctx,
		`UPDATE savings_wallets SET balance = balance - $1, updated_at = NOW()
		 WHERE user_id = $2 AND balance >= $1`,
		req.Amount, claims.UserID,
	)
	if err != nil || result.RowsAffected() == 0 {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error": "insufficient savings — transfer funds into Savings first",
		})
		return
	}

	var wID string
	err = tx.QueryRow(ctx,
		`INSERT INTO withdrawals (user_id, account_id, amount, address, source, channel)
		 VALUES ($1, NULL, $2, $3, 'savings', 'usdt') RETURNING id`,
		claims.UserID, req.Amount, req.Address,
	).Scan(&wID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
		return
	}

	// Note: no ledger row written here. The ledger table requires
	// account_id NOT NULL (it FKs to accounts), and Savings legs are
	// audited via the `transfers` table when funds are moved into Savings.
	// The `withdrawals` row itself is the source of truth for this debit.

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

// GET /wallet/ngn/resolve?bank_code=X&account_number=Y — verify a Nigerian
// bank account number and return the verified holder's name. Used by the
// frontend WithdrawSheet NGN tab so the user sees "Account: ADAMU BELLO"
// before confirming the transfer.
func (h *Handler) ResolveNGNAccount(c *gin.Context) {
	if h.paystack == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NGN payouts not configured"})
		return
	}
	bankCode := c.Query("bank_code")
	accountNumber := c.Query("account_number")
	if bankCode == "" || accountNumber == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bank_code and account_number required"})
		return
	}
	name, err := h.paystack.ResolveAccount(c.Request.Context(), bankCode, accountNumber)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"account_name": name})
}

// POST /wallet/withdraw/ngn — request a withdrawal paid out to a Nigerian
// bank account via Paystack Transfer. Body:
//
//	{
//	  "amount":              50.0,         // USD to debit
//	  "bank_code":           "058",        // Paystack bank id (e.g. GTBank)
//	  "bank_account_number": "0123456789",
//	  "bank_account_name":   "ADAMU BELLO", // verified via ResolveNGNAccount
//	}
//
// Phase-4 change: like the USDT path, this now sources from Savings. The
// frontend's "withdraw to bank from this account" flow becomes two steps:
// (1) POST /wallet/transfers (account → savings), (2) this endpoint.
//
// NGN amount paid out = amount × interbank × (1 − 2% spread). Debit happens
// in the same db tx as the withdrawal insert; the Paystack /transferrecipient
// + /transfer calls run after commit so a Paystack failure rolls back to a
// pending withdrawal an admin can retry from the dashboard.
func (h *Handler) WithdrawNGN(c *gin.Context) {
	if h.paystack == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NGN payouts not configured"})
		return
	}
	claims := c.MustGet("claims").(*auth.Claims)

	var req struct {
		Amount            float64 `json:"amount"               binding:"required,min=10"`
		BankCode          string  `json:"bank_code"            binding:"required"`
		BankAccountNumber string  `json:"bank_account_number"  binding:"required"`
		BankAccountName   string  `json:"bank_account_name"    binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Compute NGN payout at the customer rate. Lock the rate at request
	// time and store it on the withdrawal so the admin sees exactly what
	// the user was quoted, regardless of subsequent rate moves.
	custRate := h.paystack.CurrentNGNCustomerRate()
	if custRate <= 0 {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "NGN rate unavailable"})
		return
	}
	ngnPayout := req.Amount * custRate

	ctx := c.Request.Context()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Debit Savings with the same balance-guarded UPDATE as the USDT path.
	if _, err = tx.Exec(ctx,
		`INSERT INTO savings_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
		claims.UserID,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "savings init failed"})
		return
	}
	result, err := tx.Exec(ctx,
		`UPDATE savings_wallets SET balance = balance - $1, updated_at = NOW()
		 WHERE user_id = $2 AND balance >= $1`,
		req.Amount, claims.UserID,
	)
	if err != nil || result.RowsAffected() == 0 {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error": "insufficient savings — transfer funds into Savings first",
		})
		return
	}

	var wID string
	err = tx.QueryRow(ctx,
		`INSERT INTO withdrawals
		   (user_id, account_id, amount, status, source, channel,
		    bank_code, bank_account_number, bank_account_name, ngn_amount)
		 VALUES ($1, NULL, $2, 'pending', 'savings', 'ngn_bank',
		         $3, $4, $5, $6)
		 RETURNING id`,
		claims.UserID, req.Amount,
		req.BankCode, req.BankAccountNumber, req.BankAccountName, ngnPayout,
	).Scan(&wID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
		return
	}

	// No ledger row: same reasoning as the USDT path. Savings debits are
	// audited via the `transfers` table (when funds entered Savings) and
	// the `withdrawals` row itself for the outbound leg.

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	// Now talk to Paystack. We do this AFTER commit because Paystack's
	// /transferrecipient + /transfer is a multi-second external call; we
	// don't want to hold a db tx open during it. If either call fails the
	// withdrawal stays at status='pending' for an admin to retry — same
	// as if the USDT broadcast failed mid-approval.
	recipientCode, err := h.paystack.CreateRecipient(ctx,
		req.BankAccountName, req.BankAccountNumber, req.BankCode)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error":         "recipient create failed: " + err.Error(),
			"withdrawal_id": wID,
			"status":        "pending",
			"note":          "Funds reserved. Admin will retry the transfer.",
		})
		return
	}

	// Persist the recipient code so admin retries can skip the lookup.
	h.db.Exec(ctx, //nolint:errcheck
		`UPDATE withdrawals SET paystack_recipient=$1 WHERE id=$2`,
		recipientCode, wID,
	)

	transferCode, err := h.paystack.InitiateTransfer(ctx, recipientCode, ngnPayout,
		fmt.Sprintf("Otuburu withdrawal %s", wID[:8]))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error":         "transfer init failed: " + err.Error(),
			"withdrawal_id": wID,
			"status":        "pending",
			"note":          "Funds reserved. Admin will retry the transfer.",
		})
		return
	}

	// Transfer initiated successfully → status='approved', txid=transferCode.
	// Final 'sent' status comes from the Paystack webhook when the bank
	// confirms credit (transfer.success).
	h.db.Exec(ctx, //nolint:errcheck
		`UPDATE withdrawals SET status='approved', txid=$1 WHERE id=$2`,
		transferCode, wID,
	)

	// Notify user — best-effort.
	if h.mailer != nil {
		var emailAddr, name string
		if err := h.db.QueryRow(ctx,
			`SELECT email, COALESCE(name, '') FROM users WHERE id=$1`,
			claims.UserID,
		).Scan(&emailAddr, &name); err == nil && emailAddr != "" {
			if name == "" {
				name = "there"
			}
			subject := fmt.Sprintf("NGN withdrawal initiated — $%.2f", req.Amount)
			body := email.NGNWithdrawalInitiatedHTML(name, req.Amount, ngnPayout,
				req.BankAccountName, req.BankAccountNumber, req.BankCode)
			h.mailer.Send(emailAddr, subject, body)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"withdrawal_id": wID,
		"usd_debited":   req.Amount,
		"ngn_payout":    ngnPayout,
		"rate":          custRate,
		"transfer_code": transferCode,
		"status":        "approved",
		"note":          "Bank credit usually arrives within minutes. We'll email you on confirmation.",
	})
}

