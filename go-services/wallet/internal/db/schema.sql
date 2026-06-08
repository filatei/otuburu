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

-- ── Withdrawal requests (USDT TRC20 OR NGN bank payout) ──────────────────────
-- `channel` discriminates: 'usdt' uses the legacy address column for the
-- TRC20 destination; 'ngn_bank' uses the bank_* columns for a Paystack
-- transfer. The amount column stays denominated in USD — the engine always
-- debits the user account in USD; conversion to NGN happens at Paystack
-- payout time and is recorded in fx_quotes (re-using the deposit table).
CREATE TABLE IF NOT EXISTS withdrawals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    amount     NUMERIC(20,6) NOT NULL CHECK (amount > 0), -- USD debited
    address    TEXT,                     -- TRC20 destination (channel='usdt')
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent','rejected','failed')),
    txid       TEXT,                     -- on-chain hash OR Paystack transfer code
    channel    TEXT NOT NULL DEFAULT 'usdt' CHECK (channel IN ('usdt','ngn_bank')),
    -- NGN bank payout fields (NULL for channel='usdt')
    bank_code           TEXT,            -- Paystack bank code (e.g. '058' for GTBank)
    bank_account_number TEXT,
    bank_account_name   TEXT,            -- verified via /bank/resolve
    ngn_amount          NUMERIC(20,2),   -- gross NGN sent to the bank
    paystack_recipient  TEXT,            -- recipient_code returned by /transferrecipient
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration block: idempotent. Re-runs of schema.sql apply cleanly on installs
-- that pre-date the channel + bank_* columns.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='withdrawals' AND column_name='channel'
    ) THEN
        ALTER TABLE withdrawals ADD COLUMN channel TEXT NOT NULL DEFAULT 'usdt';
        ALTER TABLE withdrawals ADD COLUMN bank_code TEXT;
        ALTER TABLE withdrawals ADD COLUMN bank_account_number TEXT;
        ALTER TABLE withdrawals ADD COLUMN bank_account_name TEXT;
        ALTER TABLE withdrawals ADD COLUMN ngn_amount NUMERIC(20,2);
        ALTER TABLE withdrawals ADD COLUMN paystack_recipient TEXT;
        ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_channel_check
            CHECK (channel IN ('usdt','ngn_bank'));
    END IF;
    -- Old status check didn't include 'failed'; rewrite if needed
    BEGIN
        ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
        ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
            CHECK (status IN ('pending','approved','sent','rejected','failed'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- Old `address NOT NULL` is wrong for NGN payouts
    BEGIN
        ALTER TABLE withdrawals ALTER COLUMN address DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- Phase-4: withdrawals now originate from the user's savings wallet
    -- (account_id IS NULL for those). Keep the old account_id column for
    -- back-compat with legacy rows, but it's no longer required for new
    -- ones. The `source` column makes the origin explicit.
    BEGIN
        ALTER TABLE withdrawals ALTER COLUMN account_id DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='withdrawals' AND column_name='source'
    ) THEN
        ALTER TABLE withdrawals ADD COLUMN source TEXT NOT NULL DEFAULT 'savings'
            CHECK (source IN ('savings','account'));
        -- Legacy rows that pre-date this column have account_id != NULL, so
        -- back-fill them with source='account' to preserve historical truth.
        UPDATE withdrawals SET source='account' WHERE account_id IS NOT NULL;
    END IF;
END $$;

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

-- ── Savings wallet (one per user, USD-denominated, no positions) ─────────────
-- The SOLE origin for withdrawals. Users transfer profits + idle balance
-- from trading accounts into Savings, then withdraw from there. This forces
-- a deliberate "park first" step that:
--   1. protects active positions from accidental cash-out
--   2. surfaces a clean reconcile target for payout obligations
--   3. removes the "which of N accounts gets the withdrawal" ambiguity
-- Created lazily on first /wallet/savings hit.
CREATE TABLE IF NOT EXISTS savings_wallets (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance    NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Account kind (standard / cent / micro) ───────────────────────────────────
-- Scaling factor applied to deposits + stake on this account. Live price feed
-- is unchanged; only the user's balance is multiplied.
--   real_standard → $1 credits $1     (current behaviour, default)
--   real_cent     → $1 credits ¢100   (×100 nominal)
--   real_micro    → $1 credits μ1000  (×1000 nominal)
-- Demo accounts always behave as standard. Cent/micro logic ships in a later
-- phase; this column lands now so the migration is one-shot.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='accounts' AND column_name='kind'
    ) THEN
        ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'real_standard'
            CHECK (kind IN ('real_standard','real_cent','real_micro','demo'));
        UPDATE accounts SET kind='demo' WHERE type='demo';
    END IF;
END $$;

-- ── Internal transfers (savings ↔ account, account ↔ account) ────────────────
-- One row per transfer captures both legs. Savings legs have NULL from_id /
-- to_id because there's no accounts row for the savings wallet — the user_id
-- on this table is enough to locate the matching savings_wallets row.
-- idempotency_key lets retried POST /wallet/transfers requests no-op safely.
CREATE TABLE IF NOT EXISTS transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_kind       TEXT NOT NULL CHECK (from_kind IN ('savings','account')),
    from_id         UUID,  -- NULL when from_kind='savings'
    to_kind         TEXT NOT NULL CHECK (to_kind IN ('savings','account')),
    to_id           UUID,  -- NULL when to_kind='savings'
    amount          NUMERIC(20,6) NOT NULL CHECK (amount > 0),
    idempotency_key TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('pending','completed','failed','reversed')),
    note            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    CHECK ((from_kind='account' AND from_id IS NOT NULL) OR (from_kind='savings' AND from_id IS NULL)),
    CHECK ((to_kind='account'   AND to_id   IS NOT NULL) OR (to_kind='savings'   AND to_id   IS NULL)),
    CHECK (NOT (from_kind=to_kind AND from_id IS NOT DISTINCT FROM to_id))  -- can't transfer to self
);

