//! Shared types between adapters. Keep this file LP-vendor-neutral —
//! anything OANDA-specific lives in `oanda.rs`, not here.

use serde::{Deserialize, Serialize};

/// Direction of a market order, mirroring the engine's existing
/// `order_book::Side` but kept independent so we don't pull the order
/// book crate into liquidity-bridge (avoids a circular dep risk).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Buy,
    Sell,
}

/// Lot-sized market order. Field shapes deliberately match the engine's
/// existing CFD order proto so the bridge can be called with the same
/// values we already pass to the engine's place_order RPC.
#[derive(Debug, Clone, Serialize)]
pub struct PlaceMarketRequest {
    /// LP-side instrument name. Must already be translated from the
    /// engine's internal id (e.g. `cryXAUUSD`) to the LP's identifier
    /// (`XAU_USD` for OANDA). Translation lives in the engine glue,
    /// not in this crate, so adapters stay vendor-pure.
    pub instrument: String,
    pub side: Side,
    /// Lots — OANDA accepts units directly so the adapter multiplies
    /// by contract_size when serialising.
    pub lots: f64,
    /// Engine-side reference for the reconciliation job. Stored in the
    /// LP's `clientExtensions.id` so we can match LP fills back to
    /// engine positions at end-of-day.
    pub engine_position_id: String,
}

/// Fill report from the LP. All fields optional except instrument +
/// units + price because some LPs report partial fills async.
#[derive(Debug, Clone, Deserialize)]
pub struct MarketFill {
    /// LP-side transaction or trade id. Stored on the engine position
    /// for reconcile and dispute handling.
    pub lp_order_id: String,
    pub instrument: String,
    pub units: f64, // signed: positive for BUY fills, negative for SELL
    pub price: f64, // average fill price
    /// LP-side commission charged on this fill. Goes into the engine's
    /// house revenue tracking (negative — we pay LP, recover via markup).
    pub commission: f64,
    /// LP-side spread financing / overnight fees so we can reconcile
    /// against the engine's own carry calculations.
    pub financing: f64,
}

/// Snapshot of the LP-side account, polled nightly by the reconcile
/// job. The reconcile job compares this against the engine's house
/// stats — divergences > $1 trigger an admin email.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountSummary {
    pub account_id: String,
    pub currency: String,
    pub balance: f64,
    pub unrealised_pl: f64,
    /// Number of open positions at the LP. Should equal the engine's
    /// open passthrough position count (ignoring synthetic books).
    pub open_position_count: i32,
}
