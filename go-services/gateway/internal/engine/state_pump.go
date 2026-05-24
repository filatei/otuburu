// state_pump.go — periodically fetches engine state and broadcasts it over
// the WebSocket hub as a {"type":"state","data":{...}} message.
//
// This replaces the frontend's HTTP polling of GET /api/state, eliminating
// the repeated requests that trigger mod_evasive rate limiting and
// causing the "stuck after trade" / Forbidden bug.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"otuburu.money/gateway/internal/enginepb"
)

var stateMarshaler = protojson.MarshalOptions{
	UseProtoNames:   true, // snake_case keys — match TypeScript interfaces
	EmitUnpopulated: true, // include balance:0, positions:[] etc.
}

// RunStatePump fetches the full engine state every second and broadcasts it
// to all connected WebSocket clients. Blocks until ctx is cancelled.
func RunStatePump(ctx context.Context, client *Client, hub Broadcaster) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			msg, err := fetchStateMsg(ctx, client)
			if err != nil {
				slog.Warn("state pump: fetch failed", "err", err)
				continue
			}
			hub.Broadcast(msg)
		}
	}
}

// fetchStateMsg calls GetState on the engine and returns a JSON-encoded
// WebSocket message: {"type":"state","data":{...StateSnapshot...}}
func fetchStateMsg(ctx context.Context, client *Client) ([]byte, error) {
	rpcCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	snap, err := client.svc.GetState(rpcCtx, &enginepb.GetStateRequest{})
	if err != nil {
		return nil, err
	}

	dataBytes, err := stateMarshaler.Marshal(snap)
	if err != nil {
		return nil, fmt.Errorf("marshal state: %w", err)
	}

	// Build {"type":"state","data":<protojson>} without an extra alloc
	msg := make([]byte, 0, len(dataBytes)+24)
	msg = append(msg, `{"type":"state","data":`...)
	msg = append(msg, dataBytes...)
	msg = append(msg, '}')
	return msg, nil
}
