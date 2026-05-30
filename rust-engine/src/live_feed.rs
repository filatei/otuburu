//! Live price feed tasks — one task per live symbol.
//!
//! Binance REST `/api/v3/ticker/bookTicker` (no API key, free):
//!   - cryBTCUSD → BTCUSDT
//!   - cryETHUSD → ETHUSDT
//!
//! Yahoo Finance chart endpoint `query1.finance.yahoo.com/v8/finance/chart/GC=F`
//! (no API key, unofficial but widely used):
//!   - cryXAUUSD → spot XAU/USD via exchangerate.host; history backfill via
//!     Yahoo GC=F (futures, slight step at the boundary — acceptable).
//!     Futures basis vs spot is small (~$0.50–$5 per oz) and acceptable for
//!     a display-only synthetic feed. Frankfurter was tried first but it
//!     doesn't carry metals — every fetch failed.
//!
//! Each task polls on a fixed cadence (500 ms for crypto, 2 s for gold), builds a
//! synthetic-width spread around the mid, and fires the resulting `Tick` into every
//! account book and the OHLC aggregator exactly as the synthetic generators do in
//! `tick_loop.rs`.
//!
//! Degradation strategy: if a fetch fails, the last known good price is reused and
//! the task simply retries next cycle.  If no price has ever been received the task
//! skips the tick entirely (doesn't broadcast) until the first good response arrives.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time;
use tracing::{debug, warn};

use feed_generator::Tick;

use crate::state::SharedState;

// ── Spread constants (all in % of mid) ───────────────────────────────────────
//
// Yahoo-fed symbols only return a mid (regularMarketPrice), so we synthesise
// bid/ask around it. BTC/ETH come from Binance bookTicker with real bid/ask,
// so no synthetic spread is needed there.

/// Gold: 0.15% half-spread (15 bps each side).
const GOLD_HALF_SPREAD_PCT: f64 = 0.0015;
/// Silver: 0.20% half-spread (20 bps each side). Slightly wider than gold —
/// silver is more volatile and has lower liquidity.
const SILVER_HALF_SPREAD_PCT: f64 = 0.0020;
/// US indices: 0.05% half-spread (5 bps each side). Real-world index CFD
/// spreads run 0.5–2 points on SPX (~3–10 bps); we sit at the tighter end.
const INDEX_HALF_SPREAD_PCT: f64 = 0.0005;

// ── Metals spot (XAU/XAG) via fawazahmed0/currency-api ──────────────────────
//
// We started on exchangerate.host but they moved to a paid model in 2024 —
// the free tier now returns HTTP 200 + `{ success: false, error: 101 }` for
// every request without an access_key. Switched to fawazahmed0's CurrencyAPI
// CDN which is community-maintained, Cloudflare-cached, no API key, no rate
// limit. Used by hundreds of small fintech projects in production.
//
// Response shape:
//   {
//     "date": "2026-05-30",
//     "usd": { "xau": 0.000379, "xag": 0.0334, "eur": 0.92, ... }
//   }
//
// Each value is "target units per 1 USD" — for XAU that means ounces per USD,
// which we invert to "USD per ounce" (the price level users expect).
//
// IMPORTANT TRADE-OFF: this source refreshes once a day. Gold sits at the
// previous day's close until the next midnight UTC. Levels are accurate
// (matches what other CFD brokers show within a few dollars) but there's no
// intraday tick — chart price line stays flat during the session.
//
// If the static feel becomes a problem, the realistic upgrade path is a
// paid feed (GoldAPI.io ~$3/mo, paid exchangerate.host ~$10/mo, or Refinitiv
// ~$2k/mo at the high end). The free options are all either daily-refresh
// (this one) or COMEX futures (Yahoo GC=F, which sits +$20 above spot).

const METALS_URL: &str = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";

#[derive(serde::Deserialize)]
struct CurrencyApiResp {
    usd: std::collections::HashMap<String, f64>,
}

/// Fetch spot XAU/USD and XAG/USD prices. Returns None on any failure;
/// caller treats as "use last cached value".
async fn fetch_metals_spot(client: &reqwest::Client) -> Option<(f64, f64)> {
    let resp = client
        .get(METALS_URL)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: CurrencyApiResp = resp.json().await.ok()?;
    // Keys are lowercase ISO-4217-ish in this API (xau, xag, eur, ...). Each
    // is "1 USD = X target", so for metals we invert to get "USD per ounce".
    let xau_per_usd = body.usd.get("xau").copied()?;
    let xag_per_usd = body.usd.get("xag").copied()?;
    if xau_per_usd <= 0.0 || xag_per_usd <= 0.0 {
        return None;
    }
    Some((1.0 / xau_per_usd, 1.0 / xag_per_usd))
}

