package wallet

// Tron address generation using BIP44 HD derivation.
// Path: m/44'/195'/0'/0/{index}  (Tron coin type = 195)
// Treasury path: m/44'/195'/1'/0/0  (account index 1)
//
// Address format: Base58Check( 0x41 || keccak256(pubkey)[12:] )

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
	btcecdsa "github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/tyler-smith/go-bip32"
	"github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/sha3"
)

const (
	tronCoinType = uint32(0x800000C3) // 195 hardened
	tronPrefix   = byte(0x41)

	// USDT TRC20 contract on Tron mainnet
	USDTContract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"

	// TronGrid base URL
	TronGridBase = "https://api.trongrid.io"
)

// HDWallet derives Tron addresses and private keys from a BIP39 mnemonic.
// User deposit path:  m/44'/195'/0'/0/{index}
// Treasury path:      m/44'/195'/1'/0/0
type HDWallet struct {
	userChange  *bip32.Key // m/44'/195'/0'/0   — user deposit addresses
	treasuryKey *bip32.Key // m/44'/195'/1'/0/0 — house treasury (single key)
}

func NewHDWallet() (*HDWallet, error) {
	mnemonic := os.Getenv("WALLET_MNEMONIC")
	if mnemonic == "" {
		// Generate a new mnemonic if not set (dev mode — log it so operator can save it)
		entropy, err := bip39.NewEntropy(256)
		if err != nil {
			return nil, err
		}
		mnemonic, err = bip39.NewMnemonic(entropy)
		if err != nil {
			return nil, err
		}
		fmt.Printf("[wallet] WARNING: No WALLET_MNEMONIC set. Generated: %s\n", mnemonic)
		fmt.Println("[wallet] Set this as WALLET_MNEMONIC env var to persist addresses!")
	}

	seed := bip39.NewSeed(mnemonic, "")
	master, err := bip32.NewMasterKey(seed)
	if err != nil {
		return nil, fmt.Errorf("master key: %w", err)
	}

	// m/44'
	purpose, err := master.NewChildKey(bip32.FirstHardenedChild + 44)
	if err != nil {
		return nil, err
	}
	// m/44'/195'
	coinType, err := purpose.NewChildKey(tronCoinType)
	if err != nil {
		return nil, err
	}

	// ── User deposit path: m/44'/195'/0'/0 ──────────────────────────────────
	acct0, err := coinType.NewChildKey(bip32.FirstHardenedChild)
	if err != nil {
		return nil, err
	}
	userChange, err := acct0.NewChildKey(0)
	if err != nil {
		return nil, err
	}

	// ── Treasury path: m/44'/195'/1'/0/0 ────────────────────────────────────
	acct1, err := coinType.NewChildKey(bip32.FirstHardenedChild + 1)
	if err != nil {
		return nil, err
	}
	tChange, err := acct1.NewChildKey(0)
	if err != nil {
		return nil, err
	}
	treasuryKey, err := tChange.NewChildKey(0)
	if err != nil {
		return nil, err
	}

	return &HDWallet{userChange: userChange, treasuryKey: treasuryKey}, nil
}

// Address derives the TRC20 deposit address at index i (m/44'/195'/0'/0/i).
func (w *HDWallet) Address(index uint32) (string, error) {
	child, err := w.userChange.NewChildKey(index)
	if err != nil {
		return "", err
	}
	return tronAddressFromKey(child)
}

// PrivateKeyAt returns the raw 32-byte private key for user deposit address at index i.
func (w *HDWallet) PrivateKeyAt(index uint32) ([]byte, error) {
	child, err := w.userChange.NewChildKey(index)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	copy(key, child.Key)
	return key, nil
}

// TreasuryAddress returns the Tron base58 address of the house treasury.
func (w *HDWallet) TreasuryAddress() (string, error) {
	return tronAddressFromKey(w.treasuryKey)
}

// TreasuryPrivKey returns the raw 32-byte private key for the treasury.
func (w *HDWallet) TreasuryPrivKey() []byte {
	key := make([]byte, 32)
	copy(key, w.treasuryKey.Key)
	return key
}

// tronAddressFromKey derives a Tron base58 address from a BIP32 key.
func tronAddressFromKey(k *bip32.Key) (string, error) {
	pubKeyBytes := k.PublicKey().Key
	pubKey, err := btcec.ParsePubKey(pubKeyBytes)
	if err != nil {
		return "", fmt.Errorf("parse pubkey: %w", err)
	}
	uncompressed := pubKey.SerializeUncompressed()[1:]

	hasher := sha3.NewLegacyKeccak256()
	hasher.Write(uncompressed)
	hash := hasher.Sum(nil)

	addr := make([]byte, 21)
	addr[0] = tronPrefix
	copy(addr[1:], hash[12:])

	return base58CheckEncode(addr), nil
}

// base58CheckEncode encodes bytes with a 4-byte checksum.
func base58CheckEncode(payload []byte) string {
	checksum := doubleSHA256(payload)[:4]
	full := append(payload, checksum...)
	return base58Encode(full)
}

