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
        "crySOLUSD" => 500,
        "cryDOGEUSD" => 500,
        "cryXRPUSD" => 500,
        "cryADAUSD" => 500,
        "cryXAUUSD" => 1000,
        // PAXG poll cadence — Alpaca crypto API rate-limit-friendly at 1s.
        // Underlying gold doesn't move every millisecond anyway.
        "cryPAXGUSD" => 1000,
        "XAGUSD" => 2000,
        // US indices polled from Yahoo at 2s — the upstream doesn't update
        // any faster anyway and we don't want to hammer them.
        "SPX" | "DJI" | "NDX" => 2000,
        // ── Otuburu African synthetic family ───────────────────────────
        // PULSE-N = pure volatility (no spikes), N tied to annualised vol %.
        // SURGE-N = up-spike (was BOOM), N = expected ticks between spikes.
        // PLUNGE-N = down-spike (was CRASH), N = expected ticks between spikes.
        // DRIFT-N = slow trending random walk, N = lookback periodicity.
        // 500ms cadence keeps the price feel comparable to BOOM/CRASH.
        "PULSE75" | "PULSE100" => 500,
        "SURGE300" | "PLUNGE500" => 500,
        "DRIFT50" => 500,
        "DRIFT200" => 1000,
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
/// user-facing symbol name. Also rebrands the synthetic instrument family
/// from the legacy BOOM/CRASH names (Deriv-derived) to the Otuburu
/// SURGE/PLUNGE/PULSE/DRIFT brand. Internal IDs stay the same so
/// snapshots, ledger refs, position records, and the order book don't
/// need migration — only the visible label changes.
///
/// XAU keeps its three-letter code (no longer mislabelled as "crypto").
pub fn symbol_display_name(symbol: &str) -> &str {
    match symbol {
        // Rebrand legacy synthetics so users see the African-built family.
        "BOOM500" => return "SURGE-500",
        "BOOM1000" => return "SURGE-1000",
        "CRASH1000" => return "PLUNGE-1000",
        // New synthetic family — internal IDs are flat (no dash) so grep
        // and proto wire format are clean; user-facing names get the dash
        // for readability.
        "PULSE75" => return "PULSE-75",
        "PULSE100" => return "PULSE-100",
        "SURGE300" => return "SURGE-300",
        "PLUNGE500" => return "PLUNGE-500",
        "DRIFT50" => return "DRIFT-50",
        "DRIFT200" => return "DRIFT-200",
        _ => {}
    }
    symbol
        .strip_prefix("cry")
        .or_else(|| symbol.strip_prefix("frx"))
        .unwrap_or(symbol)
}

/// Display divisor used to scale high-priced assets for retail UX. Engine
/// stores true prices; frontends divide for presentation. PnL is in real USD
/// and never divided. Returns 1.0 when no scaling is wanted.
///
/// All divisors are now 1.0 — symbols display their REAL market prices
/// (gold at $4,500, BTC at $110,000, SPX at $7,400, etc.).
///
/// The "make small accounts feel bigger" job that this function used to do
/// has moved to the account.kind system (real_cent ×100, real_micro ×1000),
/// which is the MT5/Exness convention. A $10 deposit into a cent account
/// becomes 1000 cent-units the user can spend against the SAME real prices,
/// instead of fictional prices that don't match what they see on TradingView.
///
/// The frontend still reads `display_divisor` and divides — leaving the
/// helper here as a constant return keeps the wire contract stable and
/// lets us reintroduce per-symbol display tweaks later if needed without
/// another proto change.
pub fn symbol_display_divisor(_symbol: &str) -> f64 {
    1.0
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
            } else if *sym == "cryXAUUSD" || *sym == "XAGUSD" {
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
