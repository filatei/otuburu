// Package audit writes append-only forensic records of admin actions
// to the admin_audit_log Postgres table. Sprint 5.5f.
//
// Design choices:
//
//   - Append-only. We never UPDATE or DELETE rows; if an action is
//     reversed, that's a new entry. Audit logs that can be edited
//     aren't audit logs.
//
//   - Best-effort write. If the database is unreachable, LogEvent
//     logs a slog.Error and returns without panicking — the admin
//     action still succeeds. The alternative (refusing admin actions
//     when Postgres is down) creates a worse failure mode where a
//     misbehaving DB pinning takes the gateway's admin surface
//     offline. Missing audit lines ARE loud in slog so an outage is
//     visible in monitor.sh.
//
//   - JSONB before/after. before_value and after_value are arbitrary
//     JSON so we don't have to schema-migrate every time we add a
//     new admin action with different state shape.
//
//   - status + error captured even on rejected actions. A failed
//     admin attempt is just as forensically interesting as a
//     successful one — possibly more so, if it's the leading edge of
//     a credential-stuffing attack on the admin secret.
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service identifies the writer in the admin_audit_log.service column.
// Gateway is the only writer today; wallet's admin handler can adopt
// this in a follow-up by passing "wallet" instead.
const Service = "gateway"

// Logger wraps a Postgres pool so handlers can `audit.NewLogger(pool).Log(...)`.
// Pool may be nil during local dev / misconfigured deploys — Log degrades
// to a slog.Error without erroring out.
type Logger struct {
	pool *pgxpool.Pool
}

// NewLogger returns a Logger backed by the given pool. A nil pool is
// allowed; Log calls will become slog.Error no-ops, which is the
// behavior we want when DB is unavailable on boot.
func NewLogger(pool *pgxpool.Pool) *Logger {
	return &Logger{pool: pool}
}

// Event captures the fields we record for one admin action.
type Event struct {
	// Action verb. snake_case by convention. e.g. "set_account_routing_mode".
	Action string
	// Subject of the action — UUID, withdrawal id, etc. May be empty.
	Target string
	// State before, JSON-marshallable. nil for actions without a
	// meaningful "before" (e.g. one-shot triggers).
	Before any
	// State after, JSON-marshallable. nil if action failed before
	// any state change.
	After any
	// HTTP status code returned to the caller.
	Status int
	// Error message returned to the caller. Empty on 2xx.
	ErrorMsg string
	// Edge-network IP that originated the request.
	RequestIP string
	// User-Agent string from the request headers.
	UserAgent string
}

// Log inserts the event into admin_audit_log. Errors are logged but
// not returned — the caller is the admin handler, and we don't want
// audit write failures to surface to the caller as 5xx (which would
// be confusing — admin action succeeded, audit didn't).
func (l *Logger) Log(ctx context.Context, e Event) {
	if l == nil || l.pool == nil {
		slog.Error("audit: pool not configured — entry dropped",
			"action", e.Action, "target", e.Target, "status", e.Status)
		return
	}
	beforeJSON, _ := json.Marshal(e.Before)
	afterJSON, _ := json.Marshal(e.After)

	_, err := l.pool.Exec(ctx, `
		INSERT INTO admin_audit_log
			(service, action, target, before_value, after_value, status, error, request_ip, user_agent)
		VALUES
			($1, $2, NULLIF($3, ''), $4::jsonb, $5::jsonb, $6, $7, NULLIF($8, ''), NULLIF($9, ''))`,
		Service,
		e.Action,
		e.Target,
		string(beforeJSON),
		string(afterJSON),
		e.Status,
		e.ErrorMsg,
		e.RequestIP,
		e.UserAgent,
	)
	if err != nil {
		slog.Error("audit: insert failed",
			"err", err,
			"action", e.Action,
			"target", e.Target)
	}
}

// LogFromGin extracts request context (IP, user-agent) from a Gin
// context and writes the event. Reduces boilerplate in handlers.
func (l *Logger) LogFromGin(c *gin.Context, e Event) {
	e.RequestIP = c.ClientIP()
	e.UserAgent = c.GetHeader("User-Agent")
	l.Log(c.Request.Context(), e)
}
