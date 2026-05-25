//! Order book — CFD positions + Digital options book.
//!
//! Production port of `../../engine/engine.js`.
//! All state is in-memory in this crate; persistence (WAL + Postgres)
//! is handled by the parent `otuburu-engine` binary.

use feed_generator::Tick;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// ──────────────────────────────────────────────────────────────
// Contract specs
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ContractSpec {
    /// Notional units per lot (e.g. 100_000 for FX major)
    pub contract_size: f64,
    /// Maximum leverage offered
    pub leverage: u32,
}

pub fn default_contract_specs() -> HashMap<String, ContractSpec> {
    [
        (
            "BOOM1000",
            ContractSpec {
                contract_size: 1.0,
                leverage: 100,
            },
        ),
        (
            "BOOM500",
            ContractSpec {
                contract_size: 1.0,
                leverage: 100,
            },
        ),
        (
            "CRASH1000",
            ContractSpec {
                contract_size: 1.0,
                leverage: 100,
            },
        ),
        (
            "frxEURUSD",
            ContractSpec {
                contract_size: 100_000.0,
                leverage: 500,
            },
        ),
        (
            "frxGBPUSD",
            ContractSpec {
                contract_size: 100_000.0,
                leverage: 500,
            },
        ),
        (
            "cryBTCUSD",
            ContractSpec {
                contract_size: 1.0,
                leverage: 50,
            },
        ),
        (
            "cryETHUSD",
            ContractSpec {
                contract_size: 1.0,
                leverage: 50,
            },
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect()
}

// ──────────────────────────────────────────────────────────────
// CFD Position
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfdPosition {
    pub id: Uuid,
    pub account_id: Uuid,
    pub symbol: String,
    pub side: Side,
    pub lots: f64,
    pub entry: f64,
    pub margin: f64,
    pub notional: f64,
    pub unrealised_pnl: f64,
    pub opened_at_ms: i64,
}

// ──────────────────────────────────────────────────────────────
// Digital Option (Binary)
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Direction {
    Up,
    Down,
}

/// Payout multiplier — 1.85× implies 7.5% house edge on a fair-value 2.0× contract.
pub const PAYOUT_MULTIPLIER: f64 = 1.85;
pub const BINARY_HOUSE_EDGE: f64 = (2.0 - PAYOUT_MULTIPLIER) / 2.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryOption {
    pub id: Uuid,
    pub account_id: Uuid,
    pub symbol: String,
    pub direction: Direction,
    pub stake: f64,
    pub ticks_total: u32,
    pub ticks_left: u32,
    pub entry_mid: f64,
    pub opened_at_ms: i64,
}

// ──────────────────────────────────────────────────────────────
// Settlement result
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinarySettlement {
    pub option: BinaryOption,
    pub exit_mid: f64,
    pub won: bool,
    pub payout: f64,
}

// ──────────────────────────────────────────────────────────────
// Account
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: Uuid,
    pub currency: String,
    pub balance: f64,
    pub realised_pnl: f64,
}

impl Account {
    pub fn new_demo() -> Self {
        Account {
            // Fixed UUID so demo account ID is stable across engine restarts.
            // Changing this would invalidate any persisted client-side state.
            id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            currency: "USD".into(),
            balance: 10_000.0,
            realised_pnl: 0.0,
        }
    }
}

// ──────────────────────────────────────────────────────────────
// House stats
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HouseStats {
    pub total_spread_captured: f64,
    pub total_payout_margin: f64,
    pub total_client_pnl: f64,
    pub binary_count: u64,
    pub binary_wins: u64,
    pub cfd_count: u64,
}

impl HouseStats {
    pub fn house_net(&self) -> f64 {
        -self.total_client_pnl
    }
    pub fn binary_win_rate(&self) -> Option<f64> {
        if self.binary_count == 0 {
            None
        } else {
            Some(self.binary_wins as f64 / self.binary_count as f64)
        }
    }
}

// ──────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum BookError {
    #[error("no quote for {0}")]
    NoQuote(String),
    #[error("unknown symbol {0}")]
    UnknownSymbol(String),
    #[error("insufficient free margin (need {need:.2}, have {have:.2})")]
    InsufficientMargin { need: f64, have: f64 },
    #[error("insufficient balance (need {need:.2}, have {have:.2})")]
    InsufficientBalance { need: f64, have: f64 },
    #[error("position not found: {0}")]
    PositionNotFound(Uuid),
    #[error("invalid lots: {0}")]
    InvalidLots(f64),
    #[error("invalid stake: {0}")]
    InvalidStake(f64),
    #[error("ticks must be 1..=200, got {0}")]
    InvalidTicks(u32),
}