/// Spawn a polling task that dispatches gold AND silver ticks every
/// `cadence_ms` from a single CDN fetch. Source updates only daily so most
/// polls are CDN cache hits — fine to keep cadence aggressive for boot-time
/// warm-up, even though intraday values won't change.
fn spawn_metals_spot(state: SharedState, client: Arc<reqwest::Client>, cadence_ms: u64) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        let mut last: Option<(f64, f64)> = None;

        loop {
            interval.tick().await;
            match fetch_metals_spot(&client).await {
                Some(prices) => last = Some(prices),
                None => {
                    if last.is_none() {
                        warn!(
                            "metals spot fetch failed — no price yet, XAU/XAG silent until first success"
                        );
                    } else {
                        warn!("metals spot fetch failed — using last known");
                    }
                }
            }
            if let Some((xau, xag)) = last {
                // Gate dispatch on market hours — metals follow the FX 24/5
                // calendar (Sun 21:00 UTC → Fri 21:00 UTC). Skipping ticks
                // when the market is closed naturally freezes the chart
                // and lets the frontend detect staleness via tick age.
                let now = chrono::Utc::now();
                if crate::market_hours::is_open("cryXAUUSD", now) {
                    dispatch(&state, mid_to_tick("cryXAUUSD", xau, GOLD_HALF_SPREAD_PCT)).await;
                }
                if crate::market_hours::is_open("XAGUSD", now) {
                    dispatch(&state, mid_to_tick("XAGUSD", xag, SILVER_HALF_SPREAD_PCT)).await;
                }
            }
        }
    });
}

// ── Alpaca latest quotes (US equity ETFs as index proxies) ───────────────────
//
// Used to feed real-time bid/ask for SPX/DJI/NDX via the SPY/DIA/QQQ ETFs.
// REST polling at 1s — Alpaca's WebSocket would give finer granularity, but
// REST keeps the code simple and 1s is plenty for retail fractional UX.
//
// Free IEX feed is single-exchange data, real-time during regular market
// hours (Mon–Fri 09:30–16:00 ET). Outside those hours the endpoint returns
// the last known quote with a stale timestamp — engine keeps reusing it
// (chart appears frozen). A market-hours indicator is a follow-up commit.

/// Internal symbol id → Alpaca ETF ticker.
const ALPACA_SYMBOL_MAP: &[(&str, &str)] = &[("SPX", "SPY"), ("DJI", "DIA"), ("NDX", "QQQ")];

#[derive(serde::Deserialize)]
struct AlpacaQuotesResp {
    quotes: std::collections::HashMap<String, AlpacaQuote>,
}

#[derive(serde::Deserialize)]
struct AlpacaQuote {
    #[serde(rename = "bp")]
    bid_price: f64,
    #[serde(rename = "ap")]
    ask_price: f64,
}

/// Fetch the latest bid/ask for a batch of Alpaca tickers. Returns a map keyed
/// by Alpaca ticker (e.g. "SPY") to (bid, ask). None if the request fails
/// outright; the caller falls back to the last known quote per symbol.
async fn fetch_alpaca_quotes(
    client: &reqwest::Client,
    tickers: &[&str],
    key_id: &str,
    secret_key: &str,
) -> Option<std::collections::HashMap<String, (f64, f64)>> {
    let url = format!(
        "https://data.alpaca.markets/v2/stocks/quotes/latest?symbols={}",
        tickers.join(",")
    );
    let resp = client
        .get(&url)
        .header("APCA-API-KEY-ID", key_id)
        .header("APCA-API-SECRET-KEY", secret_key)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: AlpacaQuotesResp = resp.json().await.ok()?;
    let result = body
        .quotes
        .into_iter()
        .filter_map(|(sym, q)| {
            if q.bid_price > 0.0 && q.ask_price > q.bid_price {
                Some((sym, (q.bid_price, q.ask_price)))
            } else {
                None
            }
        })
        .collect();
    Some(result)
}

// ── Alpaca crypto quotes (PAXG/USD and other 24/7 crypto pairs) ─────────────
//
// Separate endpoint from the stock quotes — Alpaca splits crypto onto
// `/v1beta3/crypto/us/`. Auth headers are identical to the stock endpoint
// (APCA-API-KEY-ID / APCA-API-SECRET-KEY) so we reuse the same env vars
// already required for SPX/DJI/NDX.
//
// Symbol format is BASE/QUOTE — e.g. "PAXG/USD", "BTC/USD". The URL takes
// a comma-separated list but the slashes need to be URL-encoded (%2F)
// because they're path-sensitive otherwise.

