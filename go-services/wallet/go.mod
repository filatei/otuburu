module otuburu.money/wallet

go 1.23

require (
	github.com/btcsuite/btcd/btcec/v2 v2.3.3
	github.com/gin-gonic/gin v1.10.0
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.6.0
	github.com/tyler-smith/go-bip32 v1.0.0
	github.com/tyler-smith/go-bip39 v1.1.0
	golang.org/x/crypto v0.24.0
)

// Note: bcrypt removed — Google OAuth only, no passwords stored
