// Package db is the gateway's connection to Postgres. Sprint 5.5f
// — gateway gains its own pool (same DB instance as wallet) for the
// admin_audit_log table. Future audit-related tables live here too.
//
// Pattern mirrors wallet/internal/db/db.go intentionally: same env
// fallback chain (DATABASE_URL → POSTGRES_* parts), same pgxpool
// type, same ping-on-connect. Keeping the two services symmetric so
// ops only has to learn one wiring.
package db

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect dials Postgres and returns a pooled handle.
//
// Resolution order for the DSN:
//  1. DATABASE_URL env var if set
//  2. Built from POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_HOST /
//     POSTGRES_PORT / POSTGRES_DB with reasonable defaults for the
//     docker-compose internal network
//
// Caller is expected to defer pool.Close() before exit.
func Connect(ctx context.Context) (*pgxpool.Pool, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
			env("POSTGRES_USER", "otuburu"),
			env("POSTGRES_PASSWORD", "otuburu"),
			env("POSTGRES_HOST", "postgres"),
			env("POSTGRES_PORT", "5432"),
			env("POSTGRES_DB", "otuburu"),
		)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}
	return pool, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
