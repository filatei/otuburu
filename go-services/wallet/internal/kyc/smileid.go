// Package kyc wraps Smile Identity's Enhanced KYC API for Nigerian
// NIN / BVN / passport / driver's license verification.
//
// Stub mode: when SMILE_PARTNER_ID or SMILE_API_KEY is unset, the client
// returns a deterministic "approved" verdict locally with a log warning.
// This lets us ship the full upstream pipeline (DB rows, status state
// machine, frontend UI) before the Smile Identity account is approved,
// and unblocks local dev / CI without keys.
//
// Live mode: when both env vars are present, the client makes a real
// POST to Smile Identity's KYC verification endpoint. Sandbox uses
// testapi.smileidentity.com; production uses api.smileidentity.com —
// switched via SMILE_ENV (defaults to sandbox).
//
// Auth: HMAC-SHA256 signature, NOT plain api_key. Recipe is
//   signature = base64(HMAC-SHA256(api_key, timestamp + partner_id + "sid_request"))
// Send {partner_id, signature, timestamp} in the request body. The
// older `api_key` shape returns `{"code":"2413","error":"authorization
// is required"}` — sandbox accepts the request shape but the actual
// lookup auths against the signature.
//
// References
//   - Enhanced KYC docs: https://docs.smileidentity.com/products/enhanced-kyc
//   - Synchronous endpoint: /v1/identity_verification
package kyc

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
)

// Provider abstracts the upstream verification call. Real impl talks
// to Smile Identity; stub impl returns deterministic verdicts for dev.
type Provider interface {
	// Verify submits a KYC check. Returns the upstream verdict + raw
	// response bytes (stored for audit). Network errors bubble up;
	// a `rejected` verdict comes back as a non-error result with
	// approved=false so the caller can persist the rejection reason.
	Verify(ctx context.Context, req VerifyRequest) (*VerifyResult, error)
	// IsStub reports whether this provider is the dev-mode stub. Used
	// by the handler to decide whether to default sanctions screening
	// to 'clear' (stub) vs 'pending' (live — pending manual review).
	IsStub() bool
	// Env returns the upstream environment label — "stub", "sandbox",
	// or "production". Used by the frontend to gate the "Fill sandbox
	// test data" autofill affordance (only meaningful in sandbox /
	// stub modes where deterministic test IDs work).
	Env() string
}

// VerifyRequest mirrors the input shape we ask of every provider.
// Stays small + composable so we can swap to a different vendor later
// without touching call sites.
type VerifyRequest struct {
	// Document type — translates to Smile Identity's `id_type` slug
	// (NIN_V2, BVN, PASSPORT, DRIVERS_LICENSE, VOTER_ID).
	IDType    string
	IDNumber  string
	FirstName string
	LastName  string
	// ISO date YYYY-MM-DD.
	DOB string
	// Stable user id we'll thread into the upstream job_id so async
	// callbacks can be matched back to the right user.
	UserID string
}

type VerifyResult struct {
	Approved        bool
	JobID           string
	RejectionReason string
	// Full upstream JSON, persisted in kyc_submissions.sid_response
	// for audit. Useful for compliance reviews + dispute handling.
	RawResponse json.RawMessage
}

// NewProvider picks the live or stub impl based on env presence. Logs
// once at boot which mode we're in so it's obvious from the container
// startup log.
func NewProvider() Provider {
	partner := os.Getenv("SMILE_PARTNER_ID")
	apiKey := os.Getenv("SMILE_API_KEY")
	if partner == "" || apiKey == "" {
		slog.Warn("kyc: Smile Identity env not set — using STUB provider (all verifications auto-approve)")
		return &stubProvider{}
	}
	env := os.Getenv("SMILE_ENV")
	if env == "" {
		env = "sandbox"
	}
	base := "https://testapi.smileidentity.com/v1"
	if env == "production" {
		base = "https://api.smileidentity.com/v1"
	}
	slog.Info("kyc: Smile Identity provider ready", "env", env, "partner_id", partner)
	return &smileProvider{
		partnerID: partner,
		apiKey:    apiKey,
		baseURL:   base,
		env:       env,
		client:    &http.Client{Timeout: 15 * time.Second},
	}
}

// ── Live provider ───────────────────────────────────────────────────────────

type smileProvider struct {
	partnerID string
	apiKey    string
	baseURL   string
	env       string
	client    *http.Client
}

func (*smileProvider) IsStub() bool   { return false }
func (p *smileProvider) Env() string  { return p.env }

