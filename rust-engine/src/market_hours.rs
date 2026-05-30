//! Market-hours gating for live feeds and trade entry.
//!
//! Each instrument class has its own session:
//! - **Crypto** (BTC/ETH) → 24/7. Always open.
//! - **Synthetic** (BOOM/CRASH) → 24/7. We control the generator.
//! - **FX** (EUR/USD, GBP/USD) → Sun 21:00 UTC → Fri 21:00 UTC (Sydney open through NY close).
//! - **Metals** (XAU/XAG) → Same as FX (interbank spot is a bullion-bank product on the same venues as FX).
//! - **US indices** (SPX/DJI/NDX) → 13:30 UTC → 20:00 UTC weekdays only. We ignore pre/post hours.
//!
//! Used in two places:
//!   1. The Yahoo / Alpaca / metals fetchers skip dispatching ticks when
//!      `is_open()` returns false. The frontend then sees stale ticks and
//!      can render a "Closed" badge + disable trade buttons.
//!   2. The risk engine rejects new orders on closed markets so even a
//!      hand-crafted API call can't open exposure while the underlying
//!      venue isn't trading.
//!
//! Holiday handling: deliberately NOT in scope here. US market holidays
//! (Christmas Day, Thanksgiving, etc.) would require a calendar lookup
//! that doesn't pay back the complexity at our scale. We'd see a flat
//! tick during a holiday and the >60s staleness on the frontend would
//! gate trades naturally.

use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolClass {
    Crypto,
    Synthetic,
    Forex,
    Metal,
    Index,
}

/// Map an internal symbol id to its instrument class. Used to pick the
/// right session calendar in `is_open`.
///
/// Unknown symbols default to Crypto (24/7) — safest "always open" assumption
/// so a config mistake doesn't accidentally freeze a real market.
pub fn classify(internal_symbol: &str) -> SymbolClass {
    match internal_symbol {
        // cryPAXGUSD is gold by underlying but lives on crypto venues, so
        // it inherits the 24/7 calendar — the whole reason we added it.
        // Altcoins (SOL, DOGE, XRP, ADA) trade 24/7 like BTC/ETH.
        "cryBTCUSD"
        | "cryETHUSD"
        | "cryPAXGUSD"
        | "crySOLUSD"
        | "cryDOGEUSD"
        | "cryXRPUSD"
        | "cryADAUSD" => SymbolClass::Crypto,
        "cryXAUUSD" | "XAGUSD" => SymbolClass::Metal,
        "SPX" | "DJI" | "NDX" => SymbolClass::Index,
        "frxEURUSD" | "frxGBPUSD" => SymbolClass::Forex,
        s if s.starts_with("BOOM") || s.starts_with("CRASH") => SymbolClass::Synthetic,
        _ => SymbolClass::Crypto,
    }
}

/// Is the market open for this symbol at `now`?
pub fn is_open(internal_symbol: &str, now: DateTime<Utc>) -> bool {
    match classify(internal_symbol) {
        SymbolClass::Crypto | SymbolClass::Synthetic => true,
        SymbolClass::Forex | SymbolClass::Metal => is_open_24_5(now),
        SymbolClass::Index => is_open_us_cash(now),
    }
}

/// FX/metals session — Sun 21:00 UTC through Fri 21:00 UTC.
///
/// The "21:00 UTC" boundaries roughly correspond to 17:00 New York time
/// (end of NY trading), shifted by US daylight saving by an hour. We use
/// the broader 21:00 UTC mark to avoid the DST-edge complications; the
/// real venues actually transition between 20:00 and 21:00 UTC depending
/// on time of year. Wider window = friendlier to traders, conservative
/// on us.
fn is_open_24_5(now: DateTime<Utc>) -> bool {
    let wd = now.weekday();
    let hour = now.hour();
    match wd {
        // Sunday before 21:00 UTC → still weekend close
        Weekday::Sun => hour >= 21,
        // Friday after 21:00 UTC → weekend
        Weekday::Fri => hour < 21,
        // Saturday → closed
        Weekday::Sat => false,
        // Mon-Thu → fully open
        _ => true,
    }
}

