// state_pump.go — periodically fetches per-account engine state and routes it
// to the correct WebSocket clients via the hub.
//
// Each connected client registers its account_id when it opens the WebSocket
// (/ws?account_id=<uuid>).  The pump collects the distinct set of connected
// account IDs every second, fetches a StateSnapshot for each one, and delivers
// it only to the clients that belong to that account.
//
// Tick messages continue to be broadcast to all clients (fan-out).
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

// StateHub is the subset of the ws.Hub interface the state pump needs.
type StateHub interface {
	// Broadcast fans a message out to every connected client (used for ticks).
	Broadcast(msg []byte)
	// AccountIDs returns the distinct non-empty account IDs currently connected.
	AccountIDs() []string
	// BroadcastToAccount delivers a message only to clients registered under accountID.
	BroadcastToAccount(accountID string, msg []byte)
}

// RunStatePump fetches per-account engine state every second and routes each
// snapshot only to the WebSocket clients that own that account.
// Blocks until ctx is cancelled.
func RunStatePump(ctx context.Context, client *Client, hub StateHub) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			accountIDs := hub.AccountIDs()
			for _, accountID := range accountIDs {
				msg, err := fetchStateMsg(ctx, client, accountID)
				if err != nil {
					slog.Warn("state pump: fetch failed", "account_id", accountID, "err", err)
					continue
				}
				hub.BroadcastToAccount(accountID, msg)
			}
		}
	}
}

// fetchStateMsg calls GetState on the engine for the given accountID and returns
// a JSON-encoded WebSocket message: {"type":"state","data":{...StateSnapshot...}}
func fetchStateMsg(ctx context.Context, client *Client, accountID string) ([]byte, error) {
	rpcCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	snap, err := client.svc.GetState(rpcCtx, &enginepb.GetStateRequest{
		AccountId: accountID,
	})
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
