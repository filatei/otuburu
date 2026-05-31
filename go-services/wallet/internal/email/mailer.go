// Package email — transactional notifications for the wallet service.
//
// Uses Go stdlib net/smtp against the same Google Workspace relay the
// staking service already uses (smtp-relay.gmail.com:587). Authentication
// is IP-based when SMTP_USER/SMTP_PASS are empty — the Linode server IP is
// allow-listed in Google Admin's relay rules — or credentials-based when
// they are set.
//
// Templates are tiny HTML strings inline. We don't pull in a templating
// library; the messages are short, the placeholder set is small, and
// keeping them here means deploys can't break on missing template files.
package email

import (
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/smtp"
	"os"
	"strconv"
	"strings"
)

// Mailer dispatches transactional emails. Cheap to construct; the actual
// SMTP connection is per-Send (the relay's connection-pool tolerates this
// at our volume). Concurrent-safe — Send dispatches a goroutine per call.
type Mailer struct {
	host string
	port int
	user string
	pass string
	from string
}

// New builds a Mailer from environment variables. Returns nil when
// configuration is incomplete — callers should check and degrade silently
// (no-op send) rather than crash, because email is best-effort.
//
// Required: SMTP_HOST (defaults to smtp-relay.gmail.com), SMTP_FROM.
// Optional: SMTP_USER + SMTP_PASS (credential auth) — when both empty,
// we fall back to IP-relay auth.
func New() *Mailer {
	host := envOr("SMTP_HOST", "smtp-relay.gmail.com")
	port, _ := strconv.Atoi(envOr("SMTP_PORT", "587"))
	from := envOr("SMTP_FROM", "Otuburu <noreply@torama.money>")
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	if host == "" || from == "" {
		slog.Warn("mailer: SMTP_HOST or SMTP_FROM missing — emails disabled")
		return nil
	}
	m := &Mailer{host: host, port: port, user: user, pass: pass, from: from}
	slog.Info("mailer ready",
		"host", host, "port", port,
		"auth", boolStr(user != "" && pass != "", "credentials", "ip-relay"))
	return m
}

// Send dispatches one email. Errors are logged but not propagated — the
// caller should not block its own transaction (deposit credit, withdrawal
// request) on email success.
func (m *Mailer) Send(to, subject, html string) {
	if m == nil { // disabled
		return
	}
	go m.sendBlocking(to, subject, html)
}

func (m *Mailer) sendBlocking(to, subject, html string) {
	addr := fmt.Sprintf("%s:%d", m.host, m.port)

	headers := map[string]string{
		"From":         m.from,
		"To":           to,
		"Subject":      subject,
		"MIME-Version": "1.0",
		"Content-Type": "text/html; charset=UTF-8",
	}
	var msg strings.Builder
	for k, v := range headers {
		msg.WriteString(k)
		msg.WriteString(": ")
		msg.WriteString(v)
		msg.WriteString("\r\n")
	}
	msg.WriteString("\r\n")
	msg.WriteString(html)

	var auth smtp.Auth
	if m.user != "" && m.pass != "" {
		auth = smtp.PlainAuth("", m.user, m.pass, m.host)
	}

	// Manual SMTP dance so STARTTLS happens even when auth is nil.
	//
	// stdlib smtp.SendMail only initiates STARTTLS when auth != nil — a
	// historical quirk. Gmail's SMTP relay on port 587 REQUIRES STARTTLS
	// before accepting any payload; without it, the server closes the
	// connection after EHLO and the client sees `EOF`. In IP-relay mode
	// (auth=nil, since SMTP_PASS is empty), stdlib SendMail would never
	// upgrade, every send would fail silently, and the user-visible
	// 'contact us' / deposit-credited / withdrawal-status emails would
	// quietly never arrive.
	if err := m.sendSMTP(addr, auth, fromAddrOnly(m.from), to, []byte(msg.String())); err != nil {
		slog.Warn("mailer: send failed",
			"to", to, "subject", subject, "err", err)
		return
	}
	slog.Info("mailer: sent", "to", to, "subject", subject)
}

// sendSMTP replaces stdlib smtp.SendMail with one that explicitly does
// STARTTLS even when auth is nil. Otherwise identical to the stdlib path
// (EHLO → optional STARTTLS → optional AUTH → MAIL FROM → RCPT TO →
// DATA → QUIT).
func (m *Mailer) sendSMTP(addr string, auth smtp.Auth, from, to string, msg []byte) error {
	client, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer client.Close()

	// EHLO before checking extensions. smtp.Dial does an initial EHLO
	// already; Hello() here re-runs it with our own hostname for cleaner
	// server-side logs, but it's optional.
	if err := client.Hello("otuburu-wallet"); err != nil {
		return fmt.Errorf("hello: %w", err)
	}

	// Upgrade to TLS when the server advertises STARTTLS. For
	// smtp-relay.gmail.com:587 this is mandatory; the connection
	// is closed silently if we skip it.
	if ok, _ := client.Extension("STARTTLS"); ok {
		cfg := &tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12}
		if err := client.StartTLS(cfg); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}

	if auth != nil {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("auth: %w", err)
			}
		}
	}

	if err := client.Mail(from); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("rcpt to: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close body: %w", err)
	}
	return client.Quit()
}

// fromAddrOnly extracts the angle-bracketed address from a From header
// like `Otuburu <noreply@torama.money>` so smtp.SendMail (which expects a
// bare RFC 5321 mailbox) is happy.
func fromAddrOnly(from string) string {
	if i := strings.LastIndex(from, "<"); i >= 0 {
		if j := strings.Index(from[i:], ">"); j > 0 {
			return from[i+1 : i+j]
		}
	}
	return from
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func boolStr(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