/// Internal symbol id → Alpaca crypto pair (with slash).
const ALPACA_CRYPTO_MAP: &[(&str, &str)] = &[("cryPAXGUSD", "PAXG/USD")];

async fn fetch_alpaca_crypto(
    client: &reqwest::Client,
    pairs: &[&str],
    key_id: &str,
    secret_key: &str,
) -> Option<std::collections::HashMap<String, (f64, f64)>> {
    // URL-encode the slashes so the API treats the whole CSV as one query
    // param instead of splitting on '/'.
    let encoded = pairs
        .iter()
        .map(|p| p.replace('/', "%2F"))
        .collect::<Vec<_>>()
        .join(",");
    let url =
        format!("https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols={encoded}");
    let resp = client
        .get(&url)
        .header("APCA-API-KEY-ID", key_id)
        .header("APCA-API-SECRET-KEY", secret_key)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // Crypto endpoint returns the same `{ quotes: { sym: { bp, ap, ... } } }`
    // shape as the stock one, so reuse AlpacaQuotesResp/AlpacaQuote.
    let body: AlpacaQuotesResp = resp.json().await.ok()?;
    let result = body
        .quotes
        .into_iter()
        .filter_map(|(sym, q)| {
            if q.bid_price > 0.0 && q.ask_price > q.bid_price {
                Some((sym, (q.bid_price, q.ask_price)))
            } else {
                None
            }
        })
        .collect();
    Some(result)
}

/// Spawn a polling task for one or more Alpaca crypto pairs. Mirrors
/// `spawn_alpaca_indices` but pointed at the crypto endpoint. Crypto markets
/// are 24/7 so no market-hours gate is needed — `is_open` for cryPAXGUSD
/// always returns true.
fn spawn_alpaca_crypto(
    state: SharedState,
    client: Arc<reqwest::Client>,
    key_id: String,
    secret_key: String,
    cadence_ms: u64,
) {
    tokio::spawn(async move {
        let pairs: Vec<&'static str> = ALPACA_CRYPTO_MAP.iter().map(|(_, p)| *p).collect();
        // Pair-to-internal lookup so we don't string-walk on each tick.
        let pair_to_internal: std::collections::HashMap<&str, &str> =
            ALPACA_CRYPTO_MAP.iter().map(|(s, p)| (*p, *s)).collect();
        let last: Arc<Mutex<std::collections::HashMap<String, (f64, f64)>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            match fetch_alpaca_crypto(&client, &pairs, &key_id, &secret_key).await {
                Some(quotes) if !quotes.is_empty() => {
                    let mut last_w = last.lock().await;
                    for (pair, ba) in quotes {
                        last_w.insert(pair, ba);
                    }
                }
                Some(_) => {
                    warn!("alpaca crypto fetch returned 0 usable quotes");
                }
                None => {
                    let have_last = !last.lock().await.is_empty();
                    if have_last {
                        warn!("alpaca crypto fetch failed — using last known");
                    } else {
                        warn!(
                            "alpaca crypto fetch failed — no prices yet, PAXG silent until first success"
                        );
                    }
                }
            }

            let snapshot = last.lock().await.clone();
            for (pair, (bid, ask)) in snapshot {
                if let Some(internal) = pair_to_internal.get(pair.as_str()) {
                    dispatch(&state, make_tick(internal, bid, ask)).await;
                }
            }
        }
    });
}

// ── Binance + Bybit (multi-source crypto aggregation) ───────────────────────
//
// Both venues are polled in parallel each tick. When both respond, we publish
// the median (= simple average for n=2) of the bids and asks. If exactly one
// responds we publish that one. If neither responds we stay silent — the
// staleness check in the order path then rejects new orders, which is the
// right behaviour during a real venue outage.
//
// Why this matters: a single-venue feed is a single point of failure for our
// house book. Binance had a SOL flash crash in Q3 2024 that a Bybit-aware
// median would have largely ignored. Median across two top-tier venues is
// the cheapest meaningful protection we can ship.
//
// Symbol convention: every supported pair uses the same `{BASE}USDT` ticker
// on both venues, so one map drives everything.

