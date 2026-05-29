package email

import "fmt"

// Brand-consistent inline-styled templates. Keep them small — every byte
// crosses the SMTP wire and traders mostly read these on phones.

const sharedFooter = `
<hr style="border:0;border-top:1px solid #2a2a2a;margin:24px 0 12px"/>
<p style="color:#666;font-size:11px;text-align:center;margin:0">
  Otuburu &middot; torama.money &middot; This is an automated message.
</p>`

const sharedShell = `<div style="font-family:system-ui,-apple-system,sans-serif;background:#0d0d0d;color:#e0e0e0;padding:24px;border-radius:10px;max-width:520px;margin:auto">
<div style="text-align:center;margin-bottom:16px">
  <span style="font-size:22px;font-weight:900;color:#EAB308;letter-spacing:2px">OTUBURU</span>
</div>
%s
%s
</div>`

// DepositCreditedHTML — user-facing confirmation after a deposit settles.
// channel is either "USDT" or "NGN" — we keep the same shell but tweak the
// network line.
func DepositCreditedHTML(name string, usdAmount float64, channel string, ref string) string {
	netLine := ""
	switch channel {
	case "USDT":
		netLine = `<p style="color:#aaa;font-size:13px;margin:4px 0">Received via <strong style="color:#fff">USDT (TRC20)</strong></p>`
	case "NGN":
		netLine = `<p style="color:#aaa;font-size:13px;margin:4px 0">Received via <strong style="color:#fff">Paystack (NGN)</strong></p>`
	}
	body := fmt.Sprintf(`
<h2 style="color:#22c55e;margin:0 0 4px;font-size:18px">Deposit credited</h2>
<p style="color:#aaa;margin:0 0 16px">Hi %s,</p>
<div style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0 0 6px">Amount</p>
  <p style="font-size:26px;font-weight:700;color:#22c55e;margin:0">$%.2f USD</p>
  %s
  <p style="color:#666;font-size:11px;margin:8px 0 0">Reference: <code style="color:#aaa">%s</code></p>
</div>
<p style="color:#aaa;font-size:13px;margin:0 0 12px">Your account is funded and ready to trade. Open the app to place your first order.</p>
<p style="margin:0 0 0"><a href="https://otuburu.torama.money" style="background:#EAB308;color:#000;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;display:inline-block">Open Otuburu</a></p>`,
		htmlEscape(name), usdAmount, netLine, htmlEscape(ref))
	return fmt.Sprintf(sharedShell, body, sharedFooter)
}

// WithdrawalRequestedHTML — confirmation that a withdrawal request has been
// received and is queued for review.
func WithdrawalRequestedHTML(name string, usdAmount float64, address string, withdrawalID string) string {
	body := fmt.Sprintf(`
<h2 style="color:#EAB308;margin:0 0 4px;font-size:18px">Withdrawal request received</h2>
<p style="color:#aaa;margin:0 0 16px">Hi %s,</p>
<div style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0 0 6px">Amount</p>
  <p style="font-size:26px;font-weight:700;color:#fff;margin:0 0 12px">$%.2f USDT</p>
  <p style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin:0 0 6px">Destination (TRC20)</p>
  <p style="font-family:monospace;font-size:12px;color:#aaa;word-break:break-all;margin:0 0 12px">%s</p>
  <p style="color:#666;font-size:11px;margin:0">Request ID: <code style="color:#aaa">%s</code></p>
</div>
<p style="color:#aaa;font-size:13px;margin:0 0 12px">Your withdrawal is queued for review. Approved withdrawals are sent on-chain within 24 hours. We'll email you when funds leave.</p>`,
		htmlEscape(name), usdAmount, htmlEscape(address), htmlEscape(withdrawalID))
	return fmt.Sprintf(sharedShell, body, sharedFooter)
}

// htmlEscape — minimal escape for the few user-supplied bits we inject
// (name, reference, address). Not a full HTML sanitiser; the inputs come
// from our own DB so the risk is exfiltration on display, not injection.
func htmlEscape(s string) string {
	repl := []struct{ from, to string }{
		{"&", "&amp;"},
		{"<", "&lt;"},
		{">", "&gt;"},
		{"\"", "&quot;"},
		{"'", "&#39;"},
	}
	for _, r := range repl {
		s = stringsReplaceAll(s, r.from, r.to)
	}
	return s
}

// stringsReplaceAll — tiny inline so we don't drag the `strings` import
// into this file. Same behaviour as strings.ReplaceAll.
func stringsReplaceAll(s, old, new string) string {
	if old == "" || s == "" {
		return s
	}
	var b []byte
	i := 0
	for i < len(s) {
		if i+len(old) <= len(s) && s[i:i+len(old)] == old {
			b = append(b, new...)
			i += len(old)
			continue
		}
		b = append(b, s[i])
		i++
	}
	return string(b)
}