func doubleSHA256(b []byte) []byte {
	h1 := sha256.Sum256(b)
	h2 := sha256.Sum256(h1[:])
	return h2[:]
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func base58Encode(b []byte) string {
	// Count leading zeros
	leadingZeros := 0
	for _, v := range b {
		if v != 0 {
			break
		}
		leadingZeros++
	}

	// Convert to big integer, then to base58
	n := new([100]byte)
	copy(n[:], b)
	num := make([]byte, len(b)*136/100+1)
	idx := len(num)

	for i := 0; i < len(b); i++ {
		carry := int(b[i])
		for j := len(num) - 1; j >= idx || carry != 0; j-- {
			carry += 256 * int(num[j])
			num[j] = byte(carry % 58)
			carry /= 58
			if j < idx {
				idx = j
			}
		}
	}
	_ = n

	// Build result
	result := make([]byte, leadingZeros+len(num)-idx)
	for i := 0; i < leadingZeros; i++ {
		result[i] = base58Alphabet[0]
	}
	for i, v := range num[idx:] {
		result[leadingZeros+i] = base58Alphabet[v]
	}
	return string(result)
}

// SignTronTx signs a raw Tron transaction using secp256k1.
// Returns the 65-byte signature as hex: R(32) || S(32) || V(1).
func SignTronTx(privKeyBytes []byte, rawDataHex string) (string, error) {
	rawData, err := hex.DecodeString(rawDataHex)
	if err != nil {
		return "", fmt.Errorf("decode raw_data_hex: %w", err)
	}
	hash := sha256.Sum256(rawData)

	privKey, _ := btcec.PrivKeyFromBytes(privKeyBytes)
	if privKey == nil {
		return "", fmt.Errorf("invalid private key")
	}

	// btcec compact: [flag(1), R(32), S(32)]
	// flag = 27 + recovery_id (uncompressed)
	compact, err := signCompact(privKey, hash[:])
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}

	// Tron expects: R(32) || S(32) || V(1)
	tronSig := make([]byte, 65)
	copy(tronSig[0:32], compact[1:33])   // R
	copy(tronSig[32:64], compact[33:65]) // S
	tronSig[64] = compact[0] - 27        // V = recovery_id
	return hex.EncodeToString(tronSig), nil
}

// HexToTronAddress converts a hex Tron address (41...) to base58.
func HexToTronAddress(h string) (string, error) {
	b, err := hex.DecodeString(h)
	if err != nil {
		return "", err
	}
	return base58CheckEncode(b), nil
}

// TronBase58ToHex converts a Tron base58 address (T...) to hex (41...).
func TronBase58ToHex(addr string) (string, error) {
	decoded := base58Decode(addr)
	if len(decoded) != 25 {
		return "", fmt.Errorf("invalid address: wrong length %d", len(decoded))
	}
	payload := decoded[:21]
	checksum := decoded[21:25]
	computed := doubleSHA256(payload)[:4]
	for i := range checksum {
		if checksum[i] != computed[i] {
			return "", fmt.Errorf("invalid address: bad checksum")
		}
	}
	return hex.EncodeToString(payload), nil
}

// ABIEncodeTransfer ABI-encodes parameters for ERC20/TRC20 transfer(address,uint256).
// Returns the hex-encoded parameter bytes (no function selector prefix).
func ABIEncodeTransfer(toTronAddr string, amountUnits *big.Int) (string, error) {
	hexAddr, err := TronBase58ToHex(toTronAddr)
	if err != nil {
		return "", err
	}
	// hexAddr is "41" + 40 hex chars (21 bytes).
	// ABI address = last 20 bytes (drop the 0x41 prefix byte → skip 2 hex chars).
	addrHex := hexAddr[2:] // 40 hex chars = 20 bytes
	addrBytes, err := hex.DecodeString(addrHex)
	if err != nil {
		return "", err
	}

	// param1: address padded to 32 bytes (left-padded with zeros)
	param1 := make([]byte, 32)
	copy(param1[12:], addrBytes)

	// param2: uint256 amount padded to 32 bytes (big-endian)
	param2 := make([]byte, 32)
	ab := amountUnits.Bytes()
	copy(param2[32-len(ab):], ab)

	return hex.EncodeToString(append(param1, param2...)), nil
}

// USDTToSun converts a USDT float amount to the integer sun units (6 decimals).
func USDTToSun(amount float64) *big.Int {
	f := new(big.Float).SetFloat64(amount)
	f.Mul(f, big.NewFloat(1_000_000))
	sun, _ := f.Int(nil)
	return sun
}

// signCompact wraps btcec SignCompact; returns [flag, R(32), S(32)].
func signCompact(privKey *btcec.PrivateKey, hash []byte) ([]byte, error) {
	return btcecdsa.SignCompact(privKey, hash, false)
}

// base58Decode decodes a base58-encoded string to bytes.
func base58Decode(s string) []byte {
	n := big.NewInt(0)
	base := big.NewInt(58)
	for _, c := range []byte(s) {
		idx := strings.IndexByte(base58Alphabet, c)
		if idx < 0 {
			return nil
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(idx)))
	}

	decoded := n.Bytes()

	// Prepend zero bytes for leading '1's in base58
	numLeadingZeros := 0
	for _, c := range s {
		if c != '1' {
			break
		}
		numLeadingZeros++
	}

	result := make([]byte, numLeadingZeros+len(decoded))
	copy(result[numLeadingZeros:], decoded)
	return result
}