CREATE INDEX IF NOT EXISTS idx_transfers_user_created ON transfers(user_id, created_at DESC);

-- ── Ledger transfer types ────────────────────────────────────────────────────
-- Expand the CHECK so account-side transfer legs can be recorded alongside
-- deposits/withdrawals/trades. Savings-side legs are NOT written to ledger
-- (savings has no accounts.id to reference) — the `transfers` table above
-- is the audit trail for those.
DO $$ BEGIN
    ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_type_check;
    ALTER TABLE ledger ADD CONSTRAINT ledger_type_check CHECK (
        type IN ('deposit','withdrawal','withdrawal_refund',
                 'trade_win','trade_loss','bonus',
                 'transfer_in','transfer_out')
    );
END $$;

-- ── KYC tier 1 (Phase-6) ─────────────────────────────────────────────────────
-- Identity verification + sanctions screening backing the deposit/withdraw
-- caps. Tier 0 (default) = no KYC, low deposit cap, no withdrawals. Tier 1
-- = NIN/BVN verified + sanctions clear, deposits + withdrawals unlocked.
-- Tier 2 (future) = passport + proof of address for high-value accounts.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='kyc_tier'
    ) THEN
        ALTER TABLE users ADD COLUMN kyc_tier INTEGER NOT NULL DEFAULT 0
            CHECK (kyc_tier >= 0 AND kyc_tier <= 3);
    END IF;
END $$;

-- One submission per verification attempt. Multiple rows per user are
-- expected (retry after rejection, periodic re-verification). The most
-- recent row with status='approved' drives the user's effective tier.
CREATE TABLE IF NOT EXISTS kyc_submissions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Government ID submitted. Limited to the providers Smile Identity
    -- Enhanced KYC supports in Nigeria.
    id_type          TEXT NOT NULL
                     CHECK (id_type IN ('NIN','BVN','PASSPORT','DRIVERS_LICENSE','VOTERS_CARD')),
    id_number        TEXT NOT NULL,
    -- Personal details claimed by the user — cross-checked vs upstream
    -- by Smile Identity. Stored so admin sees the user's claim even when
    -- upstream rejects (lets us spot pattern abuse).
    first_name       TEXT NOT NULL,
    last_name        TEXT NOT NULL,
    dob              DATE NOT NULL,
    -- Smile Identity job tracking. sid_job_id is their server-side
    -- identifier; sid_response captures the full JSON for audit.
    sid_job_id       TEXT,
    sid_response     JSONB,
    -- Outcome lifecycle.
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired')),
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kyc_user_created
    ON kyc_submissions(user_id, created_at DESC);

