//! MetaApi.cloud REST adapter.
//!
//! MetaApi is a SaaS that wraps MT4/MT5 server connections as a clean
//! REST + WebSocket API. The intended use here is bridging Otuburu to
//! an existing Exness MT5 account (which has no public REST API of
//! its own) by routing through MetaApi as a middleman.
//!
//! Setup
//! -----
//! 1. Sign up at https://metaapi.cloud. Pricing is metered per account
//!    per hour: cloud-g2 ~ $0.0126/hr (~$9.20/mo, both demo and live);
//!    add-account one-time ~ $2.10. Cost stops only when the account is
//!    undeployed.
//! 2. Add your Exness MT5 account via their Account Management UI:
//!    server name (`Exness-MT5Real4` etc.), login, master password
//!    (investor is read-only and will NOT allow trade placement),
//!    account name.
//! 3. Once status flips to DEPLOYED, copy the account UUID and an
//!    auth-token from the Tokens page.
//!
//! Env
//! ---
//!   METAAPI_TOKEN       — Bearer token from the Tokens page
//!   METAAPI_ACCOUNT_ID  — UUID of the deployed MT5 account
//!   METAAPI_REGION      — "new-york" (default), "london", "singapore"
//!
//! Endpoints used
//! --------------
//!   GET /users/current/accounts/{accountId}/account-information
//!   POST /users/current/accounts/{accountId}/trade
//!
//! Reference: https://metaapi.cloud/docs/client/restApi/api/
//!
//! Trust note
//! ----------
//! MetaApi stores your MT5 password to maintain the server connection.
//! Read their security model before sending live credentials. Sandbox
//! /demo MT5 accounts can be wired up with zero trust risk to bench
//! the integration first.

use crate::types::*;
use crate::LpAdapter;
use anyhow::{anyhow, Context};
use serde::Deserialize;
use std::time::Duration;

pub struct MetaApi {
    token: String,
    account_id: String,
    /// MetaApi splits the API across regional clusters. `new-york` is
    /// their primary US-East cluster; users in EU/APAC pick `london`
    /// or `singapore` for lower latency. Affects only the host name.
    region: String,
    base_url: String,
    http: reqwest::Client,
}

impl MetaApi {
    pub fn new(token: String, account_id: String, region: String) -> Self {
        // mt-client-api is the lower-latency cluster for trade + read
        // calls; the v1 path is stable.
        let base_url = format!(
            "https://mt-client-api-v1.{region}.agiliumtrade.ai",
            region = region
        );
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client builder");
        Self {
            token,
            account_id,
            region,
            base_url,
            http,
        }
    }

    fn auth_header(&self) -> (reqwest::header::HeaderName, reqwest::header::HeaderValue) {
        // MetaApi uses a custom `auth-token` header with the raw token —
        // NOT conventional `Authorization: Bearer <t>`. Their error
        // when wrong is "no auth-token header provided" which is the
        // breadcrumb that points at this. Reference:
        //   https://metaapi.cloud/docs/client/restApi/api/
        (
            reqwest::header::HeaderName::from_static("auth-token"),
            reqwest::header::HeaderValue::from_str(&self.token).expect("token must be ascii"),
        )
    }
}

// ── Wire response shapes ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradeResponse {
    /// Numeric MQL5 return code. 10009 = TRADE_RETCODE_DONE (success).
    /// Everything else is a rejection; `message` carries the reason.
    numeric_code: i64,
    string_code: Option<String>,
    message: Option<String>,
    order_id: Option<String>,
    position_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // margin/free_margin/leverage land in admin UI in Sprint 5.6
struct AccountInfo {
    broker: String,
    currency: String,
    balance: f64,
    equity: f64,
    margin: f64,
    free_margin: f64,
    leverage: i32,
    /// MT5 login number. Stable across re-deployments; useful for
    /// matching MetaApi accounts to MT5 statements during reconcile.
    login: i64,
}

// ── Adapter impl ────────────────────────────────────────────────────