// idTypeToSlug maps our internal id types to Smile Identity's request slugs.
// They use NIN_V2 for the V2 lookup (which covers BVN + NIN cross-check)
// and shorter codes for the other documents.
var idTypeToSlug = map[string]string{
	"NIN":             "NIN_V2",
	"BVN":             "BVN",
	"PASSPORT":        "PASSPORT",
	"DRIVERS_LICENSE": "DRIVERS_LICENSE",
	"VOTERS_CARD":     "VOTER_ID",
}

func (p *smileProvider) Verify(ctx context.Context, req VerifyRequest) (*VerifyResult, error) {
	slug, ok := idTypeToSlug[req.IDType]
	if !ok {
		return nil, fmt.Errorf("unsupported id_type %q", req.IDType)
	}

	// Smile Identity uses HMAC-SHA256 signature auth, not plain api_key.
	// Recipe:
	//   1. timestamp in ISO8601 (their server allows ±5 min skew)
	//   2. signature = base64(HMAC-SHA256(api_key, timestamp + partner_id + "sid_request"))
	//   3. send {partner_id, signature, timestamp} in body instead of api_key
	//
	// Without this we got `{"code":"2413","error":"authorization is required"}`
	// which my parser then defaulted to a `rejected` verdict. The empty
	// rejection_reason in our v1 submissions was the giveaway.
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	mac := hmac.New(sha256.New, []byte(p.apiKey))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(p.partnerID))
	mac.Write([]byte("sid_request"))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	jobID := fmt.Sprintf("otuburu-%s-%d", req.UserID, time.Now().Unix())
	body := map[string]any{
		"partner_id": p.partnerID,
		"signature":  signature,
		"timestamp":  timestamp,
		"partner_params": map[string]any{
			"user_id":  req.UserID,
			"job_id":   jobID,
			"job_type": 5,
		},
		"country":    "NG",
		"id_type":    slug,
		"id_number":  req.IDNumber,
		"first_name": req.FirstName,
		"last_name":  req.LastName,
		"dob":        req.DOB,
	}
	payload, _ := json.Marshal(body)

	// Synchronous Enhanced KYC endpoint — returns the verdict in the
	// HTTP response body, no callback needed. The /async_id_verification
	// sibling is for fully async flows with webhooks; we don't need that.
	// Note the path is `/id_verification` (NOT `/identity_verification` —
	// the latter hits AWS API Gateway's 404 which returns the misleading
	// 'Missing Authentication Token' message).
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL+"/id_verification", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 500 {
		return nil, fmt.Errorf("smileid %d: %s", resp.StatusCode, string(raw))
	}

	// Successful Smile Identity response:
	//   {"ResultCode":"1012","ResultText":"Verified","FullName":"…", ...}
	// Auth/validation failure:
	//   {"code":"2413","error":"authorization is required","success":false}
	// We extract a verdict + best-effort reason from either shape so admin
	// reviews always have a message to look at.
	var parsed struct {
		ResultCode string `json:"ResultCode"`
		ResultText string `json:"ResultText"`
		Code       string `json:"code"`  // error path
		Error      string `json:"error"` // error path
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("smileid bad json: %w", err)
	}
	approved := parsed.ResultCode == "1012"
	reason := parsed.ResultText
	if !approved && reason == "" && parsed.Error != "" {
		// Surface the upstream auth/format error as the rejection reason
		// so it lands in kyc_submissions.rejection_reason instead of
		// being silently empty.
		reason = fmt.Sprintf("smileid %s: %s", parsed.Code, parsed.Error)
	}
	return &VerifyResult{
		Approved:        approved,
		JobID:           jobID,
		RejectionReason: reason,
		RawResponse:     raw,
	}, nil
}

// ── Stub provider (dev mode) ────────────────────────────────────────────────

type stubProvider struct{}

func (*stubProvider) IsStub() bool  { return true }
func (*stubProvider) Env() string   { return "stub" }

// Verify returns approved=true for any non-empty input, simulating the
// happy path. The raw response includes a clear "stub" marker so admin
// reviewers can tell test data apart from real verifications.
func (*stubProvider) Verify(_ context.Context, req VerifyRequest) (*VerifyResult, error) {
	if req.IDNumber == "" || req.FirstName == "" || req.LastName == "" {
		return nil, errors.New("stub: id_number / name required")
	}
	raw, _ := json.Marshal(map[string]any{
		"_stub":      true,
		"ResultCode": "1012",
		"ResultText": "Stubbed verification — Smile Identity env not configured",
		"user_id":    req.UserID,
		"timestamp":  time.Now().Format(time.RFC3339),
	})
	return &VerifyResult{
		Approved:    true,
		JobID:       fmt.Sprintf("stub-%s-%d", req.UserID, time.Now().Unix()),
		RawResponse: raw,
	}, nil
}
