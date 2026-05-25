//! Order book — CFD positions + Digital options + Spot positions.
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
        (
            "cryXAUUSD",
            ContractSpec {
                contract_size: 1.0, // 1 troy-ounce per lot
                leverage: 20,
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

/// Why a position was auto-closed by the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AutoCloseReason {
    TakeProfit,
    StopLoss,
    StopOut,
    SpotTakeProfit,
    SpotStopLoss,
}

/// A CFD position with optional take-profit / stop-loss.
///
/// `tp_profit` — close when unrealised_pnl ≥ tp_profit (USD amount).
/// `sl_loss`   — close when unrealised_pnl ≤ −sl_loss  (positive magnitude, USD).
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
    /// Optional take-profit: auto-close when profit ≥ this value (USD).
    pub tp_profit: Option<f64>,
    /// Optional stop-loss: auto-close when loss ≥ this value (positive, USD).
    pub sl_loss: Option<f64>,
}

/// Result of an auto-close triggered by TP / SL / stop-out.
#[derive(Debug, Clone)]
pub struct AutoClosed {
    pub position: CfdPosition,
    pub exit: f64,
    pub pnl: f64,
    pub reason: AutoCloseReason,
}

// ──────────────────────────────────────────────────────────────
// Spot Position
// ──────────────────────────────────────────────────────────────

/// Fractional spot position — 1:1 leverage, balance debited upfront.
///
/// `stake`     — USD amount committed (full value, no leverage).
/// `units`     — asset units owned (stake / entry).
/// `tp_profit` — optional: auto-close when profit ≥ this USD amount.
/// `sl_loss`   — optional: auto-close when loss   ≥ this USD amount (positive magnitude).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpotPosition {
    pub id: Uuid,
    pub account_id: Uuid,
    pub symbol: String,
    pub side: Side,
    pub stake: f64,
    pub units: f64,
    pub entry: f64,
    pub unrealised_pnl: f64,
    pub opened_at_ms: i64,
    pub tp_profit: Option<f64>,
    pub sl_loss: Option<f64>,
}

/// Result of closing a spot position.
#[derive(Debug, Clone)]
pub struct SpotClosed {
    pub position: SpotPosition,
    pub exit: f64,
    pub pnl: f64,
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
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub is_demo: bool,
}