/// Internal symbol id → Binance/Bybit pair (same string for both venues).
const CRYPTO_MULTI_VENUE_SYMBOLS: &[(&str, &str)] = &[
    ("cryBTCUSD", "BTCUSDT"),
    ("cryETHUSD", "ETHUSDT"),
    ("crySOLUSD", "SOLUSDT"),
    ("cryDOGEUSD", "DOGEUSDT"),
    ("cryXRPUSD", "XRPUSDT"),
    ("cryADAUSD", "ADAUSDT"),
];

#[derive(serde::Deserialize)]
struct BinanceBookTicker {
    #[serde(rename = "bidPrice")]
    bid_price: String,
    #[serde(rename = "askPrice")]
    ask_price: String,
}

async fn fetch_binance(client: &reqwest::Client, pair: &str) -> Option<(f64, f64)> {
    let url = format!("https://api.binance.com/api/v3/ticker/bookTicker?symbol={pair}");
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let bt: BinanceBookTicker = resp.json().await.ok()?;
    let bid: f64 = bt.bid_price.parse().ok()?;
    let ask: f64 = bt.ask_price.parse().ok()?;
    if bid > 0.0 && ask > bid {
        Some((bid, ask))
    } else {
        None
    }
}

// Bybit v5 spot tickers endpoint. Public, no auth. Response shape:
//   { retCode: 0, result: { list: [{ symbol, bid1Price, ask1Price, ... }] } }
#[derive(serde::Deserialize)]
struct BybitTickersResp {
    #[serde(rename = "retCode")]
    ret_code: i32,
    result: BybitResult,
}

#[derive(serde::Deserialize)]
struct BybitResult {
    list: Vec<BybitTicker>,
}

#[derive(serde::Deserialize)]
struct BybitTicker {
    #[serde(rename = "bid1Price")]
    bid_price: String,
    #[serde(rename = "ask1Price")]
    ask_price: String,
}

async fn fetch_bybit(client: &reqwest::Client, pair: &str) -> Option<(f64, f64)> {
    let url = format!("https://api.bybit.com/v5/market/tickers?category=spot&symbol={pair}");
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let body: BybitTickersResp = resp.json().await.ok()?;
    if body.ret_code != 0 {
        return None;
    }
    let t = body.result.list.into_iter().next()?;
    let bid: f64 = t.bid_price.parse().ok()?;
    let ask: f64 = t.ask_price.parse().ok()?;
    if bid > 0.0 && ask > bid {
        Some((bid, ask))
    } else {
        None
    }
}

/// Spawn a multi-venue polling task for one internal crypto symbol.
/// Polls Binance and Bybit in parallel every `cadence_ms`. Median when both
/// respond, single-venue fallback when one fails, silent when both fail.
fn spawn_multi_source_crypto(
    state: SharedState,
    client: Arc<reqwest::Client>,
    internal_symbol: &'static str,
    pair: &'static str,
    cadence_ms: u64,
) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        // Lightweight outage counter so we don't spam the log when a venue
        // goes down for an extended period. We log on the transition, not
        // every tick.
        let mut binance_down = false;
        let mut bybit_down = false;

        loop {
            interval.tick().await;

            let (bin, byb) = tokio::join!(fetch_binance(&client, pair), fetch_bybit(&client, pair));

            // Transition logging — flag the first failure and the first
            // recovery after a failure run. Mid-run silence keeps logs
            // useful during a sustained outage.
            match (bin.is_some(), binance_down) {
                (false, false) => {
                    warn!(symbol = internal_symbol, pair, "binance fetch failed");
                    binance_down = true;
                }
                (true, true) => {
                    tracing::info!(symbol = internal_symbol, pair, "binance recovered");
                    binance_down = false;
                }
                _ => {}
            }
            match (byb.is_some(), bybit_down) {
                (false, false) => {
                    warn!(symbol = internal_symbol, pair, "bybit fetch failed");
                    bybit_down = true;
                }
                (true, true) => {
                    tracing::info!(symbol = internal_symbol, pair, "bybit recovered");
                    bybit_down = false;
                }
                _ => {}
            }

            let aggregated = match (bin, byb) {
                (Some((bb, ba)), Some((yb, ya))) => {
                    // n=2 → median == average. Same formula scales for
                    // future venues if we use sort-and-pick-middle.
                    Some(((bb + yb) / 2.0, (ba + ya) / 2.0))
                }
                (Some(only), None) | (None, Some(only)) => Some(only),
                (None, None) => None,
            };

            if let Some((bid, ask)) = aggregated {
                dispatch(&state, make_tick(internal_symbol, bid, ask)).await;
            }
            // else: both venues down → silent. Frontend sees the tick age
            // out, the order path's freshness check rejects new orders.
            // This is intentional — we never want to publish a synthetic
            // price during a real outage.
        }
    });
}

