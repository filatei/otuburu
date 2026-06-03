// Package accountkind holds the canonical scaling factor for the three real
// account types — standard, cent, and micro.
//
// Why a separate package: both internal/wallet (transfers) and
// internal/payments (deposit credit) need this lookup. internal/wallet
// already imports internal/payments via the Handler dependency, so the
// only acyclic place to share the helper is a sibling package. Keeping
// it tiny + side-effect-free.
//
// Values:
//
//	real_standard → 1     ($1 USD ↔ $1 account-unit)
//	real_cent     → 100   ($1 USD → 100¢ account-units)
//	real_micro    → 1000  ($1 USD → 1000μ account-units)
//	demo / unknown → 1    (defensive; never write a 0 multiplier)
//
// Anything that crosses the Savings ↔ Account boundary (Paystack/TRC20
// deposits, /wallet/transfers legs) must multiply incoming USD by
// Scale(kind) or divide outgoing units by Scale(kind). Account-to-account
// transfers between different kinds use Scale(dest) / Scale(src).
package accountkind

// Scale returns the multiplier applied when USD enters an account of the
// given kind (or the divisor when funds leave to a USD pool). Always
// strictly positive — unknown kinds fall back to 1 so a misfiled row
// can't silently zero out a credit.
func Scale(kind string) float64 {
	switch kind {
	case "real_cent":
		return 100
	case "real_micro":
		return 1000
	default:
		return 1
	}
}
