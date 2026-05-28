package auth

import (
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// jwtSecret is read once at package init. main.go validates JWT_SECRET via
// mustEnv() before any HTTP routes are wired, so by the time any request
// hits Verify/Issue this is guaranteed non-empty. There is intentionally
// **no fallback default** — a hard-coded secret would let an attacker who
// knows the source forge tokens.
var jwtSecret = []byte(os.Getenv("JWT_SECRET"))

type Claims struct {
	UserID    string `json:"uid"`
	AccountID string `json:"aid"` // real account id
	DemoID    string `json:"did"` // demo account id
	Email     string `json:"email"`
	jwt.RegisteredClaims
}

func Sign(userID, accountID, demoID, email string) (string, error) {
	claims := Claims{
		UserID:    userID,
		AccountID: accountID,
		DemoID:    demoID,
		Email:     email,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(30 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
}

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
