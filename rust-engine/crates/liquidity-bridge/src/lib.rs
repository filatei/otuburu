//! liquidity-bridge — outbound order routing to external LPs.
//!
//! The engine stays vendor-agnostic via the [`LpAdapter`] trait; each
//! supported LP gets a concrete implementation.
//!
//! ## Adapter status
//!
//! - [`CTrader`]: cTrader Open API (Protobuf-over-WebSocket).
//!   **Production target** for Nigerian users via IC Markets (Raw
//!   Trading Ltd, Seychelles FSA). Free, no SaaS middleman, real
//!   protocol. Scaffolded in Sprint 5.4a; protocol work lands in
//!   5.4b–5.4d. Auto-selected when `CTRADER_CLIENT_ID` +
//!   `CTRADER_CLIENT_SECRET` + `CTRADER_ACCESS_TOKEN` +
//!   `CTRADER_ACCOUNT_ID` are set in env.
//! - [`MetaApi`]: SaaS bridge wrapping MT4/MT5 server connections as
//!   a REST API. Reference implementation; not in active production
//!   use (paid ~$9/mo per account). Kept as fallback if cTrader Open
//!   API becomes unavailable.
//! - [`OandaV20`]: reference REST adapter for OANDA. **Does NOT accept
//!   Nigerian residents** (OANDA blocks the country at signup). Kept
//!   as canonical example for future EU/US/AU jurisdictions.
//! - [`StubAdapter`]: dev-only fallback when no LP env is configured.
//!
//! Selection order in [`from_env`]: cTrader → MetaApi → OANDA → Stub.
//!
//! ## Architecture
//!
//! ```text
//!  Engine PlaceOrder (passthrough route)
//!         │
//!         ▼
//!  LpAdapter::place_market(symbol, side, lots)
//!         │
//!         ▼
//!  ┌─ CTrader (Protobuf/WS) ─┐ ┌─ MetaApi (REST) ──┐ ┌─ Stub ───────┐
//!  │ wss://*.ctraderapi.com  │ │ HTTPS to MetaApi  │ │ fake fills,  │
//!  │ → ProtoOANewOrderReq    │ │ → /trade endpoint │ │ dev-only     │
//!  │ → ProtoOAExecutionEvent │ │ → fill ack        │ │              │
//!  └─────────────────────────┘ └───────────────────┘ └──────────────┘
//! ```
//!
//! ## Activation model
//!
//! Read-time toggle: per-account `routing_mode` (synthetic | passthrough)
//! stored in the engine's `Book`. Passthrough is **admin-flagged only**
//! today — there is NO public opt-in path in the v1 UI. Once Otuburu has
//! an Introducing Broker agreement with the LP (or a Nigerian broker
//! license), the public toggle gets unlocked in a follow-up.
//!
//! ## Env detection
//!
//! [`from_env`] picks the first adapter whose env vars are fully present,
//! falling back to [`StubAdapter`] if none. Picks demo over live by
//! default (CTRADER_ENV/OANDA_ENV) so misconfigured deploys can't route
//! to real markets accidentally.
//!
//! References
//! ----------
//! - cTrader Open API: <https://help.ctrader.com/open-api/>
//! - OANDA v20 REST:   <https://developer.oanda.com/rest-live-v20/>
//! - MetaApi REST:     <https://metaapi.cloud/docs/client/restApi/api/>

use std::env;
use std::sync::Arc;

pub mod ctrader;
#[allow(dead_code)] // wired into ctrader.rs in Sprint 5.4c (auth handshake)
mod ctrader_ws; // internal — WS connect/send/recv primitives for ctrader.rs
pub mod metaapi;
pub mod oanda;
pub mod stub;
pub mod types;

pub use ctrader::CTrader;
pub use metaapi::MetaApi;
pub use oanda::OandaV20;
pub use stub::StubAdapter;
pub use types::*;

/// LpAdapter — the boundary between the engine and any external LP.
///
/// Implementations must be `Send + Sync` because the engine calls them
/// from multiple task contexts (tick loop, order RPC handler,
/// reconciliation job). All methods are async because every real LP
/// involves network I/O.
#[async_trait::async_trait]
pub trait LpAdapter: Send + Sync {
    /// Human-readable name for logs + admin UI ("ctrader-demo",
    /// "ctrader-live", "metaapi-london", "oanda-practice", "stub").
    fn name(&self) -> &str;

    /// Place a market order at the LP. Returns the LP-side fill report
    /// when accepted; bubbles up the error string when rejected (use
    /// these reasons in `kyc_submissions`-style audit trails — never
    /// expose them raw to end users, they often contain LP-specific
    /// IDs and rate-limit hints).
    async fn place_market(&self, order: PlaceMarketRequest)
        -> anyhow::Result<MarketFill>;

