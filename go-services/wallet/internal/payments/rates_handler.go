package payments

// GET /payments/rates — public read of the live USD↔X rate map.
//
// Response shape:
//
//	{
//	  "as_of": "2026-05-28T17:33:07Z",
//	  "currencies": {
//	    "NGN": { "interbank": 1600.0, "spread_pct": 0.02, "customer": 1632.0 },
//	    "GHS": { ... },
//	    ...
//	  }
//	}
//
// Used by the frontend deposit/withdrawal UIs to render a live preview of
// "you pay X NGN" before the user commits, so they don't get rate-surprised
// on the Paystack page. No auth — these rates are upstream-public anyway.

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type rateEntry struct {
	Interbank float64 `json:"interbank"`
	SpreadPct float64 `json:"spread_pct"`
	Customer  float64 `json:"customer"`
}

// RatesHandler returns a Gin handler closure over the supplied RateMap.
func RatesHandler(rm *RateMap) gin.HandlerFunc {
	return func(c *gin.Context) {
		out := make(map[string]rateEntry, len(supportedCurrencies))
		for _, ccy := range supportedCurrencies {
			mid := rm.USDTo(ccy)
			if mid <= 0 {
				continue
			}
			out[ccy] = rateEntry{
				Interbank: mid,
				SpreadPct: rm.SpreadFor(ccy),
				Customer:  rm.CustomerRate(ccy),
			}
		}
		c.JSON(http.StatusOK, gin.H{
			"as_of":      rm.LastUpdated().UTC().Format(time.RFC3339),
			"currencies": out,
		})
	}
}
