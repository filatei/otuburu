// Risk-monitor service — Otuburu
//
// Watches the engine's position book and house exposure via gRPC subscription.
// Fires alerts when:
//   - House net exposure exceeds 80% of the cap
//   - Any single symbol exposure exceeds 70% of the cap
//   - Client daily loss limit is approaching (>80%)
//   - Margin level on any account drops below 80%
//
// Phase 1: skeleton with stub alerting (log only).
// Phase 2: Slack / PagerDuty webhooks + auto circuit-breaker.

package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	engineAddr := envOr("ENGINE_ADDR", "localhost:9090")
	pollInterval := 5 * time.Second

	slog.Info("risk-monitor starting",
		"engine_addr", engineAddr,
		"poll_interval", pollInterval,
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// TODO Phase 2: connect to engine gRPC and subscribe to HouseStats stream
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("risk-monitor stopped")
			return
		case <-ticker.C:
			// TODO: poll engine snapshot, check thresholds, fire alerts
			slog.Debug("risk-monitor heartbeat")
		}
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
