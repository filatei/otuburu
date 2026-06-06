//! OANDA v20 REST adapter.
//!
//! Endpoint base
//! -------------
//!   - Practice (free demo): https://api-fxpractice.oanda.com
//!   - Live (real money):    https://api-fxtrade.oanda.com
//!
//! Auth
//! ----
//!   Personal Access Token in `Authorization: Bearer <token>` header.
//!   Tokens are long-lived but can be revoked from the OANDA web
//!   console. They're scoped to one account; multi-account routing
//!   would need a per-account adapter (we don't need that today).
//!
//! References
//! ----------
//!   - REST docs: https://developer.oanda.com/rest-live-v20/
//!   - Order endpoint: POST /v3/accounts/{accountID}/orders

use crate::types::*;
use crate::LpAdapter;
use anyhow::{anyhow, Context};
use serde::Deserialize;
use std::time::Duration;

const PRACTICE_BASE: &str = "https://api-fxpractice.oanda.com";
const LIVE_BASE: &str = "https://api-fxtrade.oanda.com";

pub struct OandaV20 {
    token: String,
    account_id: String,
    env: String, // "practice" | "live" — included in adapter name
    base_url: String,
    http: reqwest::Client,
}

impl OandaV20 {
    pub fn new(token: String, account_id: String, env: String) -> Self {
        let base_url = if env == "live" {
            LIVE_BASE
        } else {
            PRACTICE_BASE
        }
        .to_string();
        // 15s timeout matches Smile Identity client. OANDA's order
        // endpoint usually returns in 100-400ms; the long tail is
        // bigger only under their rare maintenance windows.
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client builder");
        Self {
            token,
            account_id,
            env,
            base_url,
            http,
        }
    }

    fn auth_headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        let bearer = format!("Bearer {}", self.token);
        h.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&bearer).expect("token must be ascii"),
        );
        h.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        // OANDA returns higher-precision pricing when this header is set.
        // Default is "DEFAULT" which gives 5 decimals; "EXTENDED" gives 7+.
        h.insert(
            "Accept-Datetime-Format",
            reqwest::header::HeaderValue::from_static("RFC3339"),
        );
        h
    }
}

// ── Wire response shapes ────────────────────────────────────────────

/// OANDA's order-fill response. We extract just what we need for the
/// fill report — fields we don't use are tolerated by serde because
/// the struct only describes a subset.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderResponse {
    order_fill_transaction: Option<OrderFillTransaction>,
    order_cancel_transaction: Option<OrderCancelTransaction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderFillTransaction {
    id: String,
    instrument: String,
    units: String, // OANDA serialises numbers as strings everywhere
    price: String,
    commission: String,
    financing: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderCancelTransaction {
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountResponse {
    account: AccountWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountWire {
    id: String,
    currency: String,
    balance: String,
    unrealized_pl: String,
    open_position_count: i32,
}

// ── Adapter impl ────────────────────────────────────────────────────

#[async_trait::async_trait]
impl LpAdapter for OandaV20 {
    fn name(&self) -> &str {
        // Borrowed slice — env string lives as long as the adapter.
        if self.env == "live" {
            "oanda-live"
        } else {
            "oanda-practice"
        }
    }

    async fn place_market(&self, req: PlaceMarketRequest) -> anyhow::Result<MarketFill> {
        // OANDA accepts units (not lots). One lot = 100,000 for FX
        // majors; less for metals/indices. The conversion belongs at
        // the engine glue layer when it translates our internal
        // symbol → OANDA instrument; for now, units == lots * 100_000
        // for FX. Override per-symbol in the glue when we add metals.
        let units_signed: f64 = match req.side {
            Side::Buy => req.lots * 100_000.0,
            Side::Sell => -req.lots * 100_000.0,
        };
        let body = serde_json::json!({
            "order": {
                "type":         "MARKET",
                "instrument":   req.instrument,
                "units":        format!("{:.0}", units_signed),
                "timeInForce":  "FOK",       // matches the engine UX wording
                "positionFill": "DEFAULT",
                "clientExtensions": {
                    "id": req.engine_position_id,
                    "tag": "otuburu",
                }
            }
        });
        let url = format!("{}/v3/accounts/{}/orders", self.base_url, self.account_id);
        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .context("oanda post /orders")?;
        let status = resp.status();
        let raw = resp.text().await.context("oanda body read")?;
        if !status.is_success() {
            return Err(anyhow!("oanda {}: {}", status, raw));
        }
        let parsed: OrderResponse =
            serde_json::from_str(&raw).with_context(|| format!("oanda decode: {}", raw))?;
        if let Some(c) = parsed.order_cancel_transaction {
            return Err(anyhow!("oanda cancelled: {}", c.reason));
        }
        let fill = parsed
            .order_fill_transaction
            .ok_or_else(|| anyhow!("oanda accepted but no fill txn: {}", raw))?;
        // OANDA returns numbers as strings; parse defensively.
        let units = fill.units.parse::<f64>().context("parse units")?;
        let price = fill.price.parse::<f64>().context("parse price")?;
        let commission = fill.commission.parse::<f64>().context("parse commission")?;
        let financing = fill.financing.parse::<f64>().context("parse financing")?;
        Ok(MarketFill {
            lp_order_id: fill.id,
            instrument: fill.instrument,
            units,
            price,
            commission,
            financing,
        })
    }

    async fn account_summary(&self) -> anyhow::Result<AccountSummary> {
        let url = format!("{}/v3/accounts/{}/summary", self.base_url, self.account_id);
        let resp = self
            .http
            .get(&url)
            .headers(self.auth_headers())
            .send()
            .await
            .context("oanda get /summary")?;
        let status = resp.status();
        let raw = resp.text().await.context("oanda body read")?;
        if !status.is_success() {
            return Err(anyhow!("oanda {}: {}", status, raw));
        }
        let parsed: AccountResponse =
            serde_json::from_str(&raw).with_context(|| format!("oanda decode: {}", raw))?;
        let a = parsed.account;
        Ok(AccountSummary {
            account_id: a.id,
            currency: a.currency,
            balance: a.balance.parse().context("parse balance")?,
            unrealised_pl: a.unrealized_pl.parse().context("parse unrealised pl")?,
            open_position_count: a.open_position_count,
        })
    }
}