-- Sanctions / PEP screening. Re-run periodically against latest OFAC /
-- EU / UN lists. Hit doesn't automatically reject — flags for manual
-- review. Tier 1 advancement requires status='clear'.
CREATE TABLE IF NOT EXISTS sanctions_checks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name   TEXT NOT NULL,
    dob         DATE,
    status      TEXT NOT NULL CHECK (status IN ('clear','hit','pending')),
    hit_details JSONB,
    checked_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sanctions_user_checked
    ON sanctions_checks(user_id, checked_at DESC);

-- ── Affiliate / IB program (Phase-5) ─────────────────────────────────────────
-- One auto-generated 6-char code per user, lazy-created on first
-- /wallet/affiliate hit. The `rate` column lets us override per-affiliate
-- when we cut deals with large IBs without touching the schema. Default
-- 30% matches industry-standard forex/synthetic broker IB tiers.
CREATE TABLE IF NOT EXISTS affiliate_codes (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code       TEXT UNIQUE NOT NULL,
    rate       NUMERIC(5,4) NOT NULL DEFAULT 0.30 CHECK (rate >= 0 AND rate <= 1),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per introduced user. introducer_user_id is RESTRICT-FK (not
-- CASCADE) so we never accidentally lose attribution history if an
-- introducer account is deleted — we'd want to handle that case
-- explicitly (transfer their book, etc.) rather than silently dropping
-- referrals. code_at_signup is denormalised from affiliate_codes so a
-- later code regeneration doesn't rewrite history.
CREATE TABLE IF NOT EXISTS referrals (
    introduced_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    introducer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    code_at_signup     TEXT NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    CHECK (introduced_user_id != introducer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_introducer ON referrals(introducer_user_id);

-- ── Admin audit log ───────────────────────────────────────────────────────────
-- Sprint 5.5f. Records every call to /api/admin/* on the gateway so we
-- have a forensic trail of who flipped what when. Append-only — never
-- updated, never deleted. Retention is "forever" until we hit a real
-- storage problem (this table grows slowly even at scale: only admin
-- actions, not user trades).
--
-- before_value/after_value are JSONB so future admin endpoints can dump
-- arbitrary state diffs without schema changes (e.g. bulk balance
-- adjustments, KYC overrides, withdrawal approvals).
--
-- Per the system architecture, this lives in the wallet's Postgres but
-- is WRITTEN by the gateway service (gateway gets its own pool against
-- the same DB instance). Wallet's admin handler is welcome to write
-- here too as we extend audit coverage to its endpoints in a follow-up.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Service that wrote the entry — "gateway" or "wallet". Lets us
    -- filter by service in dashboards without parsing the action name.
    service      TEXT NOT NULL CHECK (service IN ('gateway','wallet')),
    -- Verb describing the admin action, e.g. 'set_account_routing_mode',
    -- 'approve_withdrawal', 'reject_kyc'. Lowercase snake_case by
    -- convention; not enforced by check constraint so we don't have to
    -- migrate every time we add an action.
    action       TEXT NOT NULL,
    -- Subject of the action — usually an account UUID, user UUID, or
    -- withdrawal id. NULL for actions that don't target a specific
    -- entity (e.g. bulk operations, sweep triggers).
    target       TEXT,
    -- State before the action, if applicable. Free-form JSON per action.
    before_value JSONB,
    -- State after the action.
    after_value  JSONB,
    -- HTTP status code returned to the admin caller. 200/204 = success;
    -- anything else means the admin action was rejected (validation,
    -- engine reject, etc.) — still recorded for forensic completeness.
    status       INT NOT NULL,
    -- Error message returned to the caller when status != 2xx. Empty
    -- on success.
    error        TEXT NOT NULL DEFAULT '',
    -- Edge-network IP that originated the admin call (gin Context's
    -- ClientIP() — respects X-Forwarded-For from Apache). Useful when
    -- admin secret leaks and we need to identify the abusing source.
    request_ip   TEXT,
    -- User-agent string from the admin caller. Helps distinguish curl
    -- (humans) from a misbehaving script.
    user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_occurred ON admin_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action   ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target   ON admin_audit_log(target);

-- ── Indices ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ledger_account      ON ledger(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created      ON ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user    ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_address     ON deposit_addresses(address);
CREATE INDEX IF NOT EXISTS idx_seen_deposits_swept ON seen_deposits(swept_at) WHERE swept_at IS NULL;
