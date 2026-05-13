-- Otuburu wallet schema
-- Run once on first boot via init container or migration step

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Accounts (each user has demo + real) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('demo','real')),
    currency   TEXT NOT NULL DEFAULT 'USDT',
    balance    NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, type)
);

-- ── TRC20 deposit addresses (one per user, HD-derived) ────────────────────────
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address    TEXT UNIQUE NOT NULL,
    hd_index   INTEGER UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Ledger (all money movements) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    type       TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','trade_win','trade_loss','bonus')),
    amount     NUMERIC(20,6) NOT NULL,   -- positive = credit, negative = debit
    status     TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','failed')),
    ref        TEXT,                     -- blockchain txid or trade id
    note       TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Withdrawal requests ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount     NUMERIC(20,6) NOT NULL CHECK (amount > 0),
    address    TEXT NOT NULL,            -- destination TRC20 address
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent','rejected')),
    txid       TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Seen deposits (prevent double-crediting) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS seen_deposits (
    txid       TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    amount     NUMERIC(20,6) NOT NULL,
    credited   BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indices ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ledger_account   ON ledger(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created   ON ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_address  ON deposit_addresses(address);