// ──────────────────────────────────────────────────────────────
// Book
// ──────────────────────────────────────────────────────────────

pub struct Book {
    pub account: Account,
    pub specs: HashMap<String, ContractSpec>,
    positions: HashMap<Uuid, CfdPosition>,
    binaries: HashMap<Uuid, BinaryOption>,
    quotes: HashMap<String, Tick>,
    pub house: HouseStats,
}

impl Book {
    pub fn new(account: Account, specs: HashMap<String, ContractSpec>) -> Self {
        Book {
            account,
            specs,
            positions: HashMap::new(),
            binaries: HashMap::new(),
            quotes: HashMap::new(),
            house: HouseStats::default(),
        }
    }

    // ── persistence helpers ─────────────────────────────────

    /// Returns a snapshot of all open CFD positions for serialisation.
    pub fn positions_snapshot(&self) -> Vec<CfdPosition> {
        self.positions.values().cloned().collect()
    }

    /// Restores CFD positions from a persisted snapshot (called once on startup).
    pub fn restore_positions(&mut self, positions: Vec<CfdPosition>) {
        self.positions = positions.into_iter().map(|p| (p.id, p)).collect();
    }

    // ── margin helpers ──────────────────────────────────────

    pub fn used_margin(&self) -> f64 {
        self.positions.values().map(|p| p.margin).sum()
    }
    fn unrealised_pnl(&self) -> f64 {
        self.positions.values().map(|p| p.unrealised_pnl).sum()
    }
    pub fn equity(&self) -> f64 {
        self.account.balance + self.unrealised_pnl()
    }
    pub fn free_margin(&self) -> f64 {
        self.equity() - self.used_margin()
    }
    pub fn margin_level(&self) -> f64 {
        let u = self.used_margin();
        if u == 0.0 {
            f64::INFINITY
        } else {
            self.equity() / u * 100.0
        }
    }

    // ── CFD ────────────────────────────────────────────────

