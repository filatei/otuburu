// Package payments — live exchange-rate helper.
//
// RateFetcher polls open.er-api.com (free, no API key, hourly cadence)
// and caches the latest USD→NGN mid rate in memory.  It degrades
// gracefully: if the fetch fails the last known good rate is returned;
// if no successful fetch has ever occurred the constructor default is used.
package payments

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	erAPIURL         = "https://open.er-api.com/v6/latest/USD"
	ratePollInterval = time.Hour
	rateHTTPTimeout  = 10 * time.Second
	defaultUSDToNGN  = 1600.0 // fallback if API unreachable on first boot
)

// RateFetcher maintains a live USD→NGN exchange rate.
type RateFetcher struct {
	mu      sync.RWMutex
	current float64
	client  *http.Client
}

// NewRateFetcher creates a RateFetcher with the given seed rate (used until
// the first successful network fetch).  Call Start() to begin background
// refresh.
func NewRateFetcher(seedRate float64) *RateFetcher {
	if seedRate <= 0 {
		seedRate = defaultUSDToNGN
	}
	return &RateFetcher{
		current: seedRate,
		client:  &http.Client{Timeout: rateHTTPTimeout},
	}
}

// Start launches a background goroutine that refreshes the rate hourly.
// It performs one immediate fetch before returning so the first real rate
// is ready quickly.  The goroutine exits when ctx is cancelled.
func (rf *RateFetcher) Start(ctx context.Context) {
	rf.fetch(ctx) // immediate warm-up

	go func() {
		ticker := time.NewTicker(ratePollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				rf.fetch(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

// GetUSDToNGN returns the current USD→NGN rate (thread-safe).
func (rf *RateFetcher) GetUSDToNGN() float64 {
	rf.mu.RLock()
	defer rf.mu.RUnlock()
	return rf.current
}

// fetch performs a single HTTP request and updates the cached rate.
func (rf *RateFetcher) fetch(ctx context.Context) {
	reqCtx, cancel := context.WithTimeout(ctx, rateHTTPTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, erAPIURL, nil)
	if err != nil {
		slog.Warn("rate_fetcher: build request failed", "err", err)
		return
	}
	req.Header.Set("Accept", "application/json")

	resp, err := rf.client.Do(req)
	if err != nil {
		slog.Warn("rate_fetcher: fetch failed", "err", err)
		return
	}
	defer resp.Body.Close()

	var payload struct {
		Result string             `json:"result"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		slog.Warn("rate_fetcher: decode failed", "err", err)
		return
	}
	if payload.Result != "success" {
		slog.Warn("rate_fetcher: API returned non-success", "result", payload.Result)
		return
	}

	ngn, ok := payload.Rates["NGN"]
	if !ok || ngn <= 0 {
		slog.Warn("rate_fetcher: NGN rate missing from response")
		return
	}

	rf.mu.Lock()
	rf.current = ngn
	rf.mu.Unlock()

	slog.Info("rate_fetcher: USD/NGN updated", "rate", ngn)
}
