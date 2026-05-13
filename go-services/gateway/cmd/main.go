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

	// ── HTTP server ───────────────────────────────────────────────────────────
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/ws", hub.HandleUpgrade)
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	rest.RegisterRoutes(r.Group("/api"))

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
