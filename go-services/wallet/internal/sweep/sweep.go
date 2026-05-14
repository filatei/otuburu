package sweep

// Sweeper moves USDT from individual user deposit addresses to the house treasury
// after each deposit is confirmed.
//
// Flow per deposit:
//  1. Check TRX balance of deposit address (needed for energy/bandwidth fees).
//  2. If TRX < minTRX, fund from treasury first and wait one block.
//  3. Build + sign TRC20 transfer of full USDT balance → treasury.
//  4. Broadcast. Mark swept_at + sweep_txid in seen_deposits.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"otuburu.money/wallet/internal/wallet"
)

const (
	pollInterval = 60 * time.Second
	minTRXSun    = int64(10_000_000)  // 10 TRX minimum before sweep
	fundTRXSun   = int64(15_000_000)  // 15 TRX to send if below minimum
	feeLimitSun  = int64(100_000_000) // 100 TRX energy budget for TRC20 call
)

// Sweeper watches for unswept deposits and moves them to treasury.
type Sweeper struct {
	db          *pgxpool.Pool
	hd          *wallet.HDWallet
	apiKey      string
	treasury    string // base58 Tron address
	treasuryHex string // hex (41...) for TronGrid API calls
	client      *http.Client
	trigger     chan struct{}
}

// New creates a Sweeper and derives the treasury address.
func New(db *pgxpool.Pool, hd *wallet.HDWallet) (*Sweeper, error) {
	treasury, err := hd.TreasuryAddress()
	if err != nil {
		return nil, fmt.Errorf("treasury address: %w", err)
	}
	treasuryHex, err := wallet.TronBase58ToHex(treasury)
	if err != nil {
		return nil, fmt.Errorf("treasury hex: %w", err)
	}
	slog.Info("treasury address", "addr", treasury)

	return &Sweeper{
		db:          db,
		hd:          hd,
		apiKey:      os.Getenv("TRONGRID_API_KEY"),
		treasury:    treasury,
		treasuryHex: treasuryHex,
		client:      &http.Client{Timeout: 30 * time.Second},
		trigger:     make(chan struct{}, 1),
	}, nil
}

// TreasuryAddress returns the house treasury Tron address.
func (s *Sweeper) TreasuryAddress() string { return s.treasury }

// TriggerSweep requests an immediate sweep outside the normal polling cycle.
func (s *Sweeper) TriggerSweep(ctx context.Context) {
	select {
	case s.trigger <- struct{}{}:
	default: // already triggered
	}
}

// Run starts the background sweep loop.
func (s *Sweeper) Run(ctx context.Context) {
	slog.Info("sweeper started", "treasury", s.treasury, "interval", pollInterval)
	time.Sleep(15 * time.Second) // let monitor start first

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.processUnswept(ctx)
		case <-s.trigger:
			s.processUnswept(ctx)
		}
	}
}

// processUnswept fetches all unswept deposits and sweeps each one.
func (s *Sweeper) processUnswept(ctx context.Context) {
	type pendingSweep struct {
		txid    string
		address string
		amount  float64
		hdIndex int
	}

	rows, err := s.db.Query(ctx, `
		SELECT sd.txid, sd.address, sd.amount, da.hd_index
		FROM   seen_deposits sd
		JOIN   deposit_addresses da ON da.address = sd.address
		WHERE  sd.swept_at IS NULL
		  AND  sd.credited = true
		ORDER  BY sd.created_at ASC
		LIMIT  20
	`)
	if err != nil {
		slog.Error("sweep query", "err", err)
		return
	}
	defer rows.Close()

	var pending []pendingSweep
	for rows.Next() {
		var p pendingSweep
		if err := rows.Scan(&p.txid, &p.address, &p.amount, &p.hdIndex); err == nil {
			pending = append(pending, p)
		}
	}

	for _, p := range pending {
		if err := s.sweepDeposit(ctx, p.txid, p.address, p.hdIndex); err != nil {
			slog.Error("sweep failed", "txid", p.txid, "addr", p.address, "err", err)
			s.db.Exec(ctx, //nolint:errcheck
				`UPDATE seen_deposits SET sweep_err = $1 WHERE txid = $2`,
				err.Error(), p.txid,
			)
		}
	}
}

// sweepDeposit moves USDT from a single deposit address to the treasury.
func (s *Sweeper) sweepDeposit(ctx context.Context, depositTxid, address string, hdIndex int) error {
	slog.Info("sweeping deposit", "txid", depositTxid, "addr", address)

	addrHex, err := wallet.TronBase58ToHex(address)
	if err != nil {
		return fmt.Errorf("addr to hex: %w", err)
	}

	privKeyBytes, err := s.hd.PrivateKeyAt(uint32(hdIndex))
	if err != nil {
		return fmt.Errorf("derive private key: %w", err)
	}

	// 1. Check live on-chain balances
	usdtBalance, trxSun, err := s.getBalances(address)
	if err != nil {
		return fmt.Errorf("get balances: %w", err)
	}
	if usdtBalance <= 0 {
		slog.Warn("deposit address already empty on-chain", "addr", address)
		return s.markSwept(ctx, depositTxid, "already-empty")
	}

	// 2. Fund TRX if needed for energy fees
	if trxSun < minTRXSun {
		slog.Info("funding deposit address with TRX for fees", "addr", address, "have_sun", trxSun)
		fundTxid, err := s.sendTRX(addrHex, fundTRXSun)
		if err != nil {
			return fmt.Errorf("fund TRX: %w", err)
		}
		slog.Info("TRX funding tx", "txid", fundTxid)
		time.Sleep(6 * time.Second) // wait ~2 blocks
	}

	// 3. Sweep USDT to treasury
	amountSun := wallet.USDTToSun(usdtBalance)
	sweepTxid, err := s.sweepUSDT(addrHex, privKeyBytes, amountSun)
	if err != nil {
		return fmt.Errorf("sweep USDT: %w", err)
	}
	slog.Info("sweep complete", "sweep_txid", sweepTxid, "amount_usdt", usdtBalance)

	return s.markSwept(ctx, depositTxid, sweepTxid)
}

