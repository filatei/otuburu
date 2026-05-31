// Gateway service — Otuburu
//
// Responsibilities:
//   - Fan-out live tick stream from the Rust engine to connected WebSocket clients
//   - Proxy REST order requests to the Rust engine gRPC API
//   - (Phase 2) Authenticate every request via JWT from the Account service
//   - (Phase 2) Rate-limit per client
//
// Exposes:
//   - WebSocket  ws://:8082/ws   — authenticated tick fan-out
//   - REST proxy http://:8082/api — thin pass-through to engine

package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"otuburu.money/gateway/internal/engine"
	"otuburu.money/gateway/internal/rest"
	"otuburu.money/gateway/internal/ws"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// ── Required secrets — fail loud at boot, never start silently degraded.
	// Historical bug: a missing INTERNAL_SECRET in compose meant wallet→gateway
	// calls silently 401'd and deposits stopped crediting, but the service was
	// still "up". We now refuse to start unless both shared secrets are set
	// and meet a minimal length bar. See feedback_otuburu_env_passthrough.md.
	//
	// JWT_SECRET is consumed by internal/auth/jwt.go via os.Getenv at package
	// init — we just need to assert it exists here, value isn't held locally.
	internalSecret := mustEnv("INTERNAL_SECRET", "wallet→gateway server-to-server auth")
	mustEnv("JWT_SECRET", "HS256 user JWT signing key")

	port := envOr("PORT", "8082")
	engineAddr := envOr("ENGINE_ADDR", "localhost:9090")

	slog.Info("starting gateway", "port", port, "engine", engineAddr)

	// ── Engine gRPC client ────────────────────────────────────────────────────
	engineClient, err := engine.New(engineAddr)
	if err != nil {
		slog.Error("failed to create engine client", "err", err)
		os.Exit(1)
	}
	defer engineClient.Close()

	// Wire the engine client into the REST handlers.
	rest.Init(engineClient)

	// ── WebSocket hub ─────────────────────────────────────────────────────────
	hub := ws.NewHub()
	go hub.Run()

	// ── Tick pump — engine → hub → all WS clients ────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go engine.RunTickPump(ctx, engineClient, hub)
	go engine.RunStatePump(ctx, engineClient, hub) // pushes state every 1s → no HTTP polling needed

	// ── HTTP server ───────────────────────────────────────────────────────────
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS — same shape as wallet's middleware. Wildcard origin is fine here
	// because:
	//   (a) all sensitive routes are bearer-token authed (and a wildcard
	//       CORS doesn't allow credentials/cookies anyway), and
	//   (b) the Capacitor APK loads from the https://localhost origin,
	//       which is the immediate reason CORS is needed at all — the same
	//       header that satisfies it also satisfies any future native shell
	//       (iOS uses capacitor://localhost). Mobile WebViews + cross-origin
	//       fetches were silently 404'ing the symbol list with "0 SYMBOLS".
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

	r.GET("/ws", hub.HandleUpgrade)
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	rest.RegisterRoutes(r.Group("/api"))
	rest.RegisterInternalRoutes(r.Group("/internal"), internalSecret)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
		}
	}()

	slog.Info("gateway ready", "addr", srv.Addr)
	<-ctx.Done()

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	slog.Info("gateway stopped")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// mustEnv returns the value of env var `key`, or aborts startup with a
// helpful message if it is empty or shorter than 24 bytes. Used for shared
// secrets where a silent default would create a hard-to-debug auth bug
// later (e.g. wallet→gateway X-Internal-Secret mismatch).
//
// 24 bytes is a deliberately modest bar — long enough to defeat trivial
// dictionary attacks against HMAC, short enough that local dev secrets
// don't need to be ceremonial. Production uses 32+ in our GitHub Secrets.
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
