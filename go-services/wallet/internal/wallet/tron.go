package wallet

// Tron address generation using BIP44 HD derivation.
// Path: m/44'/195'/0'/0/{index}  (Tron coin type = 195)
//
// Address format: Base58Check( 0x41 || keccak256(pubkey)[12:] )

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/btcsuite/btcd/btcec/v2"
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

// HDWallet derives Tron addresses from a BIP39 mnemonic.
type HDWallet struct {
	account *bip32.Key // m/44'/195'/0'
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
	// m/44'/195'/0'
	acct, err := coinType.NewChildKey(bip32.FirstHardenedChild)
	if err != nil {
		return nil, err
	}
	// m/44'/195'/0'/0
	change, err := acct.NewChildKey(0)
	if err != nil {
		return nil, err
	}

	return &HDWallet{account: change}, nil
}

// Address derives the TRC20 address at index i (m/44'/195'/0'/0/i).
func (w *HDWallet) Address(index uint32) (string, error) {
	child, err := w.account.NewChildKey(index)
	if err != nil {
		return "", err
	}

	// Parse compressed public key
	pubKeyBytes := child.PublicKey().Key
	pubKey, err := btcec.ParsePubKey(pubKeyBytes)
	if err != nil {
		return "", fmt.Errorf("parse pubkey: %w", err)
	}

	// Uncompressed public key (65 bytes, skip the 0x04 prefix)
	uncompressed := pubKey.SerializeUncompressed()[1:]

	// keccak256 of public key
	hasher := sha3.NewLegacyKeccak256()
	hasher.Write(uncompressed)
	hash := hasher.Sum(nil)

	// Take last 20 bytes, prepend Tron prefix 0x41
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

// HexToTronAddress converts a hex Tron address to base58.
func HexToTronAddress(h string) (string, error) {
	b, err := hex.DecodeString(h)
	if err != nil {
		return "", err
	}
	return base58CheckEncode(b), nil
}