impl Account {
    pub fn new_demo() -> Self {
        Account {
            // Fixed UUID so the canonical demo account ID is stable across restarts.
            // Changing this would invalidate any persisted client-side state.
            id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            currency: "USD".into(),
            balance: 10_000.0,
            realised_pnl: 0.0,
            label: "Demo".into(),
            is_demo: true,
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
    pub spot_count: u64,
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
// Tick result from on_tick()
// ──────────────────────────────────────────────────────────────

pub struct TickResult {
    pub binary_settlements: Vec<BinarySettlement>,
    pub auto_closed_cfds: Vec<AutoClosed>,
    pub auto_closed_spots: Vec<SpotClosed>,
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
    spots: HashMap<Uuid, SpotPosition>,
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
            spots: HashMap::new(),
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

    /// Returns a snapshot of all open spot positions for serialisation.
    pub fn spots_snapshot(&self) -> Vec<SpotPosition> {
        self.spots.values().cloned().collect()
    }

    /// Restores spot positions from a persisted snapshot (called once on startup).
    pub fn restore_spots(&mut self, spots: Vec<SpotPosition>) {
        self.spots = spots.into_iter().map(|p| (p.id, p)).collect();
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

    /// Open a CFD position.
    ///
    /// `tp_profit` — optional take-profit in USD (positive = profit target).
    /// `sl_loss`   — optional stop-loss in USD (positive magnitude; max you're willing to lose).
    pub fn open_cfd(
        &mut self,
        account_id: Uuid,
        symbol: &str,
        side: Side,
        lots: f64,
        tp_profit: Option<f64>,
        sl_loss: Option<f64>,
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
            tp_profit,
            sl_loss,
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

    // ── Spot ────────────────────────────────────────────────

    /// Open a fractional spot position.
    ///
    /// The full `stake` is debited from balance immediately (no leverage).
    /// `units` = stake / entry_price.
    /// `tp_profit` / `sl_loss` work like CFD — in USD profit/loss magnitude.
    pub fn open_spot(
        &mut self,
        account_id: Uuid,
        symbol: &str,
        side: Side,
        stake: f64,
        tp_profit: Option<f64>,
        sl_loss: Option<f64>,
    ) -> Result<SpotPosition, BookError> {
        if stake <= 0.0 || !stake.is_finite() {
            return Err(BookError::InvalidStake(stake));
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

        // Use ask for buys, bid for sells (market-order fill)
        let entry = if side == Side::Buy { q.ask } else { q.bid };
        let units = stake / entry;

        self.account.balance -= stake;
        self.house.spot_count += 1;

        let pos = SpotPosition {
            id: Uuid::new_v4(),
            account_id,
            symbol: symbol.into(),
            side,
            stake,
            units,
            entry,
            unrealised_pnl: 0.0,
            opened_at_ms: chrono::Utc::now().timestamp_millis(),
            tp_profit,
            sl_loss,
        };
        self.spots.insert(pos.id, pos.clone());
        Ok(pos)
    }

    /// Close a spot position at the current market price.
    /// Returns the position, exit price, and P&L.
    pub fn close_spot(&mut self, id: Uuid) -> Result<SpotClosed, BookError> {
        let p = self
            .spots
            .remove(&id)
            .ok_or(BookError::PositionNotFound(id))?;
        let q = self
            .quotes
            .get(&p.symbol)
            .ok_or_else(|| BookError::NoQuote(p.symbol.clone()))?
            .clone();

        // Close at bid for buys, ask for sells
        let exit = if p.side == Side::Buy { q.bid } else { q.ask };
        let current_value = p.units * exit;
        let pnl = if p.side == Side::Buy {
            current_value - p.stake
        } else {
            p.stake - current_value
        };

        // Credit back stake + PnL (pnl can be negative if a loss)
        self.account.balance += p.stake + pnl;
        self.account.realised_pnl += pnl;
        self.house.total_client_pnl += pnl;

        Ok(SpotClosed {
            position: p,
            exit,
            pnl,
        })
    }

    fn spot_pnl(p: &SpotPosition, mark: f64) -> f64 {
        let current_value = p.units * mark;
        if p.side == Side::Buy {
            current_value - p.stake
        } else {
            p.stake - current_value
        }
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

    /// Called on every incoming tick.
    /// Returns a `TickResult` containing settled binaries, auto-closed CFDs,
    /// and auto-closed spot positions.
    pub fn on_tick(&mut self, tick: &Tick) -> TickResult {
        self.quotes.insert(tick.symbol.clone(), tick.clone());

        // ── Mark-to-market CFDs ─────────────────────────────
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

        // ── Mark-to-market Spot ─────────────────────────────
        for p in self.spots.values_mut().filter(|p| p.symbol == tick.symbol) {
            let mark = if p.side == Side::Buy {
                tick.bid
            } else {
                tick.ask
            };
            p.unrealised_pnl = Self::spot_pnl(p, mark);
        }

        // ── CFD TP / SL auto-close ──────────────────────────
        let tp_sl_ids: Vec<(Uuid, AutoCloseReason)> = self
            .positions
            .values()
            .filter(|p| p.symbol == tick.symbol)
            .filter_map(|p| {
                if let Some(tp) = p.tp_profit {
                    if p.unrealised_pnl >= tp {
                        return Some((p.id, AutoCloseReason::TakeProfit));
                    }
                }
                if let Some(sl) = p.sl_loss {
                    if p.unrealised_pnl <= -sl {
                        return Some((p.id, AutoCloseReason::StopLoss));
                    }
                }
                None
            })
            .collect();

        let mut auto_closed_cfds: Vec<AutoClosed> = Vec::new();
        for (id, reason) in tp_sl_ids {
            if let Ok((pos, pnl)) = self.close_cfd(id) {
                let exit = if pos.side == Side::Buy {
                    tick.bid
                } else {
                    tick.ask
                };
                auto_closed_cfds.push(AutoClosed {
                    position: pos,
                    exit,
                    pnl,
                    reason,
                });
            }
        }

        // ── Stop-out at 50% margin level ────────────────────
        if self.margin_level() < 50.0 {
            if let Some(worst_id) = self
                .positions
                .values()
                .min_by(|a, b| a.unrealised_pnl.partial_cmp(&b.unrealised_pnl).unwrap())
                .map(|p| p.id)
            {
                if let Ok((pos, pnl)) = self.close_cfd(worst_id) {
                    let exit = if pos.side == Side::Buy {
                        tick.bid
                    } else {
                        tick.ask
                    };
                    auto_closed_cfds.push(AutoClosed {
                        position: pos,
                        exit,
                        pnl,
                        reason: AutoCloseReason::StopOut,
                    });
                }
            }
        }

        // ── Spot TP / SL auto-close ─────────────────────────
        let spot_tp_sl_ids: Vec<(Uuid, AutoCloseReason)> = self
            .spots
            .values()
            .filter(|p| p.symbol == tick.symbol)
            .filter_map(|p| {
                if let Some(tp) = p.tp_profit {
                    if p.unrealised_pnl >= tp {
                        return Some((p.id, AutoCloseReason::SpotTakeProfit));
                    }
                }
                if let Some(sl) = p.sl_loss {
                    if p.unrealised_pnl <= -sl {
                        return Some((p.id, AutoCloseReason::SpotStopLoss));
                    }
                }
                None
            })
            .collect();

        let mut auto_closed_spots: Vec<SpotClosed> = Vec::new();
        for (id, _) in spot_tp_sl_ids {
            if let Ok(closed) = self.close_spot(id) {
                auto_closed_spots.push(closed);
            }
        }

        // ── Settle expiring binaries ────────────────────────
        let mut binary_settlements = Vec::new();
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
                    binary_settlements.push(BinarySettlement {
                        option: b,
                        exit_mid: tick.mid,
                        won,
                        payout,
                    });
                }
            }
        }

        TickResult {
            binary_settlements,
            auto_closed_cfds,
            auto_closed_spots,
        }
    }

    // ── Snapshot ─────────────────────────────────────────────

    pub fn positions(&self) -> Vec<&CfdPosition> {
        self.positions.values().collect()
    }
    pub fn spots(&self) -> Vec<&SpotPosition> {
        self.spots.values().collect()
    }
    pub fn binaries(&self) -> Vec<&BinaryOption> {
        self.binaries.values().collect()
    }
    pub fn quotes(&self) -> &HashMap<String, Tick> {
        &self.quotes
    }
}
