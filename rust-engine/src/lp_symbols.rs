//! Translate Otuburu internal symbol identifiers to LP-native form.
//!
//! Sprint 5.5b. The engine's place_order RPC calls
//! `translate_for_lp()` before forwarding a routed order to
//! `liquidity_bridge` so each LP receives instruments in whatever
//! naming convention it expects.
//!
//! Why this lives in the engine, not the bridge crate
//! ---------------------------------------------------
//! Otuburu's `cry` / `frx` prefixes are platform-internal. Adapters
//! in `liquidity-bridge` stay vendor-pure and never see Otuburu
//! names — we translate FIRST in the engine, then hand the LP-native
//! string to the adapter via `PlaceMarketRequest.instrument`. Adding
//! a new LP means editing the match in `translate_for_lp()`, not
//! every adapter.
//!
//! No-LP-equivalent symbols
//! -------------------------
//! Otuburu synthetic indices (BOOM/CRASH/PULSE/SURGE/PLUNGE/DRIFT),
//! Rise-Fall binaries, and US cash indices (SPX/DJI/NDX — broker
//! conventions vary too much to map blindly) all return `None`. The
//! engine's place_order RPC treats `None` as "fall back to synthetic"
//! regardless of the account's `routing_mode`. This is the load-
//! bearing safety property: synthetics never accidentally route to
//! a real LP.

/// Strip Otuburu's internal symbol prefix and return the canonical
/// 6-char ticker. Returns `None` for symbols without an obvious LP
/// equivalent — those callers fall back to the synthetic book.
pub fn otuburu_root(otuburu: &str) -> Option<&str> {
    if let Some(s) = otuburu.strip_prefix("cry") {
        return Some(s);
    }
    if let Some(s) = otuburu.strip_prefix("frx") {
        return Some(s);
    }
    if matches!(otuburu, "XAUUSD" | "XAGUSD") {
        return Some(otuburu);
    }
    None
}

/// Format a 6-char root for the MetaApi adapter, given the
/// configured suffix. Pure function so unit tests don't have to
/// touch the process env. Real call sites read `METAAPI_SYMBOL_SUFFIX`
/// at runtime via [`translate_for_lp`].
///
/// Suffix is typically empty for standard MT5 accounts. Exness cent
/// accounts (USC currency) and some other broker variants append
/// `m`, `c`, `.cent`, etc. — we discover the real symbol set at
/// smoke-test time and configure via env.
pub fn format_metaapi(root: &str, suffix: &str) -> String {
    format!("{root}{suffix}")
}

/// Format a 6-char root for OANDA v20 (BASE_QUOTE with an
/// underscore). Pure function so callers can test the split logic
/// without env or adapter mocks. Returns `None` for roots that
/// aren't 6 chars (defensive — OANDA doesn't have non-6-char
/// instruments in the symbol set we route).
pub fn format_oanda(root: &str) -> Option<String> {
    if root.len() == 6 {
        let (base, quote) = root.split_at(3);
        Some(format!("{base}_{quote}"))
    } else {
        None
    }
}

