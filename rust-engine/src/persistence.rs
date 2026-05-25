//! Engine state persistence — atomic JSON snapshots to disk.
//!
//! On startup: load the last snapshot and restore all account books + open CFD positions.
//! After each binary settlement: save a new snapshot asynchronously.
//! Every 60 seconds: save unconditionally (catches CFD P&L drift, manual closes, etc.)
//!
//! Snapshot path: SNAPSHOT_PATH env var, default /data/engine_snapshot.json
//! Atomic writes: write to .tmp then rename — never leaves a half-written file.
//!
//! Version history:
//!   v1 — single account (account + positions fields)
//!   v2 — multi-account (books: Vec<BookSnapshot>)

use anyhow::Result;
use chrono::Utc;
use order_book::{Account, CfdPosition};
use serde::{Deserialize, Serialize};

pub const SNAPSHOT_VERSION: u32 = 2;

/// One account and its open CFD positions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSnapshot {
    pub account: Account,
    pub positions: Vec<CfdPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSnapshot {
    /// Schema version — bump when fields change to allow forward migration.
    pub version: u32,
    /// Unix ms when this snapshot was written.
    pub saved_at_ms: i64,
    /// All trading accounts. Binaries are NOT persisted — they expire in ≤200 ticks.
    pub books: Vec<BookSnapshot>,
}

pub fn snapshot_path() -> String {
    std::env::var("SNAPSHOT_PATH").unwrap_or_else(|_| "/data/engine_snapshot.json".into())
}

/// Load the last snapshot from disk. Returns `None` on any error (missing file,
/// corrupt JSON, version mismatch) so the caller falls back to a fresh account.
pub fn load() -> Option<EngineSnapshot> {
    let path = snapshot_path();
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => {
            tracing::info!(path, "no snapshot found — starting with fresh demo account");
            return None;
        }
    };

    match serde_json::from_str::<EngineSnapshot>(&data) {
        Ok(snap) if snap.version == SNAPSHOT_VERSION => {
            tracing::info!(
                path,
                accounts = snap.books.len(),
                saved_at_ms = snap.saved_at_ms,
                "engine snapshot loaded"
            );
            Some(snap)
        }
        Ok(snap) => {
            tracing::warn!(
                found_version = snap.version,
                expected = SNAPSHOT_VERSION,
                "snapshot version mismatch — starting fresh"
            );
            None
        }
        Err(e) => {
            tracing::error!(%e, "snapshot parse error — starting fresh");
            None
        }
    }
}

/// Save a snapshot atomically. Blocking — call via `tokio::task::spawn_blocking`.
pub fn save(snap: &EngineSnapshot) -> Result<()> {
    let path = snapshot_path();
    let tmp = format!("{path}.tmp");

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(snap)?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;

    tracing::debug!(path, accounts = snap.books.len(), "snapshot saved");
    Ok(())
}

/// Build a snapshot from the current set of books.
pub fn build(books: Vec<BookSnapshot>) -> EngineSnapshot {
    EngineSnapshot {
        version: SNAPSHOT_VERSION,
        saved_at_ms: Utc::now().timestamp_millis(),
        books,
    }
}
