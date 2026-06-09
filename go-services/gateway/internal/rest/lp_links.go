package rest

// Self-serve broker linking endpoints. Sprint 5.8.
//
// Users link their own Exness MT5 (via MetaApi) or other broker
// credentials so that when their Otuburu account is in passthrough
// routing mode, the engine forwards CFD orders to THEIR broker —
// not the engine-wide one configured at boot via env.
//
// Token encryption uses pgcrypto's pgp_sym_encrypt with the
// LP_LINK_KEY env var. The key never lives in the database.
//
// Routes (all under /api, JWT-authed via auth.Middleware()):
//
//	POST   /api/lp-links       — create / update a link
//	GET    /api/lp-links       — list caller's links (no tokens returned)
//	DELETE /api/lp-links/:id   — remove one link
//
// Future:
//   - Pre-save validation (call adapter.account_summary() to verify
//     the token works before persisting). Held until the engine
//     exposes a /admin/validate-lp-link RPC, since the gateway
//     itself doesn't link against the liquidity-bridge crate.
//   - PATCH for label/region edits without re-pasting the token.
//   - GET /api/lp-links/:id/probe — re-run validation on demand.

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/gateway/internal/auth"
)

// lpLinksDB is wired at boot from cmd/main.go via InitLpLinks. Same
// pool the audit logger uses; gateway only opens one pgxpool.
var lpLinksDB *pgxpool.Pool

// InitLpLinks injects the Postgres pool into this package. Call
// before RegisterRoutes.
func InitLpLinks(pool *pgxpool.Pool) { lpLinksDB = pool }

// lpLinkKey returns the symmetric encryption key from env. Returns
// the empty string if unset — callers must refuse to encrypt/decrypt
// in that case (fail closed). 503 to the user is more honest than
// pretending the link is encrypted when it isn't.
func lpLinkKey() string { return os.Getenv("LP_LINK_KEY") }

// RegisterLpLinksRoutes attaches the user-facing broker-link endpoints
// to the given router group. Call from cmd/main.go after RegisterRoutes,
// inside the same protected group that wraps the rest of /api with
// auth.Middleware() — this file deliberately does NOT re-wrap, so the
// caller must ensure the JWT middleware fired.
func RegisterLpLinksRoutes(rg *gin.RouterGroup) {
	rg.POST("/lp-links", handleLpLinkCreate)
	rg.GET("/lp-links", handleLpLinkList)
	rg.DELETE("/lp-links/:id", handleLpLinkDelete)
}

type lpLinkCreateReq struct {
	Kind      string `json:"kind"       binding:"required,oneof=metaapi ctrader oanda"`
	AccountID string `json:"account_id" binding:"required"`
	Token     string `json:"token"      binding:"required"`
	Region    string `json:"region"`
	Label     string `json:"label"`
}

type lpLinkResp struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	AccountID  string  `json:"account_id"`
	Region     *string `json:"region,omitempty"`
	Label      string  `json:"label"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at,omitempty"`
	// Token NEVER returned to clients — we don't want it in browser
	// memory or copy-paste-ready in the network tab. The user already
	// has it (they just submitted it); the API surface is write-only
	// for tokens.
}

// handleLpLinkCreate inserts or updates a broker link for the caller.
// ON CONFLICT (user_id, kind, account_id) → DO UPDATE so re-paste of
// a fresh token rotates without first deleting.
func handleLpLinkCreate(c *gin.Context) {
	if lpLinksDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "broker linking unavailable — db not configured",
		})
		return
	}
	key := lpLinkKey()
	if key == "" {
		// Fail closed. If LP_LINK_KEY isn't set, encryption would be
		// a no-op and tokens would land in DB cleartext — worse than
		// the user being unable to link.
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "broker linking unavailable — encryption key not configured",
		})
		return
	}

	claims := auth.GetClaims(c)
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req lpLinkCreateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Label == "" {
		req.Label = "My broker"
	}
	// Normalize whitespace — paste artifacts are common with long
	// tokens copied from MetaApi UI.
	req.Token = strings.TrimSpace(req.Token)

	var (
		id        string
		createdAt string
	)
	err := lpLinksDB.QueryRow(c.Request.Context(), `
		INSERT INTO user_lp_links (user_id, kind, account_id, region, token_enc, label)
		VALUES ($1, $2, $3, NULLIF($4, ''), pgp_sym_encrypt($5, $6), $7)
		ON CONFLICT (user_id, kind, account_id) DO UPDATE
		  SET token_enc = pgp_sym_encrypt($5, $6),
		      region    = NULLIF($4, ''),
		      label     = $7
		RETURNING id, created_at::text`,
		claims.UserID, req.Kind, req.AccountID, req.Region, req.Token, key, req.Label,
	).Scan(&id, &createdAt)
	if err != nil {
		slog.Error("lp_links: insert", "err", err, "user_id", claims.UserID, "kind", req.Kind)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save broker link"})
		return
	}

	region := req.Region
	resp := lpLinkResp{
		ID:        id,
		Kind:      req.Kind,
		AccountID: req.AccountID,
		Region:    nullable(&region),
		Label:     req.Label,
		CreatedAt: createdAt,
	}
	c.JSON(http.StatusOK, resp)
}

// handleLpLinkList returns all broker links for the caller, WITHOUT
// the tokens. Tokens are write-only from the gateway's perspective.
func handleLpLinkList(c *gin.Context) {
	if lpLinksDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "db not configured"})
		return
	}
	claims := auth.GetClaims(c)
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	rows, err := lpLinksDB.Query(c.Request.Context(), `
		SELECT id::text, kind, account_id, region, label,
		       created_at::text, last_used_at::text
		FROM user_lp_links
		WHERE user_id = $1
		ORDER BY created_at DESC`,
		claims.UserID,
	)
	if err != nil {
		slog.Error("lp_links: list", "err", err, "user_id", claims.UserID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list broker links"})
		return
	}
	defer rows.Close()

	out := make([]lpLinkResp, 0)
	for rows.Next() {
		var r lpLinkResp
		var region, lastUsed *string
		if err := rows.Scan(&r.ID, &r.Kind, &r.AccountID, &region, &r.Label, &r.CreatedAt, &lastUsed); err != nil {
			slog.Error("lp_links: scan", "err", err)
			continue
		}
		r.Region = region
		r.LastUsedAt = lastUsed
		out = append(out, r)
	}
	c.JSON(http.StatusOK, gin.H{"links": out})
}

// handleLpLinkDelete removes one of the caller's broker links. The
// WHERE user_id = clause prevents one user from deleting another's
// link by guessing the id (UUIDs are hard to guess but defence in
// depth).
func handleLpLinkDelete(c *gin.Context) {
	if lpLinksDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "db not configured"})
		return
	}
	claims := auth.GetClaims(c)
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	linkID := c.Param("id")

	tag, err := lpLinksDB.Exec(c.Request.Context(),
		`DELETE FROM user_lp_links WHERE id = $1 AND user_id = $2`,
		linkID, claims.UserID,
	)
	if err != nil {
		slog.Error("lp_links: delete", "err", err, "user_id", claims.UserID, "link_id", linkID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete broker link"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "broker link not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// nullable converts an empty-string pointer to a nil pointer for
// JSON omitempty semantics. Used so the response JSON doesn't carry
// "region": "" — either the field is present with a real value or
// it's absent entirely.
func nullable(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}