    pub fn open_cfd(
        &mut self,
        account_id: Uuid,
        symbol: &str,
        side: Side,
        lots: f64,
    ) -> Result<CfdPosition, BookError> {
        if lots <= 0.0 || !lots.is_finite() {
            return Err(BookError::InvalidLots(lots));
        }
        let q = self
            .quotes
            .get(symbol)
            .ok_or_else(|| BookError::NoQuote(symbol.into()))?
            .clone();
        let spec = self
            .specs
            .get(symbol)
            .ok_or_else(|| BookError::UnknownSymbol(symbol.into()))?;

        let entry = if side == Side::Buy { q.ask } else { q.bid };
        let notional = lots * spec.contract_size * entry;
        let margin = notional / spec.leverage as f64;
        let free = self.free_margin();
        if margin > free {
            return Err(BookError::InsufficientMargin {
                need: margin,
                have: free,
            });
        }

        let spread_cost = lots * spec.contract_size * (q.ask - q.bid);
        self.house.total_spread_captured += spread_cost;
        self.house.cfd_count += 1;

        let pos = CfdPosition {
            id: Uuid::new_v4(),
            account_id,
            symbol: symbol.into(),
            side,
            lots,
            entry,
            margin,
            notional,
            unrealised_pnl: 0.0,
            opened_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        self.positions.insert(pos.id, pos.clone());
        Ok(pos)
    }

    pub fn close_cfd(&mut self, id: Uuid) -> Result<(CfdPosition, f64), BookError> {
        let p = self
            .positions
            .remove(&id)
            .ok_or(BookError::PositionNotFound(id))?;
        let q = self
            .quotes
            .get(&p.symbol)
            .ok_or_else(|| BookError::NoQuote(p.symbol.clone()))?
            .clone();
        let exit = if p.side == Side::Buy { q.bid } else { q.ask };
        let pnl = self.pnl_for(&p, exit);
        self.account.balance += pnl;
        self.account.realised_pnl += pnl;
        self.house.total_client_pnl += pnl;
        Ok((p, pnl))
    }

    fn pnl_for(&self, p: &CfdPosition, mark: f64) -> f64 {
        let dir = if p.side == Side::Buy { 1.0 } else { -1.0 };
        let cs = self
            .specs
            .get(&p.symbol)
            .map(|s| s.contract_size)
            .unwrap_or(1.0);
        dir * (mark - p.entry) * p.lots * cs
    }

    // ── Digital options ────────────────────────────────────

    pub fn open_binary(
        &mut self,
        account_id: Uuid,
        symbol: &str,
        direction: Direction,
        stake: f64,
        ticks: u32,
    ) -> Result<BinaryOption, BookError> {
        if stake <= 0.0 || !stake.is_finite() {
            return Err(BookError::InvalidStake(stake));
        }
        if ticks == 0 || ticks > 200 {
            return Err(BookError::InvalidTicks(ticks));
        }
        if stake > self.account.balance {
            return Err(BookError::InsufficientBalance {
                need: stake,
                have: self.account.balance,
            });
        }
        let q = self
            .quotes
            .get(symbol)
            .ok_or_else(|| BookError::NoQuote(symbol.into()))?
            .clone();

        self.account.balance -= stake;
        self.house.binary_count += 1;
        self.house.total_payout_margin += stake * BINARY_HOUSE_EDGE;

        let opt = BinaryOption {
            id: Uuid::new_v4(),
            account_id,
            symbol: symbol.into(),
            direction,
            stake,
            ticks_total: ticks,
            ticks_left: ticks,
            entry_mid: q.mid,
            opened_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        self.binaries.insert(opt.id, opt.clone());
        Ok(opt)
    }

    // ── Tick processing ─────────────────────────────────────

    /// Called on every incoming tick. Returns settled binary options.
    pub fn on_tick(&mut self, tick: &Tick) -> Vec<BinarySettlement> {
        self.quotes.insert(tick.symbol.clone(), tick.clone());

        // Mark-to-market open CFDs on this symbol
        let specs = &self.specs;
        for p in self
            .positions
            .values_mut()
            .filter(|p| p.symbol == tick.symbol)
        {
            let mark = if p.side == Side::Buy {
                tick.bid
            } else {
                tick.ask
            };
            let dir = if p.side == Side::Buy { 1.0 } else { -1.0 };
            let cs = specs.get(&p.symbol).map(|s| s.contract_size).unwrap_or(1.0);
            p.unrealised_pnl = dir * (mark - p.entry) * p.lots * cs;
        }

        // Stop-out at 50% margin level (close worst position)
        if self.margin_level() < 50.0 {
            if let Some(worst_id) = self
                .positions
                .values()
                .min_by(|a, b| a.unrealised_pnl.partial_cmp(&b.unrealised_pnl).unwrap())
                .map(|p| p.id)
            {
                let _ = self.close_cfd(worst_id);
            }
        }

        // Settle expiring binaries
        let mut settled = Vec::new();
        let to_settle: Vec<Uuid> = self
            .binaries
            .values()
            .filter(|b| b.symbol == tick.symbol)
            .map(|b| b.id)
            .collect();

        for id in to_settle {
            if let Some(b) = self.binaries.get_mut(&id) {
                b.ticks_left = b.ticks_left.saturating_sub(1);
                if b.ticks_left == 0 {
                    let b = self.binaries.remove(&id).unwrap();
                    let won = matches!(
                        (&b.direction, tick.mid > b.entry_mid, tick.mid < b.entry_mid),
                        (Direction::Up, true, _) | (Direction::Down, _, true)
                    );
                    let payout = if won {
                        b.stake * PAYOUT_MULTIPLIER
                    } else {
                        0.0
                    };
                    self.account.balance += payout;
                    self.house.total_client_pnl += payout - b.stake;
                    if won {
                        self.house.binary_wins += 1;
                    }
                    settled.push(BinarySettlement {
                        option: b,
                        exit_mid: tick.mid,
                        won,
                        payout,
                    });
                }
            }
        }
        settled
    }

    // ── Snapshot ─────────────────────────────────────────────

    pub fn positions(&self) -> Vec<&CfdPosition> {
        self.positions.values().collect()
    }
    pub fn binaries(&self) -> Vec<&BinaryOption> {
        self.binaries.values().collect()
    }
    pub fn quotes(&self) -> &HashMap<String, Tick> {
        &self.quotes
    }
}
