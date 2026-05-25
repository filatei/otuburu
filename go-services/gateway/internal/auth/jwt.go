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

var jwtSecret = []byte(func() string {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		return s
	}
	return "change-me-in-production-use-32-chars-min"
}())

// Claims mirrors the wallet service Claims so both services share one token format.
type Claims struct {
	UserID    string `json:"uid"`
	AccountID string `json:"aid"` // real trading account UUID
	DemoID    string `json:"did"` // demo trading account UUID
	Email     string `json:"email"`
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

// OwnsAccount returns true when the accountID matches the user's real or demo account.
func (cl *Claims) OwnsAccount(accountID string) bool {
	return accountID == cl.AccountID || accountID == cl.DemoID
}
