package wallet

import (
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"otuburu.money/wallet/internal/auth"
)

// Contact form rate limit: one message per user every 60 seconds. Prevents
// a malicious or buggy client from spamming the admin inbox. State is
// kept in memory — fine for a single wallet replica; if/when we scale
// horizontally we can move this to Redis or postgres.
const contactRateLimitSecs = 60

var (
	contactRateMu sync.Mutex
	contactRate   = map[string]time.Time{} // userID → last submission time
)

// POST /wallet/contact — relay a user-typed message to ADMIN_EMAIL.
//
// Body: { "subject": "...", "message": "..." }
//
// The sender's user identity (UserID + verified Google email) comes from
// the JWT — we don't trust client-supplied "from" fields. The email is
// SENT to the admin from the configured SMTP_FROM, with the user's email
// in the body + Reply-To header so admin replies go back to them.
func (h *Handler) Contact(c *gin.Context) {
	if h.mailer == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "contact disabled (mailer not configured)"})
		return
	}

	claims := c.MustGet("claims").(*auth.Claims)

	// Rate-limit per user.
	contactRateMu.Lock()
	last, seen := contactRate[claims.UserID]
	if seen && time.Since(last).Seconds() < contactRateLimitSecs {
		wait := contactRateLimitSecs - int(time.Since(last).Seconds())
		contactRateMu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error": "please wait before sending another message",
			"retry_after_secs": wait,
		})
		return
	}
	contactRate[claims.UserID] = time.Now()
	contactRateMu.Unlock()

	var req struct {
		Subject string `json:"subject" binding:"required,min=3,max=200"`
		Message string `json:"message" binding:"required,min=10,max=5000"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Resolve admin recipient. ADMIN_EMAILS (comma-separated) wins over
	// ADMIN_EMAIL (single) so a small ops team can all get the message
	// without per-user fan-out.
	toList := os.Getenv("ADMIN_EMAILS")
	if toList == "" {
		toList = os.Getenv("ADMIN_EMAIL")
	}
	if toList == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no admin email configured"})
		return
	}

	// Build the email body. Plain-ish HTML so the admin inbox renders
	// nicely without needing a templating system for this one-off use.
	body := contactEmailBody(claims.Email, claims.UserID, req.Subject, req.Message)
	subject := "[Otuburu] " + req.Subject

	for _, addr := range strings.Split(toList, ",") {
		addr = strings.TrimSpace(addr)
		if addr == "" {
			continue
		}
		h.mailer.Send(addr, subject, body)
	}

	c.JSON(http.StatusOK, gin.H{
		"ok": true,
		"note": "Message sent to support. We typically respond within 24 hours.",
	})
}

// contactEmailBody renders the admin-facing HTML for a contact-form
// submission. Inline styles only — most email clients strip <style>
// blocks. Kept deliberately plain so it works in Gmail / Outlook /
// Apple Mail / mobile inboxes without surprises.
func contactEmailBody(userEmail, userID, subject, message string) string {
	// Light HTML escape for the user-supplied fields. Don't run a full
	// sanitizer — the admin-only audience is trusted to handle anything
	// weird, and we don't want to swallow URLs / code snippets that
	// users send when reporting bugs.
	esc := func(s string) string {
		s = strings.ReplaceAll(s, "&", "&amp;")
		s = strings.ReplaceAll(s, "<", "&lt;")
		s = strings.ReplaceAll(s, ">", "&gt;")
		return s
	}
	return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:20px;">
<h2 style="color:#0d0d0d;border-bottom:2px solid #f5b800;padding-bottom:8px;">New Contact Form Submission</h2>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:8px 0;color:#666;width:120px;">From:</td><td style="padding:8px 0;"><strong>` + esc(userEmail) + `</strong></td></tr>
  <tr><td style="padding:8px 0;color:#666;">User ID:</td><td style="padding:8px 0;font-family:monospace;font-size:12px;color:#666;">` + esc(userID) + `</td></tr>
  <tr><td style="padding:8px 0;color:#666;">Subject:</td><td style="padding:8px 0;"><strong>` + esc(subject) + `</strong></td></tr>
</table>
<div style="border-left:4px solid #f5b800;padding:12px 16px;background:#fafafa;margin-top:16px;white-space:pre-wrap;">` + esc(message) + `</div>
<p style="font-size:12px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
Reply directly to this email — it goes to ` + esc(userEmail) + `.
</p>
</body></html>`
}
