-- Otuburu wallet schema
-- Run once on first boot via init container or migration step

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    google_id  TEXT UNIQUE NOT NULL,
    name       TEXT,
    picture    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Accounts (one demo + N labelled real per user) ────────────────────────────
-- The old UNIQUE(user_id, type) limited users to exactly one real account.
-- Phase 2 of the deposit refactor lifts that: a user can now have multiple
-- real accounts (e.g. "Main", "Strategy A", "Experiment"), each USD-denominated.
-- Demo stays singleton — there's no value in multiple demos for retail.
CREATE TABLE IF NOT EXISTS accounts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('demo','real')),
    label      TEXT NOT NULL DEFAULT 'Account',  -- user-visible name e.g. "Main"
    currency   TEXT NOT NULL DEFAULT 'USDT',
    balance    NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Migration block: idempotent. Re-runs of schema.sql apply cleanly. ────────
-- For installs that pre-date the label column / multi-real shape.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='accounts' AND column_name='label'
    ) THEN
        ALTER TABLE accounts ADD COLUMN label TEXT;
        UPDATE accounts SET label='Demo' WHERE type='demo' AND label IS NULL;
        UPDATE accounts SET label='Main' WHERE type='real' AND label IS NULL;
        ALTER TABLE accounts ALTER COLUMN label SET NOT NULL;
        ALTER TABLE accounts ALTER COLUMN label SET DEFAULT 'Account';
    END IF;
END $$;

-- Drop the old uniqueness that limited each user to one real account. Name is
-- the Postgres-generated default for `UNIQUE (user_id, type)`.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_user_id_type_key;

-- Keep demo singleton via a partial unique index. Real accounts are now N:1.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_demo_per_user
    ON accounts (user_id) WHERE type = 'demo';

-- Lookup helper: list a user's accounts in creation order.
CREATE INDEX IF NOT EXISTS idx_accounts_user_created
    ON accounts (user_id, created_at);

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
    type       TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','withdrawal_refund','trade_win','trade_loss','bonus')),
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
    swept_at   TIMESTAMPTZ,             -- NULL = not yet swept to treasury
    sweep_txid TEXT,                    -- on-chain sweep transaction
    sweep_err  TEXT,                    -- last sweep error (for retries)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Treasury sweeps log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treasury_sweeps (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deposit_txid TEXT NOT NULL REFERENCES seen_deposits(txid),
    amount     NUMERIC(20,6) NOT NULL,
    sweep_txid TEXT NOT NULL,
    swept_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Paystack NGN payments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paystack_payments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference        TEXT UNIQUE NOT NULL,   -- Paystack reference
    account_id       UUID NOT NULL REFERENCES accounts(id),
    user_id          UUID NOT NULL REFERENCES users(id),
    amount_usd       NUMERIC(20,6) NOT NULL, -- requested USD equivalent (the QUOTE — what user gets credited)
    amount_usd_actual NUMERIC(20,6),         -- actual USD credited (equals amount_usd unless re-priced)
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','processing','confirmed','failed')),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── FX quotes (audit trail per NGN deposit) ──────────────────────────────────
-- One row per credited NGN deposit. Captures the interbank rate, the spread
-- applied, the customer-facing rate, the NGN charged, and the USD credited.
-- Lets us answer "I deposited X NGN and got $Y — what rate was used?"
-- months after the fact. Also the source of truth for FX P&L on our side.
CREATE TABLE IF NOT EXISTS fx_quotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paystack_ref    TEXT UNIQUE NOT NULL REFERENCES paystack_payments(reference) ON DELETE CASCADE,
    base_ccy        TEXT NOT NULL DEFAULT 'USD',
    quote_ccy       TEXT NOT NULL DEFAULT 'NGN',
    interbank_rate  NUMERIC(20,6) NOT NULL,   -- NGN per 1 USD, as fetched from rate source
    spread_pct      NUMERIC(8,4)  NOT NULL,   -- e.g. 0.0200 = 2%
    customer_rate   NUMERIC(20,6) NOT NULL,   -- interbank * (1 + spread_pct)
    ngn_charged     NUMERIC(20,2) NOT NULL,   -- naira amount paid by customer (kobo / 100)
    usd_credited    NUMERIC(20,6) NOT NULL,   -- USD posted to the account
    source          TEXT NOT NULL DEFAULT 'open.er-api.com',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fx_quotes_created ON fx_quotes(created_at DESC);

-- ── Indices ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ledger_account      ON ledger(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created      ON ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user    ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_address     ON deposit_addresses(address);
CREATE INDEX IF NOT EXISTS idx_seen_deposits_swept ON seen_deposits(swept_at) WHERE swept_at IS NULL;