// ── Yahoo Finance (XAU/USD via spot pair XAUUSD=X) ──────────────────────────

/// Mozilla-style User-Agent override for Yahoo. Their chart endpoint sometimes
/// rejects custom UA strings, so we masquerade as a browser on this one call.
const YAHOO_UA: &str = "Mozilla/5.0 (otuburu-engine)";

#[derive(serde::Deserialize)]
struct YahooChartResp {
    chart: YahooChart,
}

#[derive(serde::Deserialize)]
struct YahooChart {
    result: Option<Vec<YahooResult>>,
}

#[derive(serde::Deserialize)]
struct YahooResult {
    meta: YahooMeta,
    // Present only on historical (range/interval) responses, not the live one.
    timestamp: Option<Vec<i64>>,
    indicators: Option<YahooIndicators>,
}

#[derive(serde::Deserialize)]
struct YahooMeta {
    #[serde(rename = "regularMarketPrice")]
    regular_market_price: Option<f64>,
}

#[derive(serde::Deserialize)]
struct YahooIndicators {
    quote: Vec<YahooQuote>,
}

#[derive(serde::Deserialize)]
struct YahooQuote {
    open: Vec<Option<f64>>,
    high: Vec<Option<f64>>,
    low: Vec<Option<f64>>,
    close: Vec<Option<f64>>,
}

/// Fetch historical OHLC candles from Yahoo's chart endpoint. Used to backfill
/// the OHLC ring buffers on engine startup so the chart isn't empty for new
/// Yahoo-fed symbols.
///
/// `range` examples: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max`.
/// `interval` examples: `1m`, `5m`, `15m`, `30m`, `1h`, `1d`.
/// Yahoo limits some combinations: 1m needs ≤7d, 5/15/30m need ≤60d,
/// 1h needs ≤730d, 1d is unlimited.
async fn fetch_yahoo_history(
    client: &reqwest::Client,
    yahoo_ticker: &str,
    range: &str,
    interval: &str,
) -> Option<Vec<crate::ohlc::Candle>> {
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}?range={range}&interval={interval}"
    );
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, YAHOO_UA)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    let yc: YahooChartResp = resp.json().await.ok()?;
    let result = yc.chart.result?.into_iter().next()?;
    let timestamps = result.timestamp?;
    let quote = result.indicators?.quote.into_iter().next()?;

    // Each parallel array is the same length; drop any element whose OHLC has
    // a null (Yahoo's gap markers — happens around weekends/holidays).
    let candles: Vec<crate::ohlc::Candle> = timestamps
        .into_iter()
        .zip(quote.open)
        .zip(quote.high)
        .zip(quote.low)
        .zip(quote.close)
        .filter_map(|((((ts, o), h), l), c)| {
            Some(crate::ohlc::Candle {
                ts_s: ts,
                open: o?,
                high: h?,
                low: l?,
                close: c?,
            })
        })
        .collect();
    Some(candles)
}

/// Fetch the latest regular-market price for any Yahoo Finance ticker via the
/// public chart endpoint. Works for `XAUUSD=X` (gold spot), `^GSPC`, `^DJI`,
/// `^IXIC`, equities, etc. Outside trading hours Yahoo returns the last close.
async fn fetch_yahoo_chart(client: &reqwest::Client, yahoo_ticker: &str) -> Option<f64> {
    let url = format!("https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_ticker}");
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, YAHOO_UA)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    let yc: YahooChartResp = resp.json().await.ok()?;
    let price = yc
        .chart
        .result?
        .into_iter()
        .next()?
        .meta
        .regular_market_price?;
    if price > 0.0 {
        Some(price)
    } else {
        None
    }
}
// ── Helpers ───────────────────────────────────────────────────────────────────

fn make_tick(symbol: &str, bid: f64, ask: f64) -> Tick {
    Tick {
        symbol: symbol.to_owned(),
        ts: chrono::Utc::now().timestamp_millis(),
        mid: (bid + ask) / 2.0,
        bid,
        ask,
        tick_index: 0, // live ticks don't use sequential index
    }
}

fn mid_to_tick(symbol: &str, mid: f64, half_spread_pct: f64) -> Tick {
    let spread = mid * half_spread_pct;
    make_tick(symbol, mid - spread, mid + spread)
}

