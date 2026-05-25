//! SQLite database — settled trade history and daily OHLC persistence.
//!
//! Uses dynamic `sqlx::query()` (not `query!()` macros) so no compile-time
//! database or SQLX_OFFLINE mode is required.
//!
//! Database path: DB_URL env var (default sqlite:///data/otuburu.db).

use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePool},
    Row,
};
use std::str::FromStr;

pub fn db_url() -> String {
    std::env::var("DB_URL").unwrap_or_else(|_| "sqlite:///data/otuburu.db".into())
}

/// Open the SQLite pool and apply the schema migration.
pub async fn connect() -> Result<SqlitePool> {
    let url = db_url();

    // Ensure the parent directory exists (SQLite creates the file, not the dir).
    if let Some(path) = url.strip_prefix("sqlite:///") {
        if let Some(parent) = std::path::Path::new(&format!("/{path}")).parent() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let opts = SqliteConnectOptions::from_str(&url)?.create_if_missing(true);
    let pool = SqlitePool::connect_with(opts).await?;
    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settled_trades (
            id           TEXT    PRIMARY KEY,
            account_id   TEXT    NOT NULL,
            symbol       TEXT    NOT NULL,
            direction    TEXT    NOT NULL,
            stake        REAL    NOT NULL,
            payout       REAL    NOT NULL,
            won          INTEGER NOT NULL,
            entry_mid    REAL    NOT NULL,
            exit_mid     REAL    NOT NULL,
            ticks_total  INTEGER NOT NULL,
            opened_at_ms INTEGER NOT NULL,
            settled_at_ms INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_st_account
         ON settled_trades (account_id, settled_at_ms)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ohlc_daily (
            symbol TEXT    NOT NULL,
            ts_s   INTEGER NOT NULL,
            open   REAL    NOT NULL,
            high   REAL    NOT NULL,
            low    REAL    NOT NULL,
            close  REAL    NOT NULL,
            PRIMARY KEY (symbol, ts_s)
        )",
    )
    .execute(pool)
    .await?;

    tracing::info!("SQLite schema ready");
    Ok(())
}

// ── Settled trade writes ──────────────────────────────────────────────────────

/// Persist a binary settlement. Uses INSERT OR IGNORE so duplicate calls are safe.
pub async fn save_settled_trade(
    pool: &SqlitePool,
    s: &order_book::BinarySettlement,
    settled_at_ms: i64,
) -> Result<()> {
    let direction = if s.option.direction == order_book::Direction::Up {
        "UP"
    } else {
        "DOWN"
    };

    sqlx::query(
        "INSERT OR IGNORE INTO settled_trades
         (id, account_id, symbol, direction, stake, payout, won,
          entry_mid, exit_mid, ticks_total, opened_at_ms, settled_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(s.option.id.to_string())
    .bind(s.option.account_id.to_string())
    .bind(&s.option.symbol)
    .bind(direction)
    .bind(s.option.stake)
    .bind(s.payout)
    .bind(s.won as i32)
    .bind(s.option.entry_mid)
    .bind(s.exit_mid)
    .bind(s.option.ticks_total as i64)
    .bind(s.option.opened_at_ms)
    .bind(settled_at_ms)
    .execute(pool)
    .await?;

    Ok(())
}

// ── Settled trade reads ───────────────────────────────────────────────────────

pub struct SettledTradeRow {
    pub id: String,
    pub account_id: String,
    pub symbol: String,
    pub direction: String,
    pub stake: f64,
    pub payout: f64,
    pub won: bool,
    pub entry_mid: f64,
    pub exit_mid: f64,
    pub ticks_total: i64,
    pub opened_at_ms: i64,
    pub settled_at_ms: i64,
}

pub async fn get_trade_history(
    pool: &SqlitePool,
    account_id: &str,
    symbol: &str, // empty = all symbols
    from_ms: i64,
    to_ms: i64,
    limit: u32,
) -> Result<Vec<SettledTradeRow>> {
    let cap = if limit == 0 { 200_i64 } else { limit as i64 };

    let rows = if symbol.is_empty() {
        sqlx::query(
            "SELECT id, account_id, symbol, direction, stake, payout, won,
                    entry_mid, exit_mid, ticks_total, opened_at_ms, settled_at_ms
             FROM settled_trades
             WHERE account_id = ? AND settled_at_ms BETWEEN ? AND ?
             ORDER BY settled_at_ms DESC
             LIMIT ?",
        )
        .bind(account_id)
        .bind(from_ms)
        .bind(to_ms)
        .bind(cap)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, account_id, symbol, direction, stake, payout, won,
                    entry_mid, exit_mid, ticks_total, opened_at_ms, settled_at_ms
             FROM settled_trades
             WHERE account_id = ? AND symbol = ? AND settled_at_ms BETWEEN ? AND ?
             ORDER BY settled_at_ms DESC
             LIMIT ?",
        )
        .bind(account_id)
        .bind(symbol)
        .bind(from_ms)
        .bind(to_ms)
        .bind(cap)
        .fetch_all(pool)
        .await?
    };

    let trades = rows
        .iter()
        .map(|r| SettledTradeRow {
            id: r.get("id"),
            account_id: r.get("account_id"),
            symbol: r.get("symbol"),
            direction: r.get("direction"),
            stake: r.get("stake"),
            payout: r.get("payout"),
            won: r.get::<i32, _>("won") != 0,
            entry_mid: r.get("entry_mid"),
            exit_mid: r.get("exit_mid"),
            ticks_total: r.get("ticks_total"),
            opened_at_ms: r.get("opened_at_ms"),
            settled_at_ms: r.get("settled_at_ms"),
        })
        .collect();

    Ok(trades)
}

// ── Daily OHLC persistence ────────────────────────────────────────────────────

pub async fn upsert_daily_candle(
    pool: &SqlitePool,
    symbol: &str,
    ts_s: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO ohlc_daily (symbol, ts_s, open, high, low, close)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol, ts_s) DO UPDATE SET
           high  = MAX(high,  excluded.high),
           low   = MIN(low,   excluded.low),
           close = excluded.close",
    )
    .bind(symbol)
    .bind(ts_s)
    .bind(open)
    .bind(high)
    .bind(low)
    .bind(close)
    .execute(pool)
    .await?;

    Ok(())
}

pub struct DailyCandle {
    pub ts_s: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

pub async fn get_daily_candles(
    pool: &SqlitePool,
    symbol: &str,
    from_s: i64,
    to_s: i64,
) -> Result<Vec<DailyCandle>> {
    let rows = sqlx::query(
        "SELECT ts_s, open, high, low, close
         FROM ohlc_daily
         WHERE symbol = ? AND ts_s BETWEEN ? AND ?
         ORDER BY ts_s ASC",
    )
    .bind(symbol)
    .bind(from_s)
    .bind(to_s)
    .fetch_all(pool)
    .await?;

    let candles = rows
        .iter()
        .map(|r| DailyCandle {
            ts_s: r.get("ts_s"),
            open: r.get("open"),
            high: r.get("high"),
            low: r.get("low"),
            close: r.get("close"),
        })
        .collect();

    Ok(candles)
}
