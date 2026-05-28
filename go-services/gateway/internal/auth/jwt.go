// Package auth provides JWT verification and Gin middleware for the gateway.
// Uses the same JWT_SECRET environment variable and Claims shape as the wallet service,
// so a single token issued by the wallet is accepted by the gateway.
package auth

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// jwtSecret is read once at package init. Main is expected to have already
// validated JWT_SECRET via mustEnv() before the rest package's routes are
// wired, so by the time any request hits Verify() this is guaranteed
// non-empty. There is intentionally **no fallback default** — a hard-coded
// secret would let an attacker who knows the source forge tokens, and a
// silent empty would 401 every legitimate request without surfacing why.
var jwtSecret = []byte(os.Getenv("JWT_SECRET"))

// Claims mirrors the wallet service Claims so both services share one token format.
// Phase 2 adds AccountIDs (slice) for multi-account users; AccountID stays as
// a back-compat alias of "first real account" for tokens issued before the
// upgrade. OwnsAccount honours both. Keep this struct byte-identical to
// wallet/internal/auth/jwt.go Claims — gateway parses tokens minted there.
type Claims struct {
	UserID     string   `json:"uid"`
	AccountID  string   `json:"aid"`  // DEPRECATED: first real account; use AccountIDs
	AccountIDs []string `json:"aids"` // all real accounts owned by the user
	DemoID     string   `json:"did"`  // demo account id (singleton)
	Email      string   `json:"email"`
	jwt.RegisteredClaims
}

const claimsKey = "claims"

// Verify parses and validates a raw JWT string, returning the embedded claims.
func Verify(token string) (*Claims, error) {
	t, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := t.Claims.(*Claims)
	if !ok || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

// Middleware is a Gin handler that requires a valid Bearer JWT on every request.
// On success it stores *Claims under the "claims" key; on failure it aborts with 401.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or malformed token"})
			return
		}
		claims, err := Verify(strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		c.Set(claimsKey, claims)
		c.Next()
	}
}

// GetClaims extracts the JWT claims stored by Middleware from the Gin context.
// Returns nil when middleware was not applied (e.g. public routes).
func GetClaims(c *gin.Context) *Claims {
	v, _ := c.Get(claimsKey)
	claims, _ := v.(*Claims)
	return claims
}

// OwnsAccount returns true when accountID matches the demo, any real account
// in AccountIDs, or the legacy AccountID field (back-compat for tokens issued
// before AccountIDs landed). All trade/account-scoped handlers gate on this.
func (cl *Claims) OwnsAccount(accountID string) bool {
	if accountID == "" {
		return false
	}
	if accountID == cl.DemoID || accountID == cl.AccountID {
		return true
	}
	for _, id := range cl.AccountIDs {
		if id == accountID {
			return true
		}
	}
	return false
}
