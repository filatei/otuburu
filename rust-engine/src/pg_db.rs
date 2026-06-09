//! Postgres pool for the engine. Sprint 5.8.
//!
//! The engine's primary DB is still SQLite (settled trades + daily
//! OHLC, in `src/db.rs`). Postgres is a NEW secondary connection
//! pointing at the SAME instance the wallet + gateway use, dedicated
//! to reading `user_lp_links` so the engine can route Passthrough
//! orders through the user's own broker.
//!
//! Why a second pool instead of putting user_lp_links in SQLite?
//! ------------------------------------------------------------
//! The link row is WRITTEN by the gateway (the encryption key
//! flows through gateway → pgcrypto → bytea). The engine only READS
//! and DECRYPTS. Two-pool model means one source of truth, no
//! gateway→engine sync needed.
//!
//! Best-effort connection
//! ----------------------
//! If Postgres is unreachable at boot, [`connect`] returns an error
//! and the engine continues with `pg_pool = None` in SharedState.
//! Routing then falls back to the engine-wide LP adapter (the same
//! one used today). Per-user routing silently disables until the DB
//! is back. The engine_service::place_order branch logs a warn so
//! a missing link is observable in monitor.sh.

use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

/// DSN resolution mirrors wallet's pattern: prefer DATABASE_URL,
/// fall back to POSTGRES_* parts with reasonable defaults for the
/// docker-compose internal network.
fn dsn() -> String {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        if !url.is_empty() {
            return url;
        }
    }
    let user = env_or("POSTGRES_USER", "otuburu");
    let pass = env_or("POSTGRES_PASSWORD", "otuburu");
    let host = env_or("POSTGRES_HOST", "postgres");
    let port = env_or("POSTGRES_PORT", "5432");
    let db = env_or("POSTGRES_DB", "otuburu");
    format!("postgres://{user}:{pass}@{host}:{port}/{db}?sslmode=disable")
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Open a Postgres pool. Returns an error rather than panicking so
/// the caller can decide whether to fail boot (refuse to start) or
/// degrade gracefully (continue with no per-user routing).
///
/// Pool sizing is modest — the engine only hits Postgres on the
/// place_order hot path for Passthrough accounts. Most queries are
/// cached after first read.
pub async fn connect() -> anyhow::Result<PgPool> {
    let url = dsn();
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&url)
        .await?;
    Ok(pool)
}
