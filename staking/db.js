/**
 * Otuburu Algorithm Staking — SQLite Database Layer
 * Drop-in: no extra service needed. Upgrade path → PostgreSQL by swapping this module.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.STAKING_DB_PATH || path.join(__dirname, '../data/staking.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    -- -------------------------------------------------------
    -- USERS (mirrors Google OAuth profile already in the app)
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS staking_users (
      id          TEXT PRIMARY KEY,          -- Google UID
      email       TEXT UNIQUE NOT NULL,
      name        TEXT,
      photo_url   TEXT,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    -- -------------------------------------------------------
    -- ALGORITHMS catalogue
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS algorithms (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      risk_level    TEXT CHECK(risk_level IN ('LOW','MEDIUM','HIGH')) DEFAULT 'MEDIUM',
      min_stake_usd REAL NOT NULL DEFAULT 100,
      max_stake_usd REAL,
      profit_share  REAL NOT NULL DEFAULT 0.80,   -- user share e.g. 0.80 = 80%
      status        TEXT CHECK(status IN ('ACTIVE','PAUSED','CLOSED')) DEFAULT 'ACTIVE',
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- -------------------------------------------------------
    -- STAKES — one record per user–algorithm position
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS stakes (
      id              TEXT PRIMARY KEY,     -- UUID
      user_id         TEXT NOT NULL REFERENCES staking_users(id),
      algorithm_id    TEXT NOT NULL REFERENCES algorithms(id),
      amount_usd      REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'USD',
      amount_local    REAL NOT NULL,        -- amount in payment currency (NGN or USD)
      fx_rate         REAL NOT NULL DEFAULT 1.0,
      status          TEXT CHECK(status IN (
                        'PENDING_PAYMENT','ACTIVE','PAUSED','CLOSED','FAILED'
                      )) DEFAULT 'PENDING_PAYMENT',
      exness_account  TEXT,                 -- filled by admin after provisioning
      paystack_ref    TEXT UNIQUE,
      started_at      INTEGER,
      closed_at       INTEGER,
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- -------------------------------------------------------
    -- PAYMENTS — Paystack transaction log
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS payments (
      id              TEXT PRIMARY KEY,     -- Paystack reference
      stake_id        TEXT NOT NULL REFERENCES stakes(id),
      user_id         TEXT NOT NULL,
      amount_kobo     INTEGER NOT NULL,     -- amount in smallest currency unit
      currency        TEXT NOT NULL DEFAULT 'NGN',
      status          TEXT CHECK(status IN ('PENDING','SUCCESS','FAILED')) DEFAULT 'PENDING',
      gateway_status  TEXT,                 -- raw status from Paystack
      gateway_ref     TEXT,                 -- Paystack transaction ID
      paid_at         INTEGER,
      meta            TEXT,                 -- JSON blob
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- -------------------------------------------------------
    -- PROFIT RECORDS — admin logs profit distributions
    -- -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS profit_records (
      id              TEXT PRIMARY KEY,
      stake_id        TEXT NOT NULL REFERENCES stakes(id),
      period_start    INTEGER NOT NULL,
      period_end      INTEGER NOT NULL,
      gross_pnl_usd   REAL NOT NULL,
      user_share_usd  REAL NOT NULL,
      house_share_usd REAL NOT NULL,
      status          TEXT CHECK(status IN ('PENDING','PAID','REINVESTED')) DEFAULT 'PENDING',
      notes           TEXT,
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- -------------------------------------------------------
    -- SEED: Algorithm catalogue
    -- -------------------------------------------------------
    INSERT OR IGNORE INTO algorithms (id, name, description, risk_level, min_stake_usd, max_stake_usd, profit_share) VALUES
      ('MR-GRID',        'MR-Grid',          'Mean-reversion grid strategy. Profits from ranging markets by placing layered buy/sell orders around a midpoint.', 'LOW',    100,  50000, 0.80),
      ('MOMENTUM-GRID',  'Momentum-Grid',    'Trend-following grid that rides breakouts. Doubles down in the direction of momentum while cutting losers fast.', 'MEDIUM', 200,  50000, 0.80),
      ('GRID-BOTH',      'Grid-Both',        'Bi-directional grid — simultaneously runs MR and Momentum layers. Best for volatile, trending markets.', 'HIGH',   500, 100000, 0.80),
      ('M1-CANDLE-MR',   'M1-Candle-MR',    '1-minute candle mean-reversion scalper. High-frequency, low-drawdown. Targets intraday micro-reversals.', 'LOW',    100,  25000, 0.80),
      ('M1-CANDLE-MOM',  'M1-Candle-Mom',   '1-minute candle momentum scalper. Enters on strong M1 closes, exits quickly. Best on liquid pairs.', 'MEDIUM', 200,  25000, 0.80);
  `);
}

// ─── USER helpers ─────────────────────────────────────────────────────────────

function upsertUser({ id, email, name, photo_url }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO staking_users (id, email, name, photo_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, photo_url=excluded.photo_url
  `).run(id, email, name, photo_url);
}

// ─── ALGORITHM helpers ────────────────────────────────────────────────────────

function getAlgorithms() {
  return getDb().prepare(`SELECT * FROM algorithms WHERE status = 'ACTIVE' ORDER BY min_stake_usd`).all();
}

function getAlgorithm(id) {
  return getDb().prepare(`SELECT * FROM algorithms WHERE id = ?`).get(id);
}

// ─── STAKE helpers ────────────────────────────────────────────────────────────

function createStake({ id, user_id, algorithm_id, amount_usd, currency, amount_local, fx_rate, paystack_ref }) {
  getDb().prepare(`
    INSERT INTO stakes (id, user_id, algorithm_id, amount_usd, currency, amount_local, fx_rate, paystack_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user_id, algorithm_id, amount_usd, currency, amount_local, fx_rate, paystack_ref);
}

function getStakeByPaystackRef(ref) {
  return getDb().prepare(`SELECT * FROM stakes WHERE paystack_ref = ?`).get(ref);
}

function activateStake(stakeId) {
  getDb().prepare(`
    UPDATE stakes SET status = 'ACTIVE', started_at = unixepoch() WHERE id = ?
  `).run(stakeId);
}

function failStake(stakeId) {
  getDb().prepare(`UPDATE stakes SET status = 'FAILED' WHERE id = ?`).run(stakeId);
}

function getUserStakes(userId) {
  return getDb().prepare(`
    SELECT s.*, a.name as algo_name, a.description as algo_desc, a.risk_level,
           a.profit_share, p.status as payment_status, p.paid_at
    FROM stakes s
    JOIN algorithms a ON s.algorithm_id = a.id
    LEFT JOIN payments p ON p.stake_id = s.id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId);
}

function setExnessAccount(stakeId, account) {
  getDb().prepare(`UPDATE stakes SET exness_account = ? WHERE id = ?`).run(account, stakeId);
}

// ─── PAYMENT helpers ──────────────────────────────────────────────────────────

function createPayment({ id, stake_id, user_id, amount_kobo, currency }) {
  getDb().prepare(`
    INSERT INTO payments (id, stake_id, user_id, amount_kobo, currency)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, stake_id, user_id, amount_kobo, currency);
}

function updatePayment({ id, status, gateway_status, gateway_ref, paid_at, meta }) {
  getDb().prepare(`
    UPDATE payments
    SET status = ?, gateway_status = ?, gateway_ref = ?, paid_at = ?, meta = ?
    WHERE id = ?
  `).run(status, gateway_status, gateway_ref, paid_at, JSON.stringify(meta), id);
}

// ─── PROFIT helpers ───────────────────────────────────────────────────────────

function logProfit({ id, stake_id, period_start, period_end, gross_pnl_usd, profit_share, notes }) {
  const user_share = gross_pnl_usd * profit_share;
  const house_share = gross_pnl_usd * (1 - profit_share);
  getDb().prepare(`
    INSERT INTO profit_records (id, stake_id, period_start, period_end, gross_pnl_usd, user_share_usd, house_share_usd, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, stake_id, period_start, period_end, gross_pnl_usd, user_share, house_share, notes);
}

function getProfitsByStake(stakeId) {
  return getDb().prepare(`SELECT * FROM profit_records WHERE stake_id = ? ORDER BY period_end DESC`).all(stakeId);
}

module.exports = {
  getDb, upsertUser,
  getAlgorithms, getAlgorithm,
  createStake, getStakeByPaystackRef, activateStake, failStake, getUserStakes, setExnessAccount,
  createPayment, updatePayment,
  logProfit, getProfitsByStake,
};
