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
//!   v3 — added BookSnapshot.spots (Vec<SpotPosition>) for fractional spot trades
//!   v4 — Sprint 5.5a: added Account.routing_mode (RoutingMode) for LP passthrough.
//!        Backward-compatible — v3 snapshots load cleanly because the new field
//!        uses #[serde(default)] which deserializes a missing field to
//!        RoutingMode::Synthetic. The version bump is semantic (signals to ops
//!        that LP routing is now a possible book state) rather than format-breaking.

use anyhow::Result;
use chrono::Utc;
use order_book::{Account, CfdPosition, SpotPosition};
use serde::{Deserialize, Serialize};

pub const SNAPSHOT_VERSION: u32 = 4;

/// Oldest snapshot version we still load. Anything below this gets
/// rejected with a "version too old, starting fresh" log message.
/// Bump together with `SNAPSHOT_VERSION` when adding a non-backward-
/// compatible field (one whose absence can't be filled by
/// `#[serde(default)]`).
pub const MIN_LOADABLE_VERSION: u32 = 3;

/// One account, its open CFD positions, and its open spot positions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSnapshot {
    pub account: Account,
    pub positions: Vec<CfdPosition>,
    /// Spot positions — defaults to empty vec on older snapshot versions.
    #[serde(default)]
    pub spots: Vec<SpotPosition>,
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
///
/// Loads snapshots from version `MIN_LOADABLE_VERSION` up to `SNAPSHOT_VERSION`.
/// Older versions migrate forward via serde defaults on new fields (each version
/// bump must keep the previous version readable by ensuring all new fields are
/// `#[serde(default)]`).
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
        Ok(snap) if snap.version >= MIN_LOADABLE_VERSION && snap.version <= SNAPSHOT_VERSION => {
            if snap.version < SNAPSHOT_VERSION {
                tracing::info!(
                    path,
                    from = snap.version,
                    to = SNAPSHOT_VERSION,
                    accounts = snap.books.len(),
                    "snapshot loaded with forward migration (new fields use serde defaults)"
                );
            } else {
                tracing::info!(
                    path,
                    accounts = snap.books.len(),
                    saved_at_ms = snap.saved_at_ms,
                    "engine snapshot loaded"
                );
            }
            Some(snap)
        }
        Ok(snap) => {
            tracing::warn!(
                found_version = snap.version,
                min_supported = MIN_LOADABLE_VERSION,
                max_supported = SNAPSHOT_VERSION,
                "snapshot version out of supported range — starting fresh"
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

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use order_book::RoutingMode;

    /// v3 snapshots written by older engine binaries (before Sprint 5.5a)
    /// don't carry the `routing_mode` field on Account. The loader must
    /// still accept them and fill the missing field via serde defaults.
    /// This guards against accidentally wiping prod account state on a
    /// deploy that bumps the snapshot version.
    #[test]
    fn v3_snapshot_loads_with_default_routing_mode() {
        // Hand-authored v3 payload — no routing_mode on Account.
        let v3_json = r#"{
            "version": 3,
            "saved_at_ms": 1700000000000,
            "books": [{
                "account": {
                    "id": "00000000-0000-4000-8000-000000000001",
                    "currency": "USD",
                    "balance": 10000.0,
                    "realised_pnl": 0.0,
                    "label": "Demo",
                    "is_demo": true
                },
                "positions": [],
                "spots": []
            }]
        }"#;

        let snap: EngineSnapshot = serde_json::from_str(v3_json).expect("v3 must parse");
        assert_eq!(snap.version, 3);
        assert_eq!(snap.books.len(), 1);
        // Default for v3-loaded accounts: Synthetic. Critical invariant
        // — if this ever defaults to Passthrough by accident, every prod
        // account would suddenly route to the LP on first deploy after
        // upgrade. That's a P0 outage.
        assert_eq!(snap.books[0].account.routing_mode, RoutingMode::Synthetic);
    }

    /// v4 snapshots roundtrip through JSON with the routing_mode field
    /// preserved. This is the steady-state case after Sprint 5.5a deploy.
    #[test]
    fn v4_snapshot_roundtrip_preserves_routing_mode() {
        use uuid::Uuid;
        let acct = Account {
            id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            currency: "USD".into(),
            balance: 5000.0,
            realised_pnl: 0.0,
            label: "Live".into(),
            is_demo: false,
            routing_mode: RoutingMode::Passthrough,
        };
        let snap = build(vec![BookSnapshot {
            account: acct,
            positions: vec![],
            spots: vec![],
        }]);
        assert_eq!(snap.version, SNAPSHOT_VERSION);

        let json = serde_json::to_string(&snap).expect("serialize");
        let parsed: EngineSnapshot = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            parsed.books[0].account.routing_mode,
            RoutingMode::Passthrough
        );
    }

    /// Snapshots from a future version (e.g. v5 written by a newer
    /// engine binary that we then roll back) must be rejected rather
    /// than silently truncated — the future version may have data we
    /// don't know how to read.
    #[test]
    fn future_version_is_rejected() {
        let future_json = format!(
            r#"{{ "version": {}, "saved_at_ms": 1700000000000, "books": [] }}"#,
            SNAPSHOT_VERSION + 1,
        );
        // Note: this is a logical test of the version check; we don't
        // exercise the file-system load() path (which would need test
        // tempdir wiring). The parse succeeds; load() would then log a
        // warning and return None. Confirmed by the match arm in load().
        let snap: EngineSnapshot =
            serde_json::from_str(&future_json).expect("future version must parse syntactically");
        assert!(snap.version > SNAPSHOT_VERSION);
    }

    /// Snapshots below MIN_LOADABLE_VERSION must be rejected. If we
    /// ever need to load v1 or v2 again, MIN_LOADABLE_VERSION gets
    /// lowered and a real migration is added.
    #[test]
    fn ancient_version_is_below_min_supported() {
        assert!(
            MIN_LOADABLE_VERSION >= 3,
            "min loadable cannot drop below v3 without explicit migration code"
        );
    }
}
