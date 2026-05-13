// Package engine — tick_pump subscribes to the Rust engine's SubscribeTicks
// streaming RPC and broadcasts each tick as JSON to the WebSocket hub.
// It reconnects automatically if the stream drops.
package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"otuburu.money/gateway/internal/enginepb"
)

// Broadcaster is implemented by ws.Hub — decouples engine from ws package.
type Broadcaster interface {
	Broadcast(msg []byte)
}

// tickEnvelope is the JSON shape sent to WebSocket clients.
type tickEnvelope struct {
	Type string          `json:"type"`
	Data *enginepb.Tick  `json:"data"`
}

// RunTickPump subscribes to all engine ticks and fans them out to hub.
// Blocks until ctx is cancelled; reconnects on stream error.
func RunTickPump(ctx context.Context, client *Client, hub Broadcaster) {
	for {
		err := pumpOnce(ctx, client, hub)
		if ctx.Err() != nil {
			// Graceful shutdown — stop retrying.
			return
		}
		slog.Warn("tick pump stream ended, reconnecting in 2s", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func pumpOnce(ctx context.Context, client *Client, hub Broadcaster) error {
	stream, err := client.svc.SubscribeTicks(ctx, &enginepb.SubscribeTicksRequest{
		Symbols: []string{}, // empty = all symbols
	})
	if err != nil {
		return err
	}
	slog.Info("tick pump connected to engine")

	for {
		tick, err := stream.Recv()
		if err != nil {
			return err
		}

		env := tickEnvelope{Type: "tick", Data: tick}
		msg, err := json.Marshal(env)
		if err != nil {
			slog.Warn("tick marshal error", "err", err)
			continue
		}
		hub.Broadcast(msg)
	}
}
