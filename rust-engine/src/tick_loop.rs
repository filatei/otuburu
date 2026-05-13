//! Spawns one async task per symbol — each calls its generator on a fixed
//! cadence, feeds the tick into the order book (MTM + settlement), and
//! broadcasts it to all gRPC subscribers.

use std::time::Duration;
use tokio::time;
use tracing::debug;

use crate::state::SharedState;
use feed_generator::default_generators;

pub fn start(state: SharedState) {
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

                // Feed tick into the order book (MTM + binary settlement)
                {
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
                }

                // Broadcast to all gRPC tick subscribers (errors = no subscribers, fine)
                if let Err(e) = state.tick_tx.send(tick) {
                    debug!("tick broadcast: no subscribers ({})", e);
                }
            }
        });
    }
}