// ── TronGrid helpers ──────────────────────────────────────────────────────────

// getBalances returns the live USDT float balance and TRX sun balance at a Tron address.
func (s *Sweeper) getBalances(addr string) (usdtFloat float64, trxSun int64, err error) {
	url := fmt.Sprintf("%s/v1/accounts/%s", wallet.TronGridBase, addr)
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if s.apiKey != "" {
		req.Header.Set("TRON-PRO-API-KEY", s.apiKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	var info struct {
		Data []struct {
			Balance int64               `json:"balance"`
			TRC20   []map[string]string `json:"trc20"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || len(info.Data) == 0 {
		return 0, 0, nil
	}
	acct := info.Data[0]
	trxSun = acct.Balance

	for _, m := range acct.TRC20 {
		if val, ok := m[wallet.USDTContract]; ok {
			n := new(big.Int)
			n.SetString(val, 10)
			f := new(big.Float).SetInt(n)
			f.Quo(f, big.NewFloat(1_000_000))
			usdtFloat, _ = f.Float64()
			break
		}
	}
	return usdtFloat, trxSun, nil
}

// sendTRX sends TRX sun from the treasury to toAddrHex (hex format).
func (s *Sweeper) sendTRX(toAddrHex string, amountSun int64) (string, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"to_address":    toAddrHex,
		"owner_address": s.treasuryHex,
		"amount":        amountSun,
		"visible":       false,
	})

	tx, err := s.tronPost("/wallet/createtransaction", body)
	if err != nil {
		return "", fmt.Errorf("create TRX tx: %w", err)
	}
	return s.signAndBroadcast(tx, s.hd.TreasuryPrivKey())
}

// sweepUSDT builds and broadcasts a TRC20 USDT transfer from the deposit address to treasury.
func (s *Sweeper) sweepUSDT(fromHex string, privKey []byte, amountSun *big.Int) (string, error) {
	param, err := wallet.ABIEncodeTransfer(s.treasury, amountSun)
	if err != nil {
		return "", fmt.Errorf("abi encode: %w", err)
	}

	usdtHex, err := wallet.TronBase58ToHex(wallet.USDTContract)
	if err != nil {
		return "", fmt.Errorf("usdt contract hex: %w", err)
	}

	body, _ := json.Marshal(map[string]interface{}{
		"owner_address":     fromHex,
		"contract_address":  usdtHex,
		"function_selector": "transfer(address,uint256)",
		"parameter":         param,
		"fee_limit":         feeLimitSun,
		"call_value":        0,
		"visible":           false,
	})

	tx, err := s.tronPost("/wallet/triggersmartcontract", body)
	if err != nil {
		return "", fmt.Errorf("trigger contract: %w", err)
	}

	// triggersmartcontract wraps result in {"transaction": {...}}
	inner, ok := tx["transaction"].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("unexpected triggersmartcontract response")
	}
	return s.signAndBroadcast(inner, privKey)
}

// signAndBroadcast signs a raw Tron transaction and broadcasts it.
func (s *Sweeper) signAndBroadcast(tx map[string]interface{}, privKeyBytes []byte) (string, error) {
	rawDataHex, ok := tx["raw_data_hex"].(string)
	if !ok {
		return "", fmt.Errorf("missing raw_data_hex")
	}

	sig, err := wallet.SignTronTx(privKeyBytes, rawDataHex)
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	tx["signature"] = []string{sig}

	body, _ := json.Marshal(tx)
	result, err := s.tronPost("/wallet/broadcasttransaction", body)
	if err != nil {
		return "", fmt.Errorf("broadcast: %w", err)
	}
	if code, ok := result["code"].(string); ok && code != "" && code != "SUCCESS" {
		msg, _ := result["message"].(string)
		return "", fmt.Errorf("broadcast error %s: %s", code, msg)
	}

	txid, _ := tx["txID"].(string)
	return txid, nil
}

// tronPost calls a TronGrid endpoint and returns the JSON response.
func (s *Sweeper) tronPost(path string, body []byte) (map[string]interface{}, error) {
	url := wallet.TronGridBase + path
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if s.apiKey != "" {
		req.Header.Set("TRON-PRO-API-KEY", s.apiKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	if err := json.Unmarshal(b, &result); err != nil {
		return nil, fmt.Errorf("parse response: %w (body: %s)", err, b)
	}
	return result, nil
}

// markSwept records a completed sweep in seen_deposits.
func (s *Sweeper) markSwept(ctx context.Context, depositTxid, sweepTxid string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE seen_deposits
		SET    swept_at = NOW(), sweep_txid = $1, sweep_err = NULL
		WHERE  txid = $2
	`, sweepTxid, depositTxid)
	return err
}
