// Package rest proxies REST calls from clients to the Rust engine via gRPC.
package rest

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"otuburu.money/gateway/internal/auth"
	"otuburu.money/gateway/internal/engine"
	"otuburu.money/gateway/internal/enginepb"
)

var (
	engineAddr   = envOr("ENGINE_ADDR", "localhost:9090")
	engineClient *engine.Client
)

// protoJSON serialises a proto.Message as JSON using snake_case field names
// and emitting zero-value (unpopulated) fields so the frontend always sees all keys.
var protoMarshaler = protojson.MarshalOptions{
	UseProtoNames:   true,
	EmitUnpopulated: true,
}

func writeProtoJSON(c *gin.Context, status int, msg proto.Message) {
	b, err := protoMarshaler.Marshal(msg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Data(status, "application/json; charset=utf-8", b)
}

// Init wires the shared engine client into this package.
// Must be called before RegisterRoutes.
func Init(client *engine.Client) {
	engineClient = client
}

// RegisterRoutes attaches all REST proxy endpoints to the given router group.
//
// Public routes (no auth required):
//   - GET /symbols   — market symbol list
//   - GET /candles   — OHLC history
//
// Protected routes (valid JWT required, account_id must belong to the caller):
//   - GET  /state           — account state
//   - POST /order           — place CFD order
//   - POST /close           — close position (legacy)
//   - DELETE /position/:id  — close position
//   - POST /binary          — place binary option
//   - POST /account         — provision engine account
//   - GET  /accounts        — list accounts (own only)
//   - GET  /history         — trade history
func RegisterRoutes(rg *gin.RouterGroup) {
	// ── Public ────────────────────────────────────────────────────────────────
	rg.GET("/symbols", handleSymbols)
	rg.GET("/candles", handleCandles)

	// ── Authenticated ─────────────────────────────────────────────────────────
	protected := rg.Group("/", auth.Middleware())
	{
		protected.GET("/state", handleState)
		protected.POST("/order", handleOrder)
		protected.POST("/close", handleClose)
		protected.DELETE("/position/:id", handleDeletePos)
		protected.POST("/binary", handleBinary)
		protected.POST("/account", handleCreateAccount)
		protected.GET("/accounts", handleListAccounts)
		protected.GET("/history", handleTradeHistory)
	}
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

// forbiddenAccount aborts with 403 when the requested account_id is not owned by the caller.
func forbiddenAccount(c *gin.Context, accountID string) bool {
	claims := auth.GetClaims(c)
	if claims == nil || !claims.OwnsAccount(accountID) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "account not owned by caller"})
		return true
	}
	return false
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
	writeProtoJSON(c, http.StatusOK, resp)
}

func handleState(c *gin.Context) {
	accountID := c.Query("account_id")
	if forbiddenAccount(c, accountID) {
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().GetState(ctx, &enginepb.GetStateRequest{
		AccountId: accountID,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
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
	if forbiddenAccount(c, req.AccountID) {
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
	writeProtoJSON(c, http.StatusOK, resp)
}

type closePositionReq struct {
	AccountID  string `json:"account_id"  binding:"required"`
	PositionID string `json:"position_id" binding:"required"`
}

// handleClose handles the legacy POST /close route.
func handleClose(c *gin.Context) {
	var req closePositionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if forbiddenAccount(c, req.AccountID) {
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
	writeProtoJSON(c, http.StatusOK, resp)
}

// handleDeletePos handles DELETE /position/:id (used by the frontend closePosition()).
func handleDeletePos(c *gin.Context) {
	posID := c.Param("id")

	var body struct {
		AccountID string `json:"account_id"`
	}
	_ = c.ShouldBindJSON(&body)

	if forbiddenAccount(c, body.AccountID) {
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().ClosePosition(ctx, &enginepb.ClosePositionRequest{
		AccountId:  body.AccountID,
		PositionId: posID,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
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
	if forbiddenAccount(c, req.AccountID) {
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
	writeProtoJSON(c, http.StatusOK, resp)
}

// ── Account management ────────────────────────────────────────────────────────

type createAccountReq struct {
	AccountID      string  `json:"account_id"      binding:"required"`
	Label          string  `json:"label"`
	IsDemo         bool    `json:"is_demo"`
	InitialBalance float64 `json:"initial_balance"`
}

func handleCreateAccount(c *gin.Context) {
	var req createAccountReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Only allow provisioning your own accounts
	if forbiddenAccount(c, req.AccountID) {
		return
	}

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().CreateAccount(ctx, &enginepb.CreateAccountRequest{
		AccountId:      req.AccountID,
		Label:          req.Label,
		IsDemo:         req.IsDemo,
		InitialBalance: req.InitialBalance,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
}

// GET /api/accounts?ids=uuid1,uuid2,...
// Filtered to only return accounts belonging to the authenticated user.
func handleListAccounts(c *gin.Context) {
	claims := auth.GetClaims(c)

	idsParam := c.Query("ids")
	var ids []string
	if idsParam != "" {
		for _, id := range strings.Split(idsParam, ",") {
			if claims.OwnsAccount(id) {
				ids = append(ids, id)
			}
		}
	} else {
		// Default: return the caller's own accounts
		ids = []string{claims.AccountID, claims.DemoID}
	}

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().ListAccounts(ctx, &enginepb.ListAccountsRequest{
		AccountIds: ids,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
}

// ── Chart history ─────────────────────────────────────────────────────────────

// GET /api/candles?symbol=frxEURUSD&resolution=M1&from=<ms>&to=<ms>
func handleCandles(c *gin.Context) {
	symbol := c.Query("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol is required"})
		return
	}
	resolution := c.Query("resolution")
	if resolution == "" {
		resolution = "M1"
	}

	fromMs, _ := strconv.ParseInt(c.Query("from"), 10, 64)
	toMs, _ := strconv.ParseInt(c.Query("to"), 10, 64)

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().GetCandles(ctx, &enginepb.GetCandlesRequest{
		Symbol:     symbol,
		Resolution: resolution,
		FromMs:     fromMs,
		ToMs:       toMs,
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
}

// ── Trade history ─────────────────────────────────────────────────────────────

// GET /api/history?account_id=<uuid>&symbol=<sym>&from=<ms>&to=<ms>&limit=<n>
func handleTradeHistory(c *gin.Context) {
	accountID := c.Query("account_id")
	if accountID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "account_id is required"})
		return
	}
	if forbiddenAccount(c, accountID) {
		return
	}

	fromMs, _ := strconv.ParseInt(c.Query("from"), 10, 64)
	toMs, _ := strconv.ParseInt(c.Query("to"), 10, 64)
	limit, _ := strconv.ParseUint(c.Query("limit"), 10, 32)

	ctx, cancel := rpcCtx()
	defer cancel()

	resp, err := engineClient.Service().GetTradeHistory(ctx, &enginepb.GetTradeHistoryRequest{
		AccountId: accountID,
		Symbol:    c.Query("symbol"),
		FromMs:    fromMs,
		ToMs:      toMs,
		Limit:     uint32(limit),
	})
	if err != nil {
		engineErr(c, err)
		return
	}
	writeProtoJSON(c, http.StatusOK, resp)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
