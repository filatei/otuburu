//! Shared mutable state — wrapped in Arc<RwLock<>> for safe multi-task access.

use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use feed_generator::Tick;
use order_book::{Account, Book, ContractSpec};
use risk_engine::{RiskConfig, RiskEngine};
use std::collections::HashMap;

/// Tick broadcast channel capacity — 1024 ticks before slow subscribers are dropped.
pub const TICK_CHANNEL_CAP: usize = 1024;

/// Cadence (ms) per symbol — matches generators.js
pub fn symbol_cadence_ms(symbol: &str) -> u64 {
    match symbol {
        "BOOM500" => 500,
        "frxEURUSD" => 500,
        "frxGBPUSD" => 500,
        "cryBTCUSD" => 500,
        "cryETHUSD" => 500,
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
}

pub fn symbol_meta(specs: &HashMap<String, ContractSpec>) -> Vec<SymbolMeta> {
    specs
        .iter()
        .map(|(sym, spec)| {
            let kind = if sym.starts_with("frx") {
                "FX"
            } else if sym.starts_with("cry") {
                "CRYPTO"
            } else {
                "BOOM_CRASH"
            };
            SymbolMeta {
                symbol: sym.clone(),
                kind: kind.into(),
                contract_size: spec.contract_size,
                leverage: spec.leverage,
                cadence_ms: symbol_cadence_ms(sym),
            }
        })
        .collect()
}

/// The shared core — one `Book` (single demo account) + risk engine + tick bus.
pub struct Inner {
    pub book: Book,
    #[allow(dead_code)] // reserved for pre-trade risk checks (wired in next milestone)
    pub risk: RiskEngine,
    pub metas: Vec<SymbolMeta>,
}

#[derive(Clone)]
pub struct SharedState {
    pub inner: Arc<RwLock<Inner>>,
    /// Broadcast channel — every tick is sent here; subscribers clone a receiver.
    pub tick_tx: broadcast::Sender<Tick>,
}

impl SharedState {
    pub fn new() -> Self {
        let specs = order_book::default_contract_specs();
        let metas = symbol_meta(&specs);

        // Restore from last snapshot (survives container restarts).
        // Falls back to a fresh $10 000 demo account if no snapshot exists.
        let (account, saved_positions) = match crate::persistence::load() {
            Some(snap) => (snap.account, snap.positions),
            None       => (Account::new_demo(), vec![]),
        };

        let mut book = Book::new(account, specs);
        book.restore_positions(saved_positions);

        let risk = RiskEngine::new(RiskConfig::default());
        let (tick_tx, _) = broadcast::channel(TICK_CHANNEL_CAP);

        SharedState {
            inner: Arc::new(RwLock::new(Inner { book, risk, metas })),
            tick_tx,
        }
    }
}
