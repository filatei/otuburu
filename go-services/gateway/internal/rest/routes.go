// Package rest proxies REST calls from clients to the Rust engine via gRPC.
package rest

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/engine"
	"otuburu.money/gateway/internal/enginepb"
)

var (
	engineAddr   = envOr("ENGINE_ADDR", "localhost:9090")
	engineClient *engine.Client
)

// Init wires the shared engine client into this package.
// Must be called before RegisterRoutes.
func Init(client *engine.Client) {
	engineClient = client
}

// RegisterRoutes attaches all REST proxy endpoints to the given router group.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/symbols", handleSymbols)
	rg.GET("/state", handleState)
	rg.POST("/order", handleOrder)
	rg.POST("/close", handleClose)
	rg.POST("/binary", handleBinary)
}

// EngineAddr returns the configured engine address (used for health checks).
func EngineAddr() string { return engineAddr }

// ── helpers ───────────────────────────────────────────────────────────────────

func rpcCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func engineErr(c *gin.Context, err error) {
	c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
}

// ── handlers ──────────────────────────────────────────────────────────────────

func handleSymbols(c *gin.Context) {
	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().GetSymbols(ctx, &enginepb.GetSymbolsRequest{})
	if err != nil {
		engineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func handleState(c *gin.Context) {
	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().GetState(ctx, &enginepb.GetStateRequest{
		AccountId: c.Query("account_id"),
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

type placeOrderReq struct {
	AccountID string  `json:"account_id" binding:"required"`
	Symbol    string  `json:"symbol"     binding:"required"`
	Side      string  `json:"side"       binding:"required"`
	Lots      float64 `json:"lots"       binding:"required"`
}

func handleOrder(c *gin.Context) {
	var req placeOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().PlaceOrder(ctx, &enginepb.PlaceOrderRequest{
		AccountId: req.AccountID,
		Symbol:    req.Symbol,
		Side:      req.Side,
		Lots:      req.Lots,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

type closePositionReq struct {
	AccountID  string `json:"account_id"  binding:"required"`
	PositionID string `json:"position_id" binding:"required"`
}

func handleClose(c *gin.Context) {
	var req closePositionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().ClosePosition(ctx, &enginepb.ClosePositionRequest{
		AccountId:  req.AccountID,
		PositionId: req.PositionID,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

type placeBinaryReq struct {
	AccountID string  `json:"account_id" binding:"required"`
	Symbol    string  `json:"symbol"     binding:"required"`
	Direction string  `json:"direction"  binding:"required"`
	Stake     float64 `json:"stake"      binding:"required"`
	Ticks     uint32  `json:"ticks"      binding:"required"`
}

func handleBinary(c *gin.Context) {
	var req placeBinaryReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().PlaceBinary(ctx, &enginepb.PlaceBinaryRequest{
		AccountId: req.AccountID,
		Symbol:    req.Symbol,
		Direction: req.Direction,
		Stake:     req.Stake,
		Ticks:     req.Ticks,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
