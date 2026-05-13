package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct{ db *pgxpool.Pool }

func NewHandler(db *pgxpool.Pool) *Handler { return &Handler{db: db} }

func (h *Handler) Register(c *gin.Context) {
	var req struct {
		Email    string `json:"email"    binding:"required,email"`
		Password string `json:"password" binding:"required,min=8"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
		return
	}

	ctx := c.Request.Context()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var userID string
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id`,
		req.Email, string(hash),
	).Scan(&userID)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
		return
	}

	// Create demo account with $10,000 starting balance
	var demoID string
	err = tx.QueryRow(ctx,
		`INSERT INTO accounts (user_id, type, balance) VALUES ($1,'demo',10000) RETURNING id`,
		userID,
	).Scan(&demoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "account error"})
		return
	}

	// Create real account (zero balance)
	var realID string
	err = tx.QueryRow(ctx,
		`INSERT INTO accounts (user_id, type, balance) VALUES ($1,'real',0) RETURNING id`,
		userID,
	).Scan(&realID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "account error"})
		return
	}

	if err := tx.Commit(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}

	token, err := Sign(userID, realID, demoID, req.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token error"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"token":      token,
		"user_id":    userID,
		"account_id": realID,
		"demo_id":    demoID,
		"email":      req.Email,
	})
}

func (h *Handler) Login(c *gin.Context) {
	var req struct {
		Email    string `json:"email"    binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()

	var userID, hash string
	err := h.db.QueryRow(ctx,
		`SELECT id, password_hash FROM users WHERE email=$1`, req.Email,
	).Scan(&userID, &hash)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	var realID, demoID string
	rows, _ := h.db.Query(ctx,
		`SELECT id, type FROM accounts WHERE user_id=$1`, userID,
	)
	defer rows.Close()
	for rows.Next() {
		var id, typ string
		rows.Scan(&id, &typ) //nolint:errcheck
		if typ == "real" {
			realID = id
		} else {
			demoID = id
		}
	}

	token, err := Sign(userID, realID, demoID, req.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token":      token,
		"user_id":    userID,
		"account_id": realID,
		"demo_id":    demoID,
		"email":      req.Email,
	})
}

func (h *Handler) Me(c *gin.Context) {
	claims := c.MustGet("claims").(*Claims)
	ctx := c.Request.Context()

	var realBal, demoBal float64
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.AccountID).Scan(&realBal) //nolint:errcheck
	h.db.QueryRow(ctx, `SELECT balance FROM accounts WHERE id=$1`, claims.DemoID).Scan(&demoBal)   //nolint:errcheck

	c.JSON(http.StatusOK, gin.H{
		"user_id":      claims.UserID,
		"email":        claims.Email,
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
		// Expose account_id as query param for downstream compatibility
		if c.Query("account_id") == "" {
			c.Request.URL.RawQuery += "&account_id=" + claims.AccountID
		}
		// Expose user_id for downstream
		_ = uuid.MustParse(claims.UserID) // validates UUID
		c.Next()
	}
}