/// Translate an Otuburu internal symbol to the LP's native form,
/// dispatching by the adapter's `name()`.
///
/// Match arms are prefix-based (e.g. `"ctrader"` matches both
/// `"ctrader-demo"` and `"ctrader-live"`) so we don't need a separate
/// arm per environment.
///
/// Returns `None` when either:
///   - The Otuburu symbol has no LP root (synthetic indices, etc.),
///     OR
///   - The LP name is unknown (defensive — don't route into a
///     misnamed adapter; better to silently fall back to synthetic
///     than misformat a real order).
pub fn translate_for_lp(otuburu: &str, lp_name: &str) -> Option<String> {
    let root = otuburu_root(otuburu)?;
    if lp_name.starts_with("ctrader") {
        // cTrader / IC Markets Raw — plain `BASEQUOTE`.
        Some(root.to_string())
    } else if lp_name.starts_with("metaapi") {
        let suffix = std::env::var("METAAPI_SYMBOL_SUFFIX").unwrap_or_default();
        Some(format_metaapi(root, &suffix))
    } else if lp_name.starts_with("oanda") {
        format_oanda(root)
    } else if lp_name == "stub" {
        Some(root.to_string())
    } else {
        None
    }
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forex_pairs_strip_frx_prefix() {
        assert_eq!(otuburu_root("frxEURUSD"), Some("EURUSD"));
        assert_eq!(otuburu_root("frxGBPUSD"), Some("GBPUSD"));
        assert_eq!(otuburu_root("frxUSDJPY"), Some("USDJPY"));
        assert_eq!(otuburu_root("frxAUDUSD"), Some("AUDUSD"));
    }

    #[test]
    fn crypto_pairs_strip_cry_prefix() {
        assert_eq!(otuburu_root("cryBTCUSD"), Some("BTCUSD"));
        assert_eq!(otuburu_root("cryETHUSD"), Some("ETHUSD"));
        assert_eq!(otuburu_root("cryXAUUSD"), Some("XAUUSD"));
        assert_eq!(otuburu_root("crySOLUSD"), Some("SOLUSD"));
    }

    #[test]
    fn metals_pass_through_as_is() {
        // XAUUSD/XAGUSD are already in 6-char form (no prefix) and
        // every LP we support recognises them verbatim.
        assert_eq!(otuburu_root("XAUUSD"), Some("XAUUSD"));
        assert_eq!(otuburu_root("XAGUSD"), Some("XAGUSD"));
    }

    /// Synthetic indices must never resolve to an LP root, regardless
    /// of caller. This is the load-bearing safety invariant: a
    /// Passthrough-flagged account that tries to trade BOOM1000 must
    /// fall back to the engine's synthetic book.
    #[test]
    fn synthetic_indices_return_none() {
        assert_eq!(otuburu_root("BOOM1000"), None);
        assert_eq!(otuburu_root("BOOM500"), None);
        assert_eq!(otuburu_root("CRASH1000"), None);
        assert_eq!(otuburu_root("PULSE75"), None);
        assert_eq!(otuburu_root("PULSE100"), None);
        assert_eq!(otuburu_root("SURGE300"), None);
        assert_eq!(otuburu_root("PLUNGE500"), None);
        assert_eq!(otuburu_root("DRIFT50"), None);
        assert_eq!(otuburu_root("DRIFT200"), None);
    }

    /// US cash indices return None pending broker-specific naming
    /// confirmation (some brokers use US500/US30/USTECH; others
    /// SPX500/US30/NAS100). We add explicit mappings in a 5.5b
    /// follow-up once each broker's symbol list is known.
    #[test]
    fn us_indices_return_none_for_now() {
        assert_eq!(otuburu_root("SPX"), None);
        assert_eq!(otuburu_root("DJI"), None);
        assert_eq!(otuburu_root("NDX"), None);
    }

    // ── Per-LP formatting ──────────────────────────────────────

    #[test]
    fn format_metaapi_passes_root_through_with_empty_suffix() {
        assert_eq!(format_metaapi("EURUSD", ""), "EURUSD");
        assert_eq!(format_metaapi("XAUUSD", ""), "XAUUSD");
    }

    #[test]
    fn format_metaapi_appends_broker_suffix() {
        // Exness cent variants — 'm' suffix is the most common.
        assert_eq!(format_metaapi("EURUSD", "m"), "EURUSDm");
        // Some brokers use '.cent' or 'c' — function is suffix-agnostic.
        assert_eq!(format_metaapi("EURUSD", ".cent"), "EURUSD.cent");
        assert_eq!(format_metaapi("EURUSD", "c"), "EURUSDc");
    }

    #[test]
    fn format_oanda_splits_into_base_quote() {
        assert_eq!(format_oanda("EURUSD"), Some("EUR_USD".to_string()));
        assert_eq!(format_oanda("XAUUSD"), Some("XAU_USD".to_string()));
        assert_eq!(format_oanda("USDJPY"), Some("USD_JPY".to_string()));
    }

    #[test]
    fn format_oanda_rejects_non_6_char_roots() {
        // Defensive — OANDA's instrument naming assumes 3+3. If a
        // future Otuburu symbol violates that, fail explicit rather
        // than emit nonsense.
        assert_eq!(format_oanda("BTC"), None);
        assert_eq!(format_oanda("EURUSDX"), None);
    }

    // ── Dispatch ───────────────────────────────────────────────

    #[test]
    fn ctrader_dispatch_uses_plain_ticker() {
        assert_eq!(
            translate_for_lp("frxEURUSD", "ctrader-demo"),
            Some("EURUSD".to_string())
        );
        assert_eq!(
            translate_for_lp("cryBTCUSD", "ctrader-live"),
            Some("BTCUSD".to_string())
        );
        assert_eq!(
            translate_for_lp("XAUUSD", "ctrader-demo"),
            Some("XAUUSD".to_string())
        );
    }

    #[test]
    fn oanda_dispatch_inserts_underscore() {
        assert_eq!(
            translate_for_lp("frxEURUSD", "oanda-practice"),
            Some("EUR_USD".to_string())
        );
        assert_eq!(
            translate_for_lp("XAUUSD", "oanda-live"),
            Some("XAU_USD".to_string())
        );
    }

    #[test]
    fn stub_dispatch_uses_plain_ticker() {
        assert_eq!(
            translate_for_lp("frxEURUSD", "stub"),
            Some("EURUSD".to_string())
        );
    }

    /// Load-bearing safety: synthetic indices stay synthetic even
    /// when routing_mode is Passthrough.
    #[test]
    fn synthetic_indices_never_route_through_any_lp() {
        assert_eq!(translate_for_lp("BOOM1000", "ctrader-demo"), None);
        assert_eq!(translate_for_lp("PULSE75", "metaapi-london"), None);
        assert_eq!(translate_for_lp("DRIFT200", "oanda-practice"), None);
        assert_eq!(translate_for_lp("SURGE300", "stub"), None);
    }

    /// Defensive: if the engine ever sees an LP name we don't
    /// recognise, fall back to synthetic. Better than misformatting
    /// a real order.
    #[test]
    fn unknown_lp_returns_none() {
        assert_eq!(translate_for_lp("frxEURUSD", "future-broker-xyz"), None);
        assert_eq!(translate_for_lp("frxEURUSD", ""), None);
    }
}
