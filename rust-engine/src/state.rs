//! Shared mutable state — wrapped in Arc<RwLock<>> for safe multi-task access.
//!
//! `Inner` holds a HashMap of Books (one per account), OHLC aggregators, and
//! risk engine. `SharedState` additionally carries the SQLite pool and the
//! broadcast channel — both are cheaply cloneable independently of the lock.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

use feed_generator::Tick;
use order_book::{Account, Book, ContractSpec};
use risk_engine::{RiskConfig, RiskEngine};

use crate::ohlc::OhlcStore;

/// Tick broadcast channel capacity — 1024 ticks before slow subscribers are dropped.
pub const TICK_CHANNEL_CAP: usize = 1024;

/// Default demo balance for auto-provisioned accounts.
const DEFAULT_DEMO_BALANCE: f64 = 10_000.0;

/// Cadence (ms) per symbol — matches generators.js
pub fn symbol_cadence_ms(symbol: &str) -> u64 {
    match symbol {
        "BOOM500" => 500,
        "frxEURUSD" => 500,
        "frxGBPUSD" => 500,
        "cryBTCUSD" => 500,
        "cryETHUSD" => 500,
        "cryXAUUSD" => 1000,
        // US indices polled from Yahoo at 2s — the upstream doesn't update
        // any faster anyway and we don't want to hammer them.
        "SPX" | "DJI" | "NDX" => 2000,
        _ => 1000, // BOOM1000, CRASH1000
    }
}

/// All the metadata for a symbol exposed via GetSymbols.
#[derive(Clone)]
pub struct SymbolMeta {
    pub symbol: String,
    pub kind: String, // "BOOM_CRASH" | "FX" | "CRYPTO"
    pub contract_size: f64,
    pub leverage: u32,
    pub cadence_ms: u64,
    /// Display-only price divisor — see `display_divisor` on `SymbolInfo` in
    /// the proto. Storage and math always use true prices; this is applied at
    /// render time. Default 1.0 = no scaling.
    pub display_divisor: f64,
    /// User-facing symbol name (e.g. "BTCUSD" for internal "cryBTCUSD").
    /// Frontends render this; internal id stays in `symbol`.
    pub display_symbol: String,
}

/// Strip the historical `cry`/`frx` namespace prefix to produce the
/// user-facing symbol name. Returns the input unchanged when no prefix
/// applies (e.g. BOOM500, CRASH1000). XAU keeps its three-letter code (no
/// longer mislabelled as "crypto").
pub fn symbol_display_name(symbol: &str) -> &str {
    symbol
        .strip_prefix("cry")
        .or_else(|| symbol.strip_prefix("frx"))
        .unwrap_or(symbol)
}

/// Display divisor used to scale high-priced assets for retail UX. Engine
/// stores true prices; frontends divide for presentation. PnL is in real USD
/// and never divided. Returns 1.0 when no scaling is wanted.
///
/// Tuned for typical mid-2026 spot prices so display values land in a
/// retail-friendly $5–$500 range (or $1–$10 for the heavily-scaled ones so
/// small-capital users can participate in single-unit movements):
///   - cryBTCUSD ÷ 1000 → BTC ~$77k  shows as ~$77
///   - cryETHUSD ÷ 10   → ETH ~$2.1k shows as ~$210
///   - cryXAUUSD ÷ 1000 → XAU ~$4.5k shows as ~$4.53 (small-cap friendly)
///   - SPX       ÷ 1000 → S&P ~7400  shows as ~$7.40
///   - DJI       ÷ 1000 → Dow ~50.6k shows as ~$50.60
///   - NDX       ÷ 1000 → Nasdaq ~26k shows as ~$26.30
///
/// Adjust if prices drift far enough that the display values leave the band.
pub fn symbol_display_divisor(symbol: &str) -> f64 {
    match symbol {
        "cryBTCUSD" => 1000.0,
        "cryETHUSD" => 10.0,
        "cryXAUUSD" => 1000.0,
        "SPX" | "DJI" | "NDX" => 1000.0,
        _ => 1.0,
    }
}

/// Symbols that represent US equity indices fed from Yahoo (no `^` prefix
/// in our internal IDs — the prefix is added only when calling Yahoo).
const INDEX_SYMBOLS: &[&str] = &["SPX", "DJI", "NDX"];