/// Feed a tick into all books, collect settlements, and broadcast.
async fn dispatch(state: &SharedState, tick: Tick) {
    let (all_settled, any_auto_close) = {
        let mut inner = state.inner.write().await;
        inner.ohlc.on_tick(&tick.symbol, tick.ts, tick.mid);

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
                    "binary settled (live)"
                );
            }
            for ac in &result.auto_closed_cfds {
                tracing::info!(
                    position_id = %ac.position.id,
                    reason = ?ac.reason,
                    pnl = ac.pnl,
                    "CFD auto-closed (live)"
                );
                any_auto_close = true;
            }
            for ac in &result.auto_closed_spots {
                tracing::info!(
                    spot_id = %ac.position.id,
                    pnl = ac.pnl,
                    "spot auto-closed (live)"
                );
                any_auto_close = true;
            }
            all_settled.extend(result.binary_settlements);
        }
        (all_settled, any_auto_close)
    };

    // Persist binary settlements to SQLite
    if !all_settled.is_empty() {
        let settled_at_ms = chrono::Utc::now().timestamp_millis();
        let db = state.db.clone();
        let settled = all_settled.clone();
        tokio::spawn(async move {
            for s in &settled {
                if let Err(e) = crate::db::save_settled_trade(&db, s, settled_at_ms).await {
                    tracing::error!(%e, "failed to save settled trade (live)");
                }
            }
        });
    }

    // Periodic snapshot on auto-close events
    if !all_settled.is_empty() || any_auto_close {
        let state_clone = state.clone();
        tokio::spawn(async move {
            let snap = {
                let inner = state_clone.inner.read().await;
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
                    tracing::error!(%e, "snapshot save failed after live settlement");
                }
            });
        });
    }

    if let Err(e) = state.tick_tx.send(tick) {
        debug!("live feed: no subscribers ({})", e);
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Spawn all live-price tasks.  Called from `tick_loop::start` after synthetic generators.
pub fn start(state: SharedState) {
    let client = Arc::new(
        reqwest::Client::builder()
            .user_agent("otuburu-engine/1.0")
            .build()
            .expect("reqwest client build failed"),
    );

    // Multi-venue crypto feed (Binance + Bybit, median bid/ask). Covers
    // BTC, ETH, SOL, DOGE, XRP, ADA — all polled in parallel at 500 ms
    // cadence. See CRYPTO_MULTI_VENUE_SYMBOLS for the symbol map.
    for (internal, pair) in CRYPTO_MULTI_VENUE_SYMBOLS {
        spawn_multi_source_crypto(state.clone(), client.clone(), internal, pair, 500);
    }

    // Gold + silver — exchangerate.host spot, both fetched in one request to
    // keep the rate-limit footprint low. Pulled every 5 seconds because retail
    // doesn't need millisecond-level metal ticks and the free tier doesn't
    // like aggressive polling. See the spawn_metals_spot block above for the
    // story on why we moved off Yahoo futures (GC=F/SI=F was $20 above spot
    // because of cost-of-carry, made our prices look wrong vs every other
    // CFD broker).
    spawn_metals_spot(state.clone(), client.clone(), 5_000);

    // US indices — Alpaca real-time IEX feed via SPY/DIA/QQQ ETFs (preferred),
    // or fall back to Yahoo polling (15-min delay) if Alpaca creds are missing.
    // Either path uses the SPY/DIA/QQQ tickers so historical and live prices
    // stay on the same scale.
    let alpaca_key = std::env::var("APCA_API_KEY_ID").unwrap_or_default();
    let alpaca_secret = std::env::var("APCA_API_SECRET_KEY").unwrap_or_default();
    if !alpaca_key.is_empty() && !alpaca_secret.is_empty() {
        tracing::info!("alpaca creds present — using Alpaca for SPX/DJI/NDX + PAXG/USD");
        spawn_alpaca_indices(
            state.clone(),
            client.clone(),
            alpaca_key.clone(),
            alpaca_secret.clone(),
            1_000,
        );
        // PAXG (tokenized gold) — Alpaca crypto endpoint, 24/7. Same creds
        // as the stock data plan; their free tier covers crypto data.
        spawn_alpaca_crypto(
            state.clone(),
            client.clone(),
            alpaca_key,
            alpaca_secret,
            1_000,
        );
    } else {
        tracing::warn!(
            "alpaca creds missing — falling back to Yahoo for SPX/DJI/NDX (delayed quotes); \
             PAXG/USD will be silent until APCA_API_KEY_ID + APCA_API_SECRET_KEY are set"
        );
        spawn_yahoo(
            state.clone(),
            client.clone(),
            "SPY",
            "SPX",
            INDEX_HALF_SPREAD_PCT,
            2_000,
        );
        spawn_yahoo(
            state.clone(),
            client.clone(),
            "DIA",
            "DJI",
            INDEX_HALF_SPREAD_PCT,
            2_000,
        );
        spawn_yahoo(
            state.clone(),
            client.clone(),
            "QQQ",
            "NDX",
            INDEX_HALF_SPREAD_PCT,
            2_000,
        );
    }

    // Historical OHLC backfill — fetch D1 + H1 from Yahoo for each symbol so
    // the chart's historical timeframes have data immediately instead of
    // waiting hours/days for live ticks to fill them. Refreshed hourly. We
    // use SPY/DIA/QQQ tickers (not ^GSPC/^DJI/^IXIC) so historical prices
    // match the ETF scale of the live feed.
    // Historical backfill for metals — same tickers as live feed so the
    // chart's history matches up with the streaming price. GC=F / SI=F are
    // COMEX futures (see live spawn block above for why we're stuck with
    // futures vs spot on the free Yahoo tier).
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "GC=F", "cryXAUUSD");
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "SI=F", "XAGUSD");
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "SPY", "SPX");
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "DIA", "DJI");
    spawn_yahoo_history_refresh(state, client, "QQQ", "NDX");
}

