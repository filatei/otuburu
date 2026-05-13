// Package auth handles registration, login, JWT issuance and refresh.
package auth

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// TODO: replace with Postgres-backed store
var userStore = map[string]storedUser{} // email -> storedUser

type storedUser struct {
	ID           uuid.UUID
	Email        string
	PasswordHash []byte
}

var jwtSecret = []byte("CHANGE_ME_IN_PRODUCTION") // loaded from env in real service

// RegisterRoutes wires auth endpoints onto the given router group.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/auth/register", handleRegister)
	rg.POST("/auth/login",    handleLogin)
	rg.POST("/auth/refresh",  handleRefresh)
}

type registerReq struct {
	Email    string `json:"email"    binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

func handleRegister(c *gin.Context) {
	var req registerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, exists := userStore[req.Email]; exists {
		c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	id := uuid.New()
	userStore[req.Email] = storedUser{ID: id, Email: req.Email, PasswordHash: hash}
	c.JSON(http.StatusCreated, gin.H{"account_id": id})
}

type loginReq struct {
	Email    string `json:"email"    binding:"required"`
	Password string `json:"password" binding:"required"`
}

func handleLogin(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	u, ok := userStore[req.Email]
	if !ok || bcrypt.CompareHashAndPassword(u.PasswordHash, []byte(req.Password)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	token, err := issueJWT(u.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "account_id": u.ID})
}

func handleRefresh(c *gin.Context) {
	// Minimal implementation: validate existing token and re-issue
	tokenStr := c.GetHeader("Authorization")
	if len(tokenStr) > 7 && tokenStr[:7] == "Bearer " {
		tokenStr = tokenStr[7:]
	}
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		return jwtSecret, nil
	})
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}
	id, _ := uuid.Parse(claims.Subject)
	token, err := issueJWT(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token})
}

func issueJWT(accountID uuid.UUID) (string, error) {
	claims := jwt.RegisteredClaims{
		Subject:   accountID.String(),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
}
