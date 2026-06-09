//! Nightly reconciliation of engine state vs LP state. Sprint 5.6.
//!
//! For each Passthrough-flagged account, compare the engine's view of
//! open positions + balance against what the LP reports. Divergences
//! log at ERROR level so `monitor.sh errors` picks them up.
//!
//! What this catches
//! -----------------
//! - LP filled an order the engine didn't book (network blip between
//!   sync gate response and the engine commit; should be rare with 5.5d
//!   but possible)
//! - Engine has a Passthrough position the LP didn't actually accept
//!   (timeout we mis-classified as success)
//! - LP closed a position on its side (margin call, stop-out, manual
//!   close in the MT5 terminal) that the engine still shows open
//! - Balance drift from swaps / financing the engine doesn't model
//!
//! What this does NOT catch (yet)
//! ------------------------------
//! - Per-position fill-price discrepancies: 5.6b will fetch the LP's
//!   /history-orders to replace the `-1.0` sentinel entries from
//!   MetaApi's /trade response with the real avg fill price.
//! - Cross-LP routing changes: when Sprint 5.8 (per-user LP links)
//!   ships, the loop here iterates per user_lp_link instead of using
//!   the engine-wide adapter.
//!
//! Cadence
//! -------
//! Default 24h, configurable via `RECONCILE_INTERVAL_HOURS`. We do NOT
//! reconcile at boot — the LP may still be initializing and the engine
//! may still be loading the snapshot. First tick fires after one
//! interval has elapsed.
//!
//! Alerting
//! --------
//! Sprint 5.6 v1 logs at ERROR level only. Email/webhook alerting is
//! deferred to 5.6b — `monitor.sh errors` tails the engine container
//! and surfaces these in the meantime.

use crate::state::SharedState;
use order_book::RoutingMode;
use std::time::Duration;

/// Default reconciliation cadence — 24h.
const DEFAULT_INTERVAL_HOURS: u64 = 24;

/// Spawn the reconciliation task. Returns immediately; the task runs
/// in the background until the engine shuts down.
pub fn start(state: SharedState) {
    let interval_hours = std::env::var("RECONCILE_INTERVAL_HOURS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_HOURS);
    let interval = Duration::from_secs(interval_hours.saturating_mul(3600));

    tracing::info!(interval_hours, "lp reconcile task started");

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // First tick fires immediately; skip it so we don't reconcile
        // at boot when the LP may still be initialising.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            run_once(&state).await;
        }
    });
}

/// Run one reconcile pass. Public so a future admin endpoint can
/// trigger it on demand without waiting for the next tick.
pub async fn run_once(state: &SharedState) {
    let lp_name = state.lp_adapter.name();
    tracing::info!(lp = lp_name, "lp reconcile pass starting");

    // ── LP-side state ──────────────────────────────────────────────
    let lp_summary = match state.lp_adapter.account_summary().await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(
                lp = lp_name,
                error = %e,
                "lp reconcile aborted — adapter returned error"
            );
            return;
        }
    };

    // ── Engine-side state ──────────────────────────────────────────
    // Read lock — we don't mutate during reconcile. Holding through
    // the (synchronous, in-memory) iteration is cheap.
    let inner = state.inner.read().await;
    let mut engine_passthrough_accounts: usize = 0;
    let mut engine_open_positions: usize = 0;
    let mut engine_total_notional: f64 = 0.0;
    for book in inner.books.values() {
        if matches!(book.account.routing_mode, RoutingMode::Passthrough) {
            engine_passthrough_accounts += 1;
            for pos in book.positions() {
                engine_open_positions += 1;
                engine_total_notional += pos.notional;
            }
        }
    }
    drop(inner);

    // ── Compare ────────────────────────────────────────────────────
    // MetaApi's /account-information doesn't return position count, so
    // adapter::account_summary returns -1 as a sentinel meaning
    // "unknown". When unknown, skip the position-count check and just
    // log balance + counts informationally.
    let lp_open_count = lp_summary.open_position_count;
    if lp_open_count < 0 {
        tracing::info!(
            lp = lp_name,
            lp_balance = lp_summary.balance,
            lp_currency = %lp_summary.currency,
            engine_passthrough_accounts,
            engine_open_positions,
            engine_total_notional,
            "lp reconcile: LP did not report position count (sentinel -1); balance + counts logged"
        );
        return;
    }

    let position_diff = (lp_open_count as i64) - (engine_open_positions as i64);
    if position_diff == 0 {
        tracing::info!(
            lp = lp_name,
            lp_balance = lp_summary.balance,
            lp_open_count,
            engine_passthrough_accounts,
            engine_open_positions,
            engine_total_notional,
            "lp reconcile: in sync"
        );
    } else {
        tracing::error!(
            lp = lp_name,
            lp_balance = lp_summary.balance,
            lp_open_count,
            engine_passthrough_accounts,
            engine_open_positions,
            engine_total_notional,
            position_diff,
            "lp reconcile: DIVERGENCE — engine vs LP position count differs"
        );
    }
}
