//! Live price feed tasks — one task per live symbol.
//!
//! Binance REST `/api/v3/ticker/bookTicker` (no API key, free):
//!   - cryBTCUSD → BTCUSDT
//!   - cryETHUSD → ETHUSDT
//!
//! Yahoo Finance chart endpoint `query1.finance.yahoo.com/v8/finance/chart/GC=F`
//! (no API key, unofficial but widely used):
//!   - cryXAUUSD → COMEX gold futures (GC=F) as a proxy for spot XAU/USD.
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
/// US indices: 0.05% half-spread (5 bps each side). Real-world index CFD
/// spreads run 0.5–2 points on SPX (~3–10 bps); we sit at the tighter end.
const INDEX_HALF_SPREAD_PCT: f64 = 0.0005;

// ── Binance book ticker ───────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct BinanceBookTicker {
    #[serde(rename = "bidPrice")]
    bid_price: String,
    #[serde(rename = "askPrice")]
    ask_price: String,
}

async fn fetch_binance(
    client: &reqwest::Client,
    pair: &str, // e.g. "BTCUSDT"
) -> Option<(f64, f64)> {
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

// ── Yahoo Finance (XAU/USD via COMEX gold futures GC=F) ──────────────────────

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
/// public chart endpoint. Works for `GC=F` (gold futures), `^GSPC`, `^DJI`,
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

    // BTC/USD — 500 ms (Binance bookTicker, real bid/ask)
    spawn_binance(state.clone(), client.clone(), "BTCUSDT", "cryBTCUSD", 500);
    // ETH/USD — 500 ms (Binance bookTicker, real bid/ask)
    spawn_binance(state.clone(), client.clone(), "ETHUSDT", "cryETHUSD", 500);

    // Yahoo-fed symbols — 2 s live polling, synthetic bid/ask around the mid.
    spawn_yahoo(
        state.clone(),
        client.clone(),
        "GC=F",
        "cryXAUUSD",
        GOLD_HALF_SPREAD_PCT,
        2_000,
    );
    spawn_yahoo(
        state.clone(),
        client.clone(),
        "^GSPC",
        "SPX",
        INDEX_HALF_SPREAD_PCT,
        2_000,
    );
    spawn_yahoo(
        state.clone(),
        client.clone(),
        "^DJI",
        "DJI",
        INDEX_HALF_SPREAD_PCT,
        2_000,
    );
    spawn_yahoo(
        state.clone(),
        client.clone(),
        "^IXIC",
        "NDX",
        INDEX_HALF_SPREAD_PCT,
        2_000,
    );

    // Historical OHLC backfill — fetch D1 + H1 from Yahoo for each Yahoo-fed
    // symbol so the chart's historical timeframes have data immediately
    // instead of waiting hours/days for live ticks to fill them. Refreshed
    // hourly while the engine runs.
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "GC=F", "cryXAUUSD");
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "^GSPC", "SPX");
    spawn_yahoo_history_refresh(state.clone(), client.clone(), "^DJI", "DJI");
    spawn_yahoo_history_refresh(state, client, "^IXIC", "NDX");
}

fn spawn_binance(
    state: SharedState,
    client: Arc<reqwest::Client>,
    pair: &'static str,
    symbol: &'static str,
    cadence_ms: u64,
) {
    tokio::spawn(async move {
        let last: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
        let mut interval = time::interval(Duration::from_millis(cadence_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            match fetch_binance(&client, pair).await {
                Some(ba) => {
                    *last.lock().await = Some(ba);
                }
                None => {
                    warn!(pair, "binance fetch failed — using last known price");
                }
            }

            if let Some((bid, ask)) = *last.lock().await {
                let tick = make_tick(symbol, bid, ask);
                dispatch(&state, tick).await;
            }
            // If still None (first fetch failed), skip this cycle silently.
        }
    });
}

/// Generic Yahoo Finance chart-endpoint feeder. Polls every `cadence_ms`,
/// synthesises bid/ask around the mid using `half_spread_pct`, and dispatches
/// a tick under the internal `symbol` id. Used for gold (GC=F) and US indices.
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
                let tick = mid_to_tick(symbol, mid, half_spread_pct);
                dispatch(&state, tick).await;
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
