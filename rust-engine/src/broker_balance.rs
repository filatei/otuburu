//! Periodic LP balance sync for broker accounts. Sprint 5.9f.
//!
//! Every 60 seconds, for each Otuburu broker account
//! (type='broker' AND lp_link_id IS NOT NULL):
//!   1. Resolve the LP adapter via `UserLpCache` (Sprint 5.8)
//!   2. Call `adapter.account_summary()` to read LP-side balance
//!   3. Overwrite the engine's in-memory `book.account.balance`
//!   4. Update `accounts.balance` in Postgres so /auth/me sees fresh data
//!
//! Why this exists
//! ---------------
//! Without this loop, broker accounts created via POST /api/lp-links
//! (Sprint 5.9b) ship with balance=0. The engine's pre-trade margin
//! check then rejects every order against them with
//! "insufficient margin" — before the order ever reaches the LP.
//! 5.9f's poll loop is what makes broker accounts actually tradeable.
//!
//! Cadence
//! -------
//! 60s default. Configurable via `BROKER_BALANCE_INTERVAL_SECS`. 60s is
//! fast enough that the UI feels live, slow enough that MetaApi cloud-g2's
//! rate limits (60 req/min per account) aren't stressed even with dozens
//! of broker accounts in the same tenant.
//!
//! Failure semantics
//! -----------------
//! Per-account failures log at WARN and the loop continues — one broken
//! link doesn't block the rest. Postgres-query failures abort the entire
//! pass and retry next interval. Engine in-memory is updated BEFORE
//! Postgres; if Postgres update fails, the engine still has truth and
//! the next pass will retry the persist.
//!
//! Race with trade settlement
//! --------------------------
//! When a trade settles between two polls, engine balance briefly diverges
//! from LP balance until the broker processes the trade (typically <1s)
//! and the next poll reads the updated number. Overwriting unconditionally
//! is the right call — the LP is the source of truth for broker accounts.
//! Worst case is a 60s window of stale balance display; no money is lost.

use crate::state::SharedState;
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;

/// Default poll cadence — 60s. Keep in sync with the user_lp_cache
/// docs; MetaApi cloud-g2 allows 60 req/min/account so this is the
/// hottest cadence we can run without bumping into rate limits.
const DEFAULT_INTERVAL_SECS: u64 = 60;

/// Spawn the broker-balance poll task. Returns immediately; the task
/// runs in the background until the engine shuts down.
pub fn start(state: SharedState) {
    let interval_secs = std::env::var("BROKER_BALANCE_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECS);
    let interval = Duration::from_secs(interval_secs);

    tracing::info!(interval_secs, "broker balance poll task started");

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Skip the immediate first tick — give the engine a moment to
        // bootstrap (snapshot reload, gRPC server up) before hammering
        // LP APIs. Same pattern as reconcile::start.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            run_once(&state).await;
        }
    });
}

/// Run one balance-sync pass over every broker account. Public so a
/// future admin endpoint can trigger it on demand without waiting for
/// the next tick.
pub async fn run_once(state: &SharedState) {
    let pg = match state.user_lp_cache.pg() {
        Some(p) => p,
        None => {
            // Postgres unreachable — engine running in synthetic-only
            // mode. Nothing to do; reconcile wouldn't run either.
            return;
        }
    };

    // Pull every broker Otuburu account. The lp_link_id IS NOT NULL
    // filter is for safety: 'broker' rows with NULL lp_link_id are
    // orphans (link deleted; see Sprint 5.9a's bi-implication CHECK
    // relaxation). 5.9c's place_order will reject orders on orphans,
    // so polling them too would be wasted work.
    let rows = match sqlx::query(
        "SELECT id FROM accounts WHERE type = 'broker' AND lp_link_id IS NOT NULL",
    )
    .fetch_all(pg)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "broker balance: postgres query failed");
            return;
        }
    };

    let count = rows.len();
    if count == 0 {
        tracing::debug!("broker balance: no linked broker accounts to poll");
        return;
    }
    tracing::info!(count, "broker balance pass starting");

    let mut updated = 0usize;
    let mut failed = 0usize;
    for row in rows {
        let account_id: Uuid = row.get("id");
        match poll_one(state, account_id).await {
            Ok(()) => updated += 1,
            Err(e) => {
                failed += 1;
                tracing::warn!(
                    %account_id,
                    error = %e,
                    "broker balance: poll failed (other accounts still attempted)"
                );
            }
        }
    }
    tracing::info!(updated, failed, "broker balance pass done");
}

/// Poll one broker account: resolve adapter, fetch LP balance, sync to
/// engine + Postgres.
async fn poll_one(state: &SharedState, account_id: Uuid) -> anyhow::Result<()> {
    // Resolve via UserLpCache — same code path place_order uses, so we
    // reuse the cached adapter instead of opening a fresh MetaApi
    // WebSocket on every poll. The cache build path also touches
    // user_lp_links.last_used_at, which gives us free "active broker"
    // tracking for cleanup queries.
    let adapter = state
        .user_lp_cache
        .get_or_build(account_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("no LP adapter for broker account (link missing or kind unsupported)"))?;

    let summary = adapter.account_summary().await?;
    let lp_balance = summary.balance;

    // ── In-memory engine update ───────────────────────────────────────
    // Write lock for the duration of the balance overwrite. The book
    // might not exist yet (engine restart before any /api/accounts
    // /CreateAccount RPC for this broker); that's fine — next gateway
    // call provisions it, and the following poll will sync.
    {
        let mut inner = state.inner.write().await;
        if let Some(book) = inner.books.get_mut(&account_id) {
            let prev = book.account.balance;
            book.account.balance = lp_balance;
            if (prev - lp_balance).abs() > 0.0001 {
                tracing::debug!(
                    %account_id,
                    prev,
                    new = lp_balance,
                    "broker balance: in-memory updated"
                );
            }
        } else {
            tracing::debug!(
                %account_id,
                "broker balance: book not in memory yet (will sync after next CreateAccount)"
            );
        }
    }

    // ── Postgres persist ──────────────────────────────────────────────
    // Single statement, no tx. The type='broker' clause prevents this
    // from accidentally clobbering a synthetic-real row if the partial
    // index ever loosens. $1::numeric cast lets us bind f64 to the
    // NUMERIC(20,6) column — sqlx doesn't have a bigdecimal feature
    // enabled in this workspace.
    if let Some(pg) = state.user_lp_cache.pg() {
        if let Err(e) = sqlx::query(
            "UPDATE accounts SET balance = $1::numeric WHERE id = $2 AND type = 'broker'",
        )
        .bind(lp_balance)
        .bind(account_id)
        .execute(pg)
        .await
        {
            // Don't fail the whole poll — engine state is updated, which
            // is what matters for trade routing. Postgres lag fixes
            // itself on the next pass.
            tracing::warn!(
                error = %e,
                %account_id,
                "broker balance: postgres persist failed (engine in-memory still synced)"
            );
        }
    }

    tracing::info!(
        %account_id,
        lp_balance,
        currency = %summary.currency,
        "broker balance synced"
    );
    Ok(())
}