    /// Fetch the LP-side account summary. Used by the reconciliation
    /// job at end-of-day to compare engine books vs LP books.
    async fn account_summary(&self) -> anyhow::Result<AccountSummary>;

    /// Quick health probe for the boot-time smoke check.
    async fn ping(&self) -> anyhow::Result<()> {
        // Default implementation just calls account_summary and
        // discards the result. Concrete adapters can override with a
        // cheaper endpoint (OANDA has /v3/accounts which is lighter).
        self.account_summary().await.map(|_| ())
    }
}

/// from_env — auto-select the adapter to wire into the engine at boot.
///
/// Selection order (first matching wins):
///   1. cTrader Open API — `CTRADER_CLIENT_ID` + `CTRADER_CLIENT_SECRET`
///      + `CTRADER_ACCESS_TOKEN` + `CTRADER_ACCOUNT_ID` all set.
///      `CTRADER_ENV` picks `demo` (default) vs `live`. Production
///      target for Nigerian users via IC Markets.
///   2. MetaApi.cloud (Exness/MT5 bridge) — both `METAAPI_TOKEN` and
///      `METAAPI_ACCOUNT_ID` set. `METAAPI_REGION` picks the cluster
///      (`new-york` default, `london`, `singapore`). Kept as fallback.
///   3. OANDA v20 (REST) — both `OANDA_TOKEN` and `OANDA_ACCOUNT_ID`
///      set. `OANDA_ENV` picks `practice` (default) vs `live`. Note:
///      OANDA blocks Nigerian residents, so this branch is for
///      EU/US/AU jurisdictions only.
///   4. Stub — none of the above set. Logs a loud warning at boot so
///      deployments with an env passthrough bug are obvious.
///
/// Wrapped in Arc<dyn> so the engine can clone the handle into tasks
/// without re-allocating.
pub fn from_env() -> Arc<dyn LpAdapter> {
    // 1. cTrader Open API — primary for Nigerian users with an IC
    //    Markets cTrader account.
    if let (Some(client_id), Some(client_secret), Some(access_token), Some(account_id)) = (
        env::var("CTRADER_CLIENT_ID").ok().filter(|s| !s.is_empty()),
        env::var("CTRADER_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
        env::var("CTRADER_ACCESS_TOKEN").ok().filter(|s| !s.is_empty()),
        env::var("CTRADER_ACCOUNT_ID").ok().filter(|s| !s.is_empty()),
    ) {
        let env_label = env::var("CTRADER_ENV").unwrap_or_else(|_| "demo".to_string());
        tracing::info!(
            env = %env_label,
            account = %account_id,
            "lp-bridge: cTrader Open API adapter ready (IC Markets)"
        );
        return Arc::new(CTrader::new(
            client_id,
            client_secret,
            access_token,
            account_id,
            env_label,
        ));
    }

    // 2. MetaApi — fallback for users on Exness/MT5 (paid SaaS).
    if let (Some(token), Some(account_id)) = (
        env::var("METAAPI_TOKEN").ok().filter(|s| !s.is_empty()),
        env::var("METAAPI_ACCOUNT_ID").ok().filter(|s| !s.is_empty()),
    ) {
        let region = env::var("METAAPI_REGION").unwrap_or_else(|_| "new-york".to_string());
        tracing::info!(
            region = %region,
            account = %account_id,
            "lp-bridge: MetaApi adapter ready (MT5/Exness bridge)"
        );
        return Arc::new(MetaApi::new(token, account_id, region));
    }

    // 3. OANDA fallback for non-NG jurisdictions.
    if let (Some(token), Some(account_id)) = (
        env::var("OANDA_TOKEN").ok().filter(|s| !s.is_empty()),
        env::var("OANDA_ACCOUNT_ID").ok().filter(|s| !s.is_empty()),
    ) {
        let env_label = env::var("OANDA_ENV").unwrap_or_else(|_| "practice".to_string());
        tracing::info!(
            env = %env_label,
            account = %account_id,
            "lp-bridge: OANDA v20 adapter ready"
        );
        return Arc::new(OandaV20::new(token, account_id, env_label));
    }

    // 4. Stub fallback.
    tracing::warn!(
        "lp-bridge: no LP env configured — using STUB adapter (all passthrough \
         orders fill at synthetic prices). Set CTRADER_* (preferred, free via \
         IC Markets), METAAPI_* (paid MT5 bridge), or OANDA_* to route to real \
         markets."
    );
    Arc::new(StubAdapter::new())
}