/// Generic Yahoo Finance chart-endpoint feeder. Polls every `cadence_ms`,
/// synthesises bid/ask around the mid using `half_spread_pct`, and dispatches
/// a tick under the internal `symbol` id. Used for gold (XAUUSD=X) and US indices.
fn spawn_yahoo(
    state: SharedState,
    client: Arc<reqwest::Client>,
    yahoo_ticker: &'static str,
    symbol: &'static str,
    half_spread_pct: f64,
    cadence_ms: u64,
) {
    tokio::spawn(async move {
        let last: Arc<Mutex<Option<f64>>> = Arc::new(Mutex::new(None));
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            match fetch_yahoo_chart(&client, yahoo_ticker).await {
                Some(mid) => {
                    *last.lock().await = Some(mid);
                }
                None => {
                    let have_last = last.lock().await.is_some();
                    if have_last {
                        warn!(
                            symbol,
                            yahoo_ticker, "yahoo fetch failed — using last known price"
                        );
                    } else {
                        warn!(
                            symbol,
                            yahoo_ticker,
                            "yahoo fetch failed — no price yet, symbol will be silent until first success"
                        );
                    }
                }
            }

            if let Some(mid) = *last.lock().await {
                // Skip dispatching when the underlying session is closed —
                // the symbol freezes at its last known price and the
                // frontend will see a stale tick (>60s old) which signals
                // "market closed" to the user. Crypto/synthetic are always
                // open so this is effectively a no-op for those.
                if crate::market_hours::is_open(symbol, chrono::Utc::now()) {
                    let tick = mid_to_tick(symbol, mid, half_spread_pct);
                    dispatch(&state, tick).await;
                }
            }
        }
    });
}

/// How often to re-fetch Yahoo history (D1 + H1). Hourly is plenty since
/// neither resolution updates faster than that upstream.
const HISTORY_REFRESH_SECS: u64 = 3600;

/// Fetch D1 (2y) and H1 (1y) history from Yahoo and seed the OHLC store,
/// then loop on `HISTORY_REFRESH_SECS` cadence to keep buffers fresh.
/// Persists D1 candles to SQLite so they survive engine restarts; H1 is
/// in-memory only (Yahoo re-fetches it every restart anyway).
fn spawn_yahoo_history_refresh(
    state: SharedState,
    client: Arc<reqwest::Client>,
    yahoo_ticker: &'static str,
    symbol: &'static str,
) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(HISTORY_REFRESH_SECS));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await; // first tick fires immediately

            // ── D1 history (2y daily candles) ────────────────────────────────
            match fetch_yahoo_history(&client, yahoo_ticker, "2y", "1d").await {
                Some(candles) if !candles.is_empty() => {
                    tracing::info!(
                        symbol,
                        yahoo_ticker,
                        count = candles.len(),
                        "seeded D1 history from Yahoo"
                    );
                    // Persist to SQLite so the next engine boot has data even
                    // before this refresh task fires.
                    let db = state.db.clone();
                    let to_persist = candles.clone();
                    let sym_owned = symbol.to_string();
                    tokio::spawn(async move {
                        for c in &to_persist {
                            if let Err(e) = crate::db::upsert_daily_candle(
                                &db, &sym_owned, c.ts_s, c.open, c.high, c.low, c.close,
                            )
                            .await
                            {
                                tracing::error!(%e, "failed to upsert daily candle");
                                break;
                            }
                        }
                    });
                    // Seed in-memory store.
                    let mut inner = state.inner.write().await;
                    inner
                        .ohlc
                        .seed(symbol, crate::ohlc::Resolution::D1, candles);
                }
                _ => {
                    warn!(symbol, yahoo_ticker, "yahoo D1 history fetch failed");
                }
            }

            // ── H1 history (1y hourly candles) ───────────────────────────────
            match fetch_yahoo_history(&client, yahoo_ticker, "1y", "1h").await {
                Some(candles) if !candles.is_empty() => {
                    tracing::info!(
                        symbol,
                        yahoo_ticker,
                        count = candles.len(),
                        "seeded H1 history from Yahoo"
                    );
                    let mut inner = state.inner.write().await;
                    inner
                        .ohlc
                        .seed(symbol, crate::ohlc::Resolution::H1, candles);
                }
                _ => {
                    warn!(symbol, yahoo_ticker, "yahoo H1 history fetch failed");
                }
            }
        }
    });
}

