package wallet

// KYC tier 1 — identity verification + deposit/withdraw cap enforcement.
//
// Tiers
// ─────
//   0 = no KYC.        Deposit cap $500 cumulative, withdrawals disabled.
//   1 = NIN/BVN OK.    Deposit cap $5000 cumulative, withdrawals enabled.
//   2 = (future)       Passport + proof of address — no deposit cap.
//
// Flow
// ────
//   1. User opens KYC sheet, enters id_type + id_number + name + DOB.
//   2. POST /wallet/kyc/submit forwards to Smile Identity (or stub).
//   3. On approval: kyc_submissions row marked approved, users.kyc_tier=1,
//      sanctions_checks row written with status='clear' (stub mode) or
//      status='pending' (live mode, manual review pending).
//   4. Subsequent deposits use kycDepositCap(tier) instead of $0.

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/kyc"
)

// Cumulative deposit caps in USD per KYC tier. Cumulative — not per
// transaction — because tier 0 users who can deposit $500 once shouldn't
// also be able to deposit $500 every day. The cap is enforced at the
// credit path against the user's lifetime sum.
func kycDepositCapUSD(tier int) float64 {
	switch tier {
	case 0:
		return 500
	case 1:
		return 5000
	case 2:
		return 0 // 0 = no cap
	default:
		return 500
	}
}

// GET /wallet/kyc — returns the caller's tier + most-recent submission
// status. Used by the KYC sheet to decide whether to show the form or
// "you're verified" success state.
//
//	{ "tier": 0, "submission": { "status": "pending", "id_type": "NIN", ... } | null }
func (h *Handler) KycStatus(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	var tier int
	if err := h.db.QueryRow(ctx,
		`SELECT kyc_tier FROM users WHERE id = $1`, claims.UserID,
	).Scan(&tier); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Most recent submission, may be nil for users who never started.
	var (
		idType, status   string
		rejectionReason  *string
		submissionExists bool
	)
	err := h.db.QueryRow(ctx,
		`SELECT id_type, status, rejection_reason
		 FROM kyc_submissions
		 WHERE user_id = $1
		 ORDER BY created_at DESC
		 LIMIT 1`,
		claims.UserID,
	).Scan(&idType, &status, &rejectionReason)
	if err == nil {
		submissionExists = true
	}

	resp := gin.H{
		"tier":            tier,
		"deposit_cap_usd": kycDepositCapUSD(tier),
	}
	if submissionExists {
		resp["submission"] = gin.H{
			"id_type":          idType,
			"status":           status,
			"rejection_reason": rejectionReason,
		}
	} else {
		resp["submission"] = nil
	}
	c.JSON(http.StatusOK, resp)
}

// POST /wallet/kyc/submit — accept document details, forward to Smile
// Identity, persist outcome, and (on approval) bump the user's tier.
//
//	Request:  { id_type, id_number, first_name, last_name, dob (YYYY-MM-DD) }
//	200 OK:   { status: 'approved'|'rejected', tier, rejection_reason? }
func (h *Handler) KycSubmit(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()
	if h.kyc == nil {
		h.initKYC()
	}

	var req struct {
		IDType    string `json:"id_type"    binding:"required,oneof=NIN BVN PASSPORT DRIVERS_LICENSE VOTERS_CARD"`
		IDNumber  string `json:"id_number"  binding:"required,min=4,max=32"`
		FirstName string `json:"first_name" binding:"required,min=1,max=64"`
		LastName  string `json:"last_name"  binding:"required,min=1,max=64"`
		DOB       string `json:"dob"        binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Validate DOB shape (YYYY-MM-DD). Defensive — Smile Identity will
	// also reject malformed DOBs but the round-trip is slower than
	// failing fast here.
	if _, err := time.Parse("2006-01-02", req.DOB); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "dob must be YYYY-MM-DD"})
		return
	}

	// Insert a pending row before calling the provider so the audit
	// trail captures every attempt (including ones that the network
	// path eats).
	var submissionID string
	if err := h.db.QueryRow(ctx,
		`INSERT INTO kyc_submissions
		   (user_id, id_type, id_number, first_name, last_name, dob, status)
		 VALUES ($1, $2, $3, $4, $5, $6, 'pending')
		 RETURNING id::text`,
		claims.UserID, req.IDType, req.IDNumber, req.FirstName, req.LastName, req.DOB,
	).Scan(&submissionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Provider call. Errors here leave the row in 'pending' for retry.
	result, err := h.kyc.Verify(ctx, kyc.VerifyRequest{
		IDType:    req.IDType,
		IDNumber:  req.IDNumber,
		FirstName: req.FirstName,
		LastName:  req.LastName,
		DOB:       req.DOB,
		UserID:    claims.UserID,
	})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error":         "verification provider unavailable: " + err.Error(),
			"submission_id": submissionID,
			"status":        "pending",
		})
		return
	}

	// Persist outcome + tier bump in one tx so a partial failure here
	// can't leave us with an approved submission but unbumped tier.
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	newStatus := "rejected"
	if result.Approved {
		newStatus = "approved"
	}
	if _, err = tx.Exec(ctx,
		`UPDATE kyc_submissions
		 SET status=$1, rejection_reason=$2, sid_job_id=$3, sid_response=$4,
		     completed_at=NOW()
		 WHERE id=$5`,
		newStatus, result.RejectionReason, result.JobID, result.RawResponse, submissionID,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if result.Approved {
		// Bump tier. CHECK constraint caps at 3; greatest() prevents a
		// re-verification from accidentally demoting a tier-2 user.
		if _, err = tx.Exec(ctx,
			`UPDATE users SET kyc_tier = GREATEST(kyc_tier, 1) WHERE id=$1`,
			claims.UserID,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Write a sanctions-checks row. Stub mode = 'clear' (dev convenience);
		// live mode = 'pending' awaiting a separate OFAC/EU/UN screening
		// integration (out of scope for v1 — admin reviews each tier-1
		// approval until that lands).
		sanctionsStatus := "pending"
		if h.kyc.IsStub() {
			sanctionsStatus = "clear"
		}
		if _, err = tx.Exec(ctx,
			`INSERT INTO sanctions_checks (user_id, full_name, dob, status)
			 VALUES ($1, $2, $3, $4)`,
			claims.UserID, req.FirstName+" "+req.LastName, req.DOB, sanctionsStatus,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	if err = tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	respTier := 0
	if result.Approved {
		respTier = 1
	}
	c.JSON(http.StatusOK, gin.H{
		"submission_id":    submissionID,
		"status":           newStatus,
		"tier":             respTier,
		"deposit_cap_usd":  kycDepositCapUSD(respTier),
		"rejection_reason": result.RejectionReason,
	})
}
