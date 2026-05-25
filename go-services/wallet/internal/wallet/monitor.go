package wallet

// TronGrid deposit monitor — polls TRC20 transfer events for each
// registered deposit address and credits user accounts on confirmation.
//
// After crediting a deposit, the monitor pushes the new Postgres balance
// into the engine book via the gateway's internal balance-sync endpoint
// so the user can trade real funds immediately without a page refresh.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const pollInterval = 30 * time.Second

type Monitor struct {
	db             *pgxpool.Pool
	apiKey         string
	gatewayURL     string // e.g. http://gateway:8082
	internalSecret string
	client         *http.Client
}

func NewMonitor(db *pgxpool.Pool) *Monitor {
	return &Monitor{
		db:             db,
		apiKey:         os.Getenv("TRONGRID_API_KEY"),
		gatewayURL:     os.Getenv("GATEWAY_URL"),
		internalSecret: os.Getenv("INTERNAL_SECRET"),
		client:         &http.Client{Timeout: 10 * time.Second},
	}
}

func (m *Monitor) Run(ctx context.Context) {
	slog.Info("deposit monitor started", "interval", pollInterval)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.scan(ctx)
		}
	}
}

func (m *Monitor) scan(ctx context.Context) {
	// Get all active deposit addresses
	rows, err := m.db.Query(ctx,
		`SELECT da.address, a.id, a.user_id
		 FROM deposit_addresses da
		 JOIN accounts a ON a.user_id = da.user_id AND a.type = 'real'`)
	if err != nil {
		slog.Error("monitor query", "err", err)
		return
	}
	defer rows.Close()

	type entry struct {
		address, accountID, userID string
	}
	var addresses []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.address, &e.accountID, &e.userID); err == nil {
			addresses = append(addresses, e)
		}
	}

	for _, e := range addresses {
		m.checkAddress(ctx, e.address, e.accountID)
	}
}

type trc20Transfer struct {
	TransactionID string `json:"transaction_id"`
	TokenInfo     struct {
		Symbol   string `json:"symbol"`
		Decimals int    `json:"decimals"`
		Address  string `json:"address"`
	} `json:"token_info"`
	From   string `json:"from"`
	To     string `json:"to"`
	Type   string `json:"type"`
	Value  string `json:"value"`
}

func (m *Monitor) checkAddress(ctx context.Context, address, accountID string) {
	url := fmt.Sprintf("%s/v1/accounts/%s/transactions/trc20?contract_address=%s&limit=20&only_to=true",
		TronGridBase, address, USDTContract)

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if m.apiKey != "" {
		req.Header.Set("TRON-PRO-API-KEY", m.apiKey)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		slog.Warn("trongrid fetch", "addr", address, "err", err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result struct {
		Data []trc20Transfer `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return
	}

	for _, t := range result.Data {
		if t.To != address || t.TokenInfo.Symbol != "USDT" {
			continue
		}
		m.credit(ctx, t, accountID)
	}
}

func (m *Monitor) credit(ctx context.Context, t trc20Transfer, accountID string) {
	// Idempotency: skip if already seen
	var exists bool
	m.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM seen_deposits WHERE txid=$1)`, t.TransactionID).Scan(&exists) //nolint:errcheck
	if exists {
		return
	}

	decimals := t.TokenInfo.Decimals
	if decimals == 0 {
		decimals = 6
	}
	rawVal, err := strconv.ParseFloat(t.Value, 64)
	if err != nil {
		return
	}
	amount := rawVal / float64(pow10(decimals))

	if amount < 1 {
		return // ignore dust
	}

	tx, err := m.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Record seen deposit
	_, err = tx.Exec(ctx,
		`INSERT INTO seen_deposits (txid, address, amount, credited) VALUES ($1,$2,$3,true)
		 ON CONFLICT (txid) DO NOTHING`,
		t.TransactionID, t.To, amount,
	)
	if err != nil {
		return
	}

	// Credit account balance
	_, err = tx.Exec(ctx,
		`UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
		amount, accountID,
	)
	if err != nil {
		return
	}

	// Record ledger entry
	_, err = tx.Exec(ctx,
		`INSERT INTO ledger (account_id, type, amount, status, ref, note)
		 VALUES ($1,'deposit',$2,'confirmed',$3,$4)`,
		accountID, amount, t.TransactionID,
		fmt.Sprintf("USDT deposit from %s", t.From),
	)
	if err != nil {
		return
	}

	if err := tx.Commit(ctx); err != nil {
		return
	}

	slog.Info("deposit credited",
		"account", accountID,
		"amount", amount,
		"txid", t.TransactionID,
	)

	// Push the new balance into the engine book so the user can trade immediately.
	// We read the current Postgres balance (post-credit) for accuracy.
	m.syncEngineBalance(ctx, accountID)
}

// syncEngineBalance reads the current Postgres balance for accountID and
// pushes it to the engine via the gateway's internal balance-sync endpoint.
// A failure here is non-fatal — the user's next page load will reconcile.
func (m *Monitor) syncEngineBalance(ctx context.Context, accountID string) {
	if m.gatewayURL == "" || m.internalSecret == "" {
		return // not configured — skip silently
	}

	var balance float64
	if err := m.db.QueryRow(ctx,
		`SELECT balance FROM accounts WHERE id = $1`, accountID,
	).Scan(&balance); err != nil {
		slog.Warn("engine sync: balance query failed", "account", accountID, "err", err)
		return
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"account_id": accountID,
		"balance":    balance,
	})

	url := m.gatewayURL + "/internal/balance-sync"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Secret", m.internalSecret)

	resp, err := m.client.Do(req)
	if err != nil {
		slog.Warn("engine sync: http request failed", "account", accountID, "err", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		slog.Warn("engine sync: unexpected status", "account", accountID, "status", resp.StatusCode, "body", string(body))
		return
	}

	slog.Info("engine balance synced", "account", accountID, "balance", balance)
}

func pow10(n int) int {
	r := 1
	for i := 0; i < n; i++ {
		r *= 10
	}
	return r
}
