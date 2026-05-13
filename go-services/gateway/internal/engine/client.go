// Package engine provides the gRPC client connecting the gateway to the
// Rust otuburu-engine service.
package engine

import (
	"log/slog"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"otuburu.money/gateway/internal/enginepb"
)

// Client wraps the gRPC connection and the generated service stub.
type Client struct {
	conn *grpc.ClientConn
	svc  enginepb.EngineServiceClient
}

// New dials the engine at addr (e.g. "localhost:9090") and returns a Client.
// The connection is non-blocking — gRPC will reconnect in the background if
// the engine is temporarily unavailable.
func New(addr string) (*Client, error) {
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, err
	}
	slog.Info("engine gRPC client created", "addr", addr)
	return &Client{conn: conn, svc: enginepb.NewEngineServiceClient(conn)}, nil
}

// Close tears down the underlying gRPC connection.
func (c *Client) Close() {
	if err := c.conn.Close(); err != nil {
		slog.Warn("engine conn close", "err", err)
	}
}

// Service returns the raw generated stub for direct RPC calls.
func (c *Client) Service() enginepb.EngineServiceClient { return c.svc }
