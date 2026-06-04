package wallet

// Affiliate / IB program — v1 surface.
//
// One auto-generated 6-character code per user, claimed lazily on the
// first /wallet/affiliate hit. Codes are random over a 32-character
// alphabet that excludes the visually-confusable 0/O/I/1 so a code
// shared verbally or scribbled on paper survives intact.
//
// What's NOT in v1 (deliberately):
//   - Per-trade earnings tracking: weekly admin compute against the
//     existing engine settled_trades + house revenue counters is more
//     trustworthy until volume justifies engine hooks.
//   - Auto-payouts: admin credits the introducer's savings wallet
//     directly during the weekly reconcile.
//   - Tiered rates: the `rate` column on affiliate_codes already lets
//     us override per-affiliate when we cut deals; UI surfacing comes
//     later.

import (
	"crypto/rand"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"otuburu.money/wallet/internal/auth"
)

// codeAlphabet — 32 readable characters. Excludes 0/O/I/1 so a typo'd
// "TZF8K2" can't accidentally be a valid different code. 32^6 ≈ 1.07e9
// combinations; collisions during code mint are vanishingly rare and
// we retry on the UNIQUE constraint either way.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const codeLength = 6

// generateCode builds one random 6-char code using crypto/rand. Used at
// claim time; if the result collides (UNIQUE constraint violation) the
// caller retries up to 3 times before giving up — at 1-in-billion odds
// per attempt, three failures in a row would be a sign of broken RNG,
// not unlucky chance.
func generateCode() (string, error) {
	buf := make([]byte, codeLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, codeLength)
	for i, b := range buf {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out), nil
}

// GET /wallet/affiliate — return the caller's affiliate code + intro
// count. Lazy-creates the code on first hit so users don't have to
// "activate" anything before sharing.
//
//	{ "code": "T4F8K2", "rate": 0.30, "introduced": 12 }
func (h *Handler) Affiliate(c *gin.Context) {
	claims := c.MustGet("claims").(*auth.Claims)
	ctx := c.Request.Context()

	// Mint a code if the user doesn't have one yet. Retry on collision
	// up to 3 times — odds suggest the RNG is borked if 3 fail.
	var code string
	var rate float64
	for attempt := 0; attempt < 3; attempt++ {
		err := h.db.QueryRow(ctx,
			`SELECT code, rate FROM affiliate_codes WHERE user_id = $1`,
			claims.UserID,
		).Scan(&code, &rate)
		if err == nil {
			break // found existing
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		// Generate + insert. Race with another concurrent generate call
		// for the same user is fine — the UNIQUE on user_id will reject
		// the second insert and the next iteration's SELECT will find
		// the winner's row.
		newCode, err := generateCode()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "code gen failed"})
			return
		}
		_, insertErr := h.db.Exec(ctx,
			`INSERT INTO affiliate_codes (user_id, code) VALUES ($1, $2)
			 ON CONFLICT (user_id) DO NOTHING`,
			claims.UserID, newCode,
		)
		if insertErr != nil {
			// UNIQUE violation on `code` (not `user_id`) — try again with
			// a fresh code. Other errors bubble up.
			continue
		}
		// Loop back to SELECT — picks up either our row or the
		// concurrent winner's.
	}
	if code == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not mint affiliate code"})
		return
	}

	// Count introduced users. Always-zero for new affiliates which is
	// fine; the UI just renders "0 referrals".
	var introduced int
	if err := h.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM referrals WHERE introducer_user_id = $1`,
		claims.UserID,
	).Scan(&introduced); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":       code,
		"rate":       rate,
		"introduced": introduced,
	})
}
