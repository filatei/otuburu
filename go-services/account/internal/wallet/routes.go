// Package wallet manages demo-money balance operations.
// Production will replace the in-memory store with Postgres + event-sourced ledger.
package wallet

import (
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

var (
	mu       sync.RWMutex
	balances = map[uuid.UUID]float64{} // account_id -> USD balance
)

// RegisterRoutes wires wallet endpoints onto the given router group.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/wallet/:account_id",        handleBalance)
	rg.POST("/wallet/:account_id/deposit",  handleDeposit)
	rg.POST("/wallet/:account_id/withdraw", handleWithdraw)
}

func handleBalance(c *gin.Context) {
	id, err := uuid.Parse(c.Param("account_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account_id"})
		return
	}
	mu.RLock()
	bal := balances[id]
	mu.RUnlock()
	c.JSON(http.StatusOK, gin.H{"account_id": id, "balance": bal, "currency": "USD"})
}

type amountReq struct {
	Amount float64 `json:"amount" binding:"required,gt=0"`
}

func handleDeposit(c *gin.Context) {
	id, err := uuid.Parse(c.Param("account_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account_id"})
		return
	}
	var req amountReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	mu.Lock()
	balances[id] += req.Amount
	newBal := balances[id]
	mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"account_id": id, "balance": newBal, "deposited": req.Amount})
}

func handleWithdraw(c *gin.Context) {
	id, err := uuid.Parse(c.Param("account_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account_id"})
		return
	}
	var req amountReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if balances[id] < req.Amount {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "insufficient balance"})
		return
	}
	balances[id] -= req.Amount
	c.JSON(http.StatusOK, gin.H{"account_id": id, "balance": balances[id], "withdrawn": req.Amount})
}
