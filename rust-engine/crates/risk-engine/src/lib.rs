//! Risk engine — pre-trade checks and circuit-breakers.
//!
//! Provides configurable limits that wrap every order before it
//! reaches the order book.
//!
//! # Checks implemented
//! - Max single-order notional (CFD)
//! - Max stake per binary option
//! - Max stake per spot position
//! - Max total open notional per symbol (symbol exposure cap)
//! - Max total net long/short notional (house book exposure)
//! - Client daily loss limit (drawdown circuit-breaker)
//! - Stale-price guard (refuse trades against a feed older than N seconds)
//!
//! Limits default to retail-scale fractional brokerage. Catastrophic-loss
//! protection comes from the layered combination — no single check stops a
//! determined attacker, but together they keep house liability bounded.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    /// Maximum notional per single CFD order (USD)
    pub max_order_notional: f64,
    /// Maximum stake on a single binary option (USD)
    pub max_binary_stake: f64,
    /// Maximum stake on a single spot position (USD)
    pub max_spot_stake: f64,
    /// Maximum aggregate open notional per symbol (USD)
    pub max_symbol_exposure: f64,
    /// Maximum aggregate house net position (USD)
    pub max_house_net_exposure: f64,
    /// Maximum daily realised loss a client can sustain before trading is suspended
    pub client_daily_loss_limit: f64,
    /// Maximum age (seconds) of the most recent tick before trading on that
    /// symbol is refused. Protects against feed-lag arbitrage.
    pub max_tick_age_secs: i64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        // Tuned for retail-scale fractional brokerage. Override per deployment
        // by serialising a RiskConfig and loading at boot if institutional
        // limits are needed.
        RiskConfig {
            max_order_notional: 10_000.0,
            max_binary_stake: 500.0,
            max_spot_stake: 5_000.0,
            max_symbol_exposure: 100_000.0,
            max_house_net_exposure: 500_000.0,
            client_daily_loss_limit: 2_000.0,
            max_tick_age_secs: 15,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RiskError {
    #[error("order notional ${notional:.2} exceeds max ${max:.2}")]
    OrderTooLarge { notional: f64, max: f64 },
    #[error("symbol {symbol} exposure ${current:.2} + ${order:.2} would exceed cap ${cap:.2}")]
    SymbolExposureExceeded {
        symbol: String,
        current: f64,
        order: f64,
        cap: f64,
    },
    #[error("house net exposure ${current:.2} + ${order:.2} would exceed cap ${cap:.2}")]
    HouseExposureExceeded { current: f64, order: f64, cap: f64 },
    #[error("daily loss for account {account_id} (${loss:.2}) exceeds limit ${limit:.2}")]
    ClientDailyLossExceeded {
        account_id: Uuid,
        loss: f64,
        limit: f64,
    },
    #[error("binary stake ${stake:.2} exceeds max ${max:.2}")]
    BinaryStakeTooLarge { stake: f64, max: f64 },
    #[error("spot stake ${stake:.2} exceeds max ${max:.2}")]
    SpotStakeTooLarge { stake: f64, max: f64 },
    #[error("price feed for {symbol} is stale ({age_secs}s old, max {max_secs}s)")]
    StalePrice {
        symbol: String,
        age_secs: i64,
        max_secs: i64,
    },
    #[error("no price feed yet for symbol {symbol}")]
    NoPriceForSymbol { symbol: String },
}

pub struct RiskEngine {
    pub cfg: RiskConfig,
}

impl RiskEngine {
    pub fn new(cfg: RiskConfig) -> Self {
        RiskEngine { cfg }
    }

    /// Refuse trading if the most recent tick for `symbol` is older than the
    /// configured threshold. `last_tick_ts_ms = None` is treated as no feed yet.
    pub fn check_price_freshness(
        &self,
        symbol: &str,
        last_tick_ts_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<(), RiskError> {
        match last_tick_ts_ms {
            None => Err(RiskError::NoPriceForSymbol {
                symbol: symbol.into(),
            }),
            Some(ts) => {
                let age_secs = (now_ms - ts) / 1000;
                if age_secs > self.cfg.max_tick_age_secs {
                    Err(RiskError::StalePrice {
                        symbol: symbol.into(),
                        age_secs,
                        max_secs: self.cfg.max_tick_age_secs,
                    })
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Pre-trade check for a CFD order.
    pub fn check_cfd(
        &self,
        notional: f64,
        symbol: &str,
        symbol_exposure: f64,
        house_net_exposure: f64,
        client_daily_loss: f64,
        account_id: Uuid,
    ) -> Result<(), RiskError> {
        if notional > self.cfg.max_order_notional {
            return Err(RiskError::OrderTooLarge {
                notional,
                max: self.cfg.max_order_notional,
            });
        }
        if symbol_exposure + notional > self.cfg.max_symbol_exposure {
            return Err(RiskError::SymbolExposureExceeded {
                symbol: symbol.into(),
                current: symbol_exposure,
                order: notional,
                cap: self.cfg.max_symbol_exposure,
            });
        }
        if house_net_exposure + notional > self.cfg.max_house_net_exposure {
            return Err(RiskError::HouseExposureExceeded {
                current: house_net_exposure,
                order: notional,
                cap: self.cfg.max_house_net_exposure,
            });
        }
        if client_daily_loss.abs() > self.cfg.client_daily_loss_limit {
            return Err(RiskError::ClientDailyLossExceeded {
                account_id,
                loss: client_daily_loss,
                limit: self.cfg.client_daily_loss_limit,
            });
        }
        Ok(())
    }

    /// Pre-trade check for a binary option.
    pub fn check_binary(
        &self,
        stake: f64,
        client_daily_loss: f64,
        account_id: Uuid,
    ) -> Result<(), RiskError> {
        if stake > self.cfg.max_binary_stake {
            return Err(RiskError::BinaryStakeTooLarge {
                stake,
                max: self.cfg.max_binary_stake,
            });
        }
        if client_daily_loss.abs() > self.cfg.client_daily_loss_limit {
            return Err(RiskError::ClientDailyLossExceeded {
                account_id,
                loss: client_daily_loss,
                limit: self.cfg.client_daily_loss_limit,
            });
        }
        Ok(())
    }

    /// Pre-trade check for a spot position (cash purchase, no leverage).
    pub fn check_spot(
        &self,
        stake: f64,
        client_daily_loss: f64,
        account_id: Uuid,
    ) -> Result<(), RiskError> {
        if stake > self.cfg.max_spot_stake {
            return Err(RiskError::SpotStakeTooLarge {
                stake,
                max: self.cfg.max_spot_stake,
            });
        }
        if client_daily_loss.abs() > self.cfg.client_daily_loss_limit {
            return Err(RiskError::ClientDailyLossExceeded {
                account_id,
                loss: client_daily_loss,
                limit: self.cfg.client_daily_loss_limit,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RiskConfig {
        RiskConfig::default()
    }

    #[test]
    fn binary_stake_cap_enforced() {
        let r = RiskEngine::new(cfg());
        let acct = Uuid::new_v4();
        assert!(r.check_binary(100.0, 0.0, acct).is_ok());
        assert!(matches!(
            r.check_binary(1_000.0, 0.0, acct),
            Err(RiskError::BinaryStakeTooLarge { .. })
        ));
    }

    #[test]
    fn spot_stake_cap_enforced() {
        let r = RiskEngine::new(cfg());
        let acct = Uuid::new_v4();
        assert!(r.check_spot(100.0, 0.0, acct).is_ok());
        assert!(matches!(
            r.check_spot(10_000.0, 0.0, acct),
            Err(RiskError::SpotStakeTooLarge { .. })
        ));
    }

    #[test]
    fn cfd_notional_cap_enforced() {
        let r = RiskEngine::new(cfg());
        let acct = Uuid::new_v4();
        assert!(r.check_cfd(1_000.0, "BTC", 0.0, 0.0, 0.0, acct).is_ok());
        assert!(matches!(
            r.check_cfd(50_000.0, "BTC", 0.0, 0.0, 0.0, acct),
            Err(RiskError::OrderTooLarge { .. })
        ));
    }

    #[test]
    fn daily_loss_cap_triggers_for_all_trade_types() {
        let r = RiskEngine::new(cfg());
        let acct = Uuid::new_v4();
        // Both signs of daily P&L should trip when |loss| > limit.
        for loss in [-2_500.0_f64, 2_500.0_f64] {
            assert!(matches!(
                r.check_binary(10.0, loss, acct),
                Err(RiskError::ClientDailyLossExceeded { .. })
            ));
            assert!(matches!(
                r.check_spot(10.0, loss, acct),
                Err(RiskError::ClientDailyLossExceeded { .. })
            ));
            assert!(matches!(
                r.check_cfd(10.0, "X", 0.0, 0.0, loss, acct),
                Err(RiskError::ClientDailyLossExceeded { .. })
            ));
        }
    }

    #[test]
    fn stale_price_refused() {
        let r = RiskEngine::new(cfg());
        let now_ms: i64 = 1_700_000_000_000;
        // Fresh tick (5s old) → OK.
        assert!(r
            .check_price_freshness("X", Some(now_ms - 5_000), now_ms)
            .is_ok());
        // 20s old → stale.
        assert!(matches!(
            r.check_price_freshness("X", Some(now_ms - 20_000), now_ms),
            Err(RiskError::StalePrice { .. })
        ));
        // No tick yet → also refused.
        assert!(matches!(
            r.check_price_freshness("X", None, now_ms),
            Err(RiskError::NoPriceForSymbol { .. })
        ));
    }

    #[test]
    fn symbol_exposure_cap() {
        let r = RiskEngine::new(cfg());
        let acct = Uuid::new_v4();
        // 95k existing + 10k order = 105k > 100k cap → reject.
        assert!(matches!(
            r.check_cfd(10_000.0, "X", 95_000.0, 0.0, 0.0, acct),
            Err(RiskError::SymbolExposureExceeded { .. })
        ));
    }
}
