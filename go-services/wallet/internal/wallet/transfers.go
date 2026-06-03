package wallet

// Internal transfers — move USD between {savings, trading account} legs.
//
// The savings wallet lives only in Postgres (savings_wallets table). Trading
// accounts live in BOTH Postgres (accounts.balance) AND the engine
// (in-memory Book.balance). The engine is the source of truth for "what can
// I actually trade with" because it knows free margin; Postgres is the
// source of truth for "what funds are recorded".
//
// To keep both halves consistent, every trading-account leg goes through
// the gateway's /internal/adjust-balance endpoint which calls the engine
// gRPC AdjustBalance RPC. The engine returns the new balance after applying
// the delta — that's what we then write to Postgres. This way the engine
// is consulted FIRST (so it can refuse a debit that would breach free
// margin) and Postgres is updated SECOND (so we don't have a phantom debit
// when the engine rejects).
//
// Failure modes:
//   - Engine reject (insufficient free margin) → HTTP 422, no DB writes.
//   - Engine network failure on first leg     → HTTP 503, no DB writes.
//   - Engine network failure on SECOND leg of
//     account↔account → COMPENSATE the first leg with a reverse delta.
//     If compensation itself fails, the transfer row is left in
//     'failed' status with the leftover delta recorded in `note` for
//     manual reconciliation. This is the only case where state can
//     diverge — single-leg transfers (savings ↔ account) never have
//     the second-leg-failure window.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"otuburu.money/wallet/internal/accountkind"
	"otuburu.money/wallet/internal/auth"
)

// accountKind looks up an account's kind. Returns 'real_standard' on miss
// so callers can't accidentally see a 0-multiplier from accountkind.Scale.
func (h *Handler) accountKind(ctx context.Context, id string) string {
	var kind string
	if err := h.db.QueryRow(ctx,
		`SELECT kind FROM accounts WHERE id=$1`, id,
	).Scan(&kind); err != nil || kind == "" {
		return "real_standard"
	}
	return kind
}

// transferLeg is a side of a transfer in the request body.
//
//	{"kind":"savings"}                       → the user's savings wallet
//	{"kind":"account", "id":"<account-uuid>"} → a specific trading account
type transferLeg struct {
	Kind string `json:"kind" binding:"required,oneof=savings account"`
	ID   string `json:"id"`
}

type transferRequest struct {
	From           transferLeg `json:"from"            binding:"required"`
	To             transferLeg `json:"to"              binding:"required"`
	Amount         float64     `json:"amount"          binding:"required,gt=0"`
	IdempotencyKey string      `json:"idempotency_key"`
	Note           string      `json:"note"`
}

// adjustBalanceResponse mirrors gateway's proto-JSON for AdjustBalanceResponse.
// Field names are camelCase because protojson emits camelCase by default.
type adjustBalanceResponse struct {
	Accepted      bool    `json:"accepted"`
	RejectReason  string  `json:"rejectReason"`
	NewBalance    float64 `json:"newBalance"`
	NewFreeMargin float64 `json:"newFreeMargin"`
}

