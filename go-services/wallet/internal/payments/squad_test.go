package payments

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Note: the `sign(secret, body)` helper (lowercase-hex HMAC-SHA512) is defined
// in monnify_test.go and shared across the package's tests. Squad's verifySig
// is case-insensitive, so a lowercase signature is accepted too.

const squadSecret = "test-squad-secret-0123456789"

func TestSquadVerifySig(t *testing.T) {
	h := &SquadHandler{secretKey: squadSecret}
	body := []byte(`{"Event":"charge_successful","Body":{"transaction_ref":"otu-1","transaction_status":"success","amount":500000}}`)

	if !h.verifySig(body, sign(squadSecret, string(body))) {
		t.Error("valid (lowercase) signature should verify")
	}
	if !h.verifySig(body, strings.ToUpper(sign(squadSecret, string(body)))) {
		t.Error("valid uppercase signature should verify")
	}
	if h.verifySig(body, sign("wrong-secret", string(body))) {
		t.Error("signature from the wrong secret must not verify")
	}
	if h.verifySig(body, "") {
		t.Error("empty signature must not verify")
	}
	if h.verifySig([]byte(`{"Body":{"amount":999}}`), sign(squadSecret, string(body))) {
		t.Error("tampered body must not verify")
	}
}

func TestSquadWebhook_HTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := &SquadHandler{secretKey: squadSecret}
	r := gin.New()
	h.RegisterRoutes(r.Group("/"))

	body := `{"Event":"charge_successful","Body":{"transaction_ref":"otu-2","transaction_status":"success","amount":500000,"email":"a@b.com"}}`

	// Valid signature → 200.
	req := httptest.NewRequest("POST", "/payments/squad/webhook", strings.NewReader(body))
	req.Header.Set("x-squad-encrypted-body", sign(squadSecret, body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("valid webhook: status = %d, want 200", w.Code)
	}

	// Bad signature → 401.
	req2 := httptest.NewRequest("POST", "/payments/squad/webhook", strings.NewReader(body))
	req2.Header.Set("x-squad-encrypted-body", sign("nope", body))
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusUnauthorized {
		t.Errorf("bad-signature webhook: status = %d, want 401", w2.Code)
	}
}

// A nil handler (SQUAD_SECRET_KEY unset) must register nothing and not panic.
func TestSquadNilHandlerSafe(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var h *SquadHandler // nil
	r := gin.New()
	h.RegisterRoutes(r.Group("/")) // must be a no-op, no panic
}
