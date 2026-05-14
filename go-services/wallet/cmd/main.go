package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"otuburu.money/wallet/internal/admin"
	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/db"
	"otuburu.money/wallet/internal/sweep"
	"otuburu.money/wallet/internal/wallet"
)

func main() {
	ctx := context.Background()

	// ── Database ──────────────────────────────────────────────────────────────
	pool, err := db.Connect(ctx)
	if err != nil {
		slog.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	slog.Info("database connected")

	// ── HD Wallet ─────────────────────────────────────────────────────────────
	hd, err := wallet.NewHDWallet()
	if err != nil {
		slog.Error("hd wallet", "err", err)
		os.Exit(1)
	}

	// ── Sweep service ─────────────────────────────────────────────────────────
	sw, err := sweep.New(pool, hd)
	if err != nil {
		slog.Error("sweep init", "err", err)
		os.Exit(1)
	}
	go sw.Run(ctx)

	// ── Deposit monitor ───────────────────────────────────────────────────────
	monitor := wallet.NewMonitor(pool)
	go monitor.Run(ctx)

	// ── HTTP server ───────────────────────────────────────────────────────────
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		c.Header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	// ── Public: Google auth ───────────────────────────────────────────────────
	authH := auth.NewHandler(pool)
	r.POST("/auth/google", authH.GoogleAuth)

	// ── Protected: user wallet routes ─────────────────────────────────────────
	protected := r.Group("/", auth.JWTMiddleware())
	protected.GET("/auth/me", authH.Me)

	walletH := wallet.NewHandler(pool, hd)
	protected.GET("/wallet/deposit-address", walletH.DepositAddress)
	protected.GET("/wallet/balance", walletH.Balance)
	protected.GET("/wallet/transactions", walletH.Transactions)
	protected.POST("/wallet/withdraw", walletH.Withdraw)

	// ── Admin: back-office dashboard ──────────────────────────────────────────
	adminH := admin.New(pool, hd, sw)
	r.GET("/admin", adminH.UI) // HTML page — no auth (JS handles it)

	adminAPI := r.Group("/admin", admin.Middleware())
	adminAPI.GET("/dashboard",                adminH.Dashboard)
	adminAPI.GET("/users",                    adminH.Users)
	adminAPI.GET("/deposits",                 adminH.Deposits)
	adminAPI.GET("/withdrawals",              adminH.Withdrawals)
	adminAPI.POST("/withdrawals/:id/approve", adminH.ApproveWithdrawal)
	adminAPI.POST("/withdrawals/:id/reject",  adminH.RejectWithdrawal)
	adminAPI.POST("/sweep",                   adminH.ManualSweep)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}
	slog.Info("wallet service ready", "port", port)
	if err := r.Run(":" + port); err != nil {
		slog.Error("server", "err", err)
	}
}
