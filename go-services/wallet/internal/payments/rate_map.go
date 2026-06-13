// Package payments — multi-currency rate map.
//
// Phase 3 extends the original single-currency RateFetcher (NGN-only) into a
// general USD↔X rate map covering the African corridors we plan to support:
// NGN, GHS, KES, ZAR, UGX. Each currency carries its own retail FX spread —
// emerging-market liquidity differential is real and one-size-fits-all
// pricing leaves margin on the table for stable rails like ZAR and overcharges
// on stable ones.
//
// Robustness via two sources:
//
//	exchangerate.host  (free, no key, broad coverage)
//	open.er-api.com    (already in use, hourly refresh)
//
// We take the median of available sources per currency. If only one source
// returns a usable value we use it; if neither does we keep the last cached
// rate so brief network blips don't break checkout.
//
// Existing RateFetcher (rate_fetcher.go) is kept for back-compat — wraps
// this map for the NGN-only callers that haven't migrated yet.
package payments

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"
)

// SupportedCurrency is one of the local fiat rails we want USD↔X for.
// Add new currencies by appending here AND extending currencySpreads
// below — the rest of the wiring is generic.
const (
	CcyNGN = "NGN" // Nigeria  — Naira
	CcyGHS = "GHS" // Ghana    — Cedi
	CcyKES = "KES" // Kenya    — Shilling
	CcyZAR = "ZAR" // S. Africa — Rand
	CcyUGX = "UGX" // Uganda   — Shilling
)

// supportedCurrencies — single source of truth for what we fetch.
var supportedCurrencies = []string{CcyNGN, CcyGHS, CcyKES, CcyZAR, CcyUGX}

// currencySpreads — retail FX spread per currency, applied on top of the
// interbank mid we compute. NGN, KES, UGX have higher spreads because their
// real-world parallel/interbank gap is wider; ZAR is the most liquid African
// currency so tightest. Tune as we learn from settlement P&L.
var currencySpreads = map[string]float64{
	CcyNGN: 0.020, // 2.0% — wide parallel-market gap
	CcyGHS: 0.020, // 2.0% — emerging tier
	CcyKES: 0.025, // 2.5% — wider PSP haircut
	CcyZAR: 0.015, // 1.5% — most liquid, smallest spread
	CcyUGX: 0.030, // 3.0% — least liquid
}

// RateMap keeps live USD→X rates for every supported currency, refreshing
// hourly from two sources in parallel. Concurrent-safe.
type RateMap struct {
	mu      sync.RWMutex
	rates   map[string]float64 // USD → ccy (interbank mid)
	updated time.Time
	client  *http.Client
}

// NewRateMap builds a RateMap with sane seed values (defensive defaults so
// the wallet boots before the first network fetch completes). Call Start to
// begin background refresh.
func NewRateMap() *RateMap {
	return &RateMap{
		rates: map[string]float64{
			CcyNGN: 1600, // seed; will be overwritten on first fetch
			CcyGHS: 14.0,
			CcyKES: 130.0,
			CcyZAR: 18.5,
			CcyUGX: 3700,
		},
		client: &http.Client{Timeout: rateHTTPTimeout},
	}
}

// Start launches a background goroutine that refreshes hourly. Performs an
// immediate warm-up fetch so the first real rate is ready quickly.
func (rm *RateMap) Start(ctx context.Context) {
	rm.fetch(ctx)
	go func() {
		t := time.NewTicker(ratePollInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				rm.fetch(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

// USDTo returns the interbank mid for USD→ccy. Returns 0 if the currency
// isn't supported (caller should treat as "unknown").
func (rm *RateMap) USDTo(ccy string) float64 {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.rates[ccy]
}

// CustomerRate returns the rate the customer is actually charged at: the
// interbank mid plus our per-currency spread. e.g. for NGN at interbank
// 1600 with 2% spread → 1632 NGN per 1 USD. Returns 0 for unsupported ccy.
func (rm *RateMap) CustomerRate(ccy string) float64 {
	mid := rm.USDTo(ccy)
	if mid <= 0 {
		return 0
	}
	return mid * (1 + currencySpreads[ccy])
}

// SpreadFor returns the spread fraction for a currency (0.02 = 2%). Useful
// for emitting the spread alongside customer rate in API responses.
func (rm *RateMap) SpreadFor(ccy string) float64 { return currencySpreads[ccy] }

// LastUpdated reports when the last successful fetch landed (zero value if
// no successful fetch has occurred yet).
func (rm *RateMap) LastUpdated() time.Time {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.updated
}

// fetch pulls fresh rates from both sources, takes the median per currency,
// and updates the map. Errors are logged but never fatal — last good value
// is preserved on failure.
func (rm *RateMap) fetch(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, rateHTTPTimeout*2)
	defer cancel()

	type src func(ctx context.Context, client *http.Client) (map[string]float64, error)
	sources := []src{rm.fetchExchangerateHost, rm.fetchOpenERAPI}

	collected := make([]map[string]float64, 0, len(sources))
	for _, s := range sources {
		if m, err := s(ctx, rm.client); err == nil && len(m) > 0 {
			collected = append(collected, m)
		} else if err != nil {
			slog.Warn("rate_map: source failed", "err", err)
		}
	}
	if len(collected) == 0 {
		slog.Warn("rate_map: every source failed — keeping cached rates")
		return
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()
	for _, ccy := range supportedCurrencies {
		var samples []float64
		for _, m := range collected {
			if v, ok := m[ccy]; ok && v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) {
				samples = append(samples, v)
			}
		}
		if len(samples) == 0 {
			continue
		}
		// Median is robust to a single outlier from a wonky source. For
		// two samples median == mean which is the simple case.
		sort.Float64s(samples)
		mid := samples[len(samples)/2]
		if len(samples)%2 == 0 {
			mid = (samples[len(samples)/2-1] + samples[len(samples)/2]) / 2
		}
		rm.rates[ccy] = mid
	}
	rm.updated = time.Now()
	slog.Info("rate_map: refreshed", "sources", len(collected), "rates", rm.rates)
}

// fetchExchangerateHost — free, no API key, supports every African currency.
func (rm *RateMap) fetchExchangerateHost(ctx context.Context, client *http.Client) (map[string]float64, error) {
	url := "https://api.exchangerate.host/latest?base=USD&symbols=" + commaJoin(supportedCurrencies)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var payload struct {
		Rates map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Rates, nil
}

// fetchOpenERAPI — same provider the legacy RateFetcher used. Kept as our
// second source for the median.
func (rm *RateMap) fetchOpenERAPI(ctx context.Context, client *http.Client) (map[string]float64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, erAPIURL, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var payload struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if payload.Result != "success" {
		return nil, nil
	}
	// Filter down to currencies we care about.
	out := make(map[string]float64, len(supportedCurrencies))
	for _, ccy := range supportedCurrencies {
		if v, ok := payload.Rates[ccy]; ok && v > 0 {
			out[ccy] = v
		}
	}
	return out, nil
}

// commaJoin — tiny helper so we don't pull in strings.Join for a single use.
func commaJoin(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}
