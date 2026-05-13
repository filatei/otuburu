package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
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

// POST /auth/google — verify Google ID token, create/find user, return JWT
func (h *Handler) GoogleAuth(c *gin.Context) {
	var req struct {
		Credential string `json:"credential" binding:"required"`
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

	// Ensure accounts exist (idempotent)
	var demoID, realID string
	tx.QueryRow(ctx, `
		INSERT INTO accounts (user_id, type, balance)
		VALUES ($1, 'demo', 10000)
		ON CONFLICT (user_id, type) DO UPDATE SET user_id = EXCLUDED.user_id
		RETURNING id`, userID,
	).Scan(&demoID) //nolint:errcheck

	tx.QueryRow(ctx, `
		INSERT INTO accounts (user_id, type, balance)
		VALUES ($1, 'real', 0)
		ON CONFLICT (user_id, type) DO UPDATE SET user_id = EXCLUDED.user_id
		RETURNING id`, userID,
	).Scan(&realID) //nolint:errcheck

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	token, err := Sign(userID, realID, demoID, info.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token":      token,
		"user_id":    userID,
		"account_id": realID,
		"demo_id":    demoID,
		"email":      info.Email,
		"name":       info.Name,
		"picture":    info.Picture,
	})
}

func (h *Handler) Me(c *gin.Context) {
	claims := c.MustGet("claims").(*Claims)
	ctx := c.Request.Context()

	var realBal, demoBal float64
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.AccountID).Scan(&realBal) //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.DemoID).Scan(&demoBal)   //nolint:errcheck

	var name, picture string
	h.db.QueryRow(ctx, `SELECT COALESCE(name,''), COALESCE(picture,'') FROM users WHERE id=$1`, claims.UserID).Scan(&name, &picture) //nolint:errcheck

	c.JSON(http.StatusOK, gin.H{
		"user_id":      claims.UserID,
		"email":        claims.Email,
		"name":         name,
		"picture":      picture,
		"real_balance": realBal,
		"demo_balance": demoBal,
		"account_id":   claims.AccountID,
		"demo_id":      claims.DemoID,
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
