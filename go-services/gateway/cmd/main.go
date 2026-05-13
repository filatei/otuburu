// Gateway service — Otuburu
//
// Responsibilities:
//   - Authenticate every inbound WebSocket / REST request (JWT via Account service)
//   - Fan-out tick stream from the Rust engine to connected clients
//   - Route order requests to the Rust engine gRPC API
//   - Rate-limit per client
//
// Exposes:
//   - WebSocket endpoint ws://:8082/ws  (authenticated)
//   - REST proxy      http://:8082/api  (thin pass-through to engine)

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

	"otuburu.money/gateway/internal/rest"
	"otuburu.money/gateway/internal/ws"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	slog.Info("starting gateway service", "port", envOr("PORT", "8082"))

	r := gin.New()
	r.Use(gin.Recovery())

	// WebSocket fan-out
	hub := ws.NewHub()
	go hub.Run()
	r.GET("/ws", hub.HandleUpgrade)

	// REST proxy to engine
	rest.RegisterRoutes(r.Group("/api"))

	srv := &http.Server{
		Addr:         ":" + envOr("PORT", "8082"),
		Handler:      r,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
		}
	}()

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