pub fn symbol_meta(specs: &HashMap<String, ContractSpec>) -> Vec<SymbolMeta> {
    specs
        .iter()
        .map(|(sym, spec)| {
            let kind = if sym.starts_with("frx") {
                "FX"
            } else if *sym == "cryXAUUSD" {
                "METAL"
            } else if sym.starts_with("cry") {
                "CRYPTO"
            } else if INDEX_SYMBOLS.contains(&sym.as_str()) {
                "INDEX"
            } else {
                "BOOM_CRASH"
            };
            SymbolMeta {
                symbol: sym.clone(),
                kind: kind.into(),
                contract_size: spec.contract_size,
                leverage: spec.leverage,
                cadence_ms: symbol_cadence_ms(sym),
                display_divisor: symbol_display_divisor(sym),
                display_symbol: symbol_display_name(sym).to_string(),
            }
        })
        .collect()
}

/// Shared inner state — write-locked for trades and tick processing.
pub struct Inner {
    /// One Book per account (demo or real). Auto-created on first request.
    pub books: HashMap<Uuid, Book>,
    /// Contract specs — shared (read-only after startup).
    pub specs: HashMap<String, ContractSpec>,
    #[allow(dead_code)] // reserved for pre-trade risk checks
    pub risk: RiskEngine,
    pub metas: Vec<SymbolMeta>,
    /// In-memory OHLC ring buffers for all symbols and resolutions.
    pub ohlc: OhlcStore,
}

impl Inner {
    /// Returns a mutable reference to the book for `account_id`, creating a
    /// fresh demo book if none exists. Uses `label` and `is_demo` only on creation.
    pub fn get_or_create_book(
        &mut self,
        account_id: Uuid,
        label: &str,
        is_demo: bool,
        initial_balance: f64,
    ) -> &mut Book {
        if !self.books.contains_key(&account_id) {
            let balance = if initial_balance > 0.0 {
                initial_balance
            } else {
                DEFAULT_DEMO_BALANCE
            };
            let account = Account {
                id: account_id,
                currency: "USD".into(),
                balance,
                realised_pnl: 0.0,
                label: label.to_owned(),
                is_demo,
            };
            let book = Book::new(account, self.specs.clone());
            self.books.insert(account_id, book);
        }
        self.books.get_mut(&account_id).unwrap()
    }
}

#[derive(Clone)]
pub struct SharedState {
    pub inner: Arc<RwLock<Inner>>,
    /// Broadcast channel — every tick is sent here; subscribers clone a receiver.
    pub tick_tx: broadcast::Sender<Tick>,
    /// SQLite connection pool — cloneable, internally arc'd.
    pub db: sqlx::SqlitePool,
}

impl SharedState {
    pub async fn new() -> Self {
        // ── Database ─────────────────────────────────────────────────────────
        let db = crate::db::connect()
            .await
            .expect("failed to connect to SQLite DB");

        // ── Contract specs ────────────────────────────────────────────────────
        let specs = order_book::default_contract_specs();
        let metas = symbol_meta(&specs);

        // ── Restore or create books ───────────────────────────────────────────
        // Snapshot v3 holds Vec<BookSnapshot> with positions + spots.
        // v2/v1 or missing → start fresh (spots defaults to empty via serde default).
        let books: HashMap<Uuid, Book> = match crate::persistence::load() {
            Some(snap) => snap
                .books
                .into_iter()
                .map(|bs| {
                    let id = bs.account.id;
                    let mut book = Book::new(bs.account, specs.clone());
                    book.restore_positions(bs.positions);
                    book.restore_spots(bs.spots);
                    (id, book)
                })
                .collect(),
            None => {
                // Provision one canonical demo account.
                let account = Account::new_demo();
                let id = account.id;
                let book = Book::new(account, specs.clone());
                let mut m = HashMap::new();
                m.insert(id, book);
                m
            }
        };

        tracing::info!(accounts = books.len(), "books loaded");

        let risk = RiskEngine::new(RiskConfig::default());
        let (tick_tx, _) = broadcast::channel(TICK_CHANNEL_CAP);
        let ohlc = OhlcStore::default();

        SharedState {
            inner: Arc::new(RwLock::new(Inner {
                books,
                specs,
                risk,
                metas,
                ohlc,
            })),
            tick_tx,
            db,
        }
    }
}
