package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct{ db *pgxpool.Pool }

func NewHandler(db *pgxpool.Pool) *Handler { return &Handler{db: db} }

// googleTokenInfo calls Google's tokeninfo endpoint to verify an ID token.
type googleTokenInfo struct {
	Sub           string `json:"sub"`   // Google user ID
	Email         string `json:"email"`
	EmailVerified string `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	Aud           string `json:"aud"`  // must match our client ID
}

func verifyGoogleToken(ctx context.Context, idToken string) (*googleTokenInfo, error) {
	url := "https://oauth2.googleapis.com/tokeninfo?id_token=" + idToken
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google: invalid token (%d)", resp.StatusCode)
	}

	var info googleTokenInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return nil, err
	}

	// Verify audience matches our client ID
	clientID := os.Getenv("GOOGLE_CLIENT_ID")
	if clientID != "" && info.Aud != clientID {
		return nil, fmt.Errorf("google: audience mismatch")
	}
	if info.EmailVerified != "true" {
		return nil, fmt.Errorf("google: email not verified")
	}
	return &info, nil
}

// POST /auth/google — verify Google ID token, create/find user, return JWT.
//
// Optional `ref` field in the body carries an affiliate code captured
// from `?ref=CODE` on the landing page. If present AND this is a new
// user, we write a referrals row attributing the introduction. Returning
// users with `ref` set in the body are ignored — attribution is one-shot
// at first signup so a user can't switch IBs by changing the URL.
func (h *Handler) GoogleAuth(c *gin.Context) {
	var req struct {
		Credential string `json:"credential"   binding:"required"`
		Ref        string `json:"ref,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "credential required"})
		return
	}

	ctx := c.Request.Context()
	info, err := verifyGoogleToken(ctx, req.Credential)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Upsert user by google_id
	var userID string
	err = tx.QueryRow(ctx, `
		INSERT INTO users (email, google_id, name, picture)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (google_id) DO UPDATE
		  SET email   = EXCLUDED.email,
		      name    = EXCLUDED.name,
		      picture = EXCLUDED.picture
		RETURNING id`,
		info.Email, info.Sub, info.Name, info.Picture,
	).Scan(&userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed: " + err.Error()})
		return
	}

	// Ensure demo exists (singleton via partial unique index — see schema.sql).
	// Plain INSERT ... ON CONFLICT (user_id, type) would fail because that
	// constraint is gone; instead we look up first and create on miss.
	var demoID string
	if err = tx.QueryRow(ctx,
		`SELECT id FROM accounts WHERE user_id=$1 AND type='demo'`, userID,
	).Scan(&demoID); err != nil {
		// Not found → create with starter balance
		if err = tx.QueryRow(ctx,
			`INSERT INTO accounts (user_id, type, label, balance)
			 VALUES ($1, 'demo', 'Demo', 10000)
			 RETURNING id`, userID,
		).Scan(&demoID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "demo create: " + err.Error()})
			return
		}
	}

	// Ensure at least one real account exists. New users get one named "Main";
	// returning users keep all theirs. The query returns the existing list
	// in creation order so the JWT and the response share an ordering.
	realIDs, err := queryRealAccountIDs(ctx, tx, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "real lookup: " + err.Error()})
		return
	}
	isNewUser := len(realIDs) == 0
	if isNewUser {
		var firstReal string
		if err = tx.QueryRow(ctx,
			`INSERT INTO accounts (user_id, type, label, balance)
			 VALUES ($1, 'real', 'Main', 0)
			 RETURNING id`, userID,
		).Scan(&firstReal); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "real create: " + err.Error()})
			return
		}
		realIDs = []string{firstReal}
	}

	// Affiliate attribution — only at FIRST signup. A user who shows up
	// with a different ?ref= weeks later can't switch IBs that way;
	// attribution is one-shot at the user's birth. The check on
	// isNewUser handles the second-time-Google-flow case (this same
	// upsert runs on every sign-in, not just first one).
	if isNewUser && req.Ref != "" {
		var introducerID string
		err := tx.QueryRow(ctx,
			`SELECT user_id FROM affiliate_codes WHERE code = $1`,
			req.Ref,
		).Scan(&introducerID)
		if err == nil && introducerID != userID {
			// Best-effort insert. ON CONFLICT covers the (vanishingly
			// rare) race where two windows both finish onboarding the
			// same Google identity simultaneously.
			tx.Exec(ctx, //nolint:errcheck
				`INSERT INTO referrals (introduced_user_id, introducer_user_id, code_at_signup)
				 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				userID, introducerID, req.Ref)
		}
		// Unknown code → silently ignore. Better UX than a sign-up error
		// for what's effectively a marketing data point.
	}

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	token, err := Sign(userID, realIDs, demoID, info.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token":   token,
		"user_id": userID,
		// Legacy fields — first real account, kept so old frontends still work
		"account_id": realIDs[0],
		"demo_id":    demoID,
		// New shape: full account list
		"account_ids": realIDs,
		"email":       info.Email,
		"name":        info.Name,
		"picture":     info.Picture,
	})
}

// queryRealAccountIDs returns the IDs of all real accounts the user owns,
// in creation order. Centralised so it can be reused from /auth/me.
func queryRealAccountIDs(ctx context.Context, q interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}, userID string) ([]string, error) {
	rows, err := q.Query(ctx,
		`SELECT id FROM accounts WHERE user_id=$1 AND type='real' ORDER BY created_at`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Me returns the authenticated user's profile plus all owned accounts.
// The legacy `account_id` / `real_balance` fields still point at the first
// real account so older frontends keep working. New shape lives under
// `accounts[]` — each entry has id, label, type, balance.
func (h *Handler) Me(c *gin.Context) {
	claims := c.MustGet("claims").(*Claims)
	ctx := c.Request.Context()

	type acctRow struct {
		ID      string  `json:"id"`
		Label   string  `json:"label"`
		Type    string  `json:"type"`
		Balance float64 `json:"balance"`
		// kind drives the savings ↔ account scaling factor on transfers.
		// 'real_standard' = 1×, 'real_cent' = 100×, 'real_micro' = 1000×.
		// Demo accounts are always 'demo' (no scaling). See accounts.kind
		// schema CHECK for the canonical enumeration.
		Kind string `json:"kind"`
	}

	// Single query for every account the user owns. Demo + real in one shot.
	rows, err := h.db.Query(ctx,
		`SELECT id, label, type, balance, kind FROM accounts
		 WHERE user_id = $1
		 ORDER BY type DESC, created_at`, // 'real' before 'demo' lexicographically — order kept stable
		claims.UserID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "accounts: " + err.Error()})
		return
	}
	defer rows.Close()

	var accounts []acctRow
	var primaryRealBal, demoBal float64
	var primaryRealID, demoID string
	for rows.Next() {
		var r acctRow
		if err := rows.Scan(&r.ID, &r.Label, &r.Type, &r.Balance, &r.Kind); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "scan: " + err.Error()})
			return
		}
		accounts = append(accounts, r)
		if r.Type == "demo" {
			demoID = r.ID
			demoBal = r.Balance
		}
		if r.Type == "real" && primaryRealID == "" {
			primaryRealID = r.ID
			primaryRealBal = r.Balance
		}
	}

	var name, picture string
	h.db.QueryRow(ctx, `SELECT COALESCE(name,''), COALESCE(picture,'') FROM users WHERE id=$1`, claims.UserID).Scan(&name, &picture) //nolint:errcheck

	// Savings balance — lazy-create then read. Returns 0 if the row was
	// just inserted, which is the right "first-login" experience.
	var savingsBal float64
	h.db.Exec(ctx, //nolint:errcheck
		`INSERT INTO savings_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		claims.UserID)
	h.db.QueryRow(ctx, //nolint:errcheck
		`SELECT balance FROM savings_wallets WHERE user_id=$1`,
		claims.UserID).Scan(&savingsBal)

	c.JSON(http.StatusOK, gin.H{
		"user_id":         claims.UserID,
		"email":           claims.Email,
		"name":            name,
		"picture":         picture,
		"accounts":        accounts, // new shape (preferred)
		"savings_balance": savingsBal,
		// Legacy back-compat fields — point at first real account
		"real_balance": primaryRealBal,
		"demo_balance": demoBal,
		"account_id":   primaryRealID,
		"demo_id":      demoID,
	})
}

// JWTMiddleware validates Bearer token and injects claims.
func JWTMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if len(header) < 8 || header[:7] != "Bearer " {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims, err := Verify(header[7:])
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		c.Set("claims", claims)
		if c.Query("account_id") == "" {
			c.Request.URL.RawQuery += "&account_id=" + claims.AccountID
		}
		c.Next()
	}
}
