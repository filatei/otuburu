package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"

	"otuburu.money/wallet/internal/admin"
	"otuburu.money/wallet/internal/auth"
	"otuburu.money/wallet/internal/db"
	"otuburu.money/wallet/internal/email"
	"otuburu.money/wallet/internal/payments"
	"otuburu.money/wallet/internal/sweep"
	"otuburu.money/wallet/internal/wallet"
)

func main() {
	ctx := context.Background()

	// ── Required secrets — fail loud at boot, never start silently degraded.
	// Symmetric with the gateway: if either of these is missing, wallet→gateway
	// balance-sync or user JWT verification will silently 401. We refuse to
	// start unless both are set and meet a minimal length bar (24 bytes).
	// The actual reads happen inside the auth/payments packages — these calls
	// exist purely to make the dependency visible and to crash cleanly here.
	// See feedback_otuburu_env_passthrough.md.
	mustEnv("INTERNAL_SECRET", "wallet→gateway server-to-server auth")
	mustEnv("JWT_SECRET",      "HS256 user JWT signing key")

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

	// ── Transactional email ──────────────────────────────────────────────────
	// Initialised before the deposit monitor and route wiring because both
	// take the mailer as a dependency. Nil-safe — when SMTP config is
	// incomplete the wallet still runs, just without notifications. Email
	// is best-effort; we never block a deposit credit or withdrawal request
	// on send success.
	mailer := email.New()

	// ── Deposit monitor ───────────────────────────────────────────────────────
	monitor := wallet.NewMonitor(pool, mailer)
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

	// paystackH built below — wired into walletH so the NGN withdraw path
	// can call /transferrecipient + /transfer. Nil-safe; NGN endpoints
	// 503 cleanly when Paystack isn't configured.

	// ── Payment channels ──────────────────────────────────────────────────────
	// Seed rate from env; RateFetcher will override with live data within seconds.
	seedRate, _ := strconv.ParseFloat(os.Getenv("USD_TO_NGN_RATE"), 64)
	rateFetcher := payments.NewRateFetcher(seedRate)
	rateFetcher.Start(ctx)

	// Phase 3: multi-currency rate map (NGN, GHS, KES, ZAR, UGX). Boots
	// alongside the legacy single-currency RateFetcher for now; future
	// callers should migrate to RateMap and the legacy fetcher can retire
	// once Paystack handler stops needing it.
	rateMap := payments.NewRateMap()
	rateMap.Start(ctx)

	paystackH := payments.New(pool, rateFetcher, mailer)
	paystackH.RegisterRoutes(protected, r.Group("/"))

	// Now that paystackH exists, build the wallet handler and register routes.
	walletH := wallet.NewHandler(pool, hd, mailer, paystackH)
	protected.GET("/wallet/deposit-address", walletH.DepositAddress)
	protected.GET("/wallet/balance", walletH.Balance)
	protected.GET("/wallet/transactions", walletH.Transactions)
	protected.POST("/wallet/withdraw", walletH.Withdraw)
	// Phase-2 multi-account: list + create real accounts for a user.
	protected.GET("/wallet/accounts", walletH.ListAccounts)
	protected.POST("/wallet/accounts", walletH.CreateAccount)
	// Phase-3 NGN withdrawal: account verification + bank payout.
	protected.GET("/wallet/ngn/resolve", walletH.ResolveNGNAccount)
	protected.POST("/wallet/withdraw/ngn", walletH.WithdrawNGN)
	// User-typed contact-us message → ADMIN_EMAIL(S). Auth required so
	// admins know who sent it; in-memory 1/min rate limit per user.
	protected.POST("/wallet/contact", walletH.Contact)

	// Expose the rate map read-only for the frontend's deposit-preview UI
	// (Phase 3 NGN/GHS/KES picker). One endpoint, no auth required — the
	// rates are publicly available from the upstream providers anyway.
	r.GET("/payments/rates", payments.RatesHandler(rateMap))

	// ── Admin: back-office dashboard ──────────────────────────────────────────
	// Note: avoid r.Group("/admin") alongside r.GET("/admin") — Gin's router
	// tree treats the group prefix as a node and drops the exact-match handler.
	// Apply the auth middleware inline per route instead.
	adminH   := admin.New(pool, hd, sw, mailer)
	adminAuth := admin.Middleware()
	r.GET("/admin",                        adminH.UI) // HTML — no auth (JS handles it)
	r.GET("/admin/dashboard",              adminAuth, adminH.Dashboard)
	r.GET("/admin/users",                  adminAuth, adminH.Users)
	r.GET("/admin/deposits",               adminAuth, adminH.Deposits)
	r.GET("/admin/withdrawals",            adminAuth, adminH.Withdrawals)
	r.POST("/admin/withdrawals/:id/approve", adminAuth, adminH.ApproveWithdrawal)
	r.POST("/admin/withdrawals/:id/reject",  adminAuth, adminH.RejectWithdrawal)
	r.POST("/admin/sweep",                 adminAuth, adminH.ManualSweep)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}
	slog.Info("wallet service ready", "port", port)
	if err := r.Run(":" + port); err != nil {
		slog.Error("server", "err", err)
	}
}

// mustEnv aborts startup with a helpful message if env var `key` is empty
// or shorter than 24 bytes. Used for shared secrets where a silent default
// would create a hard-to-debug auth bug later. Symmetric helper exists in
// gateway/cmd/main.go — keep them in sync if you change the threshold.
//
// 24 bytes is a deliberately modest bar — long enough to defeat trivial
// dictionary attacks against HMAC, short enough that local dev secrets
// don't need to be ceremonial. Production uses 32+ from GitHub Secrets.
func mustEnv(key, purpose string) string {
	const minLen = 24
	v := os.Getenv(key)
	if v == "" {
		slog.Error("missing required secret",
			"key", key, "purpose", purpose,
			"hint", "set "+key+" in your environment or compose .env file")
		os.Exit(1)
	}
	if len(v) < minLen {
		slog.Error("required secret is too short",
			"key", key, "purpose", purpose,
			"got_length", len(v), "min_length", minLen,
			"hint", "use `openssl rand -hex 32` to generate a fresh value")
		os.Exit(1)
	}
	return v
}