/// Alpaca real-time index feeder. Polls the batch latest-quotes endpoint for
/// SPY/DIA/QQQ every `cadence_ms`, dispatches each as the matching internal
/// symbol (SPX/DJI/NDX) using the real bid/ask Alpaca returns.
fn spawn_alpaca_indices(
    state: SharedState,
    client: Arc<reqwest::Client>,
    key_id: String,
    secret_key: String,
    cadence_ms: u64,
) {
    use std::collections::HashMap;
    tokio::spawn(async move {
        let tickers: Vec<&'static str> = ALPACA_SYMBOL_MAP.iter().map(|(_, alp)| *alp).collect();
        let last: Arc<Mutex<HashMap<String, (f64, f64)>>> = Arc::new(Mutex::new(HashMap::new()));
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            match fetch_alpaca_quotes(&client, &tickers, &key_id, &secret_key).await {
                Some(quotes) => {
                    // Distinguish "got data" from "got an empty response after
                    // filtering". Both used to be silent successes — that
                    // silence is exactly what masked the dispatch bug below
                    // when Alpaca briefly returned bid=0/ask=0 stubs.
                    if quotes.is_empty() {
                        warn!(
                            "alpaca quote fetch returned 0 usable quotes (filtered by bid>0 && ask>bid)"
                        );
                    } else {
                        let mut last_guard = last.lock().await;
                        for (sym, ba) in quotes {
                            last_guard.insert(sym, ba);
                        }
                    }
                }
                None => {
                    let have_any = !last.lock().await.is_empty();
                    if have_any {
                        warn!("alpaca quote fetch failed — using last known");
                    } else {
                        warn!(
                            "alpaca quote fetch failed — no prices yet, indices will be silent until first success"
                        );
                    }
                }
            }

            // Dispatch a tick for every cached symbol on every interval. Even
            // if the latest fetch failed, the previous good quote keeps the
            // live chart updated visibly (no gaps).
            let snap: Vec<(String, (f64, f64))> = last
                .lock()
                .await
                .iter()
                .map(|(k, v)| (k.clone(), *v))
                .collect();
            for (alpaca_sym, (bid, ask)) in snap {
                // ALPACA_SYMBOL_MAP entries are (internal, alpaca) so the
                // FIRST slot is the engine-internal symbol we want to dispatch
                // under. Earlier code bound `internal_sym` to the second slot
                // (the Alpaca ticker) — ticks were sent as "SPY/DIA/QQQ", the
                // engine doesn't know those, dispatch silently no-op'd, and
                // SPX/DJI/NDX stayed blank in the UI despite Alpaca returning
                // fresh quotes every second. Slot fix below.
                if let Some(&(internal_sym, _)) = ALPACA_SYMBOL_MAP
                    .iter()
                    .find(|(_, alp)| *alp == alpaca_sym.as_str())
                {
                    // US indices only tick during the cash session (13:30-
                    // 20:00 UTC weekdays). Alpaca will happily stream the
                    // last regular-session quote outside hours; we drop it
                    // so the frontend sees a stale tick and disables trades.
                    if crate::market_hours::is_open(internal_sym, chrono::Utc::now()) {
                        let tick = make_tick(internal_sym, bid, ask);
                        dispatch(&state, tick).await;
                    }
                }
            }
        }
    });
}
