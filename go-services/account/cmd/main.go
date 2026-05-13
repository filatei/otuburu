// Account service — Otuburu
//
// Responsibilities:
//   - Client registration + KYC stub
//   - JWT auth (issue / refresh / revoke)
//   - Wallet (demo-money deposits / withdrawals)
//   - Account balance queries
//
// Exposes:
//   - REST API (Gin) on :8081
//   - gRPC server on :9081  (consumed by Gateway and Risk-monitor)

package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc"

	"otuburu.money/account/internal/auth"
	"otuburu.money/account/internal/wallet"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	slog.Info("starting account service",
		"rest_port", envOr("REST_PORT", "8081"),
		"grpc_port", envOr("GRPC_PORT", "9081"),
	)

	// ── REST server ──────────────────────────────────────────
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(requestLogger())

	v1 := r.Group("/v1")
	auth.RegisterRoutes(v1)
	wallet.RegisterRoutes(v1)

	restSrv := &http.Server{
		Addr:         ":" + envOr("REST_PORT", "8081"),
		Handler:      r,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// ── gRPC server ──────────────────────────────────────────
	grpcSrv := grpc.NewServer()
	// TODO: register AccountServiceServer once proto is generated
	// accountpb.RegisterAccountServiceServer(grpcSrv, &auth.GrpcServer{})

	// ── Graceful shutdown ────────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := restSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("REST server error", "err", err)
		}
	}()

	go func() {
		ln, err := net.Listen("tcp", ":"+envOr("GRPC_PORT", "9081"))
		if err != nil {
			slog.Error("gRPC listen error", "err", err)
			return
		}
		if err := grpcSrv.Serve(ln); err != nil {
			slog.Error("gRPC server error", "err", err)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = restSrv.Shutdown(shutCtx)
	grpcSrv.GracefulStop()
	slog.Info("account service stopped")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		slog.Info("request",
			"method", c.Request.Method,
			"path",   c.Request.URL.Path,
			"status", c.Writer.Status(),
			"latency", fmt.Sprintf("%dms", time.Since(start).Milliseconds()),
		)
	}
}
