//! Spawns one async task per symbol — each calls its generator on a fixed
//! cadence, feeds the tick into the order book (MTM + settlement), and
//! broadcasts it to all gRPC subscribers.
//!
//! Also spawns a periodic snapshot task that saves state every 60 s so that
//! CFD position changes (open, close, MTM) are captured even between settlements.

use std::time::Duration;
use tokio::time;
use tracing::debug;

use crate::state::SharedState;
use feed_generator::default_generators;

pub fn start(state: SharedState) {
    // ── Per-symbol tick tasks ─────────────────────────────────────────────────
    for mut gen in default_generators() {
        let state = state.clone();
        let cadence = crate::state::symbol_cadence_ms(gen.symbol());

        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_millis(cadence));
            interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                let tick = gen.next_tick();
                debug!(symbol = %tick.symbol, mid = tick.mid, "tick");

                // Feed tick into the order book; capture snapshot data if anything settled
                let snap = {
                    let mut inner = state.inner.write().await;
                    let settled = inner.book.on_tick(&tick);

                    for s in &settled {
                        tracing::info!(
                            binary_id = %s.option.id,
                            won        = s.won,
                            payout     = s.payout,
                            "binary settled"
                        );
                    }

                    // Build snapshot while holding the lock so data is consistent.
                    // Only do this when something actually changed (a settlement happened).
                    if !settled.is_empty() {
                        Some(crate::persistence::build(
                            inner.book.account.clone(),
                            inner.book.positions_snapshot(),
                        ))
                    } else {
                        None
                    }
                    // Lock dropped here
                };

                // Persist asynchronously — do NOT hold the book lock during I/O
                if let Some(snap) = snap {
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = crate::persistence::save(&snap) {
                            tracing::error!(%e, "failed to save snapshot after settlement");
                        }
                    });
                }

                // Broadcast tick to all gRPC subscribers (error = no subscribers, fine)
                if let Err(e) = state.tick_tx.send(tick) {
                    debug!("tick broadcast: no subscribers ({})", e);
                }
            }
        });
    }

    // ── Periodic snapshot task ─────────────────────────────────────────────────
    // Saves every 60 s regardless of settlements — catches CFD open/close/MTM.
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
                    crate::persistence::build(
                        inner.book.account.clone(),
                        inner.book.positions_snapshot(),
                    )
                };

                tokio::task::spawn_blocking(move || {
                    if let Err(e) = crate::persistence::save(&snap) {
                        tracing::error!(%e, "periodic snapshot save failed");
                    }
                });
            }
        });
    }
}
