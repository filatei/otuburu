//! Binary options pricing and contract type registry.
//!
//! Extends the simple Rise/Fall in the demo with a pluggable
//! contract type system. Each contract type defines:
//!   - Its settlement condition (given entry + exit tick)
//!   - Its fair-value payout multiplier
//!   - The house payout multiplier (always ≤ fair-value)

use serde::{Deserialize, Serialize};

/// A contract type defines how a binary option is priced and settled.
pub trait ContractType: Send + Sync {
    fn name(&self) -> &str;
    /// Fair-value payout multiplier (e.g. 2.0 for 50/50)
    fn fair_multiplier(&self) -> f64;
    /// House payout multiplier (fair − edge). Must be < fair.
    fn house_multiplier(&self) -> f64;
    /// Returns true if the client wins given (entry_mid, exit_mid, barrier).
    fn is_win(&self, entry_mid: f64, exit_mid: f64, barrier: Option<f64>) -> bool;
    /// Expected house edge = (fair − house) / fair
    fn house_edge(&self) -> f64 {
        (self.fair_multiplier() - self.house_multiplier()) / self.fair_multiplier()
    }
}

// ──────────────────────────────────────────────────────────────
// Rise / Fall  (§9.1 — core product, symmetric, 7.5% edge)
// ──────────────────────────────────────────────────────────────

pub struct RiseFall {
    /// true = Rise (UP), false = Fall (DOWN)
    pub is_rise: bool,
}

impl ContractType for RiseFall {
    fn name(&self) -> &str { if self.is_rise { "RISE" } else { "FALL" } }
    fn fair_multiplier(&self) -> f64  { 2.0  }
    fn house_multiplier(&self) -> f64 { 1.85 } // 7.5% edge
    fn is_win(&self, entry: f64, exit: f64, _: Option<f64>) -> bool {
        if self.is_rise { exit > entry } else { exit < entry }
    }
}

// ──────────────────────────────────────────────────────────────
// Higher / Lower  (same as Rise/Fall but relative to a barrier)
// ──────────────────────────────────────────────────────────────

pub struct HigherLower {
    pub is_higher: bool,
}

impl ContractType for HigherLower {
    fn name(&self) -> &str { if self.is_higher { "HIGHER" } else { "LOWER" } }
    fn fair_multiplier(&self) -> f64  { 2.0  }
    fn house_multiplier(&self) -> f64 { 1.85 }
    fn is_win(&self, _entry: f64, exit: f64, barrier: Option<f64>) -> bool {
        let b = barrier.unwrap_or(0.0);
        if self.is_higher { exit > b } else { exit < b }
    }
}

// ──────────────────────────────────────────────────────────────
// Touch / No-touch  (settles if price ever touches barrier)
//
// NOTE: Touch/No-touch needs to evaluate every tick during the
// contract lifetime, not just at expiry. The Book must call
// `settle_touch` on each tick for active touch contracts.
// ──────────────────────────────────────────────────────────────

pub struct TouchNoTouch {
    /// true = Touch (wins if price hits barrier), false = No-touch
    pub is_touch: bool,
}

impl ContractType for TouchNoTouch {
    fn name(&self) -> &str { if self.is_touch { "TOUCH" } else { "NO_TOUCH" } }
    // Touch contracts pay slightly less due to early-settlement optionality
    fn fair_multiplier(&self) -> f64  { 2.0  }
    fn house_multiplier(&self) -> f64 { 1.80 } // 10% edge — wider spread for exotic
    fn is_win(&self, _entry: f64, exit: f64, barrier: Option<f64>) -> bool {
        // For Touch: win if current price == or crossed barrier.
        // This is called per-tick, so crossing is checked at each tick.
        let b = barrier.unwrap_or(f64::NAN);
        if self.is_touch { (exit - b).abs() < 1e-8 || exit >= b }
        else { exit < b } // simplified; full impl should track whether barrier was ever hit
    }
}

// ──────────────────────────────────────────────────────────────
// Contract registry
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ContractKind {
    Rise,
    Fall,
    Higher,
    Lower,
    Touch,
    NoTouch,
}

impl ContractKind {
    pub fn instantiate(&self) -> Box<dyn ContractType> {
        match self {
            ContractKind::Rise    => Box::new(RiseFall      { is_rise:    true  }),
            ContractKind::Fall    => Box::new(RiseFall      { is_rise:    false }),
            ContractKind::Higher  => Box::new(HigherLower   { is_higher:  true  }),
            ContractKind::Lower   => Box::new(HigherLower   { is_higher:  false }),
            ContractKind::Touch   => Box::new(TouchNoTouch  { is_touch:   true  }),
            ContractKind::NoTouch => Box::new(TouchNoTouch  { is_touch:   false }),
        }
    }

    pub fn house_multiplier(&self) -> f64 {
        self.instantiate().house_multiplier()
    }
    pub fn house_edge(&self) -> f64 {
        self.instantiate().house_edge()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rise_fall_edge() {
        let rise = RiseFall { is_rise: true };
        let edge = rise.house_edge();
        assert!((edge - 0.075).abs() < 1e-9, "expected 7.5% edge, got {edge}");
    }

    #[test]
    fn rise_wins_on_higher_exit() {
        let rise = RiseFall { is_rise: true };
        assert!(rise.is_win(100.0, 101.0, None));
        assert!(!rise.is_win(100.0, 99.0, None));
    }
}