#[async_trait::async_trait]
impl LpAdapter for MetaApi {
    fn name(&self) -> &str {
        // Region included so logs make multi-region setups obvious.
        // We don't allocate per call — leak a 'static name at boot via
        // a one-time format would be cleaner, but the trait's `&str`
        // return means we'd need OnceCell. Acceptable cost; this is
        // only called for log lines, not in the hot path.
        match self.region.as_str() {
            "london" => "metaapi-london",
            "singapore" => "metaapi-singapore",
            _ => "metaapi-new-york",
        }
    }

    async fn place_market(&self, req: PlaceMarketRequest) -> anyhow::Result<MarketFill> {
        // MetaApi accepts volume in lots directly — no units conversion
        // like OANDA. Symbol passed through as-is; the engine glue is
        // responsible for translating internal ids (cryXAUUSD →
        // XAUUSDm if that's what Exness uses, etc.).
        let action_type = match req.side {
            Side::Buy => "ORDER_TYPE_BUY",
            Side::Sell => "ORDER_TYPE_SELL",
        };
        let body = serde_json::json!({
            "actionType": action_type,
            "symbol":     req.instrument,
            "volume":     req.lots,
            "comment":    format!("otuburu-{}", req.engine_position_id),
        });
        let url = format!(
            "{}/users/current/accounts/{}/trade",
            self.base_url, self.account_id
        );
        let (auth_name, auth_val) = self.auth_header();
        let resp = self
            .http
            .post(&url)
            .header(auth_name, auth_val)
            .json(&body)
            .send()
            .await
            .context("metaapi POST /trade")?;
        let status = resp.status();
        let raw = resp.text().await.context("metaapi body read")?;
        if !status.is_success() {
            return Err(anyhow!("metaapi {}: {}", status, raw));
        }
        let parsed: TradeResponse =
            serde_json::from_str(&raw).with_context(|| format!("metaapi decode: {}", raw))?;
        if parsed.numeric_code != 10009 {
            // The string code + message together give a clean audit
            // line for kyc_submissions-style auditing of rejected fills.
            return Err(anyhow!(
                "metaapi rejected: code={} text={:?} message={:?}",
                parsed.numeric_code,
                parsed.string_code,
                parsed.message,
            ));
        }

        // MetaApi's /trade response is the ack — it does NOT include
        // the executed price or commission. Those land via a separate
        // /history-orders call or the WebSocket stream. For v1 we
        // return a fill with the requested values and let the
        // reconcile job fill in the actual prices nightly. Sprint 5.3
        // will add the same-tick price lookup via /symbol-price.
        let units_signed = match req.side {
            Side::Buy => req.lots * 100_000.0,
            Side::Sell => -req.lots * 100_000.0,
        };
        Ok(MarketFill {
            lp_order_id: parsed
                .order_id
                .or(parsed.position_id)
                .unwrap_or_else(|| "unknown".to_string()),
            instrument: req.instrument,
            units: units_signed,
            // Placeholder — reconcile job overwrites with the real
            // average fill price from /history-orders. -1.0 makes
            // un-reconciled fills obvious in admin reports.
            price: -1.0,
            commission: 0.0,
            financing: 0.0,
        })
    }

    async fn account_summary(&self) -> anyhow::Result<AccountSummary> {
        let url = format!(
            "{}/users/current/accounts/{}/account-information",
            self.base_url, self.account_id
        );
        let (auth_name, auth_val) = self.auth_header();
        let resp = self
            .http
            .get(&url)
            .header(auth_name, auth_val)
            .send()
            .await
            .context("metaapi GET /account-information")?;
        let status = resp.status();
        let raw = resp.text().await.context("metaapi body read")?;
        if !status.is_success() {
            return Err(anyhow!("metaapi {}: {}", status, raw));
        }
        let info: AccountInfo =
            serde_json::from_str(&raw).with_context(|| format!("metaapi decode: {}", raw))?;
        Ok(AccountSummary {
            account_id: format!("mt5-{}-{}", info.broker, info.login),
            currency: info.currency,
            balance: info.balance,
            unrealised_pl: info.equity - info.balance,
            // MetaApi doesn't return open position count on /account-info.
            // Sprint 5.3 adds a /positions probe to fill this in; for
            // now -1 signals "unknown" to the reconcile job.
            open_position_count: -1,
        })
    }
}