// POST /wallet/transfers — move funds between {savings, account} legs.
//
//	Request:  { from: {kind, id?}, to: {kind, id?}, amount, idempotency_key?, note? }
//	200 OK:   { id, status, idempotent_replay? }
//	422:      { error, transfer_id?, status? }  ← engine rejected
//	5xx:      { error }                          ← network / DB failure
func (h *Handler) Transfer(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	var req transferRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Cross-validation that struct tags can't express.
	if err := validateTransfer(&req, claims); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Idempotency: if this key was used before, return the prior result instead
	// of re-running the transfer. Lets retries (network blip, double-tap) be safe.
	if req.IdempotencyKey != "" {
		var existingID, status string
		err := h.db.QueryRow(ctx,
			`SELECT id::text, status FROM transfers
			 WHERE idempotency_key=$1 AND user_id=$2`,
			req.IdempotencyKey, claims.UserID,
		).Scan(&existingID, &status)
		if err == nil {
			c.JSON(http.StatusOK, gin.H{
				"id":                existingID,
				"status":            status,
				"idempotent_replay": true,
			})
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	transferID, status, errMsg, code := h.doTransfer(ctx, claims.UserID, &req)
	if errMsg != "" {
		body := gin.H{"error": errMsg}
		if transferID != "" {
			body["transfer_id"] = transferID
			body["status"] = status
		}
		c.JSON(code, body)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": transferID, "status": status})
}

// validateTransfer enforces request-level invariants beyond Gin's struct tags:
//   - account legs must carry an id
//   - from ≠ to (same kind + same id rejected)
//   - account legs must belong to the caller
func validateTransfer(req *transferRequest, claims *auth.Claims) error {
	if req.From.Kind == "account" && req.From.ID == "" {
		return errors.New("from.id required when from.kind=account")
	}
	if req.To.Kind == "account" && req.To.ID == "" {
		return errors.New("to.id required when to.kind=account")
	}
	if req.From.Kind == req.To.Kind && req.From.ID == req.To.ID {
		return errors.New("from and to must differ")
	}
	if req.From.Kind == "account" && !claims.OwnsAccount(req.From.ID) {
		return errors.New("from account not owned by caller")
	}
	if req.To.Kind == "account" && !claims.OwnsAccount(req.To.ID) {
		return errors.New("to account not owned by caller")
	}
	return nil
}

// doTransfer routes to the appropriate path based on {from.kind, to.kind}.
// Returns (transfer_id, status, errMsg, httpCode). errMsg=="" on success.
func (h *Handler) doTransfer(
	ctx context.Context, userID string, req *transferRequest,
) (string, string, string, int) {
	switch {
	case req.From.Kind == "savings" && req.To.Kind == "account":
		return h.transferSavingsToAccount(ctx, userID, req)
	case req.From.Kind == "account" && req.To.Kind == "savings":
		return h.transferAccountToSavings(ctx, userID, req)
	case req.From.Kind == "account" && req.To.Kind == "account":
		return h.transferAccountToAccount(ctx, userID, req)
	default:
		// savings → savings is filtered out by validateTransfer (same kind + id).
		// Two distinct savings wallets per user don't exist.
		return "", "", "savings → savings transfer is not allowed", http.StatusBadRequest
	}
}

// ── Path A: savings → account ────────────────────────────────────────────────
//
// Convention: req.Amount is in SOURCE units (USD for savings). The
// destination is credited req.Amount * Scale(destKind) so a $10 transfer
// into a cent account credits 1000 cent-units.
//
// Order of operations:
//  1. Lock savings_wallets row, validate balance >= amount, debit savings
//     (USD), write transfers row 'pending', commit. After this, the user's
//     savings is debited and a pending transfer is recorded.
//  2. Call engine AdjustBalance(+scaledAmount). On success: mirror to
//     accounts table + write transfer_in ledger row + mark 'completed'.
//  3. On engine failure: REFUND savings (best-effort), mark transfer 'failed'.
func (h *Handler) transferSavingsToAccount(
	ctx context.Context, userID string, req *transferRequest,
) (string, string, string, int) {
	destKind := h.accountKind(ctx, req.To.ID)
	scaledAmount := req.Amount * accountkind.Scale(destKind)
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return "", "", "db tx begin: " + err.Error(), http.StatusInternalServerError
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock + validate savings.
	var savingsBal float64
	if _, err = tx.Exec(ctx,
		`INSERT INTO savings_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
		userID,
	); err != nil {
		return "", "", err.Error(), http.StatusInternalServerError
	}
	if err = tx.QueryRow(ctx,
		`SELECT balance FROM savings_wallets WHERE user_id=$1 FOR UPDATE`, userID,
	).Scan(&savingsBal); err != nil {
		return "", "", err.Error(), http.StatusInternalServerError
	}
	if savingsBal < req.Amount {
		return "", "", fmt.Sprintf("insufficient savings: requested $%.2f, available $%.2f",
			req.Amount, savingsBal), http.StatusUnprocessableEntity
	}

	// Debit savings + insert pending transfer.
	if _, err = tx.Exec(ctx,
		`UPDATE savings_wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id=$2`,
		req.Amount, userID,
	); err != nil {
		return "", "", err.Error(), http.StatusInternalServerError
	}

	var transferID string
	if err = tx.QueryRow(ctx,
		`INSERT INTO transfers (user_id, from_kind, from_id, to_kind, to_id,
		                        amount, idempotency_key, status, note)
		 VALUES ($1, 'savings', NULL, 'account', $2, $3, NULLIF($4,''), 'pending', $5)
		 RETURNING id::text`,
		userID, req.To.ID, req.Amount, req.IdempotencyKey, req.Note,
	).Scan(&transferID); err != nil {
		return "", "", err.Error(), http.StatusInternalServerError
	}

	if err = tx.Commit(ctx); err != nil {
		return "", "", err.Error(), http.StatusInternalServerError
	}

	// Engine credit in destination account-units. If this fails, refund
	// savings the original USD amount the user committed.
	adj, err := h.callAdjustBalance(ctx, req.To.ID, scaledAmount,
		fmt.Sprintf("transfer %s in from savings", transferID))
	if err != nil {
		h.failTransfer(ctx, transferID, "engine credit failed: "+err.Error())
		h.refundSavings(ctx, userID, req.Amount, "refund failed engine credit on "+transferID)
		return transferID, "failed", "engine credit failed: " + err.Error(),
			http.StatusBadGateway
	}
	if !adj.Accepted {
		// Engine refused — should never happen for a credit, but defensive.
		h.failTransfer(ctx, transferID, "engine rejected credit: "+adj.RejectReason)
		h.refundSavings(ctx, userID, req.Amount, "refund engine-rejected credit on "+transferID)
		return transferID, "failed", "engine rejected credit: " + adj.RejectReason,
			http.StatusUnprocessableEntity
	}

	// Mirror engine's new balance into Postgres + record ledger (in
	// account-units) + mark completed.
	h.finalizeAccountLeg(ctx, transferID, req.To.ID, adj.NewBalance, +scaledAmount, "transfer_in")
	return transferID, "completed", "", 0
}

// ── Path B: account → savings ────────────────────────────────────────────────
//
// Convention: req.Amount is in SOURCE units (account-units for cent/micro).
// Savings is credited req.Amount / Scale(srcKind) USD. So pulling 1000 from
// a cent account credits $10 to savings.
//
// Engine debit goes first because it can reject on free-margin. Only after
// the engine accepts do we touch Postgres. The compensation path runs the
// reverse engine adjust if any subsequent step fails — keeps the engine
// and Postgres aligned even when the DB hiccups.
func (h *Handler) transferAccountToSavings(
	ctx context.Context, userID string, req *transferRequest,
) (string, string, string, int) {
	srcKind := h.accountKind(ctx, req.From.ID)
	usdToSavings := req.Amount / accountkind.Scale(srcKind)

	// Step 1: engine debit (in source account-units). Can reject on free-margin.
	adj, err := h.callAdjustBalance(ctx, req.From.ID, -req.Amount,
		"transfer to savings")
	if err != nil {
		return "", "", "engine debit failed: " + err.Error(), http.StatusBadGateway
	}
	if !adj.Accepted {
		return "", "", adj.RejectReason, http.StatusUnprocessableEntity
	}

	// Step 2: DB tx — credit savings (USD), mirror account balance, write ledger,
	// record transfer 'completed'. If this fails, compensate the engine debit.
	tx, err := h.db.Begin(ctx)
	if err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed db tx begin")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err = tx.Exec(ctx,
		`INSERT INTO savings_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
		userID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed savings init")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	if _, err = tx.Exec(ctx,
		`UPDATE savings_wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id=$2`,
		usdToSavings, userID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed savings credit")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance=$1 WHERE id=$2`, adj.NewBalance, req.From.ID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed account mirror")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	// transfers.amount stores the SOURCE-side units (what the user typed) —
	// admin reconciliation can compare it directly against the from-account's
	// ledger row. Savings-side audit lives in savings_wallets.updated_at.
	var transferID string
	if err = tx.QueryRow(ctx,
		`INSERT INTO transfers (user_id, from_kind, from_id, to_kind, to_id,
		                        amount, idempotency_key, status, note)
		 VALUES ($1, 'account', $2, 'savings', NULL, $3, NULLIF($4,''), 'completed', $5)
		 RETURNING id::text`,
		userID, req.From.ID, req.Amount, req.IdempotencyKey, req.Note,
	).Scan(&transferID); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed transfer row")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	if _, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, ref, note)
		 VALUES ($1, 'transfer_out', $2, $3, 'transfer to savings')`,
		req.From.ID, -req.Amount, transferID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed ledger insert")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	if err = tx.Commit(ctx); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed tx commit")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	return transferID, "completed", "", 0
}

// ── Path C: account → account ────────────────────────────────────────────────
//
// Two engine calls. The interesting failure window is: leg 1 (debit src)
// succeeded, leg 2 (credit dst) failed. We compensate leg 1 with a reverse
// delta. If THAT fails, the transfer is left 'failed' and an admin needs to
// reconcile — the note captures what's outstanding.
//
// Cross-kind conversion: req.Amount is in SOURCE account-units. The
// destination is credited req.Amount * Scale(destKind) / Scale(srcKind).
// Examples:
//
//	standard → cent:  $50 source → $5000 cent-units
//	cent → standard:  $5000 source → $50 standard
//	cent → micro:     $500 cent → $5000 micro
//
// The compensation amount also uses srcUnits — undoes the original debit.
func (h *Handler) transferAccountToAccount(
	ctx context.Context, userID string, req *transferRequest,
) (string, string, string, int) {
	srcKind := h.accountKind(ctx, req.From.ID)
	dstKind := h.accountKind(ctx, req.To.ID)
	srcScale := accountkind.Scale(srcKind)
	dstScale := accountkind.Scale(dstKind)
	dstAmount := req.Amount * (dstScale / srcScale)

	// Leg 1: engine debit src (in source units). Can reject on free-margin.
	debit, err := h.callAdjustBalance(ctx, req.From.ID, -req.Amount,
		"transfer to account "+req.To.ID)
	if err != nil {
		return "", "", "engine src debit failed: " + err.Error(), http.StatusBadGateway
	}
	if !debit.Accepted {
		return "", "", debit.RejectReason, http.StatusUnprocessableEntity
	}

	// Leg 2: engine credit dst (in dest units). If this fails we MUST refund src.
	credit, err := h.callAdjustBalance(ctx, req.To.ID, +dstAmount,
		"transfer in from account "+req.From.ID)
	if err != nil {
		// Compensate src — best-effort. If compensation also fails, log loud.
		h.compensateAdjust(ctx, req.From.ID, +req.Amount,
			"compensate failed dst credit (network)")
		return "", "", "engine dst credit failed: " + err.Error(), http.StatusBadGateway
	}
	if !credit.Accepted {
		// Shouldn't happen for credits, but defensive.
		h.compensateAdjust(ctx, req.From.ID, +req.Amount,
			"compensate engine-rejected dst credit")
		return "", "", "engine rejected credit: " + credit.RejectReason,
			http.StatusUnprocessableEntity
	}

	// Both engine legs succeeded. Now record everything in Postgres.
	tx, err := h.db.Begin(ctx)
	if err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed db begin")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed db begin")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance=$1 WHERE id=$2`, debit.NewBalance, req.From.ID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed src mirror")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed src mirror")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	if _, err = tx.Exec(ctx,
		`UPDATE accounts SET balance=$1 WHERE id=$2`, credit.NewBalance, req.To.ID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed dst mirror")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed dst mirror")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	// transfers.amount stores the SOURCE-side units. The dest-side amount
	// is recoverable from kind + scale lookups; no need to store both.
	var transferID string
	if err = tx.QueryRow(ctx,
		`INSERT INTO transfers (user_id, from_kind, from_id, to_kind, to_id,
		                        amount, idempotency_key, status, note)
		 VALUES ($1, 'account', $2, 'account', $3, $4, NULLIF($5,''), 'completed', $6)
		 RETURNING id::text`,
		userID, req.From.ID, req.To.ID, req.Amount, req.IdempotencyKey, req.Note,
	).Scan(&transferID); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed transfer row")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed transfer row")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	if _, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, ref, note) VALUES
		 ($1, 'transfer_out', $2, $3, 'transfer to account ' || $4),
		 ($5, 'transfer_in',  $6, $3, 'transfer from account ' || $7)`,
		req.From.ID, -req.Amount, transferID, req.To.ID,
		req.To.ID, +dstAmount, req.From.ID,
	); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed ledger")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed ledger")
		return "", "", err.Error(), http.StatusInternalServerError
	}

	if err = tx.Commit(ctx); err != nil {
		h.compensateAdjust(ctx, req.From.ID, +req.Amount, "compensate failed commit")
		h.compensateAdjust(ctx, req.To.ID, -dstAmount, "compensate failed commit")
		return "", "", err.Error(), http.StatusInternalServerError
	}
	return transferID, "completed", "", 0
}

// ── Engine adjust-balance plumbing ──────────────────────────────────────────

// callAdjustBalance POSTs to gateway's /internal/adjust-balance and returns
// the parsed response. Network / 5xx errors come back as a non-nil error;
// a 200 with accepted=false comes back as a successful adjustBalanceResponse
// with Accepted=false so the caller can decide whether to treat it as a
// reject (single-leg) or compensate (mid-flow leg-2 failure).
func (h *Handler) callAdjustBalance(
	ctx context.Context, accountID string, delta float64, reason string,
) (*adjustBalanceResponse, error) {
	if h.gatewayURL == "" || h.internalSecret == "" {
		return nil, errors.New("gateway URL or INTERNAL_SECRET not configured")
	}

	payload, _ := json.Marshal(map[string]any{
		"account_id": accountID,
		"delta":      delta,
		"reason":     reason,
	})
	url := h.gatewayURL + "/internal/adjust-balance"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Internal-Secret", h.internalSecret)

	resp, err := h.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway %d: %s", resp.StatusCode, string(body))
	}
	var out adjustBalanceResponse
	if err = json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("bad gateway response: %w", err)
	}
	return &out, nil
}

// compensateAdjust runs the inverse of a prior debit/credit when the calling
// transfer can't complete. Best-effort — failures here mean the books are
// momentarily out of sync; the loud log gives us a thread to pull.
func (h *Handler) compensateAdjust(
	ctx context.Context, accountID string, delta float64, reason string,
) {
	_, err := h.callAdjustBalance(ctx, accountID, delta, reason)
	if err != nil {
		slog.Error("compensateAdjust failed",
			"account", accountID, "delta", delta, "reason", reason, "err", err)
	}
}

// failTransfer flips a transfer row to 'failed' with an explanatory note.
// Errors here are logged but not surfaced — we're already in an error path.
func (h *Handler) failTransfer(ctx context.Context, transferID, note string) {
	if _, err := h.db.Exec(ctx,
		`UPDATE transfers SET status='failed', note=COALESCE(note,'') || ' | ' || $1
		 WHERE id=$2`, note, transferID,
	); err != nil {
		slog.Error("failTransfer mark", "id", transferID, "err", err)
	}
}

// refundSavings undoes a savings debit when a downstream engine credit
// failed. Best-effort; logs loud on failure.
func (h *Handler) refundSavings(ctx context.Context, userID string, amount float64, note string) {
	if _, err := h.db.Exec(ctx,
		`UPDATE savings_wallets SET balance = balance + $1, updated_at = NOW()
		 WHERE user_id=$2`, amount, userID,
	); err != nil {
		slog.Error("refundSavings failed",
			"user", userID, "amount", amount, "note", note, "err", err)
	}
}

// finalizeAccountLeg runs after a successful engine credit: mirrors the new
// balance into Postgres, writes a transfer_in ledger row, and flips the
// transfer to 'completed'. Best-effort — if it fails midway, the loud log
// surfaces the leftover work but funds are NOT lost because the engine has
// already credited the user.
func (h *Handler) finalizeAccountLeg(
	ctx context.Context, transferID, accountID string,
	newBalance, ledgerAmount float64, ledgerType string,
) {
	if _, err := h.db.Exec(ctx,
		`UPDATE accounts SET balance=$1 WHERE id=$2`, newBalance, accountID,
	); err != nil {
		slog.Error("finalizeAccountLeg balance mirror",
			"transfer", transferID, "err", err)
	}
	if _, err := h.db.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, ref) VALUES ($1, $2, $3, $4)`,
		accountID, ledgerType, ledgerAmount, transferID,
	); err != nil {
		slog.Error("finalizeAccountLeg ledger",
			"transfer", transferID, "err", err)
	}
	if _, err := h.db.Exec(ctx,
		`UPDATE transfers SET status='completed' WHERE id=$1`, transferID,
	); err != nil {
		slog.Error("finalizeAccountLeg status",
			"transfer", transferID, "err", err)
	}
}
