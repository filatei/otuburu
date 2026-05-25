//! Spawns one async task per symbol — each calls its generator on a fixed
//! cadence, feeds the tick into every account book (MTM + settlement) and the
//! OHLC aggregators, then broadcasts to all gRPC subscribers.
//!
//! Also spawns:
//!   - A periodic snapshot task (60 s) for CFD position drift.
//!   - A daily OHLC flush task (every 5 min) to persist D1 candles to SQLite.

use std::time::Duration;
use tokio::time;
use tracing::debug;

use crate::state::SharedState;
use feed_generator::default_generators;

pub fn start(state: SharedState) {
    // ── Live price feeds (BTC/ETH/XAU) ───────────────────────────────────────
    // These override the synthetic generators for the three live symbols.
    // Synthetic generators still run for BOOM/CRASH and FX.
    crate::live_feed::start(state.clone());

    // ── Per-symbol tick tasks (synthetic) ────────────────────────────────────
    // Skip symbols that are handled by live_feed to avoid duplicate ticks.
    const LIVE_SYMBOLS: &[&str] = &["cryBTCUSD", "cryETHUSD", "cryXAUUSD"];
    for mut gen in default_generators()
        .into_iter()
        .filter(|g| !LIVE_SYMBOLS.contains(&g.symbol()))
    {
        let state = state.clone();
        let cadence = crate::state::symbol_cadence_ms(gen.symbol());

        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_millis(cadence));
            interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                let tick = gen.next_tick();
                debug!(symbol = %tick.symbol, mid = tick.mid, "tick");

                // ── Feed books + OHLC, collect settlements ────────────────────
                let (all_settled, maybe_snap) = {
                    let mut inner = state.inner.write().await;

                    // Update OHLC for this symbol across all resolutions.
                    inner.ohlc.on_tick(&tick.symbol, tick.ts, tick.mid);

                    // Tick every account book.
                    let mut all_settled = Vec::new();
                    let mut any_auto_close = false;
                    for book in inner.books.values_mut() {
                        let result = book.on_tick(&tick);

                        for s in &result.binary_settlements {
                            tracing::info!(
                                binary_id = %s.option.id,
                                account_id = %s.option.account_id,
                                won = s.won,
                                payout = s.payout,
                                "binary settled"
                            );
                        }
                        for ac in &result.auto_closed_cfds {
                            tracing::info!(
                                position_id = %ac.position.id,
                                account_id = %ac.position.account_id,
                                reason = ?ac.reason,
                                pnl = ac.pnl,
                                "CFD auto-closed"
                            );
                            any_auto_close = true;
                        }
                        for ac in &result.auto_closed_spots {
                            tracing::info!(
                                spot_id = %ac.position.id,
                                account_id = %ac.position.account_id,
                                pnl = ac.pnl,
                                "spot auto-closed"
                            );
                            any_auto_close = true;
                        }

                        all_settled.extend(result.binary_settlements);
                    }

                    // Snapshot when something changed balance.
                    let maybe_snap = if !all_settled.is_empty() || any_auto_close {
                        let snap_books = inner
                            .books
                            .values()
                            .map(|book| crate::persistence::BookSnapshot {
                                account: book.account.clone(),
                                positions: book.positions_snapshot(),
                                spots: book.spots_snapshot(),
                            })
                            .collect();
                        Some(crate::persistence::build(snap_books))
                    } else {
                        None
                    };

                    (all_settled, maybe_snap)
                    // Lock released here
                };

                // ── Persist settlements to SQLite ─────────────────────────────
                if !all_settled.is_empty() {
                    let settled_at_ms = chrono::Utc::now().timestamp_millis();
                    let db = state.db.clone();
                    let settled = all_settled.clone();
                    tokio::spawn(async move {
                        for s in &settled {
                            if let Err(e) =
                                crate::db::save_settled_trade(&db, s, settled_at_ms).await
                            {
                                tracing::error!(%e, "failed to save settled trade to DB");
                            }
                        }
                    });
                }

                // ── Persist snapshot ──────────────────────────────────────────
                if let Some(snap) = maybe_snap {
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = crate::persistence::save(&snap) {
                            tracing::error!(%e, "snapshot save failed after settlement");
                        }
                    });
                }

                // ── Broadcast tick ────────────────────────────────────────────
                if let Err(e) = state.tick_tx.send(tick) {
                    debug!("tick broadcast: no subscribers ({})", e);
                }
            }
        });
    }

    // ── Periodic snapshot task (60 s) ─────────────────────────────────────────
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
            interval.tick().await; // skip the immediate first tick

            loop {
                interval.tick().await;

                let snap = {
                    let inner = state.inner.read().await;
                    let snap_books = inner
                        .books
                        .values()
                        .map(|book| crate::persistence::BookSnapshot {
                            account: book.account.clone(),
                            positions: book.positions_snapshot(),
                            spots: book.spots_snapshot(),
                        })
                        .collect();
                    crate::persistence::build(snap_books)
                };

                tokio::task::spawn_blocking(move || {
                    if let Err(e) = crate::persistence::save(&snap) {
                        tracing::error!(%e, "periodic snapshot save failed");
                    }
                });
            }
        });
    }

    // ── Daily OHLC flush task (every 5 min) ───────────────────────────────────
    // Upserts the current in-progress D1 candle for each symbol into SQLite so
    // daily history survives restarts even before the candle closes.
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_secs(300));
            interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
            interval.tick().await; // skip immediate first tick

            loop {
                interval.tick().await;

                let snapshots = {
                    let inner = state.inner.read().await;
                    inner.ohlc.daily_snapshots()
                };

                let db = state.db.clone();
                tokio::spawn(async move {
                    for (sym, c) in snapshots {
                        if let Err(e) = crate::db::upsert_daily_candle(
                            &db, &sym, c.ts_s, c.open, c.high, c.low, c.close,
                        )
                        .await
                        {
                            tracing::error!(%e, symbol = %sym, "daily OHLC flush failed");
                        }
                    }
                });
            }
        });
    }
}
