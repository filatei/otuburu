//! cTrader Open API adapter.
//!
//! Status
//! ------
//! Sprint 5.4a — **scaffold only**. The struct, env detection, and
//! LpAdapter impl shell are in place; all RPC methods return an
//! "unimplemented" error. Real protocol work lands in Sprint 5.4b
//! (WebSocket framing + clientMsgId correlator), 5.4c (OAuth + auth
//! handshake + account_summary), 5.4d (place_market + execution events).
//!
//! Why this adapter exists
//! -----------------------
//! cTrader Open API is the **production** routing target for Nigerian
//! users. It's free (no SaaS middleman like MetaApi), available via
//! IC Markets (Raw Trading Ltd, Seychelles FSA), and uses a real
//! protocol (Protocol Buffers over WebSocket) rather than a wrapped
//! desktop terminal session.
//!
//! Connection model
//! ----------------
//! Two long-lived WebSocket connections per cTrader ID, both TLS:
//!   - Trader connection: live.ctraderapi.com:5036 (or demo.*)
//!     handles account state, position list, orders, executions.
//!   - Spot connection: same host different protocol layer for price
//!     subscriptions (not needed for our routing use case — we get
//!     prices from our own feeds and only need cTrader for execution).
//!
//! Auth model
//! ----------
//! Two-step.
//!   1. OAuth 2.0 against connect.icmarkets.com — exchange client_id +
//!      client_secret + redirect_uri for an access_token. Refresh token
//!      issued; we refresh well before the 30-day expiry.
//!   2. Per-WS-session protobuf handshake:
//!      a. Send ProtoOAApplicationAuthReq (client_id + client_secret).
//!      b. Send ProtoOAAccountAuthReq (ctidTraderAccountId + access_token).
//!      Both must succeed before any other message will be accepted.
//!
//! Reconnect
//! ---------
//! Sessions die on idle (~10 min), server restart, or transient network
//! blip. Adapter wraps the WS in a reconnect-with-backoff loop and
//! re-runs the auth handshake before resuming traffic.
//!
//! Env
//! ---
//!   CTRADER_CLIENT_ID       — OAuth app client ID from openapi.ctrader.com
//!   CTRADER_CLIENT_SECRET   — OAuth app secret (TREAT AS PASSWORD)
//!   CTRADER_ACCESS_TOKEN    — current access_token (we exchange for a
//!                             refresh_token once and rotate from there)
//!   CTRADER_ACCOUNT_ID      — ctidTraderAccountId (numeric; cTrader-side
//!                             account id, NOT the broker login number)
//!   CTRADER_ENV             — "demo" (default) or "live"
//!
//! Reference: https://help.ctrader.com/open-api/

use crate::types::*;
use crate::LpAdapter;
use anyhow::bail;

pub struct CTrader {
    client_id:     String,
    #[allow(dead_code)] // wired in 5.4c when we implement OAuth refresh
    client_secret: String,
    #[allow(dead_code)] // wired in 5.4c when we open the WS
    access_token:  String,
    #[allow(dead_code)] // wired in 5.4c when we send ProtoOAAccountAuthReq
    account_id:    String,
    /// "demo" or "live" — picks the WS host (demo.ctraderapi.com vs
    /// live.ctraderapi.com). Default demo to keep early integration safe.
    env:           String,
}

impl CTrader {
    pub fn new(
        client_id:     String,
        client_secret: String,
        access_token:  String,
        account_id:    String,
        env:           String,
    ) -> Self {
        Self { client_id, client_secret, access_token, account_id, env }
    }

    /// Host for the WebSocket. Lives here so 5.4b can pick it up
    /// without re-deriving in the connection-loop module.
    #[allow(dead_code)] // used in 5.4b
    pub(crate) fn ws_host(&self) -> &'static str {
        match self.env.as_str() {
            "live" => "live.ctraderapi.com:5036",
            _      => "demo.ctraderapi.com:5036",
        }
    }

    /// OAuth token endpoint — IC Markets-specific. Other brokers using
    /// cTrader (Pepperstone, Spotware-direct) will need this swapped.
    /// Lives here so we can override per-broker once we support
    /// multiple in production. For Sprint 5.4 we hard-code IC.
    #[allow(dead_code)] // used in 5.4c
    pub(crate) fn oauth_token_url() -> &'static str {
        "https://connect.icmarkets.com/api/v2/oauth/token"
    }
}

#[async_trait::async_trait]
impl LpAdapter for CTrader {
    fn name(&self) -> &str {
        match self.env.as_str() {
            "live" => "ctrader-live",
            _      => "ctrader-demo",
        }
    }

    async fn place_market(&self, _order: PlaceMarketRequest) -> anyhow::Result<MarketFill> {
        // Sprint 5.4d: send ProtoOANewOrderReq (MARKET, BUY|SELL, lots),
        // correlate inbound ProtoOAExecutionEvent for the fill report.
        // Map cTrader reject codes to anyhow errors with the LP-side
        // reason verbatim for the audit trail.
        bail!(
            "ctrader place_market not yet implemented (Sprint 5.4d). \
             client_id={} env={}",
            self.client_id,
            self.env,
        )
    }

    async fn account_summary(&self) -> anyhow::Result<AccountSummary> {
        // Sprint 5.4c: open WS → app auth → account auth →
        // ProtoOATraderReq → ProtoOATraderRes → map to AccountSummary.
        // Cache the response for ~60s to avoid hammering on each
        // reconcile poll (reconcile cron in 5.6 only needs it nightly,
        // but if we expose this via admin UI later it'd be hot).
        bail!(
            "ctrader account_summary not yet implemented (Sprint 5.4c). \
             client_id={} env={}",
            self.client_id,
            self.env,
        )
    }
}
