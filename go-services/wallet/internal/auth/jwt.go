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

// Claims is the JWT payload for an authenticated user. Phase 2 extends it
// with AccountIDs (slice of real account IDs) so a user can own multiple
// real accounts simultaneously. The legacy AccountID field remains for
// one release cycle so older clients with outstanding tokens (30-day TTL)
// keep working — it's populated with the first real account ID, and the
// OwnsAccount check honours both fields.
type Claims struct {
	UserID     string   `json:"uid"`
	AccountID  string   `json:"aid"`  // DEPRECATED: first real account; use AccountIDs
	AccountIDs []string `json:"aids"` // all real accounts owned by the user
	DemoID     string   `json:"did"`  // demo account id (always singleton)
	Email      string   `json:"email"`
	jwt.RegisteredClaims
}

// Sign issues a JWT for the given user with their full set of real accounts.
// `accountIDs` should be the list of real account UUIDs the user currently
// owns; pass at least one. The legacy AccountID field is populated from
// accountIDs[0] for back-compat with older frontends.
func Sign(userID string, accountIDs []string, demoID, email string) (string, error) {
	primary := ""
	if len(accountIDs) > 0 {
		primary = accountIDs[0]
	}
	claims := Claims{
		UserID:     userID,
		AccountID:  primary,
		AccountIDs: accountIDs,
		DemoID:     demoID,
		Email:      email,
		RegisteredClaims: jwt.RegisteredClaims{
			// 1-year TTL — matches MT5-style persistence: the user stays
			// signed in until they explicitly hit Sign out. Frontend
			// stores the token in localStorage (not sessionStorage) so it
			// survives browser closes. Re-issued on every login; users
			// who close the app for >1 year just re-authenticate.
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(365 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
}

// OwnsAccount returns true when accountID matches the demo, any real
// account in AccountIDs, or the legacy AccountID field (back-compat for
// tokens issued before AccountIDs landed). Used by handlers that scope
// data to the requesting user.
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
