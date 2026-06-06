//! Stub LP adapter for dev / CI / first-boot.
//!
//! Returns deterministic in-memory fills at synthetic mid prices. The
//! reconcile job treats stub fills as "no LP delta" so it never flags
//! divergence — useful in CI where we don't want to hit OANDA.
//!
//! Active when neither OANDA_TOKEN nor OANDA_ACCOUNT_ID is set in env.
//! `from_env` logs a loud warning at boot so the stub mode is never
//! silent in production.

use crate::types::*;
use crate::LpAdapter;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct StubAdapter {
    /// Monotonic counter for fake order IDs. AtomicU64 because the
    /// adapter is shared across multiple task contexts.
    counter: AtomicU64,
}

impl StubAdapter {
    pub fn new() -> Self {
        Self {
            counter: AtomicU64::new(1),
        }
    }
}

impl Default for StubAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl LpAdapter for StubAdapter {
    fn name(&self) -> &str {
        "stub"
    }

    async fn place_market(&self, req: PlaceMarketRequest) -> anyhow::Result<MarketFill> {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        // Synthesise a fill at a price the engine would never reach.
        // Reconciliation tolerates ±$1 divergence; this 1.0 sentinel
        // makes stub fills obvious in admin reports.
        let units_signed = match req.side {
            Side::Buy => req.lots * 100_000.0,
            Side::Sell => -req.lots * 100_000.0,
        };
        Ok(MarketFill {
            lp_order_id: format!("stub-{n}"),
            instrument: req.instrument,
            units: units_signed,
            price: 1.0,
            commission: 0.0,
            financing: 0.0,
        })
    }

    async fn account_summary(&self) -> anyhow::Result<AccountSummary> {
        Ok(AccountSummary {
            account_id: "stub-account".to_string(),
            currency: "USD".to_string(),
            balance: 0.0,
            unrealised_pl: 0.0,
            open_position_count: 0,
        })
    }
}