/// US cash equities session — 13:30 UTC (9:30 NY EST) through 20:00 UTC
/// (16:00 NY EST), Monday through Friday. Pre/post-market deliberately
/// excluded; our index symbols are CFD proxies for the cash session level
/// which is what most retail traders compare against.
fn is_open_us_cash(now: DateTime<Utc>) -> bool {
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) {
        return false;
    }
    let minute_of_day = now.hour() * 60 + now.minute();
    let open = 13 * 60 + 30; // 13:30 UTC
    let close = 20 * 60; // 20:00 UTC
    (open..close).contains(&minute_of_day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn crypto_always_open() {
        // Saturday at 03:00 UTC
        assert!(is_open("cryBTCUSD", at(2026, 5, 30, 3, 0)));
        // Sunday noon
        assert!(is_open("cryETHUSD", at(2026, 5, 31, 12, 0)));
    }

    #[test]
    fn fx_closed_weekend() {
        // Saturday morning
        assert!(!is_open("frxEURUSD", at(2026, 5, 30, 10, 0)));
        // Sunday before 21:00
        assert!(!is_open("frxEURUSD", at(2026, 5, 31, 20, 0)));
        // Sunday 21:30 → open
        assert!(is_open("frxEURUSD", at(2026, 5, 31, 21, 30)));
        // Friday 22:00 → closed
        assert!(!is_open("frxEURUSD", at(2026, 5, 29, 22, 0)));
    }

    #[test]
    fn metals_match_fx() {
        // Sat → closed; mid-week → open
        assert!(!is_open("cryXAUUSD", at(2026, 5, 30, 14, 0)));
        assert!(is_open("XAGUSD", at(2026, 5, 27, 14, 0)));
    }

    #[test]
    fn us_index_only_cash_hours() {
        // Wed 13:00 UTC → pre-market closed
        assert!(!is_open("SPX", at(2026, 5, 27, 13, 0)));
        // Wed 14:00 UTC → in session
        assert!(is_open("SPX", at(2026, 5, 27, 14, 0)));
        // Wed 20:00 UTC → just closed
        assert!(!is_open("DJI", at(2026, 5, 27, 20, 0)));
        // Sat → closed
        assert!(!is_open("NDX", at(2026, 5, 30, 14, 0)));
    }

    #[test]
    fn synthetic_always_open() {
        assert!(is_open("BOOM500", at(2026, 5, 30, 3, 0)));
        assert!(is_open("CRASH1000", at(2026, 5, 31, 12, 0)));
    }

    /// Regression for the Saturday-EUR/USD bug: every symbol we actually
    /// route into the order path must be classified correctly. A new
    /// frx*/cry* pair added without an entry here would default to
    /// `Crypto` (always-open) and silently allow weekend trades.
    #[test]
    fn known_symbols_classify_correctly() {
        assert_eq!(classify("frxEURUSD"), SymbolClass::Forex);
        assert_eq!(classify("frxGBPUSD"), SymbolClass::Forex);
        assert_eq!(classify("cryBTCUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryETHUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryPAXGUSD"), SymbolClass::Crypto);
        assert_eq!(classify("crySOLUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryDOGEUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryXRPUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryADAUSD"), SymbolClass::Crypto);
        assert_eq!(classify("cryXAUUSD"), SymbolClass::Metal);
        assert_eq!(classify("XAGUSD"), SymbolClass::Metal);
        assert_eq!(classify("SPX"), SymbolClass::Index);
        assert_eq!(classify("DJI"), SymbolClass::Index);
        assert_eq!(classify("NDX"), SymbolClass::Index);
        assert_eq!(classify("BOOM1000"), SymbolClass::Synthetic);
        assert_eq!(classify("CRASH500"), SymbolClass::Synthetic);
    }

    /// End-to-end of the bug that prompted this module's existence:
    /// EUR/USD on a Saturday morning UTC must be closed. If this fails
    /// it likely means the symbol-id convention drifted between the
    /// classifier and what the order path actually sends.
    #[test]
    fn eurusd_closed_on_saturday() {
        let sat_morning = at(2026, 5, 30, 10, 0);
        assert!(!is_open("frxEURUSD", sat_morning));
        assert!(!is_open("frxGBPUSD", sat_morning));
        assert!(!is_open("cryXAUUSD", sat_morning));
        assert!(!is_open("XAGUSD", sat_morning));
        // Crypto and synthetic stay open.
        assert!(is_open("cryBTCUSD", sat_morning));
        assert!(is_open("BOOM500", sat_morning));
    }
}
